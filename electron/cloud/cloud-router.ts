import { parseInlineAttachmentDisplays, type InlineAttachmentDisplay } from "../../shared/inline-attachment-display";
import { prepareUploadReceipt, commitUploadReceipts, type UploadReceiptScope, type PendingUploadReceipt } from "./upload-receipts";
import { organizationProjectChat } from "../engine/organization-project-chat";
/**
 * Which calls go to the cloud (docs/cloud-sync.md P4). The desktop keeps
 * its own engine and store for Code sessions on a local folder; Chat, Cowork
 * and Code sessions on a GitHub repository live on the user's runner, the
 * same conversations the web version shows. The router sits in front of
 * every IPC handler (main.ts `handle`):
 *
 * - a call about a conversation goes where the conversation lives (the cloud
 *   conversations are the ones the cloud snapshot and events named);
 * - new conversations start in the cloud for Cowork, Code with a repository,
 *   and non-incognito Chat outside local and organization projects;
 * - the snapshot is the local one plus the cloud's conversations, projects
 *   and approvals; cloud events about conversations and approvals reach the
 *   window as if local. Cloud approval ids carry a prefix, so they never
 *   collide with the local engine's.
 *
 * The cloud being unreachable never blocks the local app: the snapshot then
 * holds the local part and asks again later.
 */
import type {
  AppEvent,
  Attachment,
  Conversation,
  Project,
  Snapshot,
} from "../../shared/types";
import { chatGitHubManifest } from "../../shared/chat-github";
import type { RoutineMigrationContext } from "./routine-migration-registry";
import { CloudRoutines } from "./cloud-routines";
import * as cloudRoute from "./cloud-route";
import { installMethods } from "./install-methods";
import { retryMinMs } from "./cloud-router-support";
import * as cloudRouterEvents from "./cloud-router-events";

/** What the router needs of the cloud client. */
export interface CloudCalls {
  call(method: string, args?: unknown[]): Promise<unknown>;
  snapshot(): Promise<{ snapshot: Snapshot }>;
  /** A JSON request to the service itself (its GitHub connection). */
  json?(path: string, init?: RequestInit): Promise<unknown>;
}

export interface CloudRouterDeps {
  /** The cloud client while signed in and syncing; undefined otherwise. */
  client(): CloudCalls | undefined;
  /** Sends an event to the windows. */
  push(event: AppEvent): void;
  /**
   * The bytes of an attachment this app picked (validated against the
   * main process's own list); undefined for an unknown one.
   */
  attachmentBytes(
    id: string,
  ): Promise<{ name: string; data: Uint8Array } | undefined>;
  receiptScope?(): (UploadReceiptScope & { attachment(id: string): Attachment | undefined }) | undefined;
  /** The cloud answered a snapshot (the move of local conversations may start). */
  onCloudSnapshot?(): void;
  migratedConversations?(): ReadonlySet<string> | undefined;
  device?(): { id: string; name: string };
  /** This computer's Chat permission mode (the composer's picker). */
  taskPermission?(): "default" | "auto" | "bypass" | undefined;
  routineMigration?(): RoutineMigrationContext | undefined;
  /**
   * Tasks claimed from the cloud for this computer but not yet stored here:
   * written before the claim, cleared once the task is here or released, so
   * a claim a crash interrupted is released on the next snapshot.
   */
  claims?: {
    list(): string[];
    add(id: string): void;
    remove(id: string): void;
  };
  setTimeout?(callback: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  /** Whether this computer's store holds the project (an existing local project). */
  localProject?(id: string): boolean;
}

export type Handler = (...args: any[]) => any;

const isConversation = (value: unknown): value is Conversation =>
  !!value &&
  typeof value === "object" &&
  typeof (value as Conversation).id === "string" &&
  typeof (value as Conversation).mode === "string";

export class CloudRouter {
  private uploadReceipts = new WeakMap<Attachment[], { scope: UploadReceiptScope; receipt: PendingUploadReceipt; client: CloudCalls; generation: number }[]>();
  routines: CloudRoutines;
  conversations = new Set<string>();
  /** A newly-created paired file may precede a snapshot that began earlier. */
  blankConversations = new Set<string>();
  localTasks = new Set<string>();
  projects = new Set<string>();
  retryTimer?: unknown;
  retryMs = retryMinMs;
  /** reset retires the old account; only the latest snapshot may update it. */
  snapshotGeneration = 0;
  snapshotRead = 0;
  /** The cloud's last snapshot. */
  last?: Snapshot;
  /** The next window read consumes the cache after a late response. */
  snapshotRefreshPending = false;

