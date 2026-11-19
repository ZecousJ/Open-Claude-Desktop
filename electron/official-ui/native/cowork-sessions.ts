/** Experimental local Cowork adapter; no external folder grants are inferred. */
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Approval, Conversation, Snapshot } from "../../../shared/types";
import { approvalResponse } from "../../../shared/approval-response";
import { mcpElicitationResponse } from "../../../shared/mcp-elicitation";
import { codeTurnStoppedByUser } from "../../../shared/official-code-followup";
import { isEditablePrivateChatProject } from "../../../shared/project-access";
import { codeEffortInput, codeModelChoice } from "../../ipc/code-model-preferences";
import { assertCodeSessionSendAvailable } from "../../conversations/code-lifecycle-guard";
import type { NativeHost } from "./host";
import { convertCodeTranscript } from "./code-transcript";
import { sessionAccountScope } from "./session-account-scope";
import {
  codeElicitationOffer,
  fileWritePermission,
  toolPermission,
  type ToolPermission,
} from "./command-permission";
import {
  sessionConnectors,
  initialSessionConnectors,
} from "./session-connectors";
import { storedAttachmentImage } from "./code-attachments";
import { storeCoworkAttachments } from "./cowork-attachments";
import { parseSkillReferences } from "../../../shared/skill-references";
import { createNativeSlashInventory, nativeSlashCommandRows, prepareCoworkSlashPrompt } from "./slash-commands";
import type { ComputerUseState } from "../../../shared/computer-use";
import { coworkComputerUseCard, coworkComputerUseDecision, coworkComputerUsePrefix } from "./cowork-computer-use";
import { officialCoworkSend } from "../../engine/official-cowork-send";

const publicId = (id: string) => `local_${id}`;
const partialTranscriptRecords = new Set([
  "running-turn",
  "running-command",
  "running-tool-call",
]);
const internalId = (id: string) => (id.startsWith("local_") ? id.slice(6) : "");
const localCowork = (c: Conversation) =>
  c.mode === "cowork" &&
  !c.cloudHosted &&
  (!c.environment || c.environment.kind === "local");
type CoworkReply = { id: string; text: string };
type CoworkStreamEvent =
  | { type: "message_start"; message: { id: string; model: string; role: "assistant"; content: [] } }
  | { type: "content_block_start"; index: 0; content_block: { type: "text"; text: "" } }
  | { type: "content_block_delta"; index: 0; delta: { type: "text_delta"; text: string } }
  | { type: "content_block_stop"; index: 0 }
  | { type: "message_stop" };
