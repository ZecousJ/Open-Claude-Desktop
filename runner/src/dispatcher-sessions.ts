import {
  officialCodeFollowupSend,
  type OfficialCodeFollowupSend,
} from "../../electron/ipc/conversation-turn-handlers";
import { randomUUID } from "node:crypto";
import { officialCoworkFollowupEvent } from "../../electron/engine/official-cowork-send";
import { desktopAttachmentObject } from "../../shared/attachment-object";
import { CodeSendStart, officialCodeSendStart } from "../../electron/engine/code-send-start";
import { decodeWireValue } from "../../shared/web-wire";
import { knowledgeFileLimit } from "../../shared/collections-api";
import { webErrorCodes } from "../../shared/web-protocol";
import { notAvailableOnWeb } from "../../shared/web-bridge-methods";
import type { IpcHandle } from "../../electron/app/app-context";
import { webCallScope } from "./electron-shim";
import {
  guardCall,
  runnerMethods,
  sanitizeResult,
  webArguments,
} from "./method-guard";
import {
  hasUploads,
  publishAttachmentObject,
  readUpload,
  resolveUploads,
  uploadRef,
} from "./attachments";
import { previewDocumentMethod, previewOwner } from "./previews";
import { registerWebHandlers, WebAppContext, type WebAccountSettings } from "./web-app-context";
import { browserNotificationSettings } from "../../shared/official-notification-preferences";
import { stageSession } from "./session-stage";
import type { AccountWake } from "./routine-wakes";
import {
  routineTriggerIdPattern,
  type RoutineEventFields,
} from "../../shared/routine-triggers";
import { engineStartingMethods, isOrganizationPluginMethod, type OrganizationPluginMethod } from "./dispatcher-support";
import { CapacityError } from "./dispatcher-support";
import { officialUiRead } from "./official-ui-read";
import { configureMelangeEngineReservation } from "../../electron/memory/melange-host";
import { closeOfficialMelangeEdits } from "./official-melange-edit";
import { reconcileOfficialCodeTerminals } from "./official-code-terminals";
import { verifyDocumentPreviewTokenMethod } from "../../shared/official-ui-web";
import { verifyOfficialDocumentPreviewToken } from "./official-document-preview";
import { codePreviewLeaseMethod, codePreviewRequestMethod } from "../../shared/official-code-preview";
import { officialCodePreviewLease, officialCodePreviewRequest } from "./official-code-preview";
import type { Dispatcher } from "./dispatcher";
import type { CallFrame } from "./dispatcher";
import { officialSkillAuthoring } from "../../electron/skills/skill-folder";
import { nativeSendInput, sendWithNativeReceipt } from "./native-send-receipts";
import { nativeCodeQueue, nativeCodeQueueMethods } from "./official-code-followup";
import { spendLimitAmount, writeSpendLimitSource } from "../../electron/account/spend-limit-read";
import { billingError } from "../../electron/account/billing-payments";

// ---- Internals

interface ExpectedSession {
  context: WebAppContext;
  identity: unknown;
  codeFollowup?: OfficialCodeFollowupSend;
  coworkFollowup?: { conversationId: string; eventId: string; current(): boolean };
  coworkCreation?: { conversationId: string; current(): boolean };
  coworkDelete?: { conversationId: string; current(): boolean };
  officialInventory?: boolean;
  assertMemoryCurrent?(): void;
  officialRoutine?: true;
  officialSkillAuthoring?: boolean;
  officialChatLeaf?: true;
  officialChatFork?: true;
  officialConnectorProbe?: true;
  officialConnectorLifecycle?: { method: "refreshConnectorTools" | "removeConnector"; assertCurrent(): void };
  officialSkillUpload?: boolean;
  organizationPlugin?: { method: OrganizationPluginMethod; assertCurrent(): void };
}

