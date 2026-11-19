/**
 * This computer's device link (shared/remote-devices.ts): while a Claudex
 * account is signed in and "Control from your phone" is on, the desktop keeps
 * a WebSocket to the service so the account's phones see it online, can open
 * its Code conversations, send to them, stop them and answer their
 * approvals. Calls run through DeviceMethods; local events go out as device
 * events, a running reply's at most four times a second.
 */
import type { AppEvent, Conversation } from "../../shared/types";
import { reachable } from "./device-methods";
import { dispatchReceiptUnavailable, DispatchReceiptUnavailable } from "./dispatch-delivery";
import {
  devicePaths,
  deviceMethods,
  deviceTrustRemoteMethods,
  deviceProtocolVersion,
  type DeviceAppEvent,
  type DeviceConversation,
} from "../../shared/remote-devices";
import {
  eventsSubprotocols,
  parseTicketResponse,
  webHeaders,
} from "../../shared/web-protocol";
import type { CloudSession } from "../cloud/cloud-client";
import type { DeviceMethods } from "./device-methods";
import type { DeviceTrustStore } from "./device-trust-store";
import type { DeviceTrustEnvelope } from "../../shared/remote-devices";

/** The part of a WebSocket the link uses. */
export interface LinkSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface DeviceLinkOptions {
  /** Current account's trust authority; missing account fails closed. */
  trustStore?(): DeviceTrustStore | undefined;
  /** Persist actual relay registration/heartbeat activity, never a list read. */
  registrationObserved?(connected: boolean): void;
  statusChanged?(): void;
  onlineChanged?(): void;
  mobileNotifications?(): boolean;
  /** The Claudex service's origin; undefined while signed out. */
  baseUrl(): string | undefined;
  /** The current activation's session object; undefined during retirement. */
  session(): CloudSession | undefined;
  /** The "Control from your phone" switch. */
  enabled(): boolean;
  computerAccess?(): boolean;
  /** This computer's link id (stable, 8–64 letters, digits, - or _). */
  linkId(): string;
  /**
   * Makes this computer a new link id: another computer linked with the
   * same one (a copied data folder) and took the link.
   */
  renewLinkId?(): void;
  name(): string;
  platform: string;
  version: string;
  methods: DeviceMethods;
  fetch?: typeof fetch;
  openSocket?: (url: string, protocols: string[]) => LinkSocket;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
  log?: (message: string) => void;
}

const OPEN = 1;
const turnInterval = 250;
const listInterval = 1500;
const firstRetry = 1000;
const lastRetry = 60_000;
/** Close codes after which dialing again at once would only fail again. */
const signedOutCode = 4008;
const forbiddenCode = 4003;
const replacedCode = 4409;

type Frame = {
  t: string;
  id?: string;
  method?: string;
  args?: unknown[];
  heartbeatMs?: number;
};

type LinkTarget = { origin: string; session: CloudSession };
type LinkConnection = {
  socket: LinkSocket;
  target: LinkTarget;
  cancelled: Set<string>;
};

export class DeviceLink {
  private cause?: "sign_in" | "network" | "retry" | "update";
  private publishedStatus?: ReturnType<DeviceLink["status"]>;
  private notificationTurns = new Map<string, string>();
  status() {
    return {
      id: this.options.linkId(),
      online: this.connected,
      cause: this.cause,
    };
  }
  remoteControlStatus() {
    const capacity = this.options.methods.capacity();
    return {
      ...this.status(),
      name: this.options.name(),
      activeSessions: capacity.active,
      capacity: capacity.max,
      folders: this.options.methods.directories(),
    };
  }

  private publishStatus() {
    const next = this.status();
    const previous = this.publishedStatus;
    if (
      previous?.id === next.id &&
      previous.online === next.online &&
      previous.cause === next.cause
    )
      return;
    this.publishedStatus = next;
    if ((previous?.online ?? false) !== next.online) {
      try {
        this.options.onlineChanged?.();
      } catch {
        this.options.log?.("device link: online state observer failed");
      }
    }
    this.options.statusChanged?.();
  }

