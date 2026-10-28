import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import {
  chatDeviceScopeInput,
  chatDeviceOptionsInput,
  portableChatDeviceConversation,
} from "../../shared/chat-device-context";
import type { Conversation } from "../../shared/types";
import type { DeviceHost } from "./device-methods";

const scopeInput = chatDeviceScopeInput.extend({
  remoteConversationId: z.string().max(200),
});
const transfer = z.object({
  name: z.string().min(1).max(500),
  data: z.string().max(2_800_000),
});
const sendInput = chatDeviceScopeInput
  .extend({
    logicalConversationId: z.string().min(1).max(200),
    remoteConversationId: z.string().max(200).optional(),
    source: z.unknown().optional(),
    requestId: z.string().uuid(),
    text: z.string().min(1).max(200_000),
    providerId: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    taskPermission: z.enum(["default", "auto"]),
    attachments: z.array(transfer).max(12),
    options: chatDeviceOptionsInput.optional(),
  })
  .strict();

/** A separate, explicitly negotiated Chat protocol. Legacy newSession and
 * fixed Cowork linking never stand in for this capability. */
export class ChatDeviceMethods {
  private leases = new AsyncLocalStorage<object>();
  private pending = new Map<
    string,
    { requestId: string; promise: Promise<unknown> }
  >();
  constructor(private host: DeviceHost) {}
  capabilities() {
    return this.host.chatDevice && this.host.chatDevice.accountScope()
      ? {
          chatBindingVersion: 1,
          chatPermissionModes: ["default", "auto"],
          chatModes: ["chat", "cowork"],
        }
      : undefined;
  }
  private current(account: string) {
    const lease = this.leases.getStore();
    if (
      !this.host.chatDevice ||
      this.host.chatDevice.accountScope() !== account ||
      (lease &&
        lease !== (this.host.chatDevice.scope?.() ?? this.host.chatDevice))
    )
      throw new Error(
        "The signed-in account changed. Select the device again.",
      );
  }
  private target(raw: unknown) {
    const input = scopeInput.parse(raw);
    this.current(input.accountScope);
    const conversation = this.host
      .conversations()
      .find((c) => c.id === input.remoteConversationId);
    if (
      !conversation?.deviceChatOrigin?.active ||
      conversation.deviceChatOrigin.accountScope !== input.accountScope ||
      conversation.incognito
    )
      throw new Error("This Chat device binding is no longer available.");
    return { input, conversation };
  }
  private opened(conversation: Conversation) {
    return {
      conversation: structuredClone(conversation),
      approvals: this.host
        .approvals()
        .filter((a) => a.conversationId === conversation.id),
    };
  }
  private async imported(raw: unknown) {
    const input = chatDeviceScopeInput
      .extend({
        source: z.unknown(),
        taskPermission: z.enum(["default", "auto"]),
        providerId: z.string().min(1),
        model: z.string().min(1),
      })
      .strict()
      .parse(raw);
    this.current(input.accountScope);
    if (this.host.computerAccess?.() !== true)
      throw new Error("Computer access is off on this device.");
    if (
      !this.host
        .models()
        .models.some(
          (model) =>
            model.providerId === input.providerId && model.id === input.model,
        )
    )
      throw new Error("This computer cannot use the selected model.");
    const source = portableChatDeviceConversation(input.source as Conversation);
    const id = randomUUID();
    const conversation: Conversation = {
      ...source,
      id,
      deviceChatOrigin: {
        version: 1,
        accountScope: input.accountScope,
        logicalConversationId: source.id,
        active: true,
        permission: input.taskPermission,
      },
    };
    const imported = await this.host.chatDevice!.save(conversation);
    this.current(input.accountScope);
    return this.opened(imported);
  }
  call(method: string, raw: unknown): Promise<unknown> {
    const lease = this.host.chatDevice?.scope?.() ?? this.host.chatDevice;
    return lease
      ? this.leases.run(lease, () => this.perform(method, raw))
      : Promise.reject(
          new Error(
            "This computer doesn't support Chat device binding version 1.",
          ),
        );
  }
  retire() {
    this.pending.clear();
  }
  private async perform(method: string, raw: unknown) {
    if (!this.capabilities())
      throw new Error(
        "This computer doesn't support Chat device binding version 1.",
      );
    if (method === "chatDeviceImport") return this.imported(raw);
    if (method === "chatDeviceActivate") {
      const input = scopeInput.parse(raw);
      this.current(input.accountScope);
      const conversation = this.host
        .conversations()
        .find(
          (c) =>
            c.id === input.remoteConversationId &&
            c.deviceChatOrigin?.accountScope === input.accountScope,
        );
      if (!conversation?.deviceChatOrigin || conversation.incognito)
        throw new Error("This Chat device binding is no longer available.");
      if (this.host.computerAccess?.() !== true)
        throw new Error("Computer access is off on this device.");
      conversation.deviceChatOrigin.active = true;
      await this.host.chatDevice!.save(conversation);
      this.current(input.accountScope);
      return this.opened(conversation);
    }
    if (method === "chatDeviceSend") {
      const input = sendInput.parse(raw);
      this.current(input.accountScope);
      const key = JSON.stringify([
        input.accountScope,
        input.logicalConversationId,
      ]);
      const previous = this.pending.get(key);
      if (previous?.requestId === input.requestId) return previous.promise;
      if (previous)
        throw new Error("A message is already being sent to this computer.");
      const promise = this.send(input).finally(() => {
        if (this.pending.get(key)?.promise === promise)
          this.pending.delete(key);
      });
      this.pending.set(key, { requestId: input.requestId, promise });
      return promise;
    }
    const { input, conversation } = this.target(raw);
    if (method === "chatDeviceOpen") return this.opened(conversation);
    if (method === "chatDeviceRelease") {
      if (conversation.turns.some((turn) => turn.status === "inProgress"))
        throw new Error("Stop the response before changing devices.");
      await this.host.chatDevice!.release(conversation.id);
      this.current(input.accountScope);
      conversation.deviceChatOrigin!.active = false;
      await this.host.chatDevice!.save(conversation);
      return null;
    }
    if (method === "chatDeviceInterrupt")
      return this.host.interrupt(conversation.id);
    if (method === "chatDeviceApprove") {
      const approvalInput = scopeInput
        .extend({
          approvalId: z.union([z.string(), z.number()]),
          result: z.unknown(),
        })
        .parse(raw);
      const approval = this.host
        .approvals()
        .find(
          (a) =>
            a.id === approvalInput.approvalId &&
            a.conversationId === conversation.id,
        );
      if (!approval) throw new Error("This request was already answered.");
      return this.host.approve(approval.id, approvalInput.result);
    }
    if (method === "chatDeviceBlob") {
      const blobInput = scopeInput
        .extend({
          digest: z.string().regex(/^[0-9a-f]{64}$/),
          offset: z
            .number()
            .int()
            .min(0)
            .max(16 * 1024 * 1024)
            .default(0),
          length: z
            .number()
            .int()
            .min(1)
            .max(256 * 1024)
            .default(256 * 1024),
        })
        .parse(raw);
      let referenced = false;
      JSON.stringify(conversation.turns, (key, value) => {
        if (key === "digest" && value === blobInput.digest) referenced = true;
        return value;
      });
      if (!referenced)
        throw new Error("This file does not belong to the conversation.");
      const bytes = await this.host.chatDevice!.blob(blobInput.digest);
      this.current(input.accountScope);
      if (bytes.byteLength > 16 * 1024 * 1024)
        throw new Error(
          "This generated file is too large for Chat device transfer.",
        );
      return {
        data: Buffer.from(
          bytes.subarray(blobInput.offset, blobInput.offset + blobInput.length),
        ).toString("base64"),
        size: bytes.byteLength,
      };
    }
    throw new Error(
      "This computer doesn't support that Chat device operation.",
    );
  }
  private async send(input: z.infer<typeof sendInput>) {
    this.current(input.accountScope);
    if (this.host.computerAccess?.() !== true)
      throw new Error("Computer access is off on this device.");
    if (
      !this.host
        .models()
        .models.some(
          (m) => m.providerId === input.providerId && m.id === input.model,
        )
    )
      throw new Error("This computer cannot use the selected model.");
    // Validate all transfers before importing or altering a binding.
    let size = 0;
    const transfers = input.attachments.map((file) => {
      if (file.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))
        throw new Error("This attachment cannot be transferred.");
      const bytes = Buffer.from(file.data, "base64");
      size += bytes.byteLength;
      if (size > 2 * 1024 * 1024 || !this.host.addAttachment)
        throw new Error(
          "These attachments are too large for Chat device transfer.",
        );
      return { name: file.name, bytes };
    });
    let conversation = input.remoteConversationId
      ? this.target(input).conversation
      : undefined;
    if (!conversation) {
      if (!input.source)
        throw new Error("The conversation context is missing.");
      const result = await this.imported({
        version: 1,
        accountScope: input.accountScope,
        organizationId: null,
        source: input.source,
        taskPermission: input.taskPermission,
        providerId: input.providerId,
        model: input.model,
      });
      conversation = result.conversation;
    }
    if (
      conversation.deviceChatOrigin?.logicalConversationId !==
      input.logicalConversationId
    )
      throw new Error("The Chat device binding changed. Try again.");
    if (conversation.deviceChatOrigin.lastRequestId === input.requestId)
      return this.opened(conversation);
    if (conversation.turns.some((turn) => turn.status === "inProgress"))
      throw new Error("This conversation is already responding.");
    const attachments = [];
    for (const file of transfers) {
      attachments.push(await this.host.addAttachment!(file.name, file.bytes));
      this.current(input.accountScope);
    }
    conversation.deviceChatOrigin.permission = input.taskPermission;
    conversation.deviceChatOrigin.lastRequestId = input.requestId;
    for (const [key, value] of Object.entries(input.options ?? {}))
      if (value !== undefined) Object.assign(conversation, { [key]: value });
    conversation = await this.host.chatDevice!.save(conversation);
    this.current(input.accountScope);
    await this.host.send({
      ...input.options,
      conversationId: conversation.id,
      cwd: conversation.cwd,
      text: input.text,
      mode: conversation.mode,
      attachments,
      providerId: input.providerId,
      model: input.model,
    });
    this.current(input.accountScope);
    const actual = this.host
      .conversations()
      .find((c) => c.id === conversation!.id);
    if (!actual)
      throw new Error("The device conversation is no longer available.");
    return this.opened(actual);
  }
}