export async function run(
  this: Dispatcher,
  frame: CallFrame,
  expected?: ExpectedSession,
): Promise<unknown> {
  frame.signal?.throwIfAborted();
  const userId = frame.user.id;
  if (frame.method === previewDocumentMethod)
    return this.previewDocument(frame);
  if (frame.method === verifyDocumentPreviewTokenMethod)
    return verifyOfficialDocumentPreviewToken(this, userId, frame.args?.[0]);
  if (frame.method === codePreviewLeaseMethod)
    return officialCodePreviewLease(this, frame);
  if (frame.method === codePreviewRequestMethod)
    return officialCodePreviewRequest(this, frame);
  if (frame.method === fireRoutineMethod) return this.fireRoutine(frame);
  if (frame.method === "officialUiRead" || frame.method === "officialUiAction") return officialUiRead(this, frame);
  const codeQueue = nativeCodeQueueMethods.includes(frame.method);
  const routine = expected?.officialRoutine && (frame.method === "officialCodeRoutineRun" || frame.method === "officialCodeRoutineCancel");
  const chatLeaf = expected?.officialChatLeaf && frame.method === "selectChatLeaf";
  const chatFork = expected?.officialChatFork && frame.method === "forkConversation";
  const connectorProbe = expected?.officialConnectorProbe && frame.method === "probeConnector";
  const connectorLifecycle = expected?.officialConnectorLifecycle?.method === frame.method
    ? expected.officialConnectorLifecycle : undefined;
  const organizationPlugin = expected?.organizationPlugin?.method === frame.method;
  if (!organizationPlugin && !routine && !chatLeaf && !chatFork && !connectorProbe && !connectorLifecycle && ((!codeQueue && !runnerMethods.has(frame.method)) || !this.methods.includes(frame.method)))
    throw Object.assign(new Error(notAvailableOnWeb), {
      code: webErrorCodes.methodUnavailable,
    });
  if (expected && (this.context(userId) !== expected.context || expected.context.signedOut || expected.context.officialSessionIdentity() !== expected.identity))
    throw new Error("The account changed during this request.");
  const ctx = frame.method === "clientPolicy" || frame.method === "voiceAvailability"
    ? await this.shellContextFor(frame)
    : await this.contextFor(frame);
  if (expected && (ctx !== expected.context || ctx.signedOut || ctx.officialSessionIdentity() !== expected.identity))
    throw new Error("The account changed during this request.");
  ctx.reclaimCaches?.();
  if (!expected) { ctx.setAccessToken(frame.user.accessToken); ctx.signedOut = false; }
  ctx.lastActive = this.now();
  let args = (decodeWireValue(frame.args) as unknown[]) ?? [];
  const objectTransfer = !expected && args.at(-1) === desktopAttachmentObject &&
    (frame.method === "turnAttachment" && args.length === 3 ||
      frame.method === "readGeneratedFile" && args.length === 2);
  if (objectTransfer) args = args.slice(0, -1);
  if (codeQueue) return nativeCodeQueue(this, frame, ctx, args);
  if (frame.method === "setSpendLimit") {
    if (args.length !== 1) throw Error("Invalid spend-limit request.");
    const limitUsd = spendLimitAmount.parse(args[0]);
    const backend = ctx.remote?.backend;
    const owner = ctx.activeAccount?.id;
    const identity = ctx.officialSessionIdentity();
    const current = () => !!owner && ctx.activeAccount?.id === owner && ctx.remote?.backend === backend &&
      ctx.officialSessionIdentity() === identity && !ctx.accountRetiring &&
      this.context(userId) === ctx && !frame.signal?.aborted;
    if (!backend || !current()) throw Error("The account changed while saving its spend limit.");
    try {
      const saved = await writeSpendLimitSource({ baseUrl: backend.accounts.baseUrl, fetch: ctx.runtime.fetch,
        token: frame.user.accessToken, limitUsd });
      if (!current()) throw Error("The account changed while saving its spend limit.");
      return saved;
    } catch (error) {
      throw billingError(error);
    }
  }
  const file = args[1];
  let assertTextWriteCurrent: (() => void) | undefined;
  if (
    frame.method === "addProjectKnowledgeText" &&
    file &&
    typeof file === "object" &&
    "text" in file
  ) {
    const id = uploadRef(file.text);
    if (id !== undefined) {
      const identity = ctx.officialSessionIdentity();
      const assertCurrent = () => {
        if (this.isCallCancelled(frame.id))
          throw new Error("The upload was cancelled.");
        if (
          ctx.accountRetiring ||
          this.context(userId) !== ctx ||
          ctx.officialSessionIdentity() !== identity
        )
          throw new Error("The account changed during this request.");
      };
      assertTextWriteCurrent = assertCurrent;
      const bytes = await readUpload(
        {
          request: (op, user, body) => {
            assertCurrent();
            return this.options.link.request(op, user, body);
          },
        },
        userId,
        id,
        knowledgeFileLimit,
      );
      args[1] = {
        ...file,
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      };
    }
  }
  if (hasUploads(args))
    args = await resolveUploads(args, (id, maxBytes) =>
      readUpload(
        {
          request: (op, user, body) =>
            this.options.link.request(op, user, body),
        },
        userId,
        id,
        maxBytes,
      ),
    );
  args = webArguments(frame.method, args, (id) => {
    try {
      return ctx.store.conversation(id).cwd;
    } catch {
      return undefined;
    }
  });
  if (!organizationPlugin && !routine && !chatLeaf && !chatFork && !connectorProbe && connectorLifecycle?.method !== "refreshConnectorTools") guardCall(frame.method, expected?.officialSkillUpload && frame.method === "installSkillFiles" ? args.slice(0, 1) : args, this.guard);
  const handler = ctx.handlers.get(frame.method);
  if (!handler)
    throw Object.assign(new Error(notAvailableOnWeb), {
      code: webErrorCodes.methodUnavailable,
    });
  const send = args[0];
  if (!expected && frame.method === "send" && send && typeof send === "object" && "clientRequestId" in send) {
    return sendWithNativeReceipt(ctx, nativeSendInput.parse(send), input =>
      dispatchSession.call(this, { ctx, frame, args: input, handler, assertTextWriteCurrent }));
  }
  if (!objectTransfer)
    return dispatchSession.call(this, { ctx, frame, args, handler, expected, assertTextWriteCurrent });
  const identity = ctx.officialSessionIdentity();
  const value = await dispatchSession.call(this, { ctx, frame, args, handler, expected, assertTextWriteCurrent });
  const current = () => this.context(userId) === ctx && ctx.officialSessionIdentity() === identity &&
    !ctx.accountRetiring && !ctx.signedOut && !frame.signal?.aborted;
  if (!current()) throw Error("The account changed during this request.");
  let data: { name: string; mime: string; bytes: Uint8Array } | undefined;
  if (frame.method === "readGeneratedFile" && typeof value === "string") {
    data = { name: "generated-file", mime: "application/octet-stream", bytes: Buffer.from(value, "base64") };
  } else if (frame.method === "turnAttachment" && typeof args[0] === "string" &&
      value && typeof value === "object" && "name" in value && typeof value.name === "string" &&
      "mime" in value && typeof value.mime === "string" && "data" in value && value.data instanceof Uint8Array) {
    const conversation = ctx.store.conversations.find(({ id }) => id === args[0]);
    if (conversation && !conversation.incognito)
      data = { name: value.name, mime: value.mime, bytes: value.data };
  }
  if (!data || data.bytes.byteLength === 0) return value;
  const attachmentObject = await publishAttachmentObject(this.options.link, userId, data, frame.signal).catch(() => undefined);
  if (!current()) throw Error("The account changed during this request.");
  return attachmentObject ? { name: data.name, mime: data.mime, attachmentObject } : value;
}