  callLocal(method: string, args: unknown[]) {
    return this.options.methods.call(method, args);
  }
  private connection?: LinkConnection;
  private target?: LinkTarget;
  private retry = firstRetry;
  private retryTimer?: unknown;
  private pingTimer?: unknown;
  private silentTimer?: unknown;
  private heartbeat = 25_000;
  private welcomed = false;
  /** When the current socket opened, for the close's log line. */
  private openedAt = 0;
  private access?: boolean;
  /** Conversation id → the latest change not sent yet. */
  private readonly pendingTurns = new Map<string, Conversation>();
  private turnTimer?: unknown;
  private listTimer?: unknown;
  private listPending = false;
  private lastList = -Infinity;
  /** Conversation id → the turn ids a phone was last sent. */
  private readonly sentTurns = new Map<string, string[]>();

  constructor(private readonly options: DeviceLinkOptions) {}

  private get timers() {
    return {
      set:
        this.options.setTimeout ??
        ((cb: () => void, ms: number) => setTimeout(cb, ms)),
      clear:
        this.options.clearTimeout ??
        ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private ownsTarget(target = this.target) {
    return (
      target !== undefined &&
      this.target === target &&
      this.options.session() === target.session
    );
  }

  private ownsConnection(connection: LinkConnection) {
    return this.connection === connection && this.ownsTarget(connection.target);
  }

  get connected() {
    return this.welcomed && this.ownsTarget();
  }

  /**
   * Connects or disconnects as the sign-in, the service and the switch say
   * (call after each of them changes).
   */
  refresh() {
    const base = this.options.baseUrl();
    const session = this.options.session();
    if (!base || !session || !this.options.enabled()) {
      this.disconnect();
      return;
    }
    const origin = new URL(base).origin;
    if (this.target?.origin === origin && this.target.session === session) {
      const access = this.options.computerAccess?.() ?? false;
      if (this.connected && access !== this.access) {
        this.access = access;
        this.write({ t: "status", computerAccess: access });
      }
      return;
    }
    this.disconnect();
    this.target = { origin, session };
    this.retry = firstRetry;
    void this.dial();
  }

  /** Signed out or switched off: closes the link and stays closed. */
  disconnect() {
    this.notificationTurns.clear();
    this.target = undefined;
    this.cause = undefined;
    if (this.retryTimer !== undefined) this.timers.clear(this.retryTimer);
    this.retryTimer = undefined;
    this.closeSocket(1000, "");
    this.options.methods.forget();
    this.sentTurns.clear();
    this.publishStatus();
  }

  private closeSocket(code: number, reason: string) {
    const socket = this.connection?.socket;
    this.connection = undefined;
    this.welcomed = false;
    for (const t of [
      this.pingTimer,
      this.silentTimer,
      this.turnTimer,
      this.listTimer,
    ])
      if (t !== undefined) this.timers.clear(t);
    this.pingTimer =
      this.silentTimer =
      this.turnTimer =
      this.listTimer =
        undefined;
    this.pendingTurns.clear();
    this.listPending = false;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(code, reason);
      } catch {
        // Already closed.
      }
    }
  }

  private scheduleRetry(ms = this.retry) {
    if (!this.ownsTarget()) return;
    if (this.retryTimer !== undefined) this.timers.clear(this.retryTimer);
    // Jitter, so a service restart is not met by every computer at once.
    const wait = Math.round(ms * (0.8 + Math.random() * 0.4));
    this.retryTimer = this.timers.set(() => {
      this.retryTimer = undefined;
      void this.dial();
    }, wait);
    this.retry = Math.min(lastRetry, this.retry * 2);
  }