  constructor(public deps: CloudRouterDeps) {
    this.routines = new CloudRoutines(deps.client, deps.routineMigration);
  }

  localEvent(event: AppEvent): AppEvent {
    return event.type === "schedules"
      ? { ...event, schedules: this.routines.update(event.schedules, "local") }
      : event;
  }

  get timers() {
    return {
      set:
        this.deps.setTimeout ??
        ((cb: () => void, ms: number) => setTimeout(cb, ms)),
      clear:
        this.deps.clearTimeout ??
        ((handle: unknown) =>
          clearTimeout(handle as ReturnType<typeof setTimeout> | undefined)),
    };
  }

  /** Whether a conversation lives in the cloud. */
  isCloudConversation(id: unknown) {
    return (
      typeof id === "string" &&
      !this.localTasks.has(id) &&
      (this.conversations.has(id) || this.blankConversations.has(id))
    );
  }

  isCloudProject(id: unknown) {
    return typeof id === "string" && this.projects.has(id);
  }

  /** Signed out or sync turned off: forget what the cloud held. */
  reset() {
    this.snapshotGeneration++;
    this.uploadReceipts = new WeakMap();
    this.routines.reset();
    this.conversations.clear();
    this.blankConversations.clear();
    this.localTasks.clear();
    this.projects.clear();
    this.last = undefined;
    this.snapshotRefreshPending = false;
    this.timers.clear(this.retryTimer);
    this.retryTimer = undefined;
    this.retryMs = retryMinMs;
  }

  client() {
    const client = this.deps.client();
    if (!client)
      throw new Error(
        "This conversation is in the cloud. Check your connection and try again.",
      );
    return client;
  }

  /** A call in the cloud; remembers the conversations it answers with. */
  async cloud(method: string, args: unknown[], uploaded?: Attachment[]) {
    const client = this.client(), generation = this.snapshotGeneration;
    let value = await client.call(method, args);
    if (client !== this.deps.client() || generation !== this.snapshotGeneration)
      throw Error("The signed-in account changed. Try again.");
    if (isConversation(value)) {
      const input = args[0] as { conversationId?: string; newConversationId?: string; attachments?: Attachment[] } | undefined;
      const expected = typeof args[0] === "string" ? args[0] : input?.conversationId ?? input?.newConversationId;
      const pending = uploaded ? this.uploadReceipts.get(uploaded) ?? [] : [];
      if (uploaded) this.uploadReceipts.delete(uploaded);
      // Upload receipt failures never turn an accepted model send into a retry.
      for (const row of pending) {
        if (row.client !== client || row.generation !== generation || (expected && value.id !== expected)) continue;
        try { commitUploadReceipts(row.scope, value, [row.receipt]); }
        catch { console.warn("[upload-receipt] persistence unavailable"); }
      }
    }
    if (isConversation(value)) {
      this.conversations.add(value.id);
      value = { ...value, cloudHosted: true };
    }
    if (Array.isArray(value))
      value = value.map((item) => {
        if (!isConversation(item)) return item;
        this.conversations.add(item.id);
        return { ...item, cloudHosted: true };
      });
    if (method === "deleteConversation" || method === "discardIncognito") {
      this.conversations.delete(String(args[0]));
      this.blankConversations.delete(String(args[0]));
    }
    if (method === "deleteProject") {
      const input = args[0];
      const id = typeof input === "string" ? input :
        input && typeof input === "object" && "id" in input ? input.id : undefined;
      if (typeof id === "string") this.projects.delete(id);
    }
    if (method === "saveProject" && value && typeof value === "object")
      this.projects.add((value as Project).id);
    return value;
  }