async function dispatchSession(
  this: Dispatcher,
  { ctx, frame, args, handler, expected, assertTextWriteCurrent }: {
    ctx: WebAppContext;
    frame: CallFrame;
    args: unknown[];
    handler: NonNullable<ReturnType<WebAppContext["handlers"]["get"]>>;
    expected?: ExpectedSession;
    assertTextWriteCurrent?: () => void;
  },
) {
  const userId = frame.user.id;
  const routine = expected?.officialRoutine && (frame.method === "officialCodeRoutineRun" || frame.method === "officialCodeRoutineCancel");
  const connectorLifecycle = expected?.officialConnectorLifecycle?.method === frame.method
    ? expected.officialConnectorLifecycle : undefined;
  const needsSlot =
    (engineStartingMethods.has(frame.method) || expected?.organizationPlugin || routine && frame.method === "officialCodeRoutineRun") && !ctx.engineRunning();
  frame.signal?.throwIfAborted();
  const releaseEngine = needsSlot ? await this.engineSlot(ctx) : undefined;
  let session: string | undefined;
  let goSlot = !expected && ["send", "retryResponse", "editPrompt", "compactConversation"].includes(frame.method);
  try {
    // A new conversation gets its own space, and a new Code session its
    // folder there (and its repository).
    [args, session] = await this.newSession(ctx, frame.method, args);
    if (expected?.coworkCreation) {
      const input = args[0] as { newConversationId?: string; mode?: string };
      if (frame.method !== "send" || input?.mode !== "cowork" ||
          input.newConversationId !== expected.coworkCreation.conversationId ||
          !expected.coworkCreation.current())
        throw Error("The Cloud Cowork account changed before dispatch.");
    }
    if (expected?.coworkFollowup) {
      const input = args[0] as { conversationId?: string; mode?: string };
      if (frame.method !== "send" || input?.mode !== "cowork" ||
          input.conversationId !== expected.coworkFollowup.conversationId ||
          !expected.coworkFollowup.current())
        throw Error("The Cloud Cowork session changed before dispatch.");
      args[1] = {
        ...(args[1] as object | undefined),
        [officialCoworkFollowupEvent]: expected.coworkFollowup.eventId,
      };
    }
    if (expected?.codeFollowup) {
      const code = expected.codeFollowup;
      const input = args[0] as { conversationId?: string };
      if (
        frame.method !== "send" ||
        input?.conversationId !== code.conversation.id ||
        !ctx.store.conversations.includes(code.conversation) ||
        ctx.signedOut ||
        ctx.officialSessionIdentity() !== expected.identity
      )
        throw Error("The Cloud Code session changed before dispatch.");
      args[1] = {
        ...(args[1] as object | undefined),
        [officialCodeFollowupSend]: code,
      };
    }
    if (frame.method === "compactConversation") {
      if (!this.guard.modes.includes("code") || typeof args[0] !== "string" || args.length !== 1)
        throw Error("Cloud Code compaction is unavailable for this request.");
      const store = ctx.store;
      const id = args[0];
      const conversation = store.conversation(id);
      const owner = ctx.activeAccount?.id;
      const identity = ctx.officialSessionIdentity();
      const createdAt = conversation.createdAt;
      const current = () =>
        !!owner && ctx.activeAccount?.id === owner && ctx.accountRetiring === false &&
        ctx.store === store && ctx.officialSessionIdentity() === identity && this.context(userId) === ctx &&
        conversation.id === id && conversation.createdAt === createdAt &&
        store.conversations.includes(conversation) &&
        conversation.mode === "code" && !conversation.incognito && !conversation.archived &&
        !conversation.cloudHosted && !conversation.linkedToComputer && !conversation.chatDeviceBinding &&
        conversation.environment?.kind !== "ssh" && conversation.worktree?.state !== "deleted" &&
        (!conversation.sessionAuthors || (conversation.sessionAuthors.ownerAccountUuid === owner &&
          conversation.sessionAuthors.viewerAccountUuid === owner));
      if (!current())
        throw Error("The Cloud Code session changed before compaction.");
      args[1] = randomUUID();
      args[2] = { [officialCodeSendStart]: new CodeSendStart() };
    }
    assertTextWriteCurrent?.();
    if (frame.method === "saveSkill" && expected?.officialSkillAuthoring) {
      if (this.context(userId) !== ctx || ctx.accountRetiring || ctx.officialSessionIdentity() !== expected.identity)
        throw Error("The account changed during this request.");
      args = [args[0], officialSkillAuthoring];
    }
    if (expected && (expected.officialSkillUpload || frame.method === "deleteSkill" || frame.method === "setSkillEnabled" || frame.method === "duplicateSkill" || frame.method === "renameSkill") &&
        (this.context(userId) !== ctx || ctx.accountRetiring || ctx.officialSessionIdentity() !== expected.identity))
      throw Error("The account changed during this request.");
    const value = await webCallScope.run(
      {
        userId,
        tabId: frame.user.tabId,
        consumeGoRunSlot: () => {
          const reserved = goSlot;
          goSlot = false;
          return reserved;
        },
        openUrl: (url) => this.options.openUrl(userId, url, frame.user.tabId),
      },
      () => {
        if (expected?.coworkCreation && !expected.coworkCreation.current())
          throw Error("The account or project changed before starting Cowork.");
        const deletion = expected?.coworkDelete;
        if (deletion && (frame.method !== "deleteConversation" || args.length !== 1 ||
            args[0] !== deletion.conversationId || !deletion.current()))
          throw Error("The Cloud Cowork session changed before deletion.");
        connectorLifecycle?.assertCurrent();
        expected?.organizationPlugin?.assertCurrent();
        expected?.assertMemoryCurrent?.();
        if (frame.method === "synthesizeMemory") {
          frame.signal?.throwIfAborted();
          return handler(args[0], frame.signal);
        }
        return handler(...args, ...(connectorLifecycle ? [connectorLifecycle.assertCurrent] : []));
      },
    );
    expected?.organizationPlugin?.assertCurrent();
    if (expected && (ctx.signedOut || ctx.officialSessionIdentity() !== expected.identity)) throw new Error("The account changed during this request.");
    return sanitizeResult(frame.method, value, expected?.officialInventory);
  } catch (error) {
    if (session) ctx.discardCodeSession(session);
    throw error;
  } finally {
    goSlot = false;
    if (frame.method === "deleteConversation" || frame.method === "updateConversation")
      await reconcileOfficialCodeTerminals(ctx);
    releaseEngine?.();
    ctx.lastActive = this.now();
  }
}

