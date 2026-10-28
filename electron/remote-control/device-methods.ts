/**
 * What a phone may do with this computer's Code conversations over the
 * device link (shared/remote-devices.ts): list them, open one, send to it,
 * stop it and answer its approvals. Code and Cowork conversations that run here
 * (this computer or one of its SSH hosts) are reachable: not Chat,
 * not incognito, not the cloud's.
 */
import type {
  AppEvent,
  Approval,
  Attachment,
  Conversation,
} from "../../shared/types";
import type { DispatchReceipts } from "./dispatch-delivery";
import { ChatDeviceMethods } from "./chat-device-methods";
import {
  deviceWatchMs,
  type DeviceAppEvent,
  type DeviceConversation,
  type DeviceConversationSummary,
  type DeviceDirectory,
  type DeviceMethod,
  type DeviceModels,
  type DeviceNewSessionResult,
  remoteFolderValid,
  remoteSessionCapacity,
} from "../../shared/remote-devices";

export interface DeviceHost {
  addAttachment?(name: string, data: Uint8Array): Promise<Attachment>;
  dispatchPreferences?(enabled?: boolean): Promise<boolean>;
  /** The signed-in account's local conversations. */
  conversations(): Conversation[];
  /** The local engines' approvals waiting for an answer. */
  approvals(): Approval[];
  /** The window's own `send`, `interrupt` and `approve` handlers. */
  send(input: {
    /** Missing: a new session in `cwd`. */
    conversationId?: string;
    cwd?: string;
    text: string;
    mode: "code" | "cowork" | "chat";
    attachments: Attachment[];
    providerId: string;
    model: string;
    effort?: import("../../shared/types").CodeEffort;
    webSearch?: boolean;
    research?: boolean;
    thinkingMode?: "standard" | "extended";
    connectorOverrides?: Record<string, boolean>;
    connectorToolOverrides?: import("../../shared/conversation-tools").ConversationToolOverrides;
  }): Promise<unknown>;
  interrupt(conversationId: string): Promise<unknown>;
  approve(id: string | number, result: unknown): Promise<unknown>;
  /** The folders the person added for phones (Settings → General). */
  remoteFolders(): string[];
  /** The models the computer's services offer, and the one new sessions use. */
  models(): DeviceModels;
  /** The window's own `updateConversation` handler. */
  update(
    conversationId: string,
    patch: { archived?: boolean; providerId?: string; model?: string },
  ): Promise<unknown>;
  now(): number;
  computerAccess?(): boolean;
  codeEnabled?(): boolean;
  chatDevice?: {
    accountScope(): string | undefined;
    scope?(): object;
    save(conversation: Conversation): Promise<Conversation>;
    release(id: string): Promise<unknown>;
    blob(digest: string): Promise<Uint8Array>;
  };
}

export const reachable = (c: Conversation | undefined): c is Conversation =>
  !!c &&
  (c.mode === "code" || c.mode === "cowork") &&
  !c.incognito &&
  c.environment?.kind !== "space" &&
  // The session rail's Remote Control switch, off for this session.
  !c.remoteControlOff;

const running = (c: Conversation) => c.turns.at(-1)?.status === "inProgress";

const maxListed = 100;
const maxText = 200_000;

function fail(message: string): never {
  throw new Error(message);
}

export class DeviceMethods {
  readonly chatDevices: ChatDeviceMethods;
  private starting = 0;

  capacity() {
    return {
      active:
        this.host
          .conversations()
          .filter((c) => reachable(c) && !c.archived && running(c)).length +
        this.starting,
      max: remoteSessionCapacity,
    };
  }
  /** Conversation id → until when a phone keeps it open. */
  private readonly watched = new Map<string, number>();

  constructor(
    private readonly host: DeviceHost,
    private receipts?: DispatchReceipts,
  ) {
    this.chatDevices = new ChatDeviceMethods(host);
  }

  notificationConversation(id: string) {
    return this.host
      .conversations()
      .find(
        (conversation) => conversation.id === id && reachable(conversation),
      );
  }

  private conversation(id: unknown) {
    if (typeof id !== "string" || !id || id.length > 500)
      fail("This conversation is not on this computer.");
    const found = this.host.conversations().find((c) => c.id === id);
    if (!reachable(found)) fail("This conversation is not on this computer.");
    if (found.mode === "code" && this.host.codeEnabled?.() === false)
      fail("This conversation is not on this computer.");
    return found;
  }

  isWatched(id: string) {
    const until = this.watched.get(id);
    if (until === undefined) return false;
    if (until > this.host.now()) return true;
    this.watched.delete(id);
    return false;
  }

