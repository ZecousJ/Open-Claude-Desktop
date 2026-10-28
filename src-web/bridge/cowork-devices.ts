import type {
  AppEvent,
  Approval,
  Conversation,
  Snapshot,
} from "../../shared/types";
import {
  devicePaths,
  type DeviceAppEvent,
  type DeviceConversation,
  type DeviceConversationSummary,
  type DeviceInfo,
  type DeviceMethod,
  type DeviceTrustState,
} from "../../shared/remote-devices";
import { parseRpcResponse, rpcError } from "../../shared/web-protocol";
import type { WebTransport } from "../../shared/web-client/transport";
import { mergeConversationTurn } from "../../src/host/events";
import { BrowserDeviceTrustClient } from "./device-trust-client";

const valueOf = (body: unknown) => {
  if (body && typeof body === "object" && "data" in body) return body.data;
  if (body && typeof body === "object" && "ok" in body) {
    const result = parseRpcResponse(200, body);
    if (!result.ok) throw rpcError(result.error);
    return result.value;
  }
  return body;
};

const approvalId = (device: string, id: string | number) =>
  `cowork-device:${device}:${JSON.stringify(id)}`;

// The bound computer owns execution; the cloud retains the task's identity.
export class CoworkDevices {
  private tasks = new Map<string, Conversation>();
  /**
   * The Code sessions computers offer through Remote Control (each online
   * computer's listCodeConversations), listed with the Laptop glyph and
   * no turns until one is shown (conversationTurns opens it on its
   * computer, and from then on it is one of `tasks`).
   */
  private listed = new Map<string, Conversation>();
  private approvals = new Map<
    string,
    { device: string; id: string | number; conversationId: string }
  >();
  private devices: DeviceInfo[] = [];
  private refreshing?: Promise<void>;
  private generation = 0;
  private pollTimer?: unknown;