/**
 * `send` of a new conversation (docs/cloud-sync.md): it runs in an
 * isolated space of its own, one per Chat or Cowork conversation and per
 * GitHub repository (sessions of one repository share it; a Code session
 * without one gets its own). A new Code session's folder, made by the
 * runtime's `prepareWorkspace` hook in that space, replaces the (absent)
 * `cwd`; `repository` and `repositories` (a session with several, the
 * main one first) are for the hook only and do not reach the handler,
 * which gets the clone as a setup hook to run in the session's first turn
 * (shared/session-setup.ts). Returns the arguments and the new folder.
 */
export async function newSession(
  this: Dispatcher,
  ctx: WebAppContext,
  method: string,
  args: unknown[],
): Promise<[unknown[], string | undefined]> {
  if (method !== "send") return [args, undefined];
  const input = args[0];
  if (!input || typeof input !== "object" || Array.isArray(input))
    return [args, undefined];
  // Only `input` comes from the browser; the second argument is the
  // runner's own (a session's setup), never the browser's.
  const { repository, repositories, ...rest } = input as Record<
    string,
    unknown
  >;
  if (rest.conversationId)
    return [[rest, ...this.resumedSetup(ctx, rest.conversationId)], undefined];
  return stageSession(ctx, rest, { repository, repositories });
}