  /** A model the computer offers, from an input that names one. */
  private chosenModel(input: { providerId?: unknown; model?: unknown }) {
    const { providerId, model } = input ?? {};
    if (typeof providerId !== "string" || typeof model !== "string")
      fail("Choose a model first.");
    const offered = this.host
      .models()
      .models.some(
        (item) => item.providerId === providerId && item.id === model,
      );
    if (!offered) fail("This account cannot use the selected model.");
    return { providerId, model };
  }

  /** The folders phones may start sessions in, with their open sessions. */
  directories(): DeviceDirectory[] {
    const open = new Map<string, number>();
    for (const c of this.host.conversations())
      if (reachable(c) && !c.archived && c.cwd)
        open.set(c.cwd, (open.get(c.cwd) ?? 0) + 1);
    return this.host
      .remoteFolders()
      .filter(remoteFolderValid)
      .map((path, index) => ({
        path,
        name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
        sessions: open.get(path) ?? 0,
        default: index === 0,
      }));
  }

  /** A new Code session in one of the added folders (never any other path). */
  private async newSession(raw: unknown): Promise<DeviceNewSessionResult> {
    const capacity = this.capacity();
    if (capacity.active >= capacity.max)
      fail(
        `Remote Control is at capacity (${capacity.active} of ${capacity.max} sessions). End one to start another.`,
      );
    this.starting++;
    try {
      return await this.createSession(raw);
    } finally {
      this.starting--;
    }
  }