const coworkStreamMessage = (sessionId: string, event: CoworkStreamEvent) => ({
  type: "stream_event", session_id: sessionId, parent_tool_use_id: null, event,
});
function streamCoworkReply(
  emit: (event: CoworkStreamEvent) => void,
  reply: CoworkReply,
  model: string,
  previous?: CoworkReply,
) {
  if (!previous) {
    emit({ type: "message_start", message: { id: reply.id, model, role: "assistant", content: [] } });
    emit({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  }
  const text = reply.text.slice(previous?.text.length ?? 0);
  if (text) emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
}
const projectSelection = z.union([
  z.strictObject({
    userSelectedProjectUuids: z.tuple([z.string().trim().min(1)]),
  }),
  z.strictObject({
    userSelectedProjectUuids: z.tuple([]),
    spaceId: z.literal("").optional(),
  }),
]);
const startProject = z.union([z.tuple([]), z.tuple([z.string().trim().min(1).max(128)])]);
const startPermission = z.enum(["default", "auto", "bypassPermissions"]);

export function registerExperimentalCoworkSessions(host: NativeHost) {
  const { ctx } = host;
  const localCall = (name: string, ...args: unknown[]) => {
    if (!ctx.localCall)
      throw Error("Local Cowork is not available on this host.");
    return scope.guard(() => ctx.localCall!(name, ...args));
  };
  const messageIds = new Map<string, Map<string, string>>();
  // A submission without an optimistic message UUID still needs serialization.
  // Tokens prevent an old account's finally block from releasing a new request.
  const submissions = new Map<string, { cancelled: boolean }>();
  let folderChoices = new WeakMap<object, Map<string, number>>();
  type StartLease = {
    cancelled: boolean;
    dispatched: boolean;
    stopped: boolean;
    expired?: boolean;
    done: Promise<void>;
    error?: unknown;
    stop?: Promise<void>;
  };
  const starts = new Map<string, StartLease>();
  const pending = new Map<
    string,
    { before: Set<string>; message: string; uuid: string }
  >();
  const outstanding = new Map<string, ToolPermission>(),
    permissionRevisions = new Map<string, number>();
  const computerUseCards = new Map<string, ReturnType<typeof coworkComputerUseCard>>();
  const elicitations = new Map<
    string,
    { approval: Approval; request: ToolPermission }
  >();
  const elicitationIds = new Map<string, string>();
  const elicitationPrefix = "cowork-mcp-elicitation:";
  const revisions = new Map<string, number>(),
    announced = new Map<string, Map<string, string>>();
  const runningSessions = new Set<string>();
  const streamedReplies = new Map<string, CoworkReply>();
  const scope = sessionAccountScope(ctx, () => {
    messageIds.clear();
    submissions.clear();
    folderChoices = new WeakMap();
    starts.clear();
    pending.clear();
    revisions.clear();
    announced.clear();
    runningSessions.clear();
    streamedReplies.clear();
    outstanding.clear();
    computerUseCards.clear();
    permissionRevisions.clear();
    elicitations.clear();
    elicitationIds.clear();
  });
  const on = (name: string, handler: (...args: any[]) => unknown) =>
    host.on(name, (...args) => scope.run(() => handler(...args)));
  const ownedProject = async (id: string) => {
    const { projects } = (await localCall("snapshot")) as Pick<Snapshot, "projects">;
    const [project, duplicate] = projects.filter((item) => item.id === id);
    if (!project || duplicate || !isEditablePrivateChatProject(project) || ctx.isCloudProject?.(id))
      throw Error("Project not found.");
    return project;
  };
  const rememberFolder = (caller: object | undefined, folder: string) => {
    if (!caller) throw Error("Choose the folder in this account window.");
    const chosen = folderChoices.get(caller) ?? new Map<string, number>();
    chosen.set(folder, Date.now() + 15 * 60_000);
    folderChoices.set(caller, chosen);
  };
  const folderInput = z.string().min(1).max(4096);
  on("LocalAgentModeSessions.isFolderTrusted", async (raw: unknown) => {
    const caller = host.caller;
    const folder = folderInput.parse(raw);
    if (!host.hasFolderSelection(caller, folder)) return false;
    const access = await localCall("coworkFolderAccess", folder) as { state: string };
    const trusted = access.state === "trusted";
    if (trusted) rememberFolder(caller, folder);
    return trusted;
  });
  on("LocalAgentModeSessions.addTrustedFolder", async (raw: unknown) => {
    const caller = host.caller;
    const choice = typeof raw === "string"
      ? { folder: folderInput.parse(raw), scope: "always" as const }
      : z.strictObject({ folder: folderInput, scope: z.literal("session") }).parse(raw);
    if (!caller) throw Error("Choose the folder in this account window.");
    if (!host.hasFolderSelection(caller, choice.folder))
      throw Error("Choose the folder with the folder picker again.");
    // This check validates picker provenance and rejects refused directories.
    const access = await localCall("coworkFolderAccess", choice.folder) as { state: string; reason?: string };
    if (access.state === "refused") throw Error(access.reason ?? "This folder cannot be used.");
    if (choice.scope === "always") await localCall("grantCoworkFolder", choice.folder, "always");
    rememberFolder(caller, choice.folder);
  });
  const commands = createNativeSlashInventory(ctx, "cowork");
  on("LocalAgentModeSessions.getSupportedCommands", async (options?: unknown) => {
    const listed = await commands(options);
    return nativeSlashCommandRows(listed.commands).map(row => ({ ...row, scope: "cowork" }));
  });
  // Claudex runs Cowork through its own host executor; the official VM is not required.
  on("ClaudeVM.isHostLoopModeEnabled", () => true);
  on("ClaudeVM.getRunningStatus", () => "ready");
  on("ClaudeVM.getDownloadStatus", () => "ready");
  on("ClaudeVM.startVM", () => ({ success: true }));
  const approvals = async () =>
    ((await localCall("snapshot")) as { approvals: Approval[] }).approvals;
  const owned = (c: Conversation) => {
    const owner = ctx.account()?.id;
    return !!owner && (!c.sessionAuthors ||
      (c.sessionAuthors.ownerAccountUuid === owner && c.sessionAuthors.viewerAccountUuid === owner));
  };
  const computerUseState = () => localCall("computerUseState") as Promise<ComputerUseState>;
  const computerUseFor = (c: Conversation) => !c.archived && owned(c) &&
    c.turns.at(-1)?.status === "inProgress" && !!ctx.computerUseSettingsState?.();
  const permission = (
    approval: Approval,
    c: Conversation,
  ): ToolPermission | undefined => {
    if (!owned(c)) return;
    const write = fileWritePermission(approval, c, "cowork");
    if (write) {
      return {
        requestId: String(approval.id),
        sessionId: publicId(c.id),
        ...write,
        toolUseId: write.cliToolUseId,
        ...(typeof approval.params?.reason === "string"
          ? { decisionReason: approval.params.reason.slice(0, 1000) }
          : {}),
        suppressAlwaysAllowRule: true,
      };
    }
    const offer =
      ctx.respondToLocalCodeElicitation && codeElicitationOffer(approval, c);
    if (!offer) return toolPermission(approval, c);
    const id = String(approval.id);
    const previousId = elicitationIds.get(id);
    const previous = previousId && elicitations.get(previousId);
    if (
      previous &&
      previous.approval === approval &&
      isDeepStrictEqual(previous.request, { ...offer, requestId: previousId })
    )
      return previous.request;
    if (previousId) {
      elicitations.delete(previousId);
      outstanding.delete(previousId);
      if (previous)
        host.emit("LocalAgentModeSessions", "onEvent", {
          type: "tool_permission_resolved",
          sessionId: previous.request.sessionId,
          request: previous.request,
        });
    }
    const request = {
      ...offer,
      requestId: `${elicitationPrefix}${randomUUID()}`,
    };
    elicitationIds.set(id, request.requestId);
    elicitations.set(request.requestId, { approval, request });
    return request;
  };
  const view = async (c: Conversation) => {
    const before = new Map(permissionRevisions);
    const requests = (await approvals()).flatMap((approval) => {
      if (
        (permissionRevisions.get(String(approval.id)) ?? 0) !==
        (before.get(String(approval.id)) ?? 0)
      )
        return [];
      const request = permission(approval, c);
      if (!request) return [];
      outstanding.set(request.requestId, request);
      return [request];
    });
    const cwd = c.cwd ?? ctx.defaultWorkspace?.() ?? os.homedir();
    let selectedFolders: string[] = [];
    if (c.cwd) {
      try {
        const access = await localCall("coworkFolderAccess", c.cwd, c.id) as { state: string; folder: string };
        if (access.state === "granted" || access.state === "trusted")
          selectedFolders = [access.folder];
      } catch {
        scope.sync();
      }
    }
    const computerRequests = [];
    if (computerUseFor(c)) {
      const state = await computerUseState();
      for (const pending of state.requests ?? []) {
        if (pending.conversationId !== c.id) continue;
        const card = coworkComputerUseCard(pending, state);
        computerUseCards.set(pending.id, card);
        computerRequests.push(card);
      }
    }
    return {
      sessionId: publicId(c.id),
      hostLoopMode: true,
      cwd,
      userSelectedFolders: selectedFolders,
      userSelectedProjectUuids: c.projectId ? [c.projectId] : [],
      isRunning: c.turns.some((turn) => turn.status === "inProgress"),
      isArchived: c.archived,
      isStarred: c.pinned,
      createdAt: c.createdAt,
      lastActivityAt: c.updatedAt,
      model: c.model,
      effortLevel: c.effort,
      permissionMode: c.coworkPermissionMode === "bypass" ? "bypassPermissions" : c.coworkPermissionMode,
      extendedThinkingEnabled: c.thinkingMode === undefined ? undefined : c.thinkingMode === "extended",
      title: c.title,
      ...(c.importedCliSessionId ? {
        importedFrom: "local-1p-cowork",
        importedUnconfirmed: c.importedSessionResumePending === true,
        resumeConfirmed: !c.importedSessionResumePending,
      } : {}),
      ...(c.importedSessionResumePending ? {
        error: "Confirm that you trust this imported session before resuming it.",
        errorCategory: "imported_needs_resume_confirm",
      } : {}),
      homePath: os.homedir(),
      folderExists: fs.existsSync(cwd),
      initialMessage: c.turns[0]?.prompt,
      pendingToolPermissions: [...requests, ...computerRequests],
    };
  };
  const list = async () => {
    if (!ctx.localListConversations)
      throw Error("Local Cowork is not available on this host.");
    return (await scope.guard(() => ctx.localListConversations!())).filter(
      localCowork,
    );
  };
  const get = async (id: string) => {
    const key = internalId(id);
    if (!key) return undefined;
    if (!ctx.localLoadConversation)
      throw Error("Local Cowork is not available on this host.");
    const c = await scope.guard(() => ctx.localLoadConversation!(key));
    return c && localCowork(c) ? c : undefined;
  };
  const convert = (c: Conversation) => {
    const wait = pending.get(c.id);
    if (wait) {
      const turn = c.turns.find(
        (entry) =>
          !entry.id.startsWith("pending-") &&
          !wait.before.has(entry.id) &&
          entry.prompt === wait.message,
      );
      if (turn) {
        const ids = messageIds.get(c.id) ?? new Map<string, string>();
        ids.set(`${turn.id}:user`, wait.uuid);
        messageIds.set(c.id, ids);
        pending.delete(c.id);
      }
    }
    const stableTurns = c.turns.filter(
      (turn) => !turn.id.startsWith("pending-"),
    );
    let partialReply: CoworkReply | undefined;
    const result = convertCodeTranscript(
      { ...c, id: publicId(c.id), turns: stableTurns },
      (attachment) => storedAttachmentImage(ctx.stateDirectory?.(), attachment),
      { onPartialCoworkReply: (reply) => { partialReply = reply; } },
    );
    if (
      stableTurns.length !== c.turns.length &&
      !result.unsupported.includes("running-turn")
    )
      result.unsupported.push("running-turn");
    const ids = messageIds.get(c.id);
    if (ids)
      for (const row of result.rows) {
        row.uuid = ids.get(row.uuid) ?? row.uuid;
        if (row.parentUuid)
          row.parentUuid = ids.get(row.parentUuid) ?? row.parentUuid;
      }
    return { ...result, partialReply };
  };
  const transcript = async (
    id: string,
    options?: { limit?: number; types?: string[] },
  ) => {
    if (id === "local_session_new") return [];
    const c = await get(id);
    if (!c) throw Error("Cowork session not found.");
    const result = convert(c);
    const unsupported = result.unsupported.filter((kind) => !partialTranscriptRecords.has(kind));
    if (unsupported.length)
      throw Error(
        `Cowork transcript contains unsupported records: ${unsupported.join(", ")}`,
      );
    const rows = options?.types
      ? result.rows.filter((row) => options.types!.includes(row.type))
      : result.rows;
    return options?.limit === undefined
      ? rows
      : rows.slice(-Math.max(1, Math.min(1000, options.limit | 0)));
  };
  const connectors = sessionConnectors(get, localCall, ctx);
  const sessionView = async (c: Conversation) => {
    const session = await view(c);
    return { ...session, enabledMcpTools: connectors.cachedEnabledMcpTools(c) };
  };
  on("LocalAgentModeSessions.setMcpServers", connectors.setMcpServers);
  on(
    "LocalAgentModeSessions.replaceRemoteMcpServers",
    connectors.replaceRemoteMcpServers,
  );
  on(
    "LocalAgentModeSessions.replaceEnabledMcpTools",
    connectors.replaceEnabledMcpTools,
  );
  on("LocalAgentModeSessions.getAll", async () =>
    Promise.all((await list()).map(view)),
  );
  on("LocalAgentModeSessions.getSessionList", async () => ({
    sessions: await Promise.all((await list()).map(view)),
    restPending: false,
  }));
  on("LocalAgentModeSessions.getSession", async (id: string, options?: { skipReplay?: boolean; metadataOnly?: boolean }) => {
    const caller = host.caller;
    if (id === "local_session_new")
      return {
        sessionId: id,
        hostLoopMode: true,
        cwd: os.homedir(),
        userSelectedFolders: [],
        isRunning: false,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        homePath: os.homedir(),
        folderExists: true,
      };
    const c = await get(id);
    if (!c) return null;
    const session = await sessionView(c);
    scope.sync();
    const partial = streamedReplies.get(id);
    if (caller && partial && options?.skipReplay && !options.metadataOnly)
      streamCoworkReply((event) => host.emitTo(caller, "LocalAgentModeSessions", "onEvent", {
        type: "message", sessionId: id, message: coworkStreamMessage(id, event),
      }), partial, c.model);
    return session;
  });
  on("LocalAgentModeSessions.getTranscript", transcript);
  on("LocalAgentModeSessions.getTranscriptRead", async (id: string) => ({
    messages: await transcript(id),
  }));
  on(
    "LocalAgentModeSessions.updateSession",
    async (id: string, update: unknown) => {
      if (
        !update ||
        typeof update !== "object" ||
        !Object.hasOwn(update, "userSelectedProjectUuids")
      )
        return;
      const selection = projectSelection.safeParse(update);
      if (!selection.success) throw Error("Invalid Cowork project selection.");
      if (ctx.readOnly || ctx.isCurrent?.() !== true)
        throw Error("Cowork project changes are unavailable on this host.");
      const target = selection.data.userSelectedProjectUuids[0] ?? null;
      const c = await get(id);
      if (!c) throw Error("Cowork session not found.");
      const destinationCreatedAt = target === null ? null : (await ownedProject(target)).createdAt;
      if (ctx.isCurrent?.() !== true)
        throw Error("Cowork project changes are unavailable on this host.");
      const result = await localCall("updateConversation", c.id, {
        projectId: {
          version: 1,
          target,
          expected: {
            conversationId: c.id,
            mode: "cowork",
            createdAt: c.createdAt ?? null,
            sourceProjectId: c.projectId ?? null,
            destinationCreatedAt,
          },
        },
      });
      if (
        !result ||
        typeof result !== "object" ||
        !("id" in result) ||
        result.id !== c.id ||
        !("mode" in result) ||
        result.mode !== "cowork" ||
        (("projectId" in result ? result.projectId : undefined) ?? null) !== target
      )
        throw Error("The Cowork project change could not be confirmed. Refresh before retrying.");
    },
  );
  // Exact methods in the recovered official native contract. The renderer
  // awaits these writes before sending and reads effortLevel on rehydration.
  on("LocalAgentModeSessions.setModel", async (id: string, model: string) => {
    if (typeof model !== "string" || !model.trim() || model.length > 200)
      throw Error("Invalid Cowork model.");
    const c = await get(id);
    if (!c || !owned(c) || c.archived) throw Error("Cowork session not found.");
    const catalog = await scope.guard(() => ctx.modelCatalog());
    const [item, duplicate] = catalog?.items.filter(candidate => candidate.id === model) ?? [];
    if (!item || duplicate) throw Error("The selected Cowork model is unavailable.");
    const choice = codeModelChoice(item, c.effort, ctx.settings().codeEffort, { kind: "model" });
    const latest = await get(id);
    if (!latest || !owned(latest) || latest.archived || latest.createdAt !== c.createdAt || latest.model !== c.model || latest.effort !== c.effort) throw Error("The Cowork session changed. Reopen it before trying again.");
    await localCall("updateConversation", c.id, {
      providerId: c.providerId,
      ...choice,
    });
  });
  on(
    "LocalAgentModeSessions.setEffort",
    async (id: string, effortLevel: string) => {
      const effort = codeEffortInput.parse(effortLevel);
      const c = await get(id);
      if (!c || !owned(c) || c.archived) throw Error("Cowork session not found.");
      const catalog = await scope.guard(() => ctx.modelCatalog());
      const [item, duplicate] = catalog?.items.filter(candidate => candidate.id === c.model) ?? [];
      if (!item || duplicate) throw Error("The selected Cowork model is unavailable.");
      const choice = codeModelChoice(item, c.effort, ctx.settings().codeEffort, { kind: "effort", value: effort });
      const latest = await get(id);
      if (!latest || !owned(latest) || latest.archived || latest.createdAt !== c.createdAt || latest.model !== c.model || latest.effort !== c.effort) throw Error("The Cowork session changed. Reopen it before trying again.");
      await localCall("updateConversation", c.id, choice);
    },
  );
  on(
    "LocalAgentModeSessions.setExtendedThinking",
    async (id: string, enabled: boolean) => {
      if (typeof enabled !== "boolean")
        throw Error("Invalid Cowork thinking setting.");
      const c = await get(id);
      if (!c) throw Error("Cowork session not found.");
      await localCall("updateConversation", c.id, {
        thinkingMode: enabled ? "extended" : "standard",
      });
    },
  );
  on("LocalAgentModeSessions.start", async (info: Record<string, any>) => {
    const caller = host.caller;
    if (
      !info ||
      typeof info.message !== "string" ||
      (!info.message.trim() &&
        !info.images?.length &&
        !info.userSelectedFiles?.length)
    )
      throw Error("A message or attachment is required to start Cowork.");
    const skillReferences = info.skillReferences === undefined ? undefined
      : parseSkillReferences(info.message, info.skillReferences);
    for (const key of [
      "fileAttachments",
      "trailingContentBlocks",
      "mcpServers",
      "spaceId",
    ]) {
      const value = info[key];
      if (value && (typeof value !== "object" || Object.keys(value).length))
        throw Error(`Cowork start does not support ${key} yet.`);
    }
    const folders = z.array(folderInput).max(1, "Only one Cowork folder is supported yet.").parse(info.userSelectedFolders ?? []);
    if (folders.length && (!caller || !host.hasFolderSelection(caller, folders[0]) ||
      (folderChoices.get(caller)?.get(folders[0]) ?? 0) <= Date.now()))
      throw Error("Allow the selected Cowork folder before starting.");
    const [projectId] = startProject.parse(info.userSelectedProjectUuids ?? []);
    const permission = startPermission.default("default").parse(info.permissionMode);
    const effort = codeEffortInput.optional().parse(info.effortLevel);
    if (
      info.systemPrompt !== undefined &&
      (typeof info.systemPrompt !== "string" ||
        info.systemPrompt.length > 200000)
    )
      throw Error("Invalid Cowork system prompt.");
    if (
      info.systemPromptRendererAppends !== undefined &&
      (!Array.isArray(info.systemPromptRendererAppends) ||
        info.systemPromptRendererAppends.some(
          (value: unknown) => typeof value !== "string",
        ) ||
        info.systemPromptRendererAppends.join("\n\n").length > 200000)
    )
      throw Error("Invalid Cowork system prompt appends.");
    // shared-6 sd(K) already joins the renderer appends into systemPrompt.
    const sessionInstructions =
      info.systemPrompt || info.systemPromptRendererAppends?.join("\n\n");
    if (
      info.sessionId !== undefined &&
      (typeof info.sessionId !== "string" ||
        !/^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          info.sessionId,
        ))
    )
      throw Error("Invalid Cowork session id.");
    const startId = info.sessionId
      ? internalId(info.sessionId).toLowerCase()
      : undefined;
    let finish!: () => void;
    const lease: StartLease = {
      cancelled: false,
      dispatched: false,
      stopped: false,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    if (startId && starts.has(startId))
      throw Error("This Cowork session is already being started.");
    if (startId) starts.set(startId, lease);
    const assertNotCancelled = () => {
      if (lease.cancelled)
        throw Error("The Cowork startup was cancelled before dispatch.");
    };
    const assertNew = async () => {
      assertNotCancelled();
      if (!startId) return;
      if (!ctx.localLoadConversation)
        throw Error("Local Cowork is not available on this host.");
      if (await scope.guard(() => ctx.localLoadConversation!(startId)))
        throw Error("This Cowork session already exists; open it instead.");
      assertNotCancelled();
    };
    try {
      await assertNew();
      const settings = ctx.settings();
      const provider =
        settings.providers.find((p) => p.id === settings.activeProviderId) ??
        settings.providers.find((p) => p.backend === "sub2api") ??
        settings.providers[0];
      if (!provider) throw Error("No model service is configured.");
      const model = typeof info.model === "string" && info.model ? info.model : provider.model;
      if (effort) {
        const catalog = await scope.guard(() => ctx.modelCatalog());
        const [item, duplicate] = catalog?.items.filter((candidate) => candidate.id === model) ?? [];
        if (!item || duplicate) throw Error("The selected Cowork model is unavailable.");
        codeModelChoice(item, undefined, settings.codeEffort, { kind: "effort", value: effort });
      }
      if (projectId) await ownedProject(projectId);
      const connectorChoices = await initialSessionConnectors(
        ctx,
        localCall,
        info,
      );
      assertNotCancelled();
      // Inline bytes, host-stored paths, and one-shot trusted File selections
      // only. Arbitrary renderer paths never imply filesystem or folder access.
      const attachments = await storeCoworkAttachments(
        ctx.stateDirectory?.(),
        localCall,
        info.images,
        info.userSelectedFiles,
        caller && host.takeSelectedAttachments
          ? (paths, budget) =>
              host.takeSelectedAttachments(caller, paths, budget, "new", info.sessionId)
          : undefined,
      );
      const commandText = await scope.guard(() =>
        prepareCoworkSlashPrompt(ctx, info.message, skillReferences ?? [], {}));
      await assertNew();
      assertNotCancelled();
      if (folders.length) {
        // Consume before the asynchronous grant so a second start cannot reuse it.
        if (!caller || !host.hasFolderSelection(caller, folders[0]) ||
          (folderChoices.get(caller)?.get(folders[0]) ?? 0) <= Date.now() ||
          !folderChoices.get(caller)?.delete(folders[0]))
          throw Error("Allow the selected Cowork folder before starting.");
        await localCall("grantCoworkFolder", folders[0], "session");
        assertNotCancelled();
      }
      lease.dispatched = true;
      const c = (await localCall("send", {
        mode: "cowork",
        ...(folders.length ? { cwd: folders[0] } : {}),
        ...(projectId ? { projectId } : {}),
        coworkPermissionMode: permission === "bypassPermissions" ? "bypass" : permission,
        ...connectorChoices,
        ...(info.sessionId ? { newConversationId: startId } : {}),
        ...(sessionInstructions ? { sessionInstructions } : {}),
        text: commandText ?? info.message,
        ...(!commandText && skillReferences?.length ? { skillReferences } : {}),
        attachments: attachments.map((attachment) => ({ id: attachment.id })),
        providerId: provider.id,
        model,
        ...(effort ? { effort } : {}),
        ...(typeof info.extendedThinkingEnabled === "boolean"
          ? {
              thinkingMode: info.extendedThinkingEnabled
                ? "extended"
                : "standard",
            }
          : {}),
      }, { [officialCoworkSend]: true })) as Conversation;
      if (!c?.id || !localCowork(c) || (startId && c.id !== startId))
        throw Error("The Cowork session could not be started locally.");
      if (lease.cancelled) {
        // No atomic backend request/turn ownership token exists here. Reading a
        // matching ID then interrupting can kill a replacement/newer turn.
        throw Error("Cowork cancellation is not confirmed. Open the session and stop its current task.");
      }
      if (typeof info.messageUuid === "string" && c.turns.length)
        messageIds.set(
          c.id,
          new Map([[`${c.turns[0].id}:user`, info.messageUuid]]),
        );
      host.emit("LocalAgentModeSessions", "onEvent", {
        type: "session_updated",
        sessionId: publicId(c.id),
      });
      return { sessionId: publicId(c.id) };
    } catch (error) {
      lease.error = error;
      throw error;
    } finally {
      finish();
      // An old activation's finally must not release a new activation's lease.
      if (startId && starts.get(startId) === lease) starts.delete(startId);
    }
  });
  on(
    "LocalAgentModeSessions.sendMessage",
    async (
      id: string,
      message: string,
      images?: unknown[],
      userSelectedFiles?: unknown[],
      uuid?: string,
      ...other: unknown[]
    ) => {
      const caller = host.caller;
      const c = await get(id);
      if (!c) throw Error("Cowork session not found.");
      assertCodeSessionSendAvailable(c);
      if (
        typeof message !== "string" ||
        (!message.trim() && !images?.length && !userSelectedFiles?.length)
      )
        throw Error("A message or attachment is required.");
      const marks = z.strictObject({
        personSent: z.boolean().optional(),
        skillReferences: z.unknown().optional(),
      }).nullish().parse(other[10] === false || other[10] === "" ? undefined : other[10]);
      const skillReferences = parseSkillReferences(message, marks?.skillReferences ?? []);
      const unsupported = other.findIndex((value, index) => {
        if (index === 6 && typeof value === "boolean") return false; // extendedThinking
        // These are document-ingestion feature gates, not document input. This
        // byte-payload path does not enable document-ingestion capabilities.
        if ((index === 4 || index === 7) && typeof value === "boolean")
          return false;
        if (index === 10) return false;
        return (
          value !== undefined &&
          value !== null &&
          value !== false &&
          value !== "" &&
          (!Array.isArray(value) || value.length)
        );
      });
      if (unsupported >= 0)
        throw Error(
          `Cowork message option ${["toolStates", "fileAttachments", "contentBlocks", "syntheticMessage", "documentFunnelEnabled", "seededSummon", "extendedThinking", "docxEditingCarveout", "trailingContentBlocks", "seededKind", "marks"][unsupported] ?? unsupported} is not supported yet.`,
        );
      if (submissions.has(c.id))
        throw Error("A Cowork message is still being submitted.");
      const token = { cancelled: false };
      submissions.set(c.id, token);
      const submission = uuid
        ? { before: new Set(c.turns.map((turn) => turn.id)), message, uuid }
        : undefined;
      if (submission) pending.set(c.id, submission);
      try {
        const expanded = await scope.guard(() =>
          prepareCoworkSlashPrompt(ctx, message, skillReferences, { sessionId: id }));
        if (submission && expanded !== undefined) submission.message = expanded;
        const attachments = await storeCoworkAttachments(
          ctx.stateDirectory?.(),
          localCall,
          images,
          userSelectedFiles,
          caller && host.takeSelectedAttachments
            ? (paths, budget) =>
                host.takeSelectedAttachments(caller, paths, budget, id)
            : undefined,
        );
        if (token.cancelled)
          throw Error("The Cowork message was cancelled before dispatch.");
        const attachmentIds = attachments.map(({ id }) => id);
        const latest = await get(id);
        if (!latest || latest.createdAt !== c.createdAt || !owned(latest) || token.cancelled)
          throw Error("The Cowork session changed before sending.");
        if (latest.turns.at(-1)?.status === "inProgress") {
          if (skillReferences.length && expanded === undefined)
            throw Error("Send this skill after the Cowork reply finishes.");
          const result = await localCall("officialCoworkSteer", c.id, {
            text: expanded ?? message, attachmentIds, messageId: uuid,
          }, () => !token.cancelled && submissions.get(c.id) === token);
          if (result) return { dispatched: true };
          if (token.cancelled)
            throw Error("The Cowork message was cancelled before dispatch.");
        }
        const updated = (await localCall("send", {
          conversationId: c.id,
          mode: "cowork",
          text: expanded ?? message,
          ...(skillReferences.length && expanded === undefined ? { skillReferences } : {}),
          attachments: attachmentIds.map(id => ({ id })),
          providerId: latest.providerId,
          model: latest.model,
          ...(latest.effort ? { effort: latest.effort } : {}),
          ...(typeof other[6] === "boolean"
            ? { thinkingMode: other[6] ? "extended" : "standard" }
            : {}),
        }, { [officialCoworkSend]: true })) as Conversation;
        if (updated) convert(updated);
        return { dispatched: true };
      } finally {
        if (submissions.get(c.id) === token) submissions.delete(c.id);
        if (submission && pending.get(c.id) === submission)
          pending.delete(c.id);
      }
    },
  );
  on("LocalAgentModeSessions.stop", async (id: string) => {
    const start = starts.get(internalId(id).toLowerCase());
    if (start) {
      start.cancelled = true;
      // No dispatch has occurred; the preparation guards now make dispatch impossible.
      if (!start.dispatched) return;
      if (!start.stop)
        start.stop = (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              start.done,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  start.expired = true;
                  reject(
                    Error(
                      "Cowork cancellation is not yet confirmed. Check the session before retrying.",
                    ),
                  );
                }, 30_000);
              }),
            ]);
            scope.sync();
            if (!start.stopped)
              throw (
                start.error ??
                Error("Cowork cancellation could not be confirmed.")
              );
          } finally {
            if (timer) clearTimeout(timer);
          }
        })();
      return start.stop;
    }
    const c = await get(id);
    if (!c) throw Error("Cowork session not found.");
    const submission = submissions.get(c.id);
    if (submission) submission.cancelled = true;
    await localCall("interrupt", c.id);
  });
  on("LocalAgentModeSessions.delete", async (id: string) => {
    const c = await get(id);
    if (!c) throw Error("Cowork session not found.");
    const submission = submissions.get(c.id);
    if (submission) submission.cancelled = true;
    await localCall("deleteConversation", c.id);
  });
  on(
    "LocalAgentModeSessions.respondToToolPermission",
    async (requestId: string, decision: string, updatedInput?: unknown) => {
      if (typeof requestId !== "string")
        throw Error("Invalid approval request.");
      if (requestId.startsWith(coworkComputerUsePrefix)) {
        const key = requestId.slice(coworkComputerUsePrefix.length);
        const shown = computerUseCards.get(key);
        const c = shown && await get(shown.sessionId);
        if (!c || !computerUseFor(c)) throw Error("The computer-use request is no longer available.");
        const state = await computerUseState();
        const pending = state.requests?.find((request) => request.id === key && request.conversationId === c.id);
        if (!pending || computerUseCards.get(key)?.sessionId !== shown.sessionId)
          throw Error("The computer-use request is no longer available.");
        await localCall("answerComputerUseAccess", key, coworkComputerUseDecision(pending, decision, updatedInput));
        return;
      }
      if (decision !== "once" && decision !== "deny")
        throw Error(
          "Only allow once or deny is supported for Cowork approvals.",
        );
      if (requestId.startsWith(elicitationPrefix)) {
        const unavailable = () =>
          Error("The elicitation request is no longer available.");
        const pending = elicitations.get(requestId);
        if (!pending || !ctx.respondToLocalCodeElicitation) throw unavailable();
        const c = await get(pending.request.sessionId);
        const matching = (await approvals()).filter(
          (a) => String(a.id) === String(pending.approval.id),
        );
        const offer = c && owned(c) && codeElicitationOffer(pending.approval, c);
        if (
          elicitations.get(requestId) !== pending ||
          matching.length !== 1 ||
          matching[0] !== pending.approval ||
          !offer ||
          !isDeepStrictEqual(pending.request, { ...offer, requestId })
        )
          throw unavailable();
        const answer = mcpElicitationResponse(pending.approval, updatedInput);
        if (!answer || (answer.action === "accept") !== (decision === "once"))
          throw Error(
            "This elicitation requires an explicit response to the displayed request.",
          );
        scope.sync();
        ctx.respondToLocalCodeElicitation(pending.approval, answer);
        return;
      }
      const matching = (await approvals()).filter(
        (approval) => String(approval.id) === requestId,
      );
      if (matching.length !== 1)
        throw Error("The approval request is no longer available.");
      const approval = matching[0],
        c = await get(publicId(approval.conversationId));
      if (!c || !owned(c))
        throw Error("The approval does not belong to a local Cowork session.");
      const fresh = (await approvals()).filter(
        (row) => String(row.id) === requestId,
      );
      if (fresh.length !== 1 || !isDeepStrictEqual(fresh[0], approval))
        throw Error("The approval request is no longer available.");
      const latest = await get(publicId(approval.conversationId));
      const request = latest && owned(latest) && permission(fresh[0], latest);
      if (!request) throw Error("This approval type is not supported yet.");
      if (
        updatedInput !== undefined &&
        JSON.stringify(updatedInput) !== JSON.stringify(request.input)
      )
        throw Error("Edited approval input is not supported yet.");
      await localCall(
        "approve",
        approval.id,
        approvalResponse(approval, decision === "once" ? "once" : "deny"),
      );
    },
  );
  return ctx.onEvent((event) =>
    scope.run(() => {
      scope.sync();
      if (event.type === "resync") {
        host.emit("LocalAgentModeSessions", "onEvent", { type: "initialized", sessionId: "" });
        return;
      }
      if (event.type === "computer-use") {
        if (event.resolved) {
          const card = computerUseCards.get(event.resolved);
          computerUseCards.delete(event.resolved);
          if (card) host.emit("LocalAgentModeSessions", "onEvent", {
            type: "tool_permission_resolved", sessionId: card.sessionId, request: card,
          });
        }
        if (event.request) {
          const requested = event.request;
          void get(publicId(requested.conversationId)).then(async (c) => {
            if (!c || !computerUseFor(c)) return;
            const state = await computerUseState();
            const pending = state.requests?.find((request) => request.id === requested.id && request.conversationId === c.id);
            if (!pending) return;
            const card = coworkComputerUseCard(pending, state);
            computerUseCards.set(pending.id, card);
            host.emit("LocalAgentModeSessions", "onEvent", {
              type: "tool_permission_request", sessionId: card.sessionId, request: card,
            });
          }).catch((error) => ctx.log("[official-ui] Cowork computer-use update failed", String(error)));
        }
        return;
      }
      if (event.type === "cowork-session-deleted") {
        const id = publicId(event.conversationId);
        revisions.delete(id);
        messageIds.delete(event.conversationId);
        announced.delete(id);
        runningSessions.delete(id);
        streamedReplies.delete(id);
        host.emit("LocalAgentModeSessions", "onEvent", { type: "deleted", sessionId: id });
        return;
      }
      if (event.type === "approval") {
        const requestId = String(event.approval.id),
          revision = (permissionRevisions.get(requestId) ?? 0) + 1;
        permissionRevisions.set(requestId, revision);
        void get(publicId(event.approval.conversationId))
          .then((c) => {
            if (!c || permissionRevisions.get(requestId) !== revision) return;
            const request = permission(event.approval, c);
            if (!request) {
              host.emit("LocalAgentModeSessions", "onEvent", {
                type: "error",
                sessionId: publicId(c.id),
                error:
                  "This Cowork permission request is not supported by the experimental adapter.",
              });
              return;
            }
            outstanding.set(requestId, request);
            host.emit("LocalAgentModeSessions", "onEvent", {
              type: "tool_permission_request",
              sessionId: publicId(c.id),
              request,
            });
          })
          .catch((error) =>
            ctx.log(
              "[official-ui] Cowork approval update failed",
              String(error),
            ),
          );
        return;
      }
      if (event.type === "approval-resolved") {
        const id = String(event.id),
          token = elicitationIds.get(id) ?? id,
          request = outstanding.get(token);
        permissionRevisions.set(id, (permissionRevisions.get(id) ?? 0) + 1);
        elicitationIds.delete(id);
        elicitations.delete(token);
        if (request) {
          outstanding.delete(token);
          host.emit("LocalAgentModeSessions", "onEvent", {
            type: "tool_permission_resolved",
            sessionId: request.sessionId,
            request,
          });
        }
        return;
      }
      const key =
        event.type === "conversation"
          ? event.conversation.id
          : event.type === "conversation-turn"
            ? event.conversationId
            : undefined;
      if (!key) return;
      const id = publicId(key),
        revision = (revisions.get(id) ?? 0) + 1;
      revisions.set(id, revision);
      if (
        (event.type === "conversation" && localCowork(event.conversation) &&
          event.conversation.turns.some(turn => turn.status === "inProgress")) ||
        (event.type === "conversation-turn" && event.turn.status === "inProgress" && announced.has(id))
      ) runningSessions.add(id);
      void get(id)
        .then((c) => {
          if (!c || revisions.get(id) !== revision) return;
          host.emit("LocalAgentModeSessions", "onEvent", {
            type: "session_updated",
            sessionId: id,
          });
          const result = convert(c);
          const emitMessage = (message: unknown) => host.emit("LocalAgentModeSessions", "onEvent", {
            type: "message", sessionId: id, message,
          });
          const emitStream = (event: CoworkStreamEvent) => emitMessage(coworkStreamMessage(id, event));
          const next = result.partialReply;
          let previous = streamedReplies.get(id);
          if (previous && (next?.id !== previous.id || !next.text.startsWith(previous.text))) {
            emitStream({ type: "content_block_stop", index: 0 });
            emitStream({ type: "message_stop" });
            streamedReplies.delete(id);
            previous = undefined;
          }
          if (result.unsupported.every((kind) => partialTranscriptRecords.has(kind))) {
            const seen = announced.get(id) ?? new Map<string, string>();
            for (const row of result.rows) {
              if (row.type === "assistant" && row.message.id && seen.has(row.uuid)) continue;
              const fingerprint = JSON.stringify(row);
              if (seen.get(row.uuid) !== fingerprint) {
                seen.set(row.uuid, fingerprint);
                emitMessage(row);
              }
            }
            announced.set(id, seen);
          }
          if (next) {
            streamCoworkReply(emitStream, next, c.model, previous);
            streamedReplies.set(id, next);
          }
          if (c.turns.some(turn => turn.status === "inProgress")) {
            runningSessions.add(id);
            return;
          }
          if (!result.unsupported.length) {
            host.emit("LocalAgentModeSessions", "onEvent", {
              type: "transcript_loaded",
              sessionId: id,
              messages: result.rows,
            });
          }
          const turn = c.turns.at(-1);
          if (!runningSessions.delete(id) || !turn) return;
          if (codeTurnStoppedByUser(turn)) {
            host.emit("LocalAgentModeSessions", "onEvent", {
              type: "close",
              sessionId: id,
              code: 0,
            });
          } else {
            const completed = turn.status === "completed";
            emitMessage({
              type: "result",
              uuid: `${turn.id}:result`,
              session_id: id,
              parent_tool_use_id: null,
              subtype: completed ? "success" : "error_during_execution",
              is_error: !completed,
              ...(completed ? { stop_reason: "end_turn" } : turn.error ? { errors: [turn.error] } : {}),
            });
          }
        })
        .catch((error) =>
          ctx.log("[official-ui] Cowork update failed", String(error)),
        );
    }),
  );
}