/**
 * A later message of a session whose start did not finish: its
 * repository is fetched again first (`pendingSetup`).
 */
export function resumedSetup(
  this: Dispatcher,
  ctx: WebAppContext,
  id: unknown,
): unknown[] {
  if (typeof id !== "string") return [];
  let conversation;
  try {
    conversation = ctx.store.conversation(id);
  } catch {
    return [];
  }
  const repositories = conversation.pendingSetup;
  if (
    conversation.mode !== "code" ||
    !conversation.cwd ||
    (!repositories && !conversation.pendingSetupScript)
  )
    return [];
  const fetch = repositories?.length
    ? ctx.refetchCodeSession(conversation.cwd, repositories)
    : async () => {};
  return fetch
    ? [
        {
          setup: {
            repositories: repositories ?? [],
            fetch,
            setupScript: conversation.pendingSetupScript,
          },
        },
      ]
    : [];
}

/** The runner-internal call Go makes when a task's fire address is called
 * with its token, or a GitHub event it watches arrives (signature checked):
 * the user's context opens on the short-lived token Go passes and the
 * task's trigger starts it (shared/routine-triggers.ts). */
export const fireRoutineMethod = "fireRoutineTrigger";

export async function fireRoutine(this: Dispatcher, frame: CallFrame) {
  const [triggerId, kind, text, event] =
    (decodeWireValue(frame.args) as unknown[]) ?? [];
  const named = event as { name?: unknown; fields?: unknown } | undefined;
  if (
    typeof triggerId !== "string" ||
    !routineTriggerIdPattern.test(triggerId) ||
    (kind !== "api" && kind !== "github") ||
    (text !== undefined &&
      (typeof text !== "string" || text.length > 65_536)) ||
    (kind === "github" &&
      (typeof named?.name !== "string" ||
        !named.fields ||
        typeof named.fields !== "object"))
  )
    throw new Error("The request was not valid.");
  if (this.draining)
    throw Object.assign(
      new Error("Claudex is restarting. Try again in a moment."),
      { code: webErrorCodes.runnerUnavailable },
    );
  const ctx = await this.contextFor(frame);
  ctx.setAccessToken(frame.user.accessToken);
  ctx.lastActive = this.now();
  if (!ctx.scheduler) throw new Error("Scheduled tasks aren't available.");
  const task = await ctx.scheduler.fireTrigger(
    triggerId,
    kind,
    text as string | undefined,
    kind === "github"
      ? {
          name: named!.name as string,
          fields: named!.fields as RoutineEventFields,
        }
      : undefined,
  );
  return task
    ? { scheduledTaskId: task.id, conversationId: task.conversationId }
    : { skipped: true };
}