  /**
   * A new project goes to the cloud unless it names a folder on this
   * computer (a Code project); an existing one stays where it is.
   */
  inCloudProject(project: Project) {
    if (!this.deps.client()) return false;
    if (project?.id && this.isCloudProject(project.id)) return true;
    // An existing local project stays here; without a way to tell, so does every id.
    if (project?.id && (!this.deps.localProject || this.deps.localProject(project.id))) return false;
    return !project?.cwd && (project?.kind ?? "chat") === "chat";
  }

  /** Whether a new conversation starts in the cloud. */
  private startsInCloud(input: SendInput) {
    if (!this.deps.client()) return false;
    if (input.mode === "cowork") return true;
    if (input.mode === "code") return !!input.repository;
    if (input.incognito) return false;
    return !input.projectId || this.isCloudProject(input.projectId);
  }

  async requireInlineDisplaySupport(displays: unknown) {
    if (displays === undefined || (Array.isArray(displays) && displays.length === 0)) return;
    const client = this.client(), generation = this.snapshotGeneration;
    const { snapshot } = await client.snapshot();
    if (client !== this.deps.client() || generation !== this.snapshotGeneration)
      throw Error("The signed-in account changed. Try again.");
    if (snapshot.inlineAttachmentDisplayVersion !== 1)
      throw Error("Update the Runner before sending inline attachment displays.");
  }

  remapInlineDisplays(displays: unknown, bindings: ReadonlyMap<string, Attachment>): InlineAttachmentDisplay[] | undefined {
    if (displays === undefined) return undefined;
    return parseInlineAttachmentDisplays(displays, [...bindings.keys()]).map(display => {
      const row = bindings.get(display.attachmentId)!;
      if (row.size !== undefined && row.size !== display.bytes) throw Error("The uploaded inline attachment changed.");
      return { ...display, attachmentId: row.id };
    });
  }

  async send(input: SendInput, local: Handler) {
    const projectChat = organizationProjectChat.getStore();
    if (projectChat && input?.mode === "chat" && !input.conversationId &&
        "newConversationId" in input && input.newConversationId === projectChat.conversationId)
      return local(input);
    const cloud = input?.conversationId
      ? this.isCloudConversation(input.conversationId)
      : this.startsInCloud(input);
    if (!cloud) return local(input);
    const client = this.client(), generation = this.snapshotGeneration;
    await this.requireInlineDisplaySupport(input.inlineAttachmentDisplays);
    if (client !== this.deps.client() || generation !== this.snapshotGeneration) throw Error("The signed-in account changed. Try again.");
    const bindings = new Map<string, Attachment>();
    const attachments = await this.cloudAttachments(input.attachments ?? [], false, input.inlineAttachmentDisplays === undefined ? undefined : bindings);
    if (client !== this.deps.client() || generation !== this.snapshotGeneration)
      throw Error("The signed-in account changed. Try again.");
    const next: SendInput = { ...input, attachments, inlineAttachmentDisplays: this.remapInlineDisplays(input.inlineAttachmentDisplays, bindings) };
    // The cloud runs a Chat with the permission the picker here shows.
    const permission = this.deps.taskPermission?.();
    if (input.mode !== "code" && permission && !input.taskPermission) next.taskPermission = permission;
    if (!input.conversationId) {
      // The runner gives the new conversation its own space; a folder or
      // environment of this computer means nothing there.
      delete next.cwd;
      delete next.environment;
      if (next.projectId && !this.isCloudProject(next.projectId))
        delete next.projectId;
    }
    const result = await this.cloud("send", [next], attachments);
    if (next.inlineAttachmentDisplays?.length && isConversation(result) && JSON.stringify(result.turns.at(-1)?.inlineAttachmentDisplays) !== JSON.stringify(next.inlineAttachmentDisplays))
      console.warn("[inline-display] Runner accepted the message without matching display acknowledgement.");
    return result;
  }