  constructor(
    private transport: Pick<WebTransport, "json">,
    private emit: (event: AppEvent) => void,
    private trust?: BrowserDeviceTrustClient,
    private timers = {
      set: (callback: () => void, ms: number): unknown =>
        setTimeout(callback, ms),
      clear: (handle: unknown) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  ) {}

  private poll() {
    if (!this.trust || this.pollTimer !== undefined || !this.tasks.size) return;
    const generation = this.generation;
    const scope = this.trust.scopeKey();
    if (
      !scope ||
      ![...this.tasks.values()].some(
        (task) =>
          task.linkedComputerId &&
          !this.trust!.isRevoked(task.linkedComputerId),
      )
    )
      return;
    this.pollTimer = this.timers.set(() => {
      this.pollTimer = undefined;
      if (generation !== this.generation || scope !== this.trust?.scopeKey())
        return;
      void this.refresh().finally(() => {
        if (generation === this.generation && scope === this.trust?.scopeKey())
          this.poll();
      });
    }, 3000);
  }

  async list(): Promise<DeviceInfo[]> {
    return valueOf(
      await this.transport.json(`${devicePaths.list}?includeOffline=1`),
    ) as DeviceInfo[];
  }

  /**
   * Settings → Account's device access on the web: each online computer's
   * Require trusted devices and trusted devices, through the same verified
   * calls as everything else. Turning the requirement on and removing a
   * device reach every computer; turning it off and approving stay on the
   * computer (electron/remote-control/device-trust-store.ts remote()).
   */
  async trustState(): Promise<DeviceTrustState> {
    const online = (await this.list()).filter(
      (device) => device.online !== false,
    );
    const answers = await Promise.allSettled(
      online.map(async (device) => ({
        device,
        state: (await this.rpc(
          device.id,
          "deviceTrustSummary",
          [],
        )) as DeviceTrustState,
      })),
    );
    const read = answers.flatMap((answer) =>
      answer.status === "fulfilled" ? [answer.value] : [],
    );
    // A computer still on a version without these calls is left out; any
    // other refusal (this browser not verified yet) is what the page says.
    const failure = answers.find(
      (answer) =>
        answer.status === "rejected" &&
        (answer.reason as { code?: string } | undefined)?.code !==
          "CLAUDEX_WEB_METHOD_UNAVAILABLE",
    );
    if (!read.length && failure)
      throw (failure as PromiseRejectedResult).reason;
    return {
      requireTrustedDevices:
        read.length > 0 &&
        read.every(({ state }) => state.requireTrustedDevices),
      trusted: read.flatMap(({ device, state }) =>
        state.trusted.map((client) => ({
          ...client,
          // One row per computer that trusts it.
          id: `${device.id}:${client.id}`,
          name: `${client.name} · ${device.name}`,
        })),
      ),
      pending: [],
    };
  }

  async setTrustRequired(required: boolean): Promise<DeviceTrustState> {
    if (!required)
      throw new Error("Turn off Require trusted devices on each computer.");
    const online = (await this.list()).filter(
      (device) => device.online !== false,
    );
    await Promise.all(
      online.map((device) => this.rpc(device.id, "deviceTrustRequire", [true])),
    );
    return this.trustState();
  }

  async revokeTrusted(id: string): Promise<DeviceTrustState> {
    const at = id.indexOf(":");
    if (at <= 0) throw new Error("This trusted device no longer exists.");
    await this.rpc(id.slice(0, at), "deviceTrustRevoke", [id.slice(at + 1)]);
    return this.trustState();
  }

  private async rpc(device: string, method: DeviceMethod, args: unknown[]) {
    if (this.trust)
      return this.trust.call(
        (action, values) => this.rawRpc(device, action, values),
        device,
        method,
        args,
      );
    return this.rawRpc(device, method, args);
  }

  private async rawRpc(device: string, method: DeviceMethod, args: unknown[]) {
    return valueOf(
      await this.transport.json(devicePaths.rpc(device, method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args }),
      }),
    );
  }

  private decorate(conversation: Conversation): Conversation {
    const device = this.devices.find(
      (item) => item.id === conversation.linkedComputerId,
    );
    return {
      ...conversation,
      environment:
        this.tasks.get(conversation.id)?.environment ??
        conversation.environment,
      linkedComputerOnline: Boolean(device && device.online !== false),
      linkedComputerAccess: device?.computerAccess === true,
    };
  }

  private approval(device: string, approval: Approval): Approval {
    const id = approvalId(device, approval.id);
    this.approvals.set(id, {
      device,
      id: approval.id,
      conversationId: approval.conversationId,
    });
    return { ...approval, id };
  }

  async snapshot(snapshot: Snapshot): Promise<Snapshot> {
    if (this.pollTimer !== undefined) this.timers.clear(this.pollTimer);
    this.pollTimer = undefined;
    const generation = ++this.generation;
    this.approvals.clear();
    this.tasks = new Map(
      snapshot.conversations
        .filter((task) => task.mode === "cowork" && task.linkedToComputer)
        .map((task) => [task.id, task]),
    );
    let devices: DeviceInfo[] = [];
    try {
      devices = await this.list();
    } catch {}
    if (generation !== this.generation) return snapshot;
    this.devices = devices;
    if (!this.tasks.size) {
      const sessions = await this.sessions(snapshot.conversations);
      if (generation !== this.generation) return snapshot;
      return sessions.length
        ? {
            ...snapshot,
            conversations: [...snapshot.conversations, ...sessions],
          }
        : snapshot;
    }
    const approvals = snapshot.approvals.filter(
      (approval) => !this.tasks.has(approval.conversationId),
    );
    const conversations = await Promise.all(
      snapshot.conversations.map(async (task) => {
        if (!this.tasks.has(task.id)) return task;
        let next = this.decorate(task);
        if (next.linkedComputerOnline && next.linkedComputerId) {
          try {
            const opened = (await this.rpc(
              next.linkedComputerId,
              "openConversation",
              [task.id],
            )) as DeviceConversation;
            if (generation !== this.generation) return task;
            next = this.decorate({
              ...opened.conversation,
              linkedComputerId: task.linkedComputerId,
              linkedComputerName: task.linkedComputerName,
            });
            approvals.push(
              ...opened.approvals.map((item) =>
                this.approval(next.linkedComputerId!, item),
              ),
            );
          } catch {
            next.linkedComputerOnline = false;
          }
        }
        if (generation === this.generation) this.tasks.set(task.id, next);
        return next;
      }),
    );
    // The computers' Remote Control sessions after the linked tasks.
    const sessions =
      generation === this.generation
        ? await this.sessions(snapshot.conversations)
        : [];
    if (generation === this.generation) this.poll();
    return {
      ...snapshot,
      conversations: [...conversations, ...sessions],
      approvals,
    };
  }

  /**
   * Every online computer's Remote Control Code sessions, as conversations
   * the account's own list doesn't already hold.
   */
  private async sessions(own: Conversation[]) {
    const known = new Set(own.map((conversation) => conversation.id));
    const online = this.devices.filter((device) => device.online !== false);
    const answers = await Promise.allSettled(
      online.map(async (device) => ({
        device,
        list: (await this.rpc(
          device.id,
          "listCodeConversations",
          [],
        )) as DeviceConversationSummary[],
      })),
    );
    const listed = new Map<string, Conversation>();
    for (const answer of answers) {
      if (answer.status !== "fulfilled" || !Array.isArray(answer.value.list))
        continue;
      const { device, list } = answer.value;
      for (const summary of list) {
        if (known.has(summary.id) || listed.has(summary.id)) continue;
        const opened = this.tasks.get(summary.id);
        listed.set(
          summary.id,
          opened?.linkedComputerId === device.id
            ? { ...opened, title: summary.title, updatedAt: summary.updatedAt }
            : this.decorate({
                id: summary.id,
                title: summary.title,
                mode: "code",
                ...(summary.cwd ? { cwd: summary.cwd } : {}),
                environment: summary.environment ?? { kind: "local" },
                model: summary.model,
                providerId: "",
                pinned: false,
                archived: false,
                createdAt: summary.updatedAt,
                updatedAt: summary.updatedAt,
                turns: [],
                slim: true,
                linkedComputerId: device.id,
                linkedComputerName: device.name,
              } as Conversation),
        );
      }
    }
    this.listed = listed;
    return [...listed.values()];
  }

  /** Whether a conversation is one a computer offers (its calls go there). */
  owns(id: unknown) {
    return typeof id === "string" && this.listed.has(id);
  }

  /** A listed session's full turns, opened on its computer. */
  async turns(id: string) {
    const listed = this.listed.get(id);
    if (!listed?.linkedComputerId) throw new Error("Waiting for your computer");
    const opened = await this.open(listed);
    if (!opened) throw new Error("Waiting for your computer");
    return { turns: opened.turns, savedBranches: opened.savedBranches };
  }

  async route(method: string, args: any[], fallback: () => Promise<unknown>) {
    if (method === "approve") {
      const approval = this.approvals.get(args[0]);
      if (approval)
        return this.rpc(approval.device, "approve", [approval.id, args[1]]);
      return fallback();
    }
    const id = method === "send" ? args[0]?.conversationId : args[0];
    if (method === "conversationTurns" && this.owns(id))
      return this.turns(id as string);
    // A computer's session is not on the service: its changes go to the
    // computer, or stay in this window, never to a list that lacks it
    // ("Conversation not found").
    if (method === "updateConversation" && this.owns(id))
      return this.updateListed(this.listed.get(id as string)!, args[1]);
    if (method === "codeGitStatus" && this.owns(id))
      return {
        state: "no-folder",
        ahead: 0,
        pushed: false,
        dirty: false,
        additions: 0,
        deletions: 0,
      };
    const task =
      typeof id === "string"
        ? (this.tasks.get(id) ?? this.listed.get(id))
        : undefined;
    if (!task || (method !== "send" && method !== "interrupt"))
      return fallback();
    if (
      !task.linkedComputerId ||
      !task.linkedComputerOnline ||
      // Cowork works on the computer itself; a Code session only needs it on.
      (method === "send" &&
        task.mode === "cowork" &&
        !task.linkedComputerAccess)
    )
      throw new Error("Waiting for your computer");
    const generation = this.generation;
    const result = await this.rpc(task.linkedComputerId, method, args);
    if (generation !== this.generation) return;
    const conversation = await this.open(task);
    return method === "send" ? conversation : result;
  }

  /**
   * A model chosen for a computer's session is set there (the computer's
   * own provider for that model); anything else (read, pinned) only changes
   * this window's copy.
   */
  private async updateListed(
    task: Conversation,
    patch: Partial<Conversation> | undefined,
  ) {
    if (typeof patch?.model === "string" && patch.model !== task.model) {
      if (!task.linkedComputerId || !task.linkedComputerOnline)
        throw new Error("Waiting for your computer");
      const offered = (await this.rpc(
        task.linkedComputerId,
        "listModels",
        [],
      )) as { models?: { providerId: string; id: string }[] } | undefined;
      const choice = offered?.models?.find((item) => item.id === patch.model);
      if (!choice)
        throw new Error("This account cannot use the selected model.");
      await this.rpc(task.linkedComputerId, "setModel", [
        {
          conversationId: task.id,
          providerId: choice.providerId,
          model: choice.id,
        },
      ]);
      return (await this.open(task)) ?? task;
    }
    const { model: _model, providerId: _provider, ...rest } = patch ?? {};
    const next = { ...task, ...rest } as Conversation;
    this.listed.set(task.id, next);
    if (this.tasks.has(task.id)) this.tasks.set(task.id, next);
    this.emit({ type: "conversation", conversation: next });
    return next;
  }

  private async open(task: Conversation) {
    if (!task.linkedComputerId || !task.linkedComputerOnline) return;
    const generation = this.generation;
    const scope = this.trust?.scopeKey();
    const opened = (await this.rpc(task.linkedComputerId, "openConversation", [
      task.id,
    ])) as DeviceConversation;
    if (generation !== this.generation || scope !== this.trust?.scopeKey())
      return;
    const next = this.decorate({
      ...opened.conversation,
      linkedComputerId: task.linkedComputerId,
      linkedComputerName: task.linkedComputerName,
    });
    this.tasks.set(task.id, next);
    if (this.listed.has(task.id)) this.listed.set(task.id, next);
    this.emit({ type: "conversation", conversation: next });
    for (const [id, approval] of this.approvals) {
      if (
        approval.conversationId === task.id &&
        !opened.approvals.some((item) => item.id === approval.id)
      ) {
        this.approvals.delete(id);
        this.emit({ type: "approval-resolved", id });
      }
    }
    for (const approval of opened.approvals)
      this.emit({
        type: "approval",
        approval: this.approval(task.linkedComputerId, approval),
      });
    return next;
  }

  refresh() {
    return (this.refreshing ??= this.update().finally(() => {
      this.refreshing = undefined;
    }));
  }

  private async update() {
    const generation = this.generation;
    let devices: DeviceInfo[] = [];
    try {
      devices = await this.list();
    } catch {}
    if (generation !== this.generation) return;
    this.devices = devices;
    // The computers' Remote Control sessions, again: new ones appear,
    // ones no longer offered go (deleted, archived, switched off).
    const before = this.listed;
    const sessions = await this.sessions([]);
    if (generation !== this.generation) return;
    for (const session of sessions) {
      const previous = before.get(session.id);
      if (
        !previous ||
        previous.title !== session.title ||
        previous.updatedAt !== session.updatedAt ||
        previous.linkedComputerOnline !== session.linkedComputerOnline
      )
        this.emit({ type: "conversation", conversation: session });
    }
    // A session no longer offered leaves the list as an archived one
    // does (there is no event for a conversation that went away).
    for (const [id, gone] of before)
      if (!this.listed.has(id)) {
        this.tasks.delete(id);
        this.emit({
          type: "conversation",
          conversation: { ...gone, archived: true },
        });
      }
    if (!this.tasks.size) return;
    await Promise.all(
      [...this.tasks.values()].map(async (task) => {
        const next = this.decorate(task);
        this.tasks.set(task.id, next);
        this.emit({ type: "conversation", conversation: next });
        try {
          await this.open(next);
        } catch {
          if (generation !== this.generation) return;
          for (const [id, approval] of this.approvals)
            if (approval.device === task.linkedComputerId) {
              this.approvals.delete(id);
              this.emit({ type: "approval-resolved", id });
            }
          const offline = { ...next, linkedComputerOnline: false };
          this.tasks.set(task.id, offline);
          this.emit({ type: "conversation", conversation: offline });
        }
      }),
    );
  }

  event(event: AppEvent): boolean {
    const incoming = event as unknown as {
      type: string;
      deviceId: string;
      event: DeviceAppEvent;
    };
    if (incoming.type === "devices-changed") {
      void this.refresh();
      this.emit(event);
      return true;
    }
    if (incoming.type === "device-event") {
      // Clients with signing keys refresh through signed RPC; account-wide
      // broadcast payloads carry no device proof.
      if (this.trust) {
        void this.refresh();
        return true;
      }
      const device = incoming.deviceId;
      const inner = incoming.event;
      if (inner.type === "approval-resolved") {
        const id = approvalId(device, inner.id);
        if (this.approvals.delete(id))
          this.emit({ type: "approval-resolved", id });
        return true;
      }
      if (inner.type === "device-conversations") {
        void this.refresh();
        return true;
      }
      const id =
        inner.type === "conversation"
          ? inner.conversation.id
          : inner.type === "approval"
            ? inner.approval.conversationId
            : "conversationId" in inner
              ? inner.conversationId
              : undefined;
      const task = id ? this.tasks.get(id) : undefined;
      if (task?.linkedComputerId !== device) return true;
      if (inner.type === "conversation") {
        const next = this.decorate({
          ...inner.conversation,
          linkedComputerId: device,
          linkedComputerName: task?.linkedComputerName,
        });
        this.tasks.set(next.id, next);
        this.emit({ type: "conversation", conversation: next });
      } else if (inner.type === "approval") {
        this.emit({
          type: "approval",
          approval: this.approval(device, inner.approval),
        });
      } else if (inner.type === "conversation-turn") {
        const merged = mergeConversationTurn(task, inner);
        if (merged) {
          const next = this.decorate(merged);
          this.tasks.set(next.id, next);
          this.emit({
            ...inner,
            conversation: {
              ...inner.conversation,
              environment: next.environment,
            },
          });
        }
      } else if (inner.type !== "dispatch-notification")
        // Dispatch's banners are shown by the bridge (events.ts).
        this.emit(inner as AppEvent);
      return true;
    }
    if (event.type === "conversation" && event.conversation.linkedToComputer) {
      if (!this.tasks.has(event.conversation.id))
        this.tasks.set(event.conversation.id, event.conversation);
      this.poll();
      void this.refresh();
      return true;
    }
    if (event.type === "conversation") this.tasks.delete(event.conversation.id);
    if (
      event.type === "conversation-turn" &&
      this.tasks.has(event.conversationId)
    )
      return true;
    if (event.type === "signed-out") this.clear();
    return false;
  }

  clear() {
    this.generation++;
    if (this.pollTimer !== undefined) this.timers.clear(this.pollTimer);
    this.pollTimer = undefined;
    this.tasks.clear();
    this.listed.clear();
    this.approvals.clear();
    this.devices = [];
  }
}