export function previewDocument(this: Dispatcher, frame: CallFrame) {
  const [id] = decodeWireValue(frame.args) as unknown[];
  if (typeof id !== "string" || previewOwner(id) !== frame.user.id)
    throw new Error("Preview unavailable");
  const doc = this.contexts.get(frame.user.id)?.artifactPreviews.document(id);
  if (!doc) throw new Error("Preview unavailable");
  return doc;
}

/**
 * Account work is due and no page of the user is calling: asks Go
 * for a short-lived token of the user (routine.token, which only an active
 * user the web app admits gets), opens the context on it and lets its
 * scheduler start what is due. The context then stays while a turn runs.
 */
export async function wakeUser(
  this: Dispatcher,
  userId: number,
  due: AccountWake = { routine: true, codeArchive: false },
) {
  if (this.draining) return;
  const activation = this.context(userId)?.officialSessionIdentity();
  const grant = (await this.options.link.request(
    "routine.token",
    userId,
    {},
  )) as { accessToken?: unknown } | undefined;
  const accessToken = grant?.accessToken;
  if (typeof accessToken !== "string" || !accessToken)
    throw new Error("The service gave no token for the scheduled task.");
  const ctx = await this.contextFor({ user: { id: userId, accessToken } });
  if (ctx.signedOut || (activation && ctx.officialSessionIdentity() !== activation))
    return;
  ctx.setAccessToken(accessToken);
  if (due.routine) ctx.lastActive = this.now();
  await Promise.all([
    due.routine && ctx.scheduler?.tick(),
    due.codeArchive && ctx.codeAutoArchive?.check(),
  ]);
}

type ContextRequest = { user: { id: number; accessToken: string } };
type ReadAccountSettings = (accessToken: string) => WebAccountSettings | undefined;

function sessionEnded() {
  return Object.assign(new Error("The session has ended."), { code: webErrorCodes.badRequest });
}

export interface OpeningContext {
  readonly context: Promise<WebAppContext>;
  readonly shell: Promise<WebAppContext>;
  readonly shellContext: WebAppContext | undefined;
  readonly accountSettings: Promise<ReadAccountSettings>;
  retire(): void;
}

type OpeningAccount =
  | { kind: "loading" }
  | { kind: "metadata"; account: WebAccountSettings }
  | { kind: "shell"; context: WebAppContext; read: ReadAccountSettings }
  | { kind: "open"; read: ReadAccountSettings }
  | { kind: "retired" };