  private async ticket({ origin, session }: LinkTarget, linkId: string) {
    const request = this.options.fetch ?? fetch;
    const send = async (token: string) => {
      const response = await request(
        new URL("/api/v1/claudex/mobile/events-ticket", origin),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            [webHeaders.tab]: linkId,
          },
          body: JSON.stringify({ tabId: linkId }),
        },
      );
      const body = (await response.json().catch(() => undefined)) as
        | { code?: number; data?: unknown; ok?: boolean; value?: unknown }
        | undefined;
      if (!response.ok) {
        const error = new Error(`ticket ${response.status}`) as Error & {
          status?: number;
        };
        error.status = response.status;
        throw error;
      }
      const value = body && "data" in body ? body.data : (body?.value ?? body);
      return parseTicketResponse(value).ticket;
    };
    const token = await session.currentToken();
    try {
      return await send(token);
    } catch (error) {
      if ((error as { status?: number }).status !== 401) throw error;
      return send(await session.renewed(token));
    }
  }

  private async dial() {
    const target = this.target;
    if (!target || !this.ownsTarget(target) || this.connection) return;
    const linkId = this.options.linkId();
    let ticket: string;
    try {
      ticket = await this.ticket(target, linkId);
    } catch (error) {
      if (!this.ownsTarget(target) || this.connection) return;
      const status = (error as { status?: number }).status;
      this.cause =
        status === 401
          ? "sign_in"
          : status === 426
            ? "update"
            : status
              ? "retry"
              : "network";
      this.options.log?.(`device link: no ticket (${status ?? String(error)})`);
      this.publishStatus();
      // Not allowed on the web, or signed out: try again much later.
      this.scheduleRetry(
        status === 403 || status === 401 ? lastRetry * 5 : this.retry,
      );
      return;
    }
    if (!this.ownsTarget(target) || this.connection) return;
    const url = new URL(devicePaths.link, target.origin);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    const open =
      this.options.openSocket ??
      ((u: string, p: string[]) =>
        new WebSocket(u, p) as unknown as LinkSocket);
    let socket: LinkSocket;
    try {
      socket = open(url.href, eventsSubprotocols(ticket));
    } catch {
      this.cause = "network";
      this.publishStatus();
      this.scheduleRetry();
      return;
    }
    const connection: LinkConnection = { socket, target, cancelled: new Set() };
    this.connection = connection;
    socket.onopen = () => {
      if (!this.ownsConnection(connection)) return;
      this.openedAt = Date.now();
      this.write({
        t: "hello",
        v: deviceProtocolVersion,
        deviceId: linkId,
        name: this.options.name(),
        platform: this.options.platform,
        version: this.options.version,
        methods: [...deviceMethods],
        ...this.options.methods.chatDevices.capabilities(),
        computerAccess: (this.access =
          this.options.computerAccess?.() ?? false),
      });
      this.armSilence();
    };
    socket.onmessage = (event) => {
      if (this.ownsConnection(connection)) this.receive(event.data, connection);
    };
    socket.onerror = () => {};
    socket.onclose = (event) => {
      if (this.connection !== connection) return;
      this.options.log?.(
        `device link: closed ${event.code}${event.reason ? ` ${event.reason}` : ""}` +
          (this.openedAt
            ? ` after ${Math.round((Date.now() - this.openedAt) / 1000)}s`
            : ""),
      );
      this.closeSocket(1000, "");
      if (!this.ownsTarget(target)) return;
      if (event.code === signedOutCode) {
        this.cause = "sign_in";
        this.scheduleRetry(lastRetry * 5);
      } else if (event.code === replacedCode && this.options.renewLinkId) {
        // Only another computer with this id takes a live link (this one
        // drops its own socket before dialling again): this computer takes
        // a new id and links again at once, instead of the two taking the
        // link from each other every minute.
        this.options.renewLinkId();
        this.options.log?.("device link: id in use elsewhere, made a new one");
        this.cause = undefined;
        this.retry = firstRetry;
        this.scheduleRetry(firstRetry);
      } else if (event.code === forbiddenCode || event.code === replacedCode) {
        this.cause = "retry";
        this.scheduleRetry(lastRetry);
      } else if (event.reason === "renew") {
        this.retry = firstRetry;
        this.scheduleRetry(200);
      } else {
        this.cause = "network";
        this.scheduleRetry();
      }
      this.publishStatus();
    };
  }

  private write(frame: object) {
    const socket = this.connection?.socket;
    if (!this.ownsTarget() || !socket || socket.readyState !== OPEN)
      return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** No frame for 2.5 heartbeats: the link is dead; dial again. */
  private armSilence() {
    if (this.silentTimer !== undefined) this.timers.clear(this.silentTimer);
    this.silentTimer = this.timers.set(() => {
      this.silentTimer = undefined;
      this.options.log?.(
        `device link: silent for ${Math.round(this.heartbeat * 2.5) / 1000}s`,
      );
      this.closeSocket(4000, "silent");
      this.cause = "network";
      this.publishStatus();
      this.scheduleRetry();
    }, this.heartbeat * 2.5);
  }

  private ping() {
    if (this.pingTimer !== undefined) this.timers.clear(this.pingTimer);
    this.pingTimer = this.timers.set(() => {
      this.pingTimer = undefined;
      if (this.write({ t: "ping" })) this.ping();
    }, this.heartbeat);
  }

  private receive(data: unknown, connection: LinkConnection) {
    if (typeof data !== "string") return;
    let frame: Frame;
    try {
      frame = JSON.parse(data) as Frame;
    } catch {
      return;
    }
    this.armSilence();
    switch (frame.t) {
      case "welcome":
        this.cause = undefined;
        this.welcomed = true;
        this.options.registrationObserved?.(true);
        this.publishStatus();
        this.retry = firstRetry;
        if (typeof frame.heartbeatMs === "number" && frame.heartbeatMs >= 1000)
          this.heartbeat = frame.heartbeatMs;
        this.ping();
        this.armSilence();
        return;
      case "ping":
        this.options.registrationObserved?.(false);
        this.write({ t: "pong" });
        return;
      case "pong":
        this.options.registrationObserved?.(false);
        return;
      case "call":
        if (typeof frame.id === "string" && typeof frame.method === "string")
          void this.answer(
            connection,
            frame.id,
            frame.method,
            Array.isArray(frame.args) ? frame.args : [],
          );
        return;
      case "cancel":
        if (typeof frame.id === "string") connection.cancelled.add(frame.id);
        return;
      default:
        return;
    }
  }

  private async answer(
    connection: LinkConnection,
    id: string,
    method: string,
    args: unknown[],
  ) {
    const trust = this.options.trustStore?.();
    const current = () =>
      this.ownsConnection(connection) && this.options.trustStore?.() === trust;
    try {
      if (this.options.trustStore && !trust)
        throw new Error("Sign in to Claudex again.");
      if (method === "deviceTrustChallenge" || method === "deviceTrustEnroll") {
        if (!trust) throw new Error("Device verification is unavailable.");
        if (args.length !== 1)
          throw new Error("Invalid device verification request.");
        const value =
          method === "deviceTrustChallenge"
            ? trust.challenge(args[0])
            : trust.enroll(args[0] as DeviceTrustEnvelope);
        this.write({ t: "result", id, ok: true, value });
        return;
      }
      if (trust) args = trust.authorize(method, args);
      if ((deviceTrustRemoteMethods as readonly string[]).includes(method)) {
        if (!trust) throw new Error("Device verification is unavailable.");
        this.write({
          t: "result",
          id,
          ok: true,
          value: trust.remote(method, args),
        });
        return;
      }
      const accessRevision = trust?.accessRevision;
      const deliveryCurrent = method === "deliverDispatch" || method === "officialCode"
        ? () => this.options.session() === connection.target.session &&
          this.options.trustStore?.() === trust && trust?.accessRevision === accessRevision
        : undefined;
      const value = deliveryCurrent
        ? await this.options.methods.call(method, args, deliveryCurrent)
        : await this.options.methods.call(method, args);
      if (!current()) return;
      if (accessRevision !== trust?.accessRevision)
        throw new Error("Device access changed. Verify this device again.");
      if (method === "openConversation") {
        const opened = value as DeviceConversation;
        this.sentTurns.set(
          opened.conversation.id,
          opened.conversation.turns.map((t) => t.id),
        );
      }
      if (connection.cancelled.delete(id)) return;
      this.write({ t: "result", id, ok: true, value: value ?? null });
    } catch (error) {
      if (!current()) return;
      if (connection.cancelled.delete(id)) return;
      const message =
        error instanceof Error && error.message
          ? error.message
          : "The computer couldn't do that.";
      const code = error instanceof DispatchReceiptUnavailable ? dispatchReceiptUnavailable : undefined;
      this.write({ t: "result", id, ok: false, error: { message, ...(code ? { code } : {}) } });
    }
  }

  /** A local event (main.ts push): what phones should know goes out. */
  observe(event: AppEvent) {
    if (!this.connected) return;
    if (event.type === "conversation" && reachable(event.conversation)) {
      const conversation = event.conversation;
      const turn = conversation.turns.at(-1);
      const previous = this.notificationTurns.get(conversation.id);
      if (turn)
        this.notificationTurns.set(
          conversation.id,
          `${turn.id}:${turn.status}`,
        );
      if (
        this.options.mobileNotifications?.() &&
        this.options.methods.notificationConversation(conversation.id) &&
        turn &&
        previous === `${turn.id}:inProgress` &&
        turn.status !== "inProgress"
      )
        this.send({
          type: "dispatch-notification",
          conversationId: conversation.id,
          title: conversation.title || "Claudex",
          body: "Claudex finished a task",
          tag: `dispatch-${conversation.id}-${turn.id}`,
        });
    }
    if (event.type === "approval" && this.options.mobileNotifications?.()) {
      const conversation = this.options.methods.notificationConversation(
        event.approval.conversationId,
      );
      if (conversation)
        this.send({
          type: "dispatch-notification",
          conversationId: conversation.id,
          title: conversation.title || "Claudex",
          body: "Claudex is waiting for your input",
          tag: `dispatch-permission-${event.approval.id}`,
        });
    }
    for (const out of this.options.methods.eventsFor(event)) {
      if (out.type === "device-conversations") this.listChanged();
      else if (out.type === "conversation") this.turnChanged(out.conversation);
      else {
        // Approvals keep their place after the turn that asked.
        this.flushTurns();
        this.send(out);
      }
    }
  }

  private send(event: DeviceAppEvent) {
    // Account-wide relay broadcasts have no per-client proof. Protected
    // hosts expose data only in replies to signed calls, never on that bus.
    const trust = this.options.trustStore?.();
    if (
      this.options.trustStore &&
      (!trust || trust.state().requireTrustedDevices)
    )
      return;
    this.write({ t: "event", event });
  }

  private listChanged() {
    const wait = this.lastList + listInterval - this.now();
    if (wait <= 0 && this.listTimer === undefined) {
      this.lastList = this.now();
      this.send({ type: "device-conversations" });
      return;
    }
    this.listPending = true;
    if (this.listTimer !== undefined) return;
    this.listTimer = this.timers.set(
      () => {
        this.listTimer = undefined;
        if (!this.listPending) return;
        this.listPending = false;
        this.lastList = this.now();
        this.send({ type: "device-conversations" });
      },
      Math.max(0, wait),
    );
  }

  private turnChanged(conversation: Conversation) {
    this.pendingTurns.set(conversation.id, conversation);
    if (this.turnTimer !== undefined) return;
    this.turnTimer = this.timers.set(() => {
      this.turnTimer = undefined;
      this.flushTurns();
    }, turnInterval);
  }

  /**
   * Sends the latest state of each changed conversation: only its last turn
   * when the turns before it are the ones the phone has, else all of it.
   */
  private flushTurns() {
    if (this.turnTimer !== undefined) this.timers.clear(this.turnTimer);
    this.turnTimer = undefined;
    for (const conversation of this.pendingTurns.values()) {
      const ids = conversation.turns.map((t) => t.id);
      const sent = this.sentTurns.get(conversation.id);
      const last = conversation.turns.at(-1);
      const sameBefore =
        sent !== undefined &&
        last !== undefined &&
        ids.length >= 1 &&
        (ids.length === sent.length || ids.length === sent.length + 1) &&
        ids.slice(0, ids.length - 1).every((id, i) => id === sent[i]);
      if (sameBefore && last) {
        const { id: _id, turns: _turns, ...rest } = conversation;
        this.send({
          type: "conversation-turn",
          conversationId: conversation.id,
          turn: last,
          conversation: rest,
        });
      } else {
        this.send({ type: "conversation", conversation });
      }
      this.sentTurns.set(conversation.id, ids);
    }
    this.pendingTurns.clear();
  }
}