  /** Local attachments uploaded to the cloud, as the cloud's own rows. */
  async cloudAttachments(attachments: Attachment[], preserveExisting = false, bindings?: Map<string, Attachment>) {
    const out: Attachment[] = [];
    const receipts: { scope: UploadReceiptScope; receipt: PendingUploadReceipt; client: CloudCalls; generation: number }[] = [];
    const duplicateIds = new Set<string>();
    const client = this.client(), generation = this.snapshotGeneration, scope = this.deps.receiptScope?.();
    const check = () => { if (client !== this.deps.client() || generation !== this.snapshotGeneration || scope?.current() === false) throw Error("The signed-in account changed. Try again."); };
    const bind = (local: Attachment, remote: Attachment) => {
      if (!bindings) return;
      if (bindings.has(local.id) || [...bindings.values()].some(row => row.id === remote.id))
        throw Error("The uploaded attachment identity is ambiguous.");
      bindings.set(local.id, remote);
    };
    for (const attachment of attachments) {
      check();
      const selected = scope?.attachment(attachment.id);
      // Version APIs already accept owned remote IDs; only selected local rows
      // need uploading. Unknown IDs retain the service's existing validation.
      if (preserveExisting && !selected) { out.push(attachment); bind(attachment, attachment); continue; }
      const file = await this.deps.attachmentBytes(attachment.id);
      check();
      if (!file)
        throw new Error(
          `${attachment.name} is no longer available. Attach it again.`,
        );
      const link = chatGitHubManifest(file.data);
      if (link) {
        out.push(
          (await client.call("linkChatGitHubRepository", [
            link.repository,
            link.branch,
          ])) as Attachment,
        );
        check();
        continue;
      }
      const row = await client.call("addAttachmentData", [file.name, file.data]) as Attachment;
      check();
      if (bindings && (row.name !== file.name || row.size !== file.data.byteLength)) throw Error("The uploaded attachment changed.");
      bind(attachment, row);
      out.push(row);
      if (scope && selected) {
        try {
          const receipt = prepareUploadReceipt(scope, selected, file.data, row);
          if (duplicateIds.has(row.id) || receipts.some(item => item.receipt.rowId === row.id)) {
            duplicateIds.add(row.id);
            for (let i = receipts.length - 1; i >= 0; i--) if (receipts[i].receipt.rowId === row.id) receipts.splice(i, 1);
            throw Error("Duplicate upload receipt.");
          }
          receipts.push({ scope, receipt, client, generation });
        } catch { console.warn("[upload-receipt] source unavailable"); }
      }
    }
    this.uploadReceipts.set(out, receipts);
    return out;
  }

  async cloudAttachmentIds(ids: unknown) {
    if (!Array.isArray(ids)) return ids;
    const rows = await this.cloudAttachments(
      ids.map((id) => ({ id: String(id) }) as Attachment),
    );
    return rows.map((row) => row.id);
  }
}

export interface CloudRouter {
  recoverClaims: OmitThisParameter<typeof cloudRouterEvents.recoverClaims>;
  merge: OmitThisParameter<typeof cloudRouterEvents.merge>;
  withTimeout: typeof cloudRouterEvents.withTimeout;
  retryLater: OmitThisParameter<typeof cloudRouterEvents.retryLater>;
  cloudEvent: OmitThisParameter<typeof cloudRouterEvents.cloudEvent>;
}
installMethods(CloudRouter.prototype, cloudRouterEvents);

export interface CloudRouter {
  route: OmitThisParameter<typeof cloudRoute.route>;
}
installMethods(CloudRouter.prototype, cloudRoute);

type SendInput = Parameters<
  import("../../shared/types").CoreDesktopAPI["send"]
>[0];