function liveAccountSettings(dispatcher: Dispatcher, ctx: WebAppContext): ReadAccountSettings {
  const accountId = ctx.activeAccount?.id;
  const activation = ctx.officialSessionIdentity();
  return (accessToken) => {
    if (!accountId || ctx.activeAccount?.id !== accountId ||
        !dispatcher.isShellContextCurrent(ctx) || ctx.officialSessionIdentity() !== activation)
      return;
    ctx.reclaimCaches?.();
    ctx.setAccessToken(accessToken);
    ctx.lastActive = dispatcher.now();
    return { accountId, settings: browserNotificationSettings(ctx.store.settings) };
  };
}

/** The user's context, opened once (concurrent first calls share it). */
export async function contextFor(this: Dispatcher, frame: ContextRequest): Promise<WebAppContext> {
  const existing = this.contexts.get(frame.user.id);
  if (existing && !existing.closed) return existing;
  return openingFor(this, frame).context;
}

export async function shellContextFor(this: Dispatcher, frame: ContextRequest): Promise<WebAppContext> {
  const existing = this.contexts.get(frame.user.id);
  const ctx = existing && !existing.closed ? existing : await openingFor(this, frame).shell;
  if (!this.isShellContextCurrent(ctx)) throw sessionEnded();
  return ctx;
}

export function isShellContextCurrent(this: Dispatcher, ctx: WebAppContext) {
  return !ctx.closed && !ctx.closedFlag && !ctx.signedOut && !ctx.accountRetiring && (
    this.contexts.get(ctx.userId) === ctx ||
    this.opening.get(ctx.userId)?.shellContext === ctx
  );
}

export async function accountSettingsFor(
  this: Dispatcher,
  frame: ContextRequest,
): Promise<ReadAccountSettings> {
  const existing = this.contexts.get(frame.user.id);
  if (existing && !existing.closed) return liveAccountSettings(this, existing);
  return openingFor(this, frame).accountSettings;
}

function openingFor(dispatcher: Dispatcher, frame: ContextRequest): OpeningContext {
  const userId = frame.user.id;
  const opening = dispatcher.opening.get(userId);
  if (opening) return opening;
  if (dispatcher.draining && !dispatcher.admitWhileDraining)
    throw Object.assign(
      new Error("Claudex is restarting. Try again in a moment."),
      { code: webErrorCodes.runnerUnavailable },
    );
  let state: OpeningAccount = { kind: "loading" };
  let settingsReady = () => {};
  const metadata = new Promise<void>((resolve) => { settingsReady = resolve; });
  let shellReady: (ctx: WebAppContext) => void = () => {};
  const prepared = new Promise<WebAppContext>((resolve) => { shellReady = resolve; });
  let stop = () => {};
  const retirement = new Promise<void>((resolve) => { stop = resolve; });
  const ended = retirement.then(() => { throw sessionEnded(); });
  const retire = () => {
    if (state.kind === "shell") {
      state.context.signedOut = true;
      state.context.setAccessToken("");
    }
    state = { kind: "retired" };
    settingsReady();
    stop();
  };
  const retired = () => state.kind === "retired";
  const context = (async () => {
    await dispatcher.userSlot(userId);
    if (retired()) throw sessionEnded();
    const open = dispatcher.options.openContext ?? WebAppContext.open;
    const ctx = await open(
      {
        ...dispatcher.options.runtime,
        transport: {
          request: (op, user, body) =>
            dispatcher.options.link.request(op, user, body),
        },
        publish: (user, event) => {
          const owner = dispatcher.contexts.get(user) ?? dispatcher.opening.get(user)?.shellContext;
          if (owner) owner.lastActive = dispatcher.now();
          dispatcher.options.publish(user, event);
        },
        closed: (ctx) => {
          if (dispatcher.contexts.get(ctx.userId) === ctx) {
            dispatcher.contexts.delete(ctx.userId);
            dispatcher.options.forget?.(ctx.userId);
          } else if (dispatcher.opening.get(ctx.userId) === record) {
            if (state.kind === "shell") retire();
            dispatcher.options.forget?.(ctx.userId);
          }
        },
      },
      {
        userId,
        accessToken: frame.user.accessToken,
        accountSettingsReady: (account) => {
          if (state.kind !== "loading") return;
          state = { kind: "metadata", account };
          settingsReady();
        },
        shellReady: (ctx) => {
          if (retired() || ctx.closed) throw sessionEnded();
          state = { kind: "shell", context: ctx, read: liveAccountSettings(dispatcher, ctx) };
          shellReady(ctx);
          return ended;
        },
        register: (ctx) => {
          const handle: IpcHandle = (name, fn) => {
            if (runnerMethods.has(name) || isOrganizationPluginMethod(name) || name === "forkConversation" || name === "selectChatLeaf" || name === "officialCodeRoutineRun" || name === "officialCodeRoutineCancel" || name === "probeConnector" || name === "refreshConnectorTools")
              ctx.handlers.set(name, fn);
          };
          registerWebHandlers(ctx, handle);
        },
      },
    );
    if (retired() || ctx.closed) {
      await ctx.close();
      throw sessionEnded();
    }
    configureMelangeEngineReservation(ctx, async () => {
      const releaseEngine = ctx.engineRunning() ? undefined : await dispatcher.engineSlot(ctx);
      ctx.melangeModelCalls++;
      return () => {
        ctx.melangeModelCalls--;
        releaseEngine?.();
      };
    });
    dispatcher.contexts.set(userId, ctx);
    state = { kind: "open", read: liveAccountSettings(dispatcher, ctx) };
    return ctx;
  })().catch((error) => {
    state = { kind: "retired" };
    throw error;
  }).finally(() => {
    dispatcher.opening.delete(userId);
  });
  const read: ReadAccountSettings = (accessToken) => {
    if (state.kind === "open" || state.kind === "shell") return state.read(accessToken);
    if (state.kind === "metadata") return state.account;
  };
  const accountSettings = Promise.race([metadata, context]).then(() => read);
  void accountSettings.catch(() => {});
  const shell = Promise.race([prepared, context, ended]);
  void shell.catch(() => {});
  const record: OpeningContext = {
    context,
    shell,
    get shellContext() { return state.kind === "shell" ? state.context : undefined; },
    accountSettings,
    retire,
  };
  dispatcher.opening.set(userId, record);
  return record;
}