  private async createSession(raw: unknown): Promise<DeviceNewSessionResult> {
    const input = raw as {
      cwd?: unknown;
      text?: unknown;
      providerId?: unknown;
      model?: unknown;
      mode?: unknown;
      attachments?: unknown;
    };
    const cwd = input?.cwd;
    if (
      input?.mode !== undefined &&
      input.mode !== "code" &&
      input.mode !== "cowork"
    )
      fail("This computer can't do that.");
    if (typeof cwd !== "string" || !remoteFolderValid(cwd))
      fail("Choose a directory, not the filesystem root.");
    if (!this.host.remoteFolders().includes(cwd))
      fail(
        "This folder isn't added for your phone. Add it in Settings on the computer.",
      );
    const text = input.text;
    if (typeof text !== "string" || !text.trim() || text.length > maxText)
      fail("Write a message first.");
    let picked: { providerId: string; model: string };
    if (input.providerId === undefined && input.model === undefined) {
      const fallback = this.host.models().default;
      if (!fallback) fail("No model is available on this computer.");
      picked = { providerId: fallback.providerId, model: fallback.id };
    } else picked = this.chosenModel(input);
    const attachments: Attachment[] = [];
    if (input.attachments !== undefined) {
      if (!Array.isArray(input.attachments) || input.attachments.length > 12)
        fail("This file can't be attached.");
      let total = 0;
      for (const file of input.attachments) {
        if (
          !file ||
          typeof file.name !== "string" ||
          file.name.length > 500 ||
          typeof file.data !== "string" ||
          file.data.length > 90_000_000 ||
          file.data.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data) ||
          !this.host.addAttachment
        )
          fail("This file can't be attached.");
        const data = Buffer.from(file.data, "base64");
        total += data.byteLength;
        if (total > 64 * 1024 * 1024) fail("This file can't be attached.");
        attachments.push(await this.host.addAttachment(file.name, data));
      }
    }
    const created = (await this.host.send({
      cwd,
      text,
      mode: input.mode === "cowork" ? "cowork" : "code",
      attachments,
      providerId: picked.providerId,
      model: picked.model,
    })) as Conversation | undefined;
    if (!created?.id) fail("This computer couldn't start the session.");
    this.watched.set(created.id, this.host.now() + deviceWatchMs);
    return { conversationId: created.id };
  }

  summaries(dispatch = false): DeviceConversationSummary[] {
    if (!dispatch && this.host.codeEnabled?.() === false) return [];
    const waiting = new Map<string, number>();
    for (const a of this.host.approvals())
      waiting.set(a.conversationId, (waiting.get(a.conversationId) ?? 0) + 1);
    return this.host
      .conversations()
      .filter(
        (c) => reachable(c) && !c.archived && (dispatch || c.mode === "code"),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, maxListed)
      .map((c) => ({
        id: c.id,
        title: c.title,
        ...(c.cwd ? { cwd: c.cwd } : {}),
        ...(c.environment ? { environment: c.environment } : {}),
        updatedAt: c.updatedAt,
        running: running(c),
        approvals: waiting.get(c.id) ?? 0,
        model: c.model,
        ...(dispatch
          ? {
              mode: c.mode as "code" | "cowork",
              failed: c.turns.at(-1)?.status === "failed",
              readyReview: c.pullRequests?.some((request) =>
                ["open", "draft", "queued"].includes(request.state),
              ),
            }
          : {}),
      }));
  }

  /** Runs one relayed call. */
  async call(method: string, args: unknown[]): Promise<unknown> {
    if (method.startsWith("chatDevice"))
      return this.chatDevices.call(method, args[0]);
    if (
      this.host.codeEnabled?.() === false &&
      [
        "listDirectories",
        "newSession",
        "listModels",
        "setModel",
        "endSession",
      ].includes(method)
    )
      fail("This computer can't do that.");
    switch (method as DeviceMethod) {
      case "dispatchPreferences":
        if (
          !this.host.dispatchPreferences ||
          (args.length && typeof args[0] !== "boolean")
        )
          fail("This computer can't do that.");
        return this.host.dispatchPreferences(args[0] as boolean | undefined);
      case "deliverDispatch": {
        const input = args[0] as {
          id?: unknown;
          method?: unknown;
          args?: unknown;
        };
        if (
          !this.receipts ||
          typeof input?.id !== "string" ||
          !/^[a-f0-9-]{36}$/.test(input.id) ||
          (input.method !== "newSession" && input.method !== "send") ||
          !Array.isArray(input.args) ||
          input.args.length !== 1
        )
          fail("This computer can't do that.");
        return this.receipts.run(input.id, () =>
          this.call(input.method as string, input.args as unknown[]),
        );
      }
      case "listDispatchTasks":
        return this.summaries(true);
      case "listCodeConversations":
        return this.summaries();
      case "remoteControlCapacity":
        return this.capacity();
      case "openConversation": {
        const conversation = this.conversation(args[0]);
        this.watched.set(conversation.id, this.host.now() + deviceWatchMs);
        const answer: DeviceConversation = {
          conversation,
          approvals: this.host
            .approvals()
            .filter((a) => a.conversationId === conversation.id),
        };
        return answer;
      }
      case "send": {
        const input = args[0] as { conversationId?: unknown; text?: unknown };
        const conversation = this.conversation(input?.conversationId);
        if (
          conversation.mode === "cowork" &&
          this.host.computerAccess?.() === false
        )
          fail("Waiting for your computer");
        const text = input?.text;
        if (typeof text !== "string" || !text.trim() || text.length > maxText)
          fail("Write a message first.");
        this.watched.set(conversation.id, this.host.now() + deviceWatchMs);
        await this.host.send({
          conversationId: conversation.id,
          text,
          mode: conversation.mode as "code" | "cowork",
          attachments: [],
          providerId: conversation.providerId,
          model: conversation.model,
        });
        return null;
      }
      case "listDirectories":
        return this.directories();
      case "newSession":
        return this.newSession(args[0]);
      case "endSession": {
        const conversation = this.conversation(args[0]);
        // The turn stops first; its waiting approvals die with it. The
        // session stays on the computer, archived, until the person
        // deletes it (the web: "stays until you archive it").
        if (running(conversation)) await this.host.interrupt(conversation.id);
        await this.host.update(conversation.id, { archived: true });
        this.watched.delete(conversation.id);
        return null;
      }
      case "listModels":
        return this.host.models();
      case "setModel": {
        const input = args[0] as {
          conversationId?: unknown;
          providerId?: unknown;
          model?: unknown;
        };
        const conversation = this.conversation(input?.conversationId);
        const { providerId, model } = this.chosenModel(input);
        await this.host.update(conversation.id, { providerId, model });
        return null;
      }
      case "interrupt": {
        const conversation = this.conversation(args[0]);
        await this.host.interrupt(conversation.id);
        return null;
      }
      case "approve": {
        const id = args[0];
        const approval = this.host.approvals().find((a) => a.id === id);
        if (!approval) fail("This request was already answered.");
        this.conversation(approval.conversationId);
        await this.host.approve(approval.id, args[1]);
        return null;
      }
      default:
        fail("This computer can't do that.");
    }
  }

  /**
   * The device events a local event makes. Turn changes go out only for a
   * conversation a phone has open; the list hint and approvals always.
   */
  eventsFor(event: AppEvent): DeviceAppEvent[] {
    switch (event.type) {
      case "conversation": {
        const c = event.conversation;
        if (
          !reachable(c) ||
          (c.mode === "code" && this.host.codeEnabled?.() === false)
        )
          return [];
        const out: DeviceAppEvent[] = [{ type: "device-conversations" }];
        if (this.isWatched(c.id))
          out.push({ type: "conversation", conversation: c });
        return out;
      }
      case "approval": {
        const c = this.host
          .conversations()
          .find((item) => item.id === event.approval.conversationId);
        return reachable(c) &&
          (c.mode !== "code" || this.host.codeEnabled?.() !== false)
          ? [
              { type: "approval", approval: event.approval },
              { type: "device-conversations" },
            ]
          : [];
      }
      case "approval-resolved":
        return [
          { type: "approval-resolved", id: event.id },
          { type: "device-conversations" },
        ];
      case "resync":
        return [{ type: "device-conversations" }];
      default:
        return [];
    }
  }

  forget() {
    this.watched.clear();
    this.chatDevices.retire();
  }
}
