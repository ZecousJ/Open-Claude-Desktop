import fs from "node:fs/promises";
import path from "node:path";
import type {
  AppEvent,
  Approval,
  Attachment,
  Conversation,
  Settings,
} from "../../shared/types";
import type {
  ChatDeviceBinding,
  ChatDeviceDirectory,
  ChatDeviceSendInput,
} from "../../shared/chat-devices-api";
import { chatDeviceUnavailable } from "../../shared/chat-devices-api";
import {
  chatDeviceSendInput,
  setChatDeviceInput,
} from "../../shared/chat-device-context";
import { DesktopDeviceTrustClient } from "../../electron/remote-control/device-trust-client";
import type { DeviceMethod } from "../../shared/remote-devices";
import * as chatDevicesMessages from "./chat-devices-messages";
import { installMethods } from "./install-methods";
import { scopeOf } from "./chat-devices-support";
import * as chatDevicesRouting from "./chat-devices-routing";

export interface Opened {
  conversation: Conversation;
  approvals: Approval[];
}
export interface ChatDeviceRunnerHost {
  accountScope: string;
  /** Actual service and account identity; absent on old/unsupported hosts. */
  trustScope?: string;
  root: string;
  current(): boolean;
  conversations(): Conversation[];
  settings(): Settings;
  attachment(id: string): Attachment | undefined;
  save(
    conversation: Conversation,
    options?: { retainOnFailure?: boolean },
  ): Promise<void>;
  request(op: "device.list" | "device.call", body: unknown): Promise<unknown>;
  push(event: AppEvent): void;
  release(id: string): Promise<unknown>;
}

/** One real runner context owns orchestration and the durable logical ↔
 * remote mapping. Web and Electron use this same implementation. */