/** Room for one more context: closes the longest-idle one without tabs or turns. */
export async function userSlot(this: Dispatcher, userId: number) {
  // The opening context is not counted yet (this runs before it is listed).
  if (this.contexts.size + this.opening.size < this.maxUsers) return;
  const idle = [...this.contexts.values()]
    .filter((ctx) => ctx.userId !== userId && !ctx.busy() && ctx.tabs === 0)
    .sort((a, b) => a.lastActive - b.lastActive)[0];
  if (!idle)
    throw new CapacityError(
      "Claudex is at capacity right now. Try again in a few minutes.",
    );
  await this.closeContext(idle);
}

/** Room for one more running engine: stops the longest-idle other one. */
export function engineSlot(this: Dispatcher, ctx: WebAppContext) {
  const run = this.slotLock.then(async () => {
    const running = [...this.contexts.values()].filter(
      (other) =>
        other !== ctx &&
        (other.engineRunning() || this.reserved.has(other.userId)),
    );
    if (running.length >= this.maxEngines) {
      const idle = running
        .filter((other) => !other.busy() && !this.reserved.has(other.userId))
        .sort((a, b) => a.lastActive - b.lastActive)[0];
      if (!idle || running.length - 1 >= this.maxEngines)
        throw new CapacityError(
          "Claudex is busy right now. Try again in a few minutes.",
        );
      await idle.stopEngine();
    }
    const userId = ctx.userId;
    this.reserved.set(userId, (this.reserved.get(userId) ?? 0) + 1);
    return () => {
      const count = this.reserved.get(userId) ?? 0;
      if (count <= 1) this.reserved.delete(userId);
      else this.reserved.set(userId, count - 1);
    };
  });
  this.slotLock = run.catch(() => {});
  return run;
}

export async function closeContext(this: Dispatcher, ctx: WebAppContext) {
  closeOfficialMelangeEdits(ctx);
  if (this.contexts.get(ctx.userId) === ctx) this.contexts.delete(ctx.userId);
  this.options.forget?.(ctx.userId);
  await ctx
    .close()
    .catch((error) =>
      this.log(
        `claudex-runner: closing user ${ctx.userId}'s context failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
}