export class ChatDeviceController {
  private relayTrustVersion: 0 | 1 | undefined;
  private readonly trust: DesktopDeviceTrustClient;
  private disposed = false;
  private polling?: ReturnType<typeof setTimeout>;
  private pending = new Map<
    string,
    { requestId: string; promise: Promise<Conversation> }
  >();
  private changes = new Set<string>();
  private refreshing?: Promise<void>;
  private retryDelay = 500;
  approvals = new Map<
    string,
    {
      binding: ChatDeviceBinding;
      remoteId: string | number;
      logicalId: string;
      approval: Approval;
    }
  >();
  constructor(public host: ChatDeviceRunnerHost) {
    this.trust = new DesktopDeviceTrustClient(
      () => path.join(host.root, "device-trust-client"),
      () => (!this.disposed && host.current() ? host.trustScope : undefined),
      () => "Claudex runner",
    );
  }
  current() {
    if (this.disposed || !this.host.current())
      throw new Error("The signed-in account changed. Try again.");
  }
  private scope(accountScope: string, organizationId: unknown) {
    this.current();
    if (accountScope !== this.host.accountScope || organizationId !== null)
      throw new Error(
        "The signed-in account or organization changed. Select the device again.",
      );
  }
  async directory(): Promise<ChatDeviceDirectory> {
    this.current();
    let value: unknown;
    try {
      value = await this.host.request("device.list", { version: 1 });
    } catch {
      throw new Error(chatDeviceUnavailable);
    }
    this.current();
    const data = value as ChatDeviceDirectory;
    if (
      data?.version !== 1 ||
      data.accountScope !== this.host.accountScope ||
      data.organizationId !== null ||
      !Array.isArray(data.devices)
    )
      throw new Error(chatDeviceUnavailable);
    if (
      data.deviceTrustRelayVersion !== undefined &&
      data.deviceTrustRelayVersion !== 1
    )
      throw new Error(chatDeviceUnavailable);
    this.relayTrustVersion = data.deviceTrustRelayVersion === 1 ? 1 : 0;
    return data;
  }
  async elected(
    deviceId: string,
    mode: Conversation["mode"],
    permission: "default" | "auto",
  ) {
    const directory = await this.directory();
    const device = directory.devices.find((item) => item.id === deviceId);
    if (!device)
      throw new Error("The selected computer is no longer available.");
    if (
      device.chatBindingVersion !== 1 ||
      !device.chatModes?.includes(mode as "chat" | "cowork")
    )
      throw new Error(
        "This computer doesn't support Chat device binding version 1.",
      );
    if (!device.chatPermissionModes?.includes(permission))
      throw new Error(
        "This computer doesn't support the selected permission mode.",
      );
    if (device.online !== true)
      throw new Error(
        "The selected computer is offline. Reconnect it or choose another device.",
      );
    if (device.computerAccess !== true)
      throw new Error("Computer access is off on the selected device.");
    return device;
  }
  async call(
    binding: Pick<ChatDeviceBinding, "deviceId">,
    method: string,
    input: Record<string, unknown>,
  ) {
    this.current();
    if (this.relayTrustVersion === undefined) await this.directory();
    const proof = this.relayTrustVersion === 1;
    if (proof && !this.host.trustScope) throw new Error(chatDeviceUnavailable);
    const raw = async (method: DeviceMethod, args: unknown[]) => {
      this.current();
      const value = await this.host.request("device.call", {
        version: 1,
        deviceId: binding.deviceId,
        method,
        args,
        ...(proof ? { scope: scopeOf(this.host.accountScope) } : {}),
      });
      this.current();
      return value;
    };
    const args = [{ ...scopeOf(this.host.accountScope), ...input }];
    const value = proof
      ? await this.trust.call(
          raw,
          binding.deviceId,
          method as DeviceMethod,
          args,
        )
      : await raw(method as DeviceMethod, args);
    this.current();
    return value;
  }
  target(id: string) {
    const conversation = this.host.conversations().find((c) => c.id === id);
    if (!conversation || conversation.mode === "code" || conversation.incognito)
      throw new Error("This conversation can't use a Chat device.");
    if (conversation.linkedToComputer && !conversation.chatDeviceBinding)
      throw new Error(
        "This Cowork task is bound to its owning computer and cannot be moved with Chat Devices.",
      );
    return conversation;
  }
  binding(conversation: Conversation, expected?: number) {
    const binding = conversation.chatDeviceBinding;
    if (
      binding &&
      (binding.version !== 1 ||
        binding.accountScope !== this.host.accountScope ||
        binding.organizationId !== null ||
        (expected !== undefined && binding.revision !== expected))
    )
      throw new Error(
        "The Chat device binding changed. Select the device again.",
      );
    if (
      !binding &&
      expected !== undefined &&
      expected !== (conversation.chatDeviceRevision ?? 0)
    )
      throw new Error(
        "The Chat device binding changed. Select the device again.",
      );
    return binding;
  }
  async transfers(attachments: { id: string }[]) {
    let total = 0;
    const result = [];
    for (const row of attachments) {
      const file = this.host.attachment(row.id);
      if (!file)
        throw new Error(
          "This attachment is no longer available. Add it again.",
        );
      const bytes = await fs.readFile(file.path);
      this.current();
      total += bytes.byteLength;
      if (total > 2 * 1024 * 1024)
        throw new Error(
          "These attachments are too large for Chat device transfer.",
        );
      result.push({ name: file.name, data: bytes.toString("base64") });
    }
    return result;
  }
  async send(raw: unknown): Promise<Conversation> {
    const input = chatDeviceSendInput.parse(raw);
    this.scope(input.accountScope, input.organizationId);
    const logicalId = input.conversationId ?? input.requestId;
    const prior = this.pending.get(logicalId);
    if (prior?.requestId === input.requestId) return prior.promise;
    if (this.changes.has(logicalId))
      throw new Error(
        "The Chat device is being changed. Try again in a moment.",
      );
    if (prior)
      throw new Error("A message is already being sent to this computer.");
    const promise = this.submit(
      input as ChatDeviceSendInput,
      logicalId,
    ).finally(() => {
      if (this.pending.get(logicalId)?.promise === promise)
        this.pending.delete(logicalId);
    });
    this.pending.set(logicalId, { requestId: input.requestId, promise });
    return promise;
  }
  schedule() {
    if (this.polling || this.disposed) return;
    this.polling = setTimeout(() => {
      this.polling = undefined;
      void this.refresh();
    }, this.retryDelay);
    this.polling.unref?.();
  }
  pendingApprovals() {
    return [...this.approvals.values()].map((entry) => entry.approval);
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const work = this.refreshAll().finally(() => {
      if (this.refreshing === work) this.refreshing = undefined;
    });
    this.refreshing = work;
    return work;
  }
  private async refreshAll() {
    if (this.disposed || !this.host.current()) return;
    for (const conversation of this.host.conversations()) {
      const binding = conversation.chatDeviceBinding;
      if (
        !binding ||
        this.changes.has(conversation.id) ||
        this.pending.has(conversation.id)
      )
        continue;
      try {
        const opened = (await this.call(binding, "chatDeviceOpen", {
          remoteConversationId: binding.remoteConversationId,
        })) as Opened;
        const now = this.host
          .conversations()
          .find((c) => c.id === conversation.id)?.chatDeviceBinding;
        if (
          now?.revision === binding.revision &&
          now.deviceId === binding.deviceId &&
          now.remoteConversationId === binding.remoteConversationId &&
          !this.changes.has(conversation.id) &&
          !this.pending.has(conversation.id)
        )
          await this.receive(conversation, binding, opened);
        this.retryDelay = 500;
      } catch (error) {
        this.retryDelay = Math.min(30_000, this.retryDelay * 2);
        if (!this.disposed && this.host.current()) {
          const waiting = {
            ...conversation,
            chatDeviceError:
              error instanceof Error ? error.message : String(error),
          };
          await this.host.save(waiting).catch(() => {});
          if (this.disposed || !this.host.current()) return;
          this.host.push({ type: "conversation", conversation: waiting });
        }
        this.schedule();
      }
    }
  }
  async select(raw: unknown) {
    const input = setChatDeviceInput.parse(raw);
    this.scope(input.accountScope, input.organizationId);
    if (
      this.changes.has(input.conversationId) ||
      this.pending.has(input.conversationId)
    )
      throw new Error("The Chat device is busy. Try again in a moment.");
    this.changes.add(input.conversationId);
    try {
      return await this.migrate(input);
    } finally {
      this.changes.delete(input.conversationId);
    }
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.polling);
    this.polling = undefined;
    this.approvals.clear();
  }
}

export interface ChatDeviceController {
  migrate: OmitThisParameter<typeof chatDevicesRouting.migrate>;
  route: OmitThisParameter<typeof chatDevicesRouting.route>;
}
installMethods(ChatDeviceController.prototype, chatDevicesRouting);

export interface ChatDeviceController {
  submit: OmitThisParameter<typeof chatDevicesMessages.submit>;
  receive: OmitThisParameter<typeof chatDevicesMessages.receive>;
}
installMethods(ChatDeviceController.prototype, chatDevicesMessages);
