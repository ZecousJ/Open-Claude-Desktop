import { createCodeTasks } from "./code-tasks";
import {createCodeRewind, codeRewindMark} from './code-rewind';
import { createCodeFork } from "./code-history";
import { reserveCodeFork, reserveCodeRewind } from "./code-fork-receipts";
import { trustFromDetectedProject } from "../../ipc/workspace-trust";
import { environmentChangeRefusal } from "./environment-preflight";
import { officialLocalMcpServersConfig } from "./extensions-read";
import { codeModelChoice, codeStartProvider, type CodeModelPreference } from "../../ipc/code-model-preferences";
import { isConversationModel } from "../../../shared/model-catalog-api";
import { codeReadSnapshot, sameCodeReadActivity } from "../../../shared/code-read-state";
import { codeThinkingPreferenceSnapshot } from "../../../shared/code-thinking-preferences";
import { visibleThinkingSummary } from "../../../shared/thinking-summaries";
import { itemIsRunning } from "../../../shared/activity";
import { codeTurnStoppedByUser } from "../../../shared/official-code-followup";
import {
  codeApiRetryClearedMessage,
  codeApiRetryMessage,
  type CodeApiRetryMessage,
} from "../../../shared/official-code-retry";
import { parseCodeAutoCompact } from "../../../shared/official-code-context";
import { parseReviewArguments } from "../../../shared/code-review-target";
import { builtInOutputStyles, outputStyleNames } from "../../../shared/output-styles";
import { parsePullRequestUrl, sessionPullRequests } from "../../../shared/pull-request";
import { validRepositoryName } from "../../../shared/github-parse";
import { preference } from "../../../shared/settings-extras";
import { codeSessionEnvironmentSelection } from "./code-session-environment";
import { CodeSendCancelled, CodeSendStart, officialCodeNewTaskInput, officialCodeSendStart, officialCodeSessionEnvironment } from "../../engine/code-send-start";
import { codeCloudSideSessionTarget, officialCodeSideSessionTarget, type CodeSideSessionPlacement } from "../../../shared/official-code-side-session";
import { browserMcpServerName } from "../../browser/mcp-tools";
import { editorApprovalServerName } from "../../../shared/editors";
import { parseSkillReferences } from "../../../shared/skill-references";
/** Experimental LocalSessions adapter for local Claudex Code sessions. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Approval, Attachment, Conversation, SessionPullRequest, Turn } from "../../../shared/types";
import type { ComputerUseState } from "../../../shared/computer-use";
import { approvalResponse } from "../../../shared/approval-response";
import { mcpElicitationResponse } from "../../../shared/mcp-elicitation";
import { connectorUuid } from "../api/connectors";
import { hiwonderKnowledgeEnabled, HIWONDER_KNOWLEDGE_SERVER } from "../../../shared/knowledge-api";
import { isLocalCodeSession as localCode, isWslCodeSession as wslCode } from "../api/code-session-ownership";
import { wslEnvironmentInput } from "../../workspace/workspace-fs";
import { learnAttachment } from "../api/files";
import { codeOutputAttachment, flushGeneratedOutputBindings } from "../api/generated-output-files";
import type { NativeHost } from "./host";
import type { AdapterContext } from "../api/context";
import {
  convertCodeTranscript,
  pageCodeTranscript,
  normalizeCodeTranscriptLimit,
  attachmentTranscript,
  codeCompactionProgressUuid,
  codeSteerTranscriptInput,
  hydrateCodeOutput,
  type CodeTranscriptRow,
} from "./code-transcript";
import type { WorkspaceTrust } from "../../../shared/workspace-trust-api";
import { classifyTccFolderKind } from "./tcc-folder";
import { sessionAccountScope } from "./session-account-scope";
import {
  createNativeSlashInventory,
  createNativeSlashPreparation,
  isReservedCodeSlashCommand,
  leadingSlashCommand,
  nativeSlashCommandRows,
  parseCodeCommandScope,
  prepareNativeSshCommand,
  readNativeSshCommands,
  type PreparedNativeCommand,
} from "./slash-commands";
import {
  codeElicitationOffer,
  toolPermission,
  type ToolPermission,
} from "./command-permission";
import {
  coworkComputerUseCard,
  coworkComputerUseDecision,
  coworkComputerUsePrefix,
} from "./cowork-computer-use";
import {
  sessionConnectors,
  initialSessionConnectors,
} from "./session-connectors";
import {
  codeSessionState,
  type CommandReceipt,
  type QueuedCodeMessage,
} from "./code-session-state";
import { isCodeScratchWorkspace } from "../../workspace/code-scratch-workspace";
import { conversationWorktrees } from "../../git/code-worktree";
import { readPullRequestChecks } from "../../git/github-cli";
import { workspaceRepository } from "../../git/git-branch";
import { codeDirectories } from "../../workspace/code-additional-folder";
import { officialContextUsage } from "../../../shared/official-code-context";
import {
  codeComposerFileReferences,
  queuedCodeComposerText,
  storeCodeAttachments,
  storedAttachmentImage,
} from "./code-attachments";

const publicId = (id: string) => `local_${id}`;
const internalId = (id: string) =>
  id.startsWith("local_") ? id.slice("local_".length) : "";
const resultUuid = (turnId: string) => turnId + ":result";
const codePermissionModes = {
  default: "manual",
  acceptEdits: "acceptEdits",
  plan: "plan",
  auto: "auto",
  bypassPermissions: "bypass",
} as const;
const codePermissionMode = z.enum(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
const codeEffortFlag = z.string().nullable();
const codeSessionFlags = z.object({
  effortLevel: codeEffortFlag.optional(),
  ultracode: z.boolean().optional(),
  outputStyle: z.string().optional(),
}).strict();
const codeStartModes = z.object({
  ultracode: z.boolean().optional(),
  fastMode: z.boolean().optional(),
});
const codeModelSnapshot = (c: Conversation) => ({
  providerId: c.providerId,
  model: c.model,
  effort: c.effort ?? null,
  codeUltracode: c.codeUltracode ?? false,
});
const requireFastModeOff = (enabled?: boolean) => {
  if (enabled) throw Error("Fast mode is unavailable for this account.");
};
const elicitationPrefix = "code-mcp-elicitation:";
const prBranchRequest = z.object({
  cwd: z.string(),
  branch: z.string().nullish(),
  id: z.string().nullish(),
  repository: z.string().nullish(),
  host: z.string().nullish(),
});
const prBoundTarget = z.tuple([
  z.string().refine(validRepositoryName),
  z.number().int().positive(),
  z.string().optional(),
]);
const nextPrTimeout = 60 * 60 * 1000;
type NextPrArmResult = "armed" | "refused" | "dropped";
type NextPrWait = {
  branch: string;
  expiresAt: number;
  persisted: boolean;
  finish: (result: NextPrArmResult) => void;
};

export function codeSession(
  c: Conversation,
  permissions: ToolPermission[] = [],
  workspace?: string,
  ssh?: ReturnType<NonNullable<AdapterContext["sshCodeEnvironment"]>>,
) {
  let activeTurn: Turn | undefined;
  for (let index = c.turns.length - 1; index >= 0; index--) {
    if (c.turns[index].status === "inProgress") {
      activeTurn = c.turns[index];
      break;
    }
  }
  const running = activeTurn !== undefined;
  const latestTurn = c.turns.at(-1);
  const error = latestTurn?.status === "failed" ? latestTurn.error : undefined;
  const disabledConnectors = Object.entries(c.connectorOverrides ?? {}).flatMap(
    ([name, enabled]) => (name !== HIWONDER_KNOWLEDGE_SERVER && enabled === false ? [connectorUuid(name)] : []),
  );
  const disabledTools = Object.entries(c.connectorToolOverrides ?? {}).flatMap(
    ([name, tools]) => {
      const disabled = Object.keys(tools).filter((tool) => tools[tool] === false);
      if (!disabled.length) return [];
      const uuid = connectorUuid(name);
      return disabled.map((tool) => `${uuid}:${tool}`);
    },
  );
  const proposals = c.codeModelProposals ?? [];
  const proposalTurn = c.turns.at(-1);
  const visibleProposals = proposals.filter(p => p.expiresAt > Date.now() &&
    (p.kind === "offer"
      ? p.state.kind === "pending" && proposalTurn?.id === p.sourceTurnId && proposalTurn?.status === "inProgress"
      : p.state.kind === "pending" || p.state.kind === "claimed"));
  const suggestions = [
    ...visibleProposals.map(p => ({
      id: p.id, title: p.title, prompt: p.brief, context: p.context,
      createdAt: p.createdAt, expiresAt: p.expiresAt,
      ...(p.worktree === undefined ? {} : { useWorktree: p.worktree }),
      ...(p.kind === "offer" ? { offer: true } : {}),
      ...(p.sourceToolCallId ? { toolUseId: `${p.sourceTurnId}:tool:${p.sourceToolCallId}` } : {}),
    })),
    ...(c.codeNewTask?.nativeInput ? [{
      id: c.codeNewTask.id, title: c.codeNewTask.text.slice(0, 100), prompt: c.codeNewTask.text,
      createdAt: c.codeNewTask.nativeInput.createdAt, context: "fresh", offer: true,
    }] : []),
  ];
  const permissionMode = (
    {
      bypass: "bypassPermissions",
      acceptEdits: "acceptEdits",
      plan: "plan",
      auto: "auto",
      manual: "default",
    } as const
  )[c.codePermissionMode ?? "manual"];
  const { kind: _kind, ...sshConfig } = ssh?.remoteTarget ?? {};
  const managed = localCode(c) || wslCode(c) || !!ssh;
  const worktree = managed ? c.worktree : undefined;
  const folderWorktrees = managed ? c.additionalWorktrees?.flatMap(worktree =>
    worktree.folders.map(({ origin, repository }) => ({
      folder: origin,
      ...(origin !== repository ? { repoRoot: repository } : {}),
      worktreePath: worktree.path,
      worktreeName: worktree.name,
      branch: worktree.branch,
      ...(ssh ? { remote: true } : {}),
      ...(worktree.sourceBranch ? { sourceBranch: worktree.sourceBranch } : {}),
      ...(worktree.state === "deleted" ? { removed: true } : {}),
      ...(worktree.state === "kept" ? { keptDirty: true } : {}),
    })),
  ) : undefined;
  const cwd = worktree?.state === "deleted" ? worktree.origin : c.cwd!;
  return {
    sessionId: publicId(c.id),
    cwd,
    originCwd: worktree?.origin ?? cwd,
    ...(worktree && {
      startedWithWorktree: true,
      branch: worktree.branch,
      ...(worktree.sourceBranch ? { sourceBranch: worktree.sourceBranch } : {}),
      ...(worktree.state === "deleted" ? { worktreeRemoved: true } : {
        worktreePath: worktree.path,
        worktreeName: worktree.name,
        harnessCwd: cwd,
      }),
    }),
    ...(managed && conversationWorktrees(c).some(tree => tree.state === "kept")
      ? { keptDirtyWorktree: true } : {}),
    isScratchWorkspace: !ssh && !wslCode(c) && isCodeScratchWorkspace(c, workspace),
    ...(c.scratchCarried ? { scratchCarried: c.scratchCarried } : {}),
    title: c.title,
    ...(c.nativeSideSession && c.parentSessionId ? { spawnedFrom: { sessionId: publicId(c.parentSessionId), taskId: c.nativeSideSession.taskId, title: c.title, sideSession: true, sharedCheckout: !c.worktree } } : {}),
    startedFromEnvironmentId: c.startedFromEnvironmentId,
    ...(c.scheduledTaskId ? { scheduledTaskId: c.scheduledTaskId } : {}),
    titleSource: c.titleSetByUser ? "user" : "auto",
    createdAt: c.createdAt,
    lastActivityAt: c.updatedAt,
    model: c.model,
    effort: c.effort,
    outputStyle: c.outputStyle ?? "default",
    availableOutputStyles: outputStyleNames(c.customOutputStyles),
    isArchived: c.archived,
    isStarred: c.pinned,
    autoArchiveOnPrClose: c.prAutoArchive ?? (c.codeAutoArchiveExempt ? false : undefined),
    prs: c.pullRequests?.flatMap(pr => {
      const ref = parsePullRequestUrl(pr.url);
      if (!ref || !pr.headRef) return [];
      return [{
        prNumber: pr.number,
        repo: pr.repository,
        url: pr.url,
        host: ref.host,
        provider: ref.host === "github.com" ? "github" : "github-enterprise",
        branch: pr.headRef,
        baseRef: pr.baseRef,
        title: pr.title,
        state: pr.state === "draft" ? "OPEN" : pr.state.toUpperCase(),
        own: pr.own,
        autoFix: pr.autoFix?.ci,
        dismissed: pr.dismissed,
      }];
    }),
    ...(c.importedCliSessionId ? {
      importedFrom: c.importedCodeSource ?? "terminal-cli",
      importedUnconfirmed: c.importedSessionResumePending === true,
      resumeConfirmed: !c.importedSessionResumePending,
    } : {}),
    ...(c.importedSessionResumePending ? {
      error: "Confirm that you trust this imported session before resuming it.",
      errorCategory: "imported_needs_resume_confirm",
    } : {}),
    rewindUndoable: c.rewind?.variant === "pending",
    rewindMarks: [...c.rewind ? [codeRewindMark(c)] : [],
      ...(c.savedBranches ?? []).flatMap(branch => branch.rewindMark ? [{ id: branch.id, ...branch.rewindMark }] : [])],
    isRunning: running,
    turnRunning: running,
    claudexTurnStartedAt: activeTurn?.createdAt,
    ...(error ? { error, errorAt: c.updatedAt } : {}),
    ...(latestTurn?.status === "completed" && c.sessionState === "blocked"
      ? { postTurnSummary: { status_category: "blocked" } }
      : {}),
    hasBackgroundActivity: false,
    hasBackgroundWork: false,
    hasPreClearSession: c.preClearHistory ? true : undefined,
    ...(ssh ? { remoteTarget: ssh.remoteTarget, sshConfig, homePath: ssh.homePath } :
      c.environment?.kind === "wsl" ? { remoteTarget: c.environment } :
        { folderExists: fs.existsSync(cwd), homePath: os.homedir() }),
    permissionMode,
    pendingToolPermissions: permissions,
    ...(suggestions.length ? { backgroundTaskSuggestions: suggestions } : {}),
    ...(c.cloudSpawnedTasks?.length ? { cloudSpawnedTasks: c.cloudSpawnedTasks.map(({ taskId, sessionId, title }) => ({
      taskId, sessionId, title,
    })) } : {}),
    spawningTaskIds: [],
    sdkMcpServers: [],
    claudexKnowledgeEnabled: hiwonderKnowledgeEnabled(c),
    ...(disabledConnectors.length || disabledTools.length
      ? {
          claudexDisabledMcp: {
            connectors: disabledConnectors,
            tools: disabledTools,
          },
        }
      : {}),
    additionalDirectories: [...new Set([
      ...(c.additionalFolders ?? []).filter(folder =>
        !c.additionalWorktrees?.some(tree => tree.state === "deleted" && tree.folders.some(entry => entry.cwd === folder))),
      ...(c.additionalWorktrees ?? []).flatMap(tree =>
        tree.state === "deleted" ? tree.folders.map(entry => entry.origin) : []),
    ])],
    ...(folderWorktrees?.length ? { folderWorktrees } : {}),
    loops: [],
  };
}

/** Local Code operations used by the official desktop composer and transcript. */
export function registerExperimentalCodeSessions(host: NativeHost, isDetectedFolder?: (cwd: string) => boolean) {
  const { ctx } = host;
  const sshEnvironment = (c: Conversation) =>
    c.mode === "code" && !c.incognito && !c.cloudHosted && !c.cloudEnvironmentId &&
    c.environment?.kind === "ssh" ? ctx.sshCodeEnvironment?.(c) : undefined;
  const readable = (c: Conversation) => Boolean(localCode(c) || wslCode(c) || sshEnvironment(c)) &&
    (!c.sessionAuthors?.ownerAccountUuid || c.sessionAuthors.ownerAccountUuid === ctx.account?.()?.id);
  const computerUseFor = (c: Conversation) => {
    if (!ctx.computerUseSettingsState || !localCode(c) || c.archived ||
        c.turns.at(-1)?.status !== "inProgress") return false;
    const owner = ctx.account()?.id;
    return !!owner &&
      (!c.sessionAuthors ||
        (c.sessionAuthors.ownerAccountUuid === owner && c.sessionAuthors.viewerAccountUuid === owner)) &&
      !!ctx.computerUseSettingsState();
  };
  const offerable = (c: Conversation) => Boolean(localCode(c) || sshEnvironment(c));
  const offerWorktreeDefault = (c: Conversation) =>
    (!!c.worktree && c.worktree.state !== "deleted") ||
      c.additionalWorktrees?.some(tree => tree.state !== "deleted") || undefined;
  const canKeepAwake = (c: Conversation) => !c.archived && !c.incognito && readable(c);
  const ultracodeAvailable = (c: Conversation) => !c.incognito &&
    ctx.codeUltracodeAvailable?.(c.providerId, c.model, c.id) === true;
  const sessionDetails = (c: Conversation, permissions?: ToolPermission[], ssh = sshEnvironment(c)) => ({
    ...codeSession(c, permissions, ssh ? undefined : ctx.defaultWorkspace?.(), ssh),
    ultracode: c.codeUltracode === true && ultracodeAvailable(c),
    manualKeepAwake: canKeepAwake(c) && ctx.officialCodeManualKeepAwake?.(c.id) ? true : undefined,
  });
  const commandInventory = createNativeSlashInventory(ctx, "code");
  const prepareCommand = createNativeSlashPreparation(ctx);
  const localCall = (name: string, ...args: unknown[]) => {
    if (!ctx.localCall)
      throw Error("Local Code is not available on this host.");
    return scope.guard(() => ctx.localCall!(name, ...args));
  };
  const selectedFiles = (
    caller: NativeHost["caller"],
    message: string,
    target: string,
  ) => {
    const references = codeComposerFileReferences(message);
    if (!caller || !references.length) return undefined;
    return (budget: number) =>
      host.takeCodeComposerAttachments(caller, references, budget, target);
  };
  const messageIds = new Map<string, Map<string, string>>();
  const commandReceipts = new Map<string, Map<string, CommandReceipt>>();
  const inputHash = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  const receiptCount = () =>
    [...commandReceipts.values()].reduce((n, rows) => n + rows.size, 0);
  const rememberMessage = (id: string, entry: QueuedCodeMessage, force = false) => {
    if (!force && !entry.command && !entry.attachments?.length && !entry.skillReferences?.length) return;
    const rows = commandReceipts.get(id) ?? new Map<string, CommandReceipt>();
    if (!rows.has(entry.uuid) && receiptCount() >= 2000)
      throw Error("The saved message receipt limit has been reached.");
    rows.set(entry.uuid, {
      inputHash: inputHash(entry.message),
      payloadHash: inputHash(entry.sendText ?? entry.message),
      ...(entry.requestHash ? { requestHash: entry.requestHash } : {}),
    });
    commandReceipts.set(id, rows);
  };
  const pending = new Map<string, { uuid: string; start?: CodeSendStart }>();
  const stagingAttachments = new Set<string>();
  const cancellations = new Map<string, object>();
  const stopping = new Map<string, Promise<void>>();
  const isStopping = (id: string) => [...stopping.keys()].some(key =>
    (JSON.parse(key) as [string, unknown])[0] === id);
  const managing = new Set<string>();
  const metadataUpdates = new Map<string, Promise<void>>();
  const queued = new Map<string, QueuedCodeMessage[]>();
  const legacyMigrations = new Map<string, Promise<Conversation | undefined>>();
  const startingIds = new Map<string, CodeSendStart>();
  const initializingWorktrees = new Set<string>();
  const durable = codeSessionState(ctx);
  let loaded = false;
  const recovering = new Set<string>();
  const draining = new Map<string, string>();
  const outstanding = new Map<
    string,
    { request: ToolPermission; approval: Approval }
  >();
  const computerUseCards = new Map<string, ReturnType<typeof coworkComputerUseCard>>();
  const permissionIds = new Map<string, string>();
  const permissionRevisions = new Map<string, number>();
  const revisions = new Map<string, number>();
  const announced = new Map<string, Map<string, string>>();
  const partialReplies = new Map<string, string[]>();
  const pendingReplies = (c: Conversation) => {
    const turn = c.turns.at(-1);
    return turn?.status === "inProgress" ? turn.items
      .filter(item => item.type === "agentMessage" && itemIsRunning(item))
      .map(item => `${turn.id}:item:${item.id}`) : [];
  };
  const activeRetries = new Map<string, CodeApiRetryMessage>();
  const promptSuggestions = new Map<string, {
    suggestion: NonNullable<Conversation["promptSuggestion"]>;
    announced: boolean;
  }>();
  const autoArchivedSessions = new Set<string>();
  const settledTurns = new Map<string, Turn[]>();
  const runningSessions = new Set<string>();
  const resolvingOffers = new Map<string, { uuid: string }>();
  const offeredInput = (c: Conversation) => c.codeNewTask?.nativeInput?.uuid ?? resolvingOffers.get(c.id)?.uuid;
  const nextPrWaits = new Map<string, NextPrWait>();
  const clearNextPrWaits = () => {
    for (const waiter of nextPrWaits.values()) waiter.finish("dropped");
  };
  let clearHistory = () => {};
  const scope = sessionAccountScope(ctx, () => {
    clearHistory();
    messageIds.clear();
    commandReceipts.clear();
    pending.clear();
    stagingAttachments.clear();
    cancellations.clear();
    stopping.clear();
    managing.clear();
    metadataUpdates.clear();
    queued.clear();
    legacyMigrations.clear();
    resolvingOffers.clear();
    startingIds.clear();
    initializingWorktrees.clear();
    draining.clear();
    outstanding.clear();
    computerUseCards.clear();
    permissionIds.clear();
    permissionRevisions.clear();
    revisions.clear();
    announced.clear();
    partialReplies.clear();
    activeRetries.clear();
    promptSuggestions.clear();
    autoArchivedSessions.clear();
    settledTurns.clear();
    runningSessions.clear();
    clearNextPrWaits();
    recovering.clear();
    loaded = false;
  });
  const load = () => {
    scope.sync();
    if (loaded) return;
    const saved = durable.read();
    for (const [id, entries] of saved.queues) {
      queued.set(id, entries);
      recovering.add(id);
    }
    for (const [id, entries] of saved.messageIds)
      messageIds.set(id, new Map(entries));
    for (const [id, rows] of saved.commandReceipts ?? [])
      commandReceipts.set(id, new Map(rows));
    loaded = true;
  };
  const persist = () => {
    scope.sync();
    durable.write({
      version: 1,
      queues: [...queued],
      commandReceipts: [...commandReceipts].map(([id, rows]) => [
        id,
        [...rows],
      ]),
      messageIds: [...messageIds].map(([id, entries]) => [id, [...entries]]),
    });
  };
  const stillCurrent = () => {
    try {
      scope.sync();
      return true;
    } catch {
      return false;
    }
  };
  const on = (name: string, handler: (...args: any[]) => unknown) =>
    host.on(name, (...args) =>
      scope.run(() => {
        load();
        return handler(...args);
      }),
    );
  const publishRetry = (c: Conversation, replay = false) => {
    const id = publicId(c.id);
    const previous = activeRetries.get(id);
    const next = c.archived ? undefined : codeApiRetryMessage(id, c.turns.at(-1));
    if ((!next || !replay) && isDeepStrictEqual(previous, next)) return;
    if (next) activeRetries.set(id, next);
    else activeRetries.delete(id);
    host.emit("LocalSessions", "onEvent", {
      type: "message",
      sessionId: id,
      message: next ?? codeApiRetryClearedMessage(id),
    });
  };
  const publishPromptSuggestion = (
    id: string,
    next?: Conversation["promptSuggestion"],
  ) => {
    const previous = promptSuggestions.get(id);
    if (next) {
      if (previous?.announced && previous.suggestion.turnId === next.turnId &&
          previous.suggestion.text === next.text) return;
      promptSuggestions.set(id, { suggestion: next, announced: true });
    } else if (!promptSuggestions.delete(id)) return;
    host.emit("LocalSessions", "onEvent", {
      type: "prompt_suggestion",
      sessionId: id,
      data: next?.text ?? "",
    });
  };
  const convert = (c: Conversation) => {
    // The engine replaces a provisional turn id as soon as Codex starts it.
    // Hide only live provisional IDs. A failed/interrupted provisional turn is
    // already durable history and must retain its input and error after reopen.
    const stableTurns = c.turns.filter(
      (turn) => !turn.id.startsWith("pending-") || turn.status !== "inProgress",
    );
    const converted = convertCodeTranscript(
      {
        ...c,
        id: publicId(c.id),
        turns: stableTurns,
      },
      undefined,
      { mcpServers: ctx.settings?.().mcpServers },
    );
    if (
      stableTurns.length !== c.turns.length &&
      !converted.unsupported.includes("running-turn")
    )
      converted.unsupported.push("running-turn");
    const ids = messageIds.get(c.id);
    if (ids)
      for (const row of converted.rows) {
        row.uuid = ids.get(row.uuid) ?? row.uuid;
        if (row.parentUuid)
          row.parentUuid = ids.get(row.parentUuid) ?? row.parentUuid;
      }
    return converted;
  };
  const hydrateTranscript = (c: Conversation, rows: CodeTranscriptRow[]) => {
    if (!rows.some((row) => row.codeOutput || row.file_attachments?.length)) return rows;
    const root = ctx.stateDirectory?.();
    const attachments = new Map<string, Attachment>();
    const collect = (files: Attachment[]) => {
      for (const file of files) attachments.set(file.id, file);
    };
    for (const turn of c.turns) {
      collect(turn.attachments);
      for (const item of turn.items) {
        const steer = codeSteerTranscriptInput(turn, item);
        if (steer) collect(steer.attachments);
      }
    }
    const turns = new Map(c.turns.map((turn) => [turn.id, turn]));
    const withApi = !c.incognito && ctx.withOfficialApiScope;
    const hydrate = () => rows.map((row) => {
      if (row.codeOutput) {
        const { turnId, itemId, fileId } = row.codeOutput;
        const turn = turns.get(turnId);
        const item = turn?.items.find((entry) => entry.id === itemId);
        const file = item?.generatedFiles?.find((entry) => entry.id === fileId);
        const attachment = withApi && turn && item && (!fileId || file)
          ? codeOutputAttachment(ctx, c, turn, item, file)
          : undefined;
        return hydrateCodeOutput(row, attachment);
      }
      if (!row.file_attachments?.length || typeof row.message.content !== "string")
        return row;
      const loaded = new Set<string>();
      const referenced = row.file_attachments.flatMap(({ file_uuid }) => {
        const file = attachments.get(file_uuid);
        return file ? [file] : [];
      });
      const { content } = attachmentTranscript(row.message.content, referenced, (attachment) => {
        const data = storedAttachmentImage(root, attachment);
        if (data) loaded.add(attachment.id);
        return data;
      });
      if (withApi)
        for (const file of referenced)
          if (!loaded.has(file.id)) learnAttachment(file, c.id);
      if (!loaded.size) return row;
      const files = row.file_attachments.filter((file) => !loaded.has(file.file_uuid));
      return {
        ...row,
        message: { ...row.message, content },
        file_attachments: files.length ? files : undefined,
      };
    });
    return withApi ? withApi(() => {
      const hydrated = hydrate();
      flushGeneratedOutputBindings();
      return hydrated;
    }) : hydrate();
  };
  const queueFor = (conversationId: string) => queued.get(conversationId) ?? [];
  const setQueue = (conversationId: string, entries: QueuedCodeMessage[]) => {
    const previous = queued.get(conversationId);
    if (entries.length) queued.set(conversationId, entries);
    else queued.delete(conversationId);
    try {
      persist();
    } catch (error) {
      if (previous) queued.set(conversationId, previous);
      else queued.delete(conversationId);
      throw error;
    }
  };
  const holdUnsent = (id: string, uuid: string) => {
    const entries = queueFor(id);
    if (entries.some((entry) => entry.uuid === uuid && entry.state === "submitting"))
      setQueue(id, entries.map((entry) => {
        if (entry.uuid !== uuid || entry.state !== "submitting") return entry;
        const { before, ...saved } = entry;
        return { ...saved, state: "queued", requiresConfirmation: true };
      }));
  };
  const queuedRow = (
    c: Conversation,
    entry: QueuedCodeMessage,
    parentUuid: string | null,
  ) => {
    const text = queuedCodeComposerText(entry.message, entry.attachments ?? []);
    const offset = text.length - entry.message.length;
    return {
    type: "user" as const,
    uuid: entry.uuid,
    parentUuid,
    sessionId: publicId(c.id),
    timestamp: new Date(entry.createdAt).toISOString(),
    isSidechain: false as const,
    priority: entry.state === "steered" ? "next" : "later",
    ...(entry.skillReferences?.length ? { claudexSkillSelection: {
      text,
      references: entry.skillReferences.map(ref => ({ ...ref, start: ref.start + offset, end: ref.end + offset })),
    } } : {}),
    client_platform: "desktop_app",
    message: {
      role: "user" as const,
      content: attachmentTranscript(
        text,
        entry.attachments ?? [],
        (a) => storedAttachmentImage(ctx.stateDirectory?.(), a),
      ).content,
    },
    };
  };
  const withQueuedRows = (c: Conversation, transcript: CodeTranscriptRow[]) => {
    const offer = offeredInput(c);
    const entries = queueFor(c.id).filter(entry => entry.uuid !== offer);
    if (!entries.length) return transcript;
    const messages = [...transcript];
    const displayed = new Set(transcript.map((row) => row.uuid));
    for (const entry of entries)
      if (!displayed.has(entry.uuid))
        messages.push(queuedRow(c, entry, messages.at(-1)?.uuid ?? null));
    return messages;
  };
  const emitQueuedMessage = (
    c: Conversation,
    uuid: string,
    message: string,
  ) => {
    const transcript = convert(c).rows;
    host.emit("LocalSessions", "onEvent", {
      type: "message",
      sessionId: publicId(c.id),
      message: queuedRow(
        c,
        queueFor(c.id).find((entry) => entry.uuid === uuid) ?? {
          uuid,
          message,
          state: "queued",
          createdAt: Date.now(),
        },
        transcript.at(-1)?.uuid ?? null,
      ),
    });
  };
  const emitWithdrawnMessage = async (c: Conversation, uuid: string) => {
    host.emit("LocalSessions", "onEvent", {
      type: "held_input_withdrawn",
      sessionId: publicId(c.id),
      withdrawnUuids: [uuid],
      session: await view(c),
    });
  };
  const running = (c: Conversation) =>
    c.turns.some((turn) => turn.status === "inProgress");
  const messagePresent = (c: Conversation, entry: QueuedCodeMessage) => {
    return c.turns.some((turn) =>
      turn.items.some(
        (item) =>
          item.type === "userMessage" &&
          (item.clientId === entry.messageId ||
            (entry.messageId === undefined &&
              item.text === (entry.sendText ?? entry.message))),
      ),
    );
  };
  const reconcileQueued = (c: Conversation) => {
    const entries = queueFor(c.id);
    if (!entries.length) return;
    const unknownSteers = entries.filter(
      (entry) => entry.state === "submitting" && entry.delivery === "steer",
    );
    const next = entries.flatMap((entry) => {
      if ((c.cloudSpawnedTasks ?? []).some(link => link.messageUuid === entry.uuid)) {
        rememberMessage(c.id, entry, true);
        return [];
      }
      if (entry.state === "submitting") {
        if (entry.delivery === "steer") {
          const text = entry.sendText ?? entry.message;
          const ids = messageIds.get(c.id) ?? new Map<string, string>();
          const matches = c.turns.flatMap((turn) =>
            turn.items.flatMap((item) => {
              if (
                item.type !== "userMessage" ||
                item.steered !== true ||
                item.text !== text ||
                entry.beforeItems?.includes(item.id)
              )
                return [];
              const uuid =
                item.officialCodeEventId ??
                (item.clientId || `${turn.id}:item:${item.id}`);
              const assigned = ids.get(uuid);
              return assigned && assigned !== entry.uuid
                ? []
                : [{ id: item.id, uuid }];
            }),
          );
          if (matches.length !== 1) return [entry];
          const match = matches[0];
          if (
            unknownSteers.some(
              (other) =>
                other !== entry &&
                (other.sendText ?? other.message) === text &&
                !other.beforeItems?.includes(match.id),
            )
          )
            return [entry];
          ids.set(match.uuid, entry.uuid);
          messageIds.set(c.id, ids);
          rememberMessage(c.id, entry);
          return [];
        }
        const matches = c.turns.filter(
          (turn) =>
            (!turn.id.startsWith("pending-") || turn.status !== "inProgress") &&
            (!turn.undispatchedCodeSendUuid || turn.undispatchedCodeSendUuid === entry.uuid) &&
            !entry.before?.includes(turn.id) &&
            turn.prompt === (entry.sendText ?? entry.message),
        );
        const proven = matches.filter(
          (turn) => turn.undispatchedCodeSendUuid === entry.uuid,
        );
        const candidates = proven.length ? proven : matches;
        if (candidates.length !== 1) return [entry]; // Delivery is unknown: never resend automatically.
        const turn = candidates[0];
        const ids = messageIds.get(c.id) ?? new Map<string, string>();
        const userUuid = turn.officialCodeEventId ?? `${turn.id}:user`;
        if (ids.get(userUuid) !== entry.uuid) {
          ids.set(userUuid, entry.uuid);
          messageIds.set(c.id, ids);
          if (turn.id.startsWith("pending-")) persist();
        }
        if (turn.id.startsWith("pending-") &&
            !(turn.status === "failed" && turn.undispatchedCodeSendUuid === entry.uuid))
          return [entry];
        rememberMessage(c.id, entry);
        return [];
      }
      if (entry.state !== "steered") return [entry];
      if (messagePresent(c, entry)) {
        rememberMessage(c.id, entry);
        return [];
      }
      return running(c)
        ? [entry]
        : [{ ...entry, state: "queued" as const, messageId: undefined }];
    });
    if (
      next.length !== entries.length ||
      next.some((entry, index) => entry !== entries[index])
    )
      setQueue(c.id, next);
  };
  const drainQueued = async (c: Conversation, targetUuid?: string) => {
    if (c.archived || managing.has(c.id)) return;
    reconcileQueued(c);
    if (running(c) || draining.has(c.id) || pending.has(c.id)) return;
    const entries = queueFor(c.id);
    const entry =
      targetUuid === undefined
        ? entries[0]
        : entries.find((item) => item.uuid === targetUuid);
    if (entry?.state !== "queued") return;
    if (
      targetUuid === undefined &&
      (entry.requiresConfirmation ||
        ["interrupted", "failed"].includes(c.turns.at(-1)?.status ?? ""))
    )
      return;
    draining.set(c.id, entry.uuid);
    const cancellation = cancellations.get(c.id);
    const start = new CodeSendStart();
    try {
      const before = new Set(c.turns.map((turn) => turn.id));
      if (entry.attachments?.length)
        await localCall(
          "officialRestoreCodeAttachments",
          entry.attachments.map((a) => a.id),
        );
      if (cancellations.get(c.id) !== cancellation) return;
      setQueue(
        c.id,
        queueFor(c.id).map((item) =>
          item.uuid === entry.uuid
            ? { ...item, state: "submitting", before: [...before] }
            : item,
        ),
      );
      pending.set(c.id, { uuid: entry.uuid, start });
      const updated = (await localCall("send", {
        conversationId: c.id,
        continueCodeSession: true,
        mode: "code",
        text: entry.sendText ?? entry.message,
        ...(entry.skillReferences?.length ? { skillReferences: entry.skillReferences } : {}),
        attachments: entry.attachments?.map((a) => ({ id: a.id })) ?? [],
        providerId: c.providerId,
        model: c.model,
      }, {
        [officialCodeSendStart]: start,
        ...(entry.command ? { slashInput: { text: entry.message, uuid: entry.uuid } } : {}),
      })) as Conversation;
      const accepted =
        updated?.id === c.id &&
        updated.turns.some(
          (turn) =>
            (!turn.id.startsWith("pending-") || turn.status === "inProgress") &&
            !before.has(turn.id) &&
            turn.prompt === (entry.sendText ?? entry.message),
        );
      if (updated?.id === c.id) reconcileQueued(updated);
      if (entry.command && !accepted)
        throw Error(
          "The command delivery could not be confirmed; check the session before retrying.",
        );
      return accepted;
    } catch (error) {
      if (!stillCurrent()) throw error;
      if (start.cancelledBeforeDispatch) {
        holdUnsent(c.id, entry.uuid);
        return false;
      }
      ctx.log("[official-ui] queued Code send failed", String(error));
      host.emit("LocalSessions", "onEvent", {
        type: "error",
        sessionId: publicId(c.id),
        error: `The queued message could not be confirmed. It is saved; check the session before sending it again. ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      if (stillCurrent()) {
        const current = pending.get(c.id);
        if (current?.uuid === entry.uuid) pending.delete(c.id);
        draining.delete(c.id);
      }
    }
  };
  const steerQueued = async (c: Conversation, entry: QueuedCodeMessage) => {
    if (entry.skillReferences?.length) return false;
    const cancellation = cancellations.get(c.id);
    draining.set(c.id, entry.uuid);
    try {
      if (entry.attachments?.length)
        await localCall(
          "officialRestoreCodeAttachments",
          entry.attachments.map((a) => a.id),
        );
      if (cancellations.get(c.id) !== cancellation)
        throw Error("The Code message was cancelled before dispatch.");
      const attempted: QueuedCodeMessage = {
        ...entry,
        state: "submitting",
        delivery: "steer",
        before: c.turns.map((turn) => turn.id),
        beforeItems: c.turns.flatMap((turn) =>
          turn.items.map((item) => item.id),
        ),
      };
      const existing = queueFor(c.id);
      setQueue(
        c.id,
        existing.some((item) => item.uuid === entry.uuid)
          ? existing.map((item) =>
              item.uuid === entry.uuid ? attempted : item,
            )
          : [...existing, attempted],
      );
      const result = (await localCall(
        "steerTurn",
        c.id,
        entry.sendText ?? entry.message,
        entry.attachments?.map((a) => a.id) ?? [],
      )) as { messageId?: string; conversation?: Conversation } | null;
      if (entry.command && !result?.messageId)
        throw Error(
          "The command steering result is unknown; it will not be replayed automatically.",
        );
      if (result?.messageId) {
        rememberMessage(c.id, entry);
        const ids = messageIds.get(c.id) ?? new Map<string, string>();
        ids.set(result.messageId, entry.uuid);
        messageIds.set(c.id, ids);
      }
      setQueue(
        c.id,
        queueFor(c.id).map((item) =>
          item.uuid === entry.uuid
            ? {
                ...entry,
                state: result?.messageId ? "steered" : "queued",
                ...(cancellations.get(c.id) !== cancellation ? {requiresConfirmation:true} : {}),
                messageId: result?.messageId,
              }
            : item,
        ),
      );
      if (result?.conversation) reconcileQueued(result.conversation);
      return !!result?.messageId;
    } finally {
      if (stillCurrent()) draining.delete(c.id);
    }
  };
  const list = async () => {
    if (!ctx.localListConversations)
      throw Error("Local Code is not available on this host.");
    return (await scope.guard(() => ctx.localListConversations!())).filter(readable);
  };
  const approvals = async () =>
    ((await localCall("snapshot")) as { approvals: Approval[] }).approvals;
  const computerUseState = () => localCall("computerUseState") as Promise<ComputerUseState>;
  const remoteControlStartState = () => {
    if (!ctx.account()?.id) return { defaultOn: false, overridable: false, unavailable: "signed_out" };
    const link = ctx.localRemoteControlStatus?.();
    if (!link || link.cause === "sign_in")
      return { defaultOn: false, overridable: false, unavailable: "unverified" };
    if (ctx.readOnly || !ctx.officialRemoteControlOrigin?.() || !preference(ctx.settings(), "remoteControl"))
      return { defaultOn: false, overridable: false, unavailable: "unavailable" };
    return { defaultOn: preference(ctx.settings(), "remoteControlNewSessions"), overridable: true };
  };
  const remoteControlSession = (c: Conversation) => {
    const available = !c.archived && !c.incognito && c.environment?.kind !== "space" &&
      c.worktree?.state !== "deleted" && remoteControlStartState().overridable;
    const link = available && !c.remoteControlOff ? ctx.localRemoteControlStatus?.() : undefined;
    const origin = ctx.officialRemoteControlOrigin?.();
    const url = link?.online && origin &&
      new URL(`/code/session_${c.id.replaceAll("-", "")}`, origin);
    if (url && link) url.searchParams.set("device", link.id);
    return {
      remoteControlAvailable: available,
      ...(!link ? {} : url ?
        { bridgeSessionUrl: url.href } :
        { remoteControlConnecting: true }),
    };
  };
  const elicitationFor = (a: Approval, c: Conversation) => {
    const offer = ctx.respondToLocalCodeElicitation && codeElicitationOffer(a, c);
    const editorApproval = offer?.toolName === editorApprovalServerName &&
      typeof a.id === "string" && a.id.startsWith("app:");
    if (c.environment?.kind === "ssh" && offer?.toolName !== browserMcpServerName && !editorApproval) return;
    return offer;
  };
  const permission = (a: Approval, c: Conversation): ToolPermission | undefined => {
    if (
      a.conversationId !== c.id ||
      (c.sessionAuthors?.ownerAccountUuid &&
        c.sessionAuthors.ownerAccountUuid !== ctx.account?.()?.id)
    )
      return;
    const ssh = c.environment?.kind === "ssh";
    if (!ssh && (
      a.method === "item/commandExecution/requestApproval" ||
      a.method === "item/fileChange/requestApproval" ||
      a.method === "item/permissions/requestApproval"
    ))
      return ctx.codeCommandPermissions?.project(a.id, c.id);
    const offer = elicitationFor(a, c);
    if (!offer) return ssh ? undefined : toolPermission(a, c, ctx.settings?.().mcpServers);
    const previousId = permissionIds.get(String(a.id));
    const previous = previousId && outstanding.get(previousId);
    if (
      previous &&
      previous.approval === a &&
      isDeepStrictEqual(previous.request, { ...offer, requestId: previousId })
    )
      return previous.request;
    const request = { ...offer, requestId: `${elicitationPrefix}${randomUUID()}` };
    return request;
  };
  const resolvePermission = (id: string) => {
    const token = permissionIds.get(id) ?? id,
      request = outstanding.get(token)?.request;
    permissionIds.delete(id);
    outstanding.delete(token);
    if (request)
      host.emit("LocalSessions", "onEvent", {
        type: "tool_permission_resolved",
        sessionId: request.sessionId,
        request,
      });
  };
  const rememberPermission = (a: Approval, request: ToolPermission) => {
    const id = String(a.id),
      previous = permissionIds.get(id) ?? id;
    if (previous !== request.requestId) resolvePermission(id);
    if (id !== request.requestId) permissionIds.set(id, request.requestId);
    if (outstanding.get(request.requestId)?.request !== request)
      outstanding.set(request.requestId, { request, approval: a });
  };
  const view = async (c: Conversation, reconcile = true) => {
    const ssh = sshEnvironment(c);
    if (reconcile) reconcileQueued(c);
    const before = new Map(permissionRevisions);
    const requests = (await approvals()).flatMap((a) => {
      const request = permission(a, c);
      if (
        !request ||
        (permissionRevisions.get(String(a.id)) ?? 0) !==
          (before.get(String(a.id)) ?? 0)
      )
        return [];
      rememberPermission(a, request);
      return [request];
    });
    if (computerUseFor(c)) {
      const state = await computerUseState();
      for (const pending of state.requests ?? []) {
        if (pending.conversationId !== c.id) continue;
        const card = coworkComputerUseCard(pending, state);
        computerUseCards.set(pending.id, card);
        requests.push(card);
      }
    }
    const latestTurn = c.turns.at(-1);
    const suggestion = !c.archived && !c.incognito &&
      latestTurn?.status === "completed" && c.promptSuggestion?.turnId === latestTurn.id &&
      !running(c) &&
      preference(ctx.settings(), "ccPromptSuggestions")
      ? c.promptSuggestion.text : undefined;
    const session = {
      ...sessionDetails(c, requests, ssh),
      ...remoteControlSession(c),
      ...(suggestion ? { promptSuggestion: suggestion } : {}),
    };
    const offer = offeredInput(c);
    const held = queueFor(c.id).filter(
      (entry) =>
        entry.uuid !== offer && ((entry.state === "submitting" &&
          !c.turns.some(
            (turn) =>
              turn.status === "inProgress" &&
              !entry.before?.includes(turn.id) &&
              turn.prompt === (entry.sendText ?? entry.message),
          )) ||
        entry.requiresConfirmation ||
        ["interrupted", "failed"].includes(c.turns.at(-1)?.status ?? "")),
    );
    const unconfirmed = held.some((entry) => entry.state === "submitting");
    return {
      ...session,
      ...(held.length
        ? {
            sendsHeldAfterError: held.map((entry) => entry.uuid),
            heldInput: {
              uuids: held.map((entry) => entry.uuid),
              since: held[0].createdAt,
            },
            ...(unconfirmed
              ? {
                  error:
                    "A saved message's delivery could not be confirmed. Check the session before sending it again.",
                }
              : {}),
          }
        : {}),
    };
  };
  const migrateLegacyOffer = async (
    c: Conversation,
  ): Promise<Conversation | undefined> => {
    const existing = legacyMigrations.get(c.id);
    if (existing) return scope.guard(() => existing);
    const offer = c.codeNewTask;
    if (!offer || offer.nativeInput || offer.attachments.length) return c;
    const migrate = async () => {
      const uuid = "legacy-task-" + offer.id;
      const previous = queueFor(c.id).find((entry) => entry.uuid === uuid);
      // A recovered, edited held message must not silently release a different offer.
      if (previous && previous.message !== offer.text)
        throw Error(
          "The saved Code input changed; review it before continuing.",
        );
      const staged: QueuedCodeMessage | undefined = previous
        ? undefined
        : {
            uuid,
            message: offer.text,
            state: "queued",
            createdAt: c.updatedAt,
            requiresConfirmation: true,
          };
      if (staged) setQueue(c.id, [...queueFor(c.id), staged]);
      const released = await localCall(
        "officialReleaseCodeNewTask",
        c.id,
        offer.id,
        offer.text,
      );
      if (released !== true && released !== false)
        throw Error("The legacy Code input release was not confirmed.");
      if (released === false && staged) {
        // Compare object identity: don't remove a user edit or another activation's entry.
        setQueue(
          c.id,
          queueFor(c.id).filter((entry) => entry !== staged),
        );
      }
      // Never mutate the pre-await snapshot. A newer offer may now occupy it.
      return scope.guard(() => ctx.localLoadConversation!(c.id));
    };
    const work = migrate();
    legacyMigrations.set(c.id, work);
    try {
      return await work;
    } finally {
      if (legacyMigrations.get(c.id) === work) legacyMigrations.delete(c.id);
    }
  };
  const get = async (id: string, includeSsh = false) => {
    const key = internalId(id);
    if (!key) return undefined;
    if (!ctx.localLoadConversation)
      throw Error("Local Code is not available on this host.");
    let c = await scope.guard(() => ctx.localLoadConversation!(key));
    if (!c || !readable(c) || !(localCode(c) || wslCode(c) || includeSsh && sshEnvironment(c))) return undefined;
    if (!c.archived && !managing.has(c.id) && (localCode(c) || wslCode(c)) && (c.codeNewTask || legacyMigrations.has(c.id))) {
      c = await migrateLegacyOffer(c);
      if (!c || !readable(c) || !(localCode(c) || wslCode(c))) return undefined;
    }
    if (c.codeNewTask?.nativeInput) {
      const entry = queueFor(c.id).find(item => item.uuid === c!.codeNewTask!.nativeInput!.uuid);
      if (entry && !commandReceipts.get(c.id)?.has(entry.uuid)) {
        rememberMessage(c.id, entry, true);
        persist();
      }
    }
    reconcileQueued(c);
    if (!c.archived && !managing.has(c.id) && recovering.delete(key)) {
      // Reads hydrate saved input; a fresh full read precedes any resumed send.
      setTimeout(() => {
        void (async () => {
          scope.sync();
          const current = await get(id, includeSsh);
          if (current) await drainQueued(current);
        })().catch((error) =>
          ctx.log("[official-ui] Code queue recovery failed", String(error)),
        );
      }, 250);
    }
    return c;
  };
  const tasks = createCodeTasks({
    get: async id => {
      const c = await get(id, true);
      return c && readable(c) ? c : undefined;
    },
    call: localCall,
    writable: () => !ctx.readOnly && ctx.isCurrent?.() !== false,
  });
  on("LocalSessions.stopTask", tasks.stop);
  on("LocalSessions.getTaskOutput", tasks.output);
  const readTranscript = async (id: string, replayRetry = false) => {
    const revision = revisions.get(id);
    const c = await get(id, true);
    if (!c) throw new Error("Code session not found");
    await tasks.hydrate(c);
    if (revisions.get(id) === revision && running(c)) runningSessions.add(id);
    const converted = convert(c);
    if (!announced.has(id))
      announced.set(
        id,
        new Map(converted.rows.map((row) => [row.uuid, JSON.stringify(row)])),
      );
    const partial = pendingReplies(c);
    if (partial.length) partialReplies.set(id, partial);
    if (
      process.env.CLAUDEX_OFFICIAL_UI_E2E === "1" &&
      process.env.CLAUDEX_CODE_DIAGNOSTICS === "1" &&
      c.turns.some((turn) => turn.prompt.includes("CODE_FILE_E2E"))
    )
      ctx.log?.(
        "[official-ui] test file record shapes",
        JSON.stringify(
          c.turns.flatMap((turn) =>
            turn.items
              .filter((item) => item.type === "fileChange")
              .map((item) => ({
                status: item.status,
                lifecycle: item.lifecycleStatus,
                generatedCount: item.generatedFiles?.length ?? 0,
                changes: item.changes?.map((change) => ({
                  kind:
                    typeof change.kind === "string"
                      ? change.kind
                      : change.kind?.type,
                  moved: !!change.kind?.move_path,
                  hasDiff: typeof change.diff === "string",
                  diffLength: change.diff?.length ?? 0,
                  hasHunk: /^@@ -\d/m.test(change.diff ?? ""),
                  hasCR: (change.diff ?? "").includes("\r"),
                })),
              })),
          ),
        ),
      );
    if (replayRetry && revisions.get(id) === revision) publishRetry(c, true);
    return { conversation: c, rows: withQueuedRows(c, converted.rows) };
  };
  const connectors = sessionConnectors(get, localCall, ctx);
  const sessionView = async (c: Conversation) => {
    const session = await view(c);
    scope.sync();
    if (!localCode(c)) return session;
    // The original connector controls synchronize their catalog separately.
    // History must open even if that discovery is still pending.
    return { ...session, enabledMcpTools: connectors.cachedEnabledMcpTools(c) };
  };
  on("LocalSessions.setMcpServers", connectors.setMcpServers);
  on(
    "LocalSessions.replaceRemoteMcpServers",
    connectors.replaceRemoteMcpServers,
  );
  on("LocalSessions.replaceEnabledMcpTools", connectors.replaceEnabledMcpTools);
  // A menu/list read is never authority to recover or dispatch saved input.
  const listed = async () => Promise.all((await list()).map(c => view(c, false)));
  const historyOperations = new Map<string, object>();
  const historyIdle = (id: string) => {
    if (pending.has(id) || queued.get(id)?.length || draining.has(id) ||
        stagingAttachments.has(id) || isStopping(id))
      throw Error("Wait for queued Code work to settle before changing history.");
  };
  const readHistorySession = async (id: string, includeSsh = false) => {
    const c = await readOpenedSession(id, includeSsh);
    historyIdle(c.id);
    if (c.incognito || c.archived || c.worktree?.state === "deleted" || c.codeNewTask)
      throw Error("Restore this Code session and settle saved input before changing history.");
    return c;
  };
  const forkSession = createCodeFork({
    current: () => stillCurrent() && ctx.isCurrent?.() !== false && !ctx.readOnly,
    load: async id => {
      const c = await readOpenedSession(id);
      historyIdle(c.id);
      if (c.incognito || c.codeNewTask) throw Error("Settle saved input before forking this Code session.");
      return c;
    },
    convert,
    fork: (id, options) => {
      historyIdle(id);
      return localCall("forkConversation", id, options) as Promise<Conversation>;
    },
    reserve: (requestId, payloadHash) => reserveCodeFork(ctx, {requestId, payloadHash}).fresh,
  });
  const rewindSession = createCodeRewind({
    current: () => stillCurrent() && ctx.isCurrent?.() !== false && !ctx.readOnly,
    load: readHistorySession,
    convert,
    call: (method, id, turn) => {
      historyIdle(id);
      return localCall(method, id, ...(turn === undefined ? [] : [turn])) as Promise<Conversation>;
    },
    reserve: (requestId,payloadHash,undo) => reserveCodeRewind(ctx,{requestId,payloadHash},undo).fresh,
    switchSavedMark: (id, mark) => localCall("officialCodeSwitchRewindMark", id, mark, () => stillCurrent() && ctx.isCurrent?.() !== false && !ctx.readOnly) as Promise<Conversation>,
    files: (id, turn, dryRun) => localCall("officialCodeRewindFiles", id, turn, dryRun, () => stillCurrent() && ctx.isCurrent?.() !== false && !ctx.readOnly),
  });
  clearHistory = () => { forkSession.clear(); rewindSession.clear(); historyOperations.clear(); };
  const changeHistory = async <T>(session: unknown, operation: () => Promise<T>): Promise<T> => {
    if (typeof session !== "string" || !/^local_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(session))
      throw Error("An owned local Code session is required.");
    const id = internalId(session);
    if (managing.has(id)) throw Error("A Code session change is already pending.");
    historyIdle(id);
    const token = {};
    historyOperations.set(id, token);
    managing.add(id);
    try { return await operation(); }
    finally {
      if (stillCurrent() && historyOperations.get(id) === token) {
        historyOperations.delete(id);
        managing.delete(id);
      }
    }
  };
  on("LocalSessions.rewindV2", (id: unknown, message: unknown) =>
    changeHistory(id, () => rewindSession.rewind(id, message)));
  on("LocalSessions.rewind", (id: unknown, message: unknown) =>
    changeHistory(id, async () => (await rewindSession.rewind(id, message)).prefill));
  on("LocalSessions.undoRewind", (id: unknown) =>
    changeHistory(id, () => rewindSession.undo(id)));
  const sessionMutationCurrent = () => stillCurrent() && ctx.isCurrent?.() !== false && !ctx.readOnly;
  const codeClear = async (id: string, action: "clear" | "restore") => {
    const c = await readHistorySession(id, true);
    if (running(c)) throw Error("Wait for this Code session to finish.");
    if (action === "restore" && !c.preClearHistory) return undefined;
    return await localCall("officialCodeClearHistory", c.id, action, sessionMutationCurrent) as Conversation | undefined;
  };
  const clearSession = (id: string, keepForRestore?: unknown) =>
    changeHistory(id, async () => {
      const keep = z.boolean().optional().parse(keepForRestore);
      let saved: Conversation | undefined;
      if (keep === false) {
        const c = await readHistorySession(id);
        const first = convert({ ...c, turns: c.turns.slice(0, 1) }).rows[0];
        if (first?.type !== "user") throw Error("A complete first prompt is required.");
        await rewindSession.rewind(id, first.uuid);
        saved = await readHistorySession(id);
      } else {
        saved = await codeClear(id, "clear");
      }
      if (!saved || saved.turns.length || saved.threadId)
        throw Error("The cleared Code conversation could not be confirmed.");
      announced.delete(id);
      partialReplies.delete(id);
      activeRetries.delete(id);
      publishPromptSuggestion(id);
      settledTurns.delete(id);
      runningSessions.delete(id);
      host.emit("LocalSessions", "onEvent", {
        type: "cleared",
        sessionId: id,
        session: { ...sessionDetails(saved),
          ...remoteControlSession(saved) },
        hasPreClearSession: !!saved.preClearHistory,
      });
    });
  on("LocalSessions.clearSession", clearSession);
  on("LocalSessions.resumePreClearSession", (id: string) =>
    changeHistory(id, async () => {
      const saved = await codeClear(id, "restore");
      if (!saved) return null;
      const { rows } = convert(saved);
      return hydrateTranscript(saved, rows);
    }));
  on("LocalSessions.forkSession", (parent: unknown, requested: unknown, message?: unknown, targetCwd?: unknown) =>
    changeHistory(parent, () => forkSession(parent, requested, message, targetCwd)));
  on("LocalSessions.rewindFiles", (id: unknown, message: unknown, dryRun: unknown) =>
    changeHistory(id, () => rewindSession.files(id, message, dryRun)));
  on("LocalSessions.switchRewindMark", (id: unknown, mark: unknown) =>
    changeHistory(id, () => rewindSession.switchMark(id, mark)));
  on("LocalSessions.rewindToRefusedPrompt", (id: unknown) =>
    changeHistory(id, () => rewindSession.refusedPrompt(id)));
  on("LocalSessions.getAll", listed);
  let listGeneration = 1;
  on("LocalSessions.getSessionList", async () => ({
    loadGeneration: listGeneration,
    sessions: await listed(),
    archivedPending: false,
  }));
  on("LocalSessions.getRemoteControlStartState", remoteControlStartState);
  on("LocalSessions.toggleRemoteControl", async (id: string, raw: unknown) => {
    const enabled = z.boolean().parse(raw);
    const c = await readOpenedSession(id, true);
    if (enabled && !remoteControlSession(c).remoteControlAvailable)
      return { ok: false, reason: "unavailable" };
    const saved = await localCall("updateConversation", c.id, { remoteControl: enabled }) as Conversation;
    return { ok: saved.id === c.id && (enabled ? !saved.remoteControlOff : saved.remoteControlOff === true) };
  });
  on("LocalSessions.getSession", async (id: string) => {
    const revision = revisions.get(id);
    const c = await get(id, true);
    if (!c) return null;
    const session = await sessionView(c);
    if (session.promptSuggestion && c.promptSuggestion && revisions.get(id) === revision &&
        !promptSuggestions.has(id))
      promptSuggestions.set(id, { suggestion: c.promptSuggestion, announced: false });
    return session;
  });
  on("LocalSessions.getPrChecks", async (
    cwd: string, number: number, repository?: string, forge = "github.com",
  ) => {
    if (!ctx.account()?.id) return { success: false, error: "Code is not signed in." };
    if (forge.toLowerCase() !== "github.com")
      return { success: false, error: `Unknown GitHub host "${forge}".` };
    if (!repository && cwd && path.isAbsolute(cwd) && ctx.localCall) {
      const trust = await localCall("checkWorkspaceTrust", cwd) as WorkspaceTrust;
      if (!trust.trusted) return { success: false, error: "Folder is not trusted." };
      repository = workspaceRepository(cwd);
    }
    if (!repository)
      return {
        success: false,
        error: "Could not resolve GitHub repository from the working directory.",
      };
    return scope.guard(() => readPullRequestChecks(repository, number));
  });
  on("LocalSessions.getPrStateForBranch", async (rawCwd: unknown, rawBranch?: unknown,
    rawId?: unknown, rawRepository?: unknown, rawHost?: unknown) => {
    const { cwd, branch, id, repository, host } = prBranchRequest.parse({
      cwd: rawCwd, branch: rawBranch, id: rawId, repository: rawRepository, host: rawHost,
    });
    const key = id && internalId(id);
    const unavailable = { success: false, errorKind: "unavailable" };
    if (!id || !key || !ctx.account()?.id || !ctx.localLoadConversation) return unavailable;
    const revision = revisions.get(id);
    const c = await scope.guard(() => ctx.localLoadConversation!(key));
    if (!c || c.id !== key || !readable(c) || c.incognito || revisions.get(id) !== revision)
      return unavailable;
    const folders = [c.cwd, c.worktree?.path, c.worktree?.origin, ...(c.additionalFolders ?? []),
      ...(c.additionalWorktrees ?? []).flatMap(worktree =>
        worktree.folders.flatMap(folder => [folder.origin, folder.cwd]))];
    if (cwd && !folders.includes(cwd)) return unavailable;
    const local = localCode(c) && !c.linkedToComputer;
    if (local && host && host.toLowerCase() !== "github.com") return unavailable;
    const read = local && ctx.readOfficialCodeArchivePullRequests;
    const prs = read ? await scope.guard(() => read(c, { cwd, branch })) : c.pullRequests;
    if (revisions.get(id) !== revision || !prs) return unavailable;
    const matches = prs.filter(pr =>
      (!branch || pr.headRef === branch) &&
      (!repository || pr.repository.toLowerCase() === repository.toLowerCase()) &&
      (!host || parsePullRequestUrl(pr.url)?.host === host.toLowerCase()),
    );
    const pr = matches.find(pr => pr.state !== "merged" && pr.state !== "closed") ?? matches[0];
    if (read && pr && canSetPrMetadata(c)) await syncPrBindings(c, prs);
    return pr ? {
      success: true, number: pr.number, url: pr.url, title: pr.title,
      state: pr.state === "draft" ? "open" : pr.state,
      isDraft: pr.state === "draft", headRefName: pr.headRef,
      baseRefName: pr.baseRef, ownCreate: pr.own,
    } : { success: true };
  });
  const canSetPrMetadata = (c: Conversation) =>
    !!ctx.account()?.id && sessionMutationCurrent() && localCode(c) &&
    !c.incognito && !c.archived && !c.linkedToComputer && c.worktree?.state !== "deleted";
  const readPrSession = async (raw: unknown) => {
    const id = internalId(z.string().parse(raw));
    if (!id || !ctx.localLoadConversation || !sessionMutationCurrent()) return;
    const conversation = await scope.guard(() => ctx.localLoadConversation!(id));
    if (conversation?.id === id && readable(conversation) && canSetPrMetadata(conversation))
      return conversation;
  };
  const syncPrBindings = async (c: Conversation, next: SessionPullRequest[]) => {
    const current = c.pullRequests ?? [];
    const facts = (rows: SessionPullRequest[]) => rows.map(({ checkedAt, ...row }) => row);
    if (!isDeepStrictEqual(facts(current), facts(next)))
      await localCall("officialUpdateSessionPullRequests", c.id, { current, next });
  };
  const changeBoundPr = async (id: unknown, target: unknown, change: (row: SessionPullRequest) => SessionPullRequest) => {
    const [repo, prNumber, forge = "github.com"] = prBoundTarget.parse(target);
    if (forge.toLowerCase() !== "github.com") return;
    const c = await readPrSession(id);
    if (!c) return;
    const next = (c.pullRequests ?? []).map(pr => pr.number === prNumber &&
      pr.repository.toLowerCase() === repo.toLowerCase() && parsePullRequestUrl(pr.url)?.host === "github.com"
      ? change(pr) : pr);
    await syncPrBindings(c, next);
  };
  on("LocalSessions.setBoundPrAutoFix", async (id: unknown, repository: unknown, number: unknown,
    rawEnabled: unknown, rawHost?: unknown) => {
    const enabled = z.boolean().parse(rawEnabled);
    await changeBoundPr(id, [repository, number, rawHost], pr =>
      pr.autoFix?.ci === enabled ||
      (enabled && (pr.dismissed || pr.state === "closed" || pr.state === "merged"))
        ? pr
        : { ...pr, autoFix: { ...pr.autoFix, ci: enabled, comments: enabled } });
  });
  on("LocalSessions.dismissBoundPr", (id: unknown, repository: unknown, number: unknown, rawHost?: unknown) =>
    changeBoundPr(id, [repository, number, rawHost], pr => ({ ...pr, dismissed: true })));
  on("LocalSessions.setAutoFixOwnPrsWanted", async (id: unknown, raw: unknown) => {
    const wanted = z.boolean().parse(raw);
    if (id === null) {
      if (wanted || !sessionMutationCurrent() || !ctx.localListConversations) return;
      const sessions = await list();
      await Promise.all(sessions.filter(c => canSetPrMetadata(c) && c.prAutoFixOwnPrs)
        .map(c => localCall("officialSetPrAutoFixIntent", c.id, { own: false })));
      return;
    }
    const c = await readPrSession(id);
    if (c && c.prAutoFixOwnPrs !== wanted)
      await localCall("officialSetPrAutoFixIntent", c.id, { own: wanted });
  });
  on("LocalSessions.armAutoFixOnNextPr", async (id: unknown, raw: unknown): Promise<NextPrArmResult> => {
    const branch = z.string().min(1).max(250).parse(raw);
    const c = await readPrSession(id);
    if (!c) return "refused";
    nextPrWaits.get(c.id)?.finish("dropped");
    const expiresAt = Date.now() + nextPrTimeout;
    const result = new Promise<NextPrArmResult>(resolve => {
      const finish: NextPrWait["finish"] = (result) => {
        clearTimeout(timer);
        if (nextPrWaits.get(c.id)?.finish === finish) nextPrWaits.delete(c.id);
        resolve(result);
      };
      const timer = setTimeout(finish, nextPrTimeout, "dropped");
      timer.unref();
      nextPrWaits.set(c.id, { branch, expiresAt, persisted: false, finish });
    });
    try {
      await localCall("officialSetPrAutoFixIntent", c.id, { arm: { branch, expiresAt } });
      const waiter = nextPrWaits.get(c.id);
      if (waiter?.expiresAt === expiresAt) waiter.persisted = true;
    } catch (error) {
      if (nextPrWaits.get(c.id)?.expiresAt === expiresAt) nextPrWaits.get(c.id)?.finish("refused");
      throw error;
    }
    return result;
  });
  on("LocalSessions.requestTranscriptPort", () => false);
  // Opening/prewarming is not an instruction to migrate, restore, or send
  // saved input. Unlike get(), this read has no queue-recovery side effects.
  const readOpenedSession = async (id: unknown, includeSsh = false) => {
    if (typeof id !== "string" || !id.startsWith("local_") ||
        id.length <= 6 || id.length > 506)
      throw Error("Invalid local Code session.");
    if (ctx.readOnly || ctx.isCurrent?.() === false)
      throw Error("Local Code session updates are unavailable.");
    if (!ctx.localLoadConversation)
      throw Error("Local Code is not available on this host.");
    const c = await scope.guard(() => ctx.localLoadConversation!(internalId(id)));
    if (ctx.readOnly || ctx.isCurrent?.() === false)
      throw Error("Local Code session updates are unavailable.");
    if (!c || c.id !== internalId(id) || !(localCode(c) || wslCode(c) || includeSsh && sshEnvironment(c)) ||
        (c.sessionAuthors?.ownerAccountUuid &&
         c.sessionAuthors.ownerAccountUuid !== ctx.account?.()?.id))
      throw Error("Code session not found");
    return c;
  };
  const noQueuedInput = (id: string) => !pending.has(id) && !draining.has(id) &&
    !stagingAttachments.has(id) && !isStopping(id) &&
    !durable.read().queues.some(([key, entries]) => key === id && entries.length);
  const unregisterArchiveHold = ctx.registerOfficialCodeArchiveHold?.((id) =>
    scope.run(() => {
      load();
      return pending.has(id) || draining.has(id) || stagingAttachments.has(id) ||
        isStopping(id) || queueFor(id).length > 0 || managing.has(id) ||
        historyOperations.has(publicId(id));
    }),
  );
  on("LocalSessions.addDirectories", async (id: string, raw: unknown) => {
    const folders = codeDirectories.safeParse(raw);
    if (!folders.success) return false;
    try {
      return await changeHistory(id, async () => {
        const c = await readHistorySession(id, true);
        if (running(c)) return false;
        const saved = await localCall("updateConversation", c.id, {
          additionalFolders: folders.data,
        }, sessionMutationCurrent) as Conversation;
        return saved?.id === c.id && saved.createdAt === c.createdAt;
      });
    } catch {
      return false;
    }
  });
  on("LocalSessions.warmSession", async (id: unknown) => {
    const c = await readOpenedSession(id, true);
    const warm = ctx.warmCodeSession;
    if (!warm)
      throw Error("Prewarming local Code sessions is not supported. The model applies on the next start.");
    if (!noQueuedInput(c.id))
      throw Error("The Code session has pending work. The model applies on the next start.");
    await scope.guard(() => warm(c));
  });
  on("LocalSessions.personOpenedSession", async (id: unknown) => {
    const c = await readOpenedSession(id, true);
    // Even an already-read snapshot must reach the host: an earlier service
    // write may have mutated memory without a confirmed durable outcome.
    const expected = codeReadSnapshot(c);
    const wasUnread = c.unread === true;
    const saved = await localCall("updateConversation", c.id, {
      unread: { version: 1, expected },
    }) as Conversation | undefined;
    if (ctx.readOnly || ctx.isCurrent?.() === false || !saved ||
        saved.id !== c.id || !readable(saved) || !Array.isArray(saved.turns) ||
        saved.unread === true || !sameCodeReadActivity(saved, expected) ||
        (saved.readStateRevision ?? 0) !== expected.readStateRevision + (wasUnread ? 1 : 0))
      throw Error("The Code read acknowledgment could not be confirmed. Reopen the session before retrying.");
    if (!saved.archived && sshEnvironment(saved))
      void ctx.reconnectSshCodeSession?.(saved, "open", () => noQueuedInput(saved.id)).catch((error) =>
        ctx.log("Code SSH opening retry failed", String(error)),
      );
  });
  on("LocalSessions.reconnectSessionHost", async (id: unknown) => {
    const c = await readOpenedSession(id, true);
    if (c.archived || !sshEnvironment(c)) return false;
    return (await ctx.reconnectSshCodeSession?.(c, "retry", () => noQueuedInput(c.id))) ?? false;
  });
  on(
    "LocalSessions.setThinkingSummariesWanted",
    async (id: string, wanted: boolean) => {
      if (
        typeof id !== "string" ||
        !id.startsWith("local_") ||
        typeof wanted !== "boolean"
      )
        throw Error("Invalid Code thinking summary preference.");
      if (ctx.readOnly || ctx.isCurrent?.() === false)
        throw Error("Code thinking summary changes are unavailable.");
      const c = await readOpenedSession(id, true);
      if (
        !c ||
        c.id !== internalId(id) ||
        c.incognito || c.cloudEnvironmentId ||
        (c.sessionAuthors?.ownerAccountUuid &&
          c.sessionAuthors.ownerAccountUuid !== ctx.account?.()?.id)
      )
        throw Error("Code session not found");
      if (ctx.readOnly || ctx.isCurrent?.() === false)
        throw Error("Code thinking summary changes are unavailable.");
      // Existing engine on-demand summary policy consumes this per-conversation
      // preference for future turns; no historical reasoning is synthesized.
      const expected = codeThinkingPreferenceSnapshot(c);
      const saved = await localCall("updateConversation", c.id, {
        thinkingSummariesWanted: { version: 1, wanted, expected },
      }) as Conversation | undefined;
      if (ctx.readOnly || ctx.isCurrent?.() === false || !saved ||
          saved.id !== expected.id || saved.createdAt !== expected.createdAt ||
          !readable(saved) || saved.incognito || saved.cloudEnvironmentId ||
          saved.thinkingSummariesWanted !== wanted ||
          (saved.sessionAuthors?.ownerAccountUuid &&
           saved.sessionAuthors.ownerAccountUuid !== ctx.account?.()?.id))
        throw Error("The Code thinking summary preference could not be confirmed. Reopen the session before retrying.");
    },
  );
  const contextUsage = async (id: string) => {
    const c = await get(id, true);
    if (!c) throw Error("Code session not found");
    return officialContextUsage(c);
  };
  on("LocalSessions.getContextUsage", contextUsage);
  on("LocalSessions.getContextUsageSummary", contextUsage);
  on(
    "LocalSessions.changeCwd",
    async (
      id: string,
      cwd: string,
      trustAccepted?: boolean,
      trustedDirectory?: string,
    ) => {
      if (ctx.isCurrent?.() === false || ctx.readOnly) throw Error("Local folder changes are unavailable.");
      if (trustAccepted !== undefined && typeof trustAccepted !== "boolean") throw Error("Invalid folder trust response.");
      if (trustedDirectory !== undefined && typeof trustedDirectory !== "string") throw Error("Invalid trusted directory.");
      const key = typeof id === "string" ? internalId(id) : "";
      const read = async () => {
        const c = key && ctx.localLoadConversation
          ? await scope.guard(() => ctx.localLoadConversation!(key))
          : undefined;
        return c && (!c.sessionAuthors?.ownerAccountUuid ||
          c.sessionAuthors.ownerAccountUuid === ctx.account?.()?.id) ? c : undefined;
      };
      const busy = { status: "rejected", reason: "busy", message: "A directory change for this session is already in progress." };
      const c = await read();
      const refusal = environmentChangeRefusal(c, id, cwd);
      if (refusal) return refusal;
      if (!c) throw Error("Code session not found.");
      if (managing.has(key) || !noQueuedInput(key) || c.codeNewTask) return busy;
      const { createdAt, cwd: originalCwd } = c;
      managing.add(key);
      try {
        const real = fs.realpathSync(cwd);
        const trust = (await localCall(
          "checkWorkspaceTrust",
          real,
        )) as WorkspaceTrust;
        const fresh = await read();
        const changed = environmentChangeRefusal(fresh, id, cwd);
        if (changed) return changed;
        if (!fresh || fresh.createdAt !== createdAt || fresh.cwd !== originalCwd ||
            ctx.isCurrent?.() === false || fs.realpathSync(cwd) !== real)
          throw Error("The session changed during folder selection.");
        if (!trust || typeof trust.trusted !== "boolean" || !Array.isArray(trust.sources)) throw Error("Invalid workspace trust response.");
        const root = ctx.defaultWorkspace?.(),
          relative = root && fs.existsSync(root)
            ? path.relative(fs.realpathSync(root), real)
            : undefined;
        const internal =
          relative !== undefined &&
          (relative === "" ||
            (!relative.startsWith("..") && !path.isAbsolute(relative)));
        if (!trust.trusted && !internal) {
          if (!trustAccepted || trustedDirectory !== real)
            return {
              status: "needs_trust",
              directory: real,
              sources: trust.sources,
            };
          await localCall("saveWorkspaceTrust", cwd);
        }
        const beforeChange = await read();
        const noLongerAllowed = environmentChangeRefusal(beforeChange, id, cwd);
        if (noLongerAllowed) return noLongerAllowed;
        if (beforeChange?.createdAt !== createdAt || beforeChange.cwd !== originalCwd ||
            !noQueuedInput(key) || ctx.isCurrent?.() === false || fs.realpathSync(cwd) !== real)
          throw Error("The session changed during folder selection.");
        const result = await localCall(
          "officialChangeSessionFolder",
          c.id,
          cwd,
          { expected: { cwd: originalCwd, createdAt }, current: sessionMutationCurrent },
        ) as { status?: string; cwd?: string; changed?: boolean; transcriptRelocated?: boolean };
        if (ctx.isCurrent?.() === false || result?.status !== "ok" || typeof result.cwd !== "string" ||
          typeof result.changed !== "boolean" || typeof result.transcriptRelocated !== "boolean")
          throw Error("The working directory change was not confirmed.");
        host.emit("LocalSessions", "onEvent", {
          type: "session_updated",
          sessionId: id,
        });
        return result;
      } catch (error) {
        return {
          status: "rejected",
          reason: "change_failed",
          message: String((error as Error).message ?? error),
        };
      } finally {
        if (stillCurrent()) managing.delete(key);
      }
    },
  );
  const modelPreference = async (id: string, c: Conversation, model: string) => {
    const prior = codeModelSnapshot(c);
    const catalog = await scope.guard(() => ctx.modelCatalog());
    const fresh = await readOpenedSession(id);
    if (!isDeepStrictEqual(prior, codeModelSnapshot(fresh)))
      throw Error("The Code model changed. Reopen its settings before retrying.");
    const matches = catalog?.items.filter((item) => item.id === model) ?? [];
    if (matches.length !== 1)
      throw Error(
        "The selected model is unavailable. Refresh the model catalog.",
      );
    return matches[0]!;
  };
  const saveModelPreference = (
    c: Conversation,
    choice: Omit<CodeModelPreference, "providerId">,
  ) =>
    localCall("updateConversation", c.id, {
      model: {
        version: 1,
        expected: codeModelSnapshot(c),
        choice,
      },
    });
  on("LocalSessions.setModel", async (id: string, model: string) => {
    if (typeof model !== "string" || !model.trim() || model.length > 200)
      throw Error("Invalid Code model.");
    const c = await readOpenedSession(id);
    const item = await modelPreference(id, c, model);
    await saveModelPreference(c, codeModelChoice(item, c.effort, ctx.settings().codeEffort, { kind: "model" }));
  });
  const setModelFlags = async (id: string, flags: Pick<z.infer<typeof codeSessionFlags>, "effortLevel" | "ultracode">) => {
    const c = await readOpenedSession(id);
    const { effortLevel, ultracode } = flags;
    const choice = effortLevel === undefined ? {} : codeModelChoice(
      await modelPreference(id, c, c.model), c.effort, ctx.settings().codeEffort,
      { kind: "effort", value: effortLevel },
    );
    if (ultracode === true && !ultracodeAvailable(c))
      throw Error("Ultracode is not supported by this Code session.");
    if (effortLevel !== undefined || ultracode !== undefined)
      await saveModelPreference(c, { ...choice, ...(ultracode !== undefined ? { codeUltracode: ultracode } : {}) });
  };
  on("LocalSessions.setEffort", async (id: string, effortLevel: unknown) => {
    const flag = codeEffortFlag.safeParse(effortLevel);
    if (!flag.success)
      throw Error("This reasoning effort is not supported.");
    await setModelFlags(id, { effortLevel: flag.data });
  });
  on("LocalSessions.setFastMode", async (id: string, enabled: unknown) => {
    requireFastModeOff(z.boolean().parse(enabled));
    await readOpenedSession(id, true);
  });
  on("LocalSessions.setPermissionMode", async (id: string, mode: unknown) => {
    const parsed = codePermissionMode.safeParse(mode);
    if (!parsed.success) return false;
    const c = await readOpenedSession(id, true);
    if (c.archived || c.worktree?.state === "deleted" || managing.has(c.id)) return false;
    const selected = codePermissionModes[parsed.data];
    const saved = await localCall("updateConversation", c.id, { codePermissionMode: selected }) as Conversation;
    return saved?.id === c.id && saved.codePermissionMode === selected;
  });
  on("LocalSessions.listGlobalOutputStyles", () => ({
    builtIns: builtInOutputStyles.map((style) => style.name),
    customs: [],
  }));
  // Current official composers prefer the combined flag API over setEffort.
  on(
    "LocalSessions.applyFlagSettings",
    async (id: string, raw: unknown) => {
      const parsed = codeSessionFlags.safeParse(raw);
      if (!parsed.success)
        throw Error("These Code flags are not supported yet.");
      const flags = parsed.data;
      if ("outputStyle" in flags) {
        if (Object.keys(flags).length !== 1 || typeof flags.outputStyle !== "string")
          throw Error("Choose one available Code output style.");
        const c = await readOpenedSession(id, true);
        if (c.archived || c.worktree?.state === "deleted" ||
            !outputStyleNames(c.customOutputStyles).includes(flags.outputStyle))
          throw Error("This output style is unavailable for the Code session.");
        const saved = await localCall("updateConversation", c.id, { outputStyle: flags.outputStyle }) as Conversation;
        if (saved?.id !== c.id || saved.outputStyle !== flags.outputStyle)
          throw Error("The Code output style could not be confirmed.");
        return;
      }
      await setModelFlags(id, flags);
    },
  );
  on("LocalSessions.createScratchWorkspace", () => {
    if (!ctx.createScratchWorkspace)
      throw Error("This host cannot create a local Code workspace.");
    return ctx.createScratchWorkspace();
  });
  on("LocalSessions.classifyTccFolderKind", (folder: string) =>
    classifyTccFolderKind(folder),
  );
  on("LocalSessions.checkTrust", async (cwd: string) => {
    const trust = (await localCall(
      "checkWorkspaceTrust",
      cwd,
    )) as WorkspaceTrust;
    let agentWorkspace = false;
    try {
      const root = ctx.defaultWorkspace?.();
      if (root) {
        const relative = path.relative(
          fs.realpathSync(root),
          fs.realpathSync(cwd),
        );
        agentWorkspace =
          relative === "" ||
          (!relative.startsWith("..") && !path.isAbsolute(relative));
      }
    } catch {
      /* Missing paths are never implicitly trusted. */
    }
    return { trusted: trust.trusted || agentWorkspace, sources: trust.sources, claudexTrustRoot: trust.root };
  });
  on(
    "LocalSessions.checkStoredTrust",
    async (cwd: string) =>
      ((await localCall("checkWorkspaceTrust", cwd)) as WorkspaceTrust).trusted,
  );
  on("LocalSessions.saveTrust", async (cwd: string) => {
    if (isDetectedFolder?.(cwd))
      await localCall("saveWorkspaceTrust", cwd, undefined, trustFromDetectedProject);
    else
      await localCall("saveWorkspaceTrust", cwd);
  });
  on("LocalSessions.getTranscript", async (id: string) => {
    const transcript = await readTranscript(id, true);
    return hydrateTranscript(transcript.conversation, transcript.rows);
  });
  on("LocalSessions.getTranscriptTail", async (id: string, limit: number) => {
    const count = normalizeCodeTranscriptLimit(limit, 500);
    const { conversation, rows } = await readTranscript(id, true);
    const page = pageCodeTranscript(rows, "", count);
    return { messages: hydrateTranscript(conversation, page.messages), hasMore: page.hasMore };
  });
  on(
    "LocalSessions.getTranscriptPage",
    async (id: string, before: string, limit: number) => {
      const count = normalizeCodeTranscriptLimit(limit);
      if (typeof before !== "string")
        throw new TypeError("Transcript cursor must be a string.");
      const { conversation, rows } = await readTranscript(id, !before);
      const page = pageCodeTranscript(rows, before, count);
      return { ...page, messages: hydrateTranscript(conversation, page.messages), source: "full" };
    },
  );
  on("LocalSessions.getSupportedCommands", async (options?: unknown) => {
    const { sessionId } = parseCodeCommandScope(options);
    const c = sessionId ? await readOpenedSession(sessionId, true) : undefined;
    if (c?.environment?.kind === "ssh") {
      const listed = await readNativeSshCommands(localCall, { kind: "session", conversationId: c.id });
      return nativeSlashCommandRows(listed?.commands ?? []);
    }
    const listed = await commandInventory(options);
    const commands = nativeSlashCommandRows(listed.commands);
    if (!c || !localCode(c) || !c.turns.length || (!c.threadId && !running(c)) || c.archived ||
        c.worktree?.state === "deleted") return commands;
    return [...commands,
      { name: "compact", description: "Compact session", kind: "harness" as const },
      { name: "review", description: "Review the changes in this session", argumentHint: "[target]", kind: "skill" as const },
    ];
  });
  const startSession = async (
    info: Record<string, any>,
    start: CodeSendStart,
    caller: NativeHost["caller"],
    { requestedId, ultracode }: { requestedId?: string; ultracode?: boolean },
  ) => {
    if (
      !info ||
      typeof info.cwd !== "string" ||
      typeof info.message !== "string" ||
      info.message.length > 200_000 ||
      (!info.message.trim() &&
        !info.images?.length &&
        !info.attachments?.length)
    )
      throw new Error("A folder and a message are required to start Code.");
    const sessionEnvironment = codeSessionEnvironmentSelection.parse(info);
    const skillReferences = parseSkillReferences(info.message, info.skillReferences ?? []);
    if (info.messageUuid !== undefined &&
        (typeof info.messageUuid !== "string" || !info.messageUuid || info.messageUuid.length > 500))
      throw Error("Invalid Code message identifier.");
    const wsl = info.remoteTarget?.kind === "wsl"
      ? wslEnvironmentInput.parse(info.remoteTarget)
      : undefined;
    const rawSsh = info.remoteTarget?.kind === "ssh" ? info.remoteTarget : info.sshConfig;
    const ssh = rawSsh
      ? await localCall("officialSshTarget", rawSsh) as { kind: "ssh"; hostId: string }
      : undefined;
    const environment = wsl ?? ssh;
    const slash = leadingSlashCommand(info.message.trimStart());
    if (!environment && slash && isReservedCodeSlashCommand(slash.name))
      throw Error(`/${slash.name} is unavailable before a local Code session starts.`);
    const folderChoices = z.array(z.object({
      path: z.string().min(1).max(4096),
      useWorktree: z.boolean().optional(),
      sourceBranch: z.string().min(1).max(255).optional(),
    })).max(20).optional().parse(info.additionalFolders);
    const additionalWorktreeFolders = folderChoices
      ?.filter(folder => folder.useWorktree)
      .map(({ path, sourceBranch }) => ({ path, sourceBranch }));
    for (const key of [
      "remoteTarget",
      "sshConfig",
      "systemPrompt",
      "systemPromptAppend",
      "sessionMentions",
    ]) {
      if (key === "remoteTarget" && wsl) continue;
      if (key === "remoteTarget" && ssh && info.remoteTarget === rawSsh) continue;
      if (key === "sshConfig" && ssh) continue;
      const value = info[key];
      if (value && (typeof value !== "object" || Object.keys(value).length))
        throw new Error(`Code start does not support ${key} yet.`);
    }
    const mode = codePermissionMode.safeParse(info.permissionMode ?? "default");
    if (!mode.success)
      throw new Error("This Code permission mode is not supported.");
    const permission = codePermissionModes[mode.data];
    const settings = ctx.settings();
    const remoteControlAtStart = z.boolean().optional().parse(info.remoteControlAtStart);
    if (!environment && remoteControlAtStart === true && !remoteControlStartState().overridable)
      throw Error("Remote Control is unavailable on this computer.");
    const mcpServers: unknown = info.mcpServers;
    if (
      mcpServers != null &&
      (typeof mcpServers !== "object" ||
        Array.isArray(mcpServers) ||
        (Object.keys(mcpServers).length > 0 &&
          !isDeepStrictEqual(
            mcpServers,
            officialLocalMcpServersConfig(settings.mcpServers),
          )))
    )
      throw new Error(
        "The local MCP server configuration changed. Refresh and try again.",
      );
    const provider = codeStartProvider(settings);
    if (!provider) throw new Error("No model service is configured.");
    const model = typeof info.model === "string" && info.model ? info.model : provider.model;
    if (!isConversationModel(model))
      throw new Error("The requested Code model is unavailable.");
    if (ultracode && (environment || ctx.readOnly || ctx.isCurrent?.() === false ||
        ctx.codeUltracodeAvailable?.(provider.id, model) !== true))
      throw Error("Ultracode is not supported by this Code session.");
    const effort = ["low", "medium", "high", "xhigh", "max", "ultra"].includes(
      info.effort,
    )
      ? info.effort
      : undefined;
    const connectorChoices = await initialSessionConnectors(
      ctx,
      localCall,
      info,
    );
    if (start.cancelledBeforeDispatch) throw new CodeSendCancelled();
    const prepared = ssh
      ? await prepareNativeSshCommand(names =>
          readNativeSshCommands(localCall, { kind: "draft", hostId: ssh.hostId, cwd: info.cwd }, names),
        info.message, skillReferences)
      : wsl ? { message: info.message }
      : await prepareCommand(info.message, { cwd: info.cwd }, skillReferences);
    const sendSkills = prepared.command ? prepared.skillReferences ?? [] : skillReferences;
    if (start.cancelledBeforeDispatch) throw new CodeSendCancelled();
    const fileAttachments = await storeCodeAttachments(
      localCall,
      info.images,
      info.attachments,
      selectedFiles(caller, info.message, "new"),
    );
    if (start.cancelledBeforeDispatch) throw new CodeSendCancelled();
    const c = (await localCall("send", {
      mode: "code",
      ...connectorChoices,
      ...(requestedId ? { newConversationId: requestedId } : {}),
      ...(!environment && remoteControlAtStart !== undefined ? {
        codeRemoteControlAtStart: remoteControlAtStart,
      } : {}),
      text: prepared.sendText ?? prepared.message,
      ...(sendSkills.length ? { skillReferences: sendSkills } : {}),
      cwd: info.cwd,
      ...(environment ? { environment } : {}),
      attachments: fileAttachments.map((a) => ({ id: a.id })),
      providerId: provider.id,
      model,
      ...(ultracode ? { codeUltracode: true } : {}),
      codePermissionMode: permission,
      ...(effort ? { effort } : {}),
      ...(typeof info.thinkingSummariesWanted === "boolean"
        ? { thinkingSummariesWanted: info.thinkingSummariesWanted }
        : {}),
      ...(info.useWorktree ? { worktree: true } : {}),
      ...(info.useWorktree && typeof info.sourceBranch === "string"
        ? { worktreeBranch: info.sourceBranch } : {}),
      ...(typeof info.branchHint === "string" ? { worktreeBranchHint: info.branchHint } : {}),
      ...(Array.isArray(info.additionalDirectories)
        ? { additionalFolders: info.additionalDirectories }
        : {}),
      ...(additionalWorktreeFolders?.length ? { additionalWorktreeFolders } : {}),
    }, {
      [officialCodeSendStart]: start,
      [officialCodeSessionEnvironment]: sessionEnvironment,
      ...(prepared.command ? { slashInput: {
        text: prepared.message,
        ...(typeof info.messageUuid === "string" ? { uuid: info.messageUuid } : {}),
      } } : {}),
      ...(!environment && !info.useWorktree && typeof info.sourceBranch === "string"
        ? { folderBranch: info.sourceBranch } : {}),
    })) as Conversation;
    if (!c?.id || !(localCode(c) || wslCode(c) || sshEnvironment(c)))
      throw new Error("The Code session could not be started locally.");
    const initialTurn = c.turns[0];
    if (info.useWorktree && !c.worktree && initialTurn?.status === "failed")
      throw Error(initialTurn.error ?? "The Code worktree could not be created.");
    if (typeof info.messageUuid === "string" && c.turns.length)
      messageIds.set(
        c.id,
        new Map([[`${c.turns[0].id}:user`, info.messageUuid]]),
      );
    persist();
    host.emit("LocalSessions", "onEvent", {
      type: "session_updated",
      sessionId: publicId(c.id),
      session: { ...sessionDetails(c),
        ...remoteControlSession(c) },
    });
    return { sessionId: publicId(c.id) };
  };
  on("LocalSessions.start", async (info: Record<string, any>) => {
    const caller = host.caller;
    if (!info || typeof info !== "object")
      throw new Error("A folder and a message are required to start Code.");
    if (info.spawnedFrom?.pendingPop === true) {
      const source = z.object({
        sessionId: z.string().regex(/^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
        taskId: z.string().regex(/^task_[a-f0-9]{8}$/),
        pendingPop: z.literal(true),
        proposalPicks: z.unknown().optional(),
      }).passthrough().parse(info.spawnedFrom);
      const requestedId = info.sessionId === undefined ? undefined : z.string().regex(
        /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      ).parse(info.sessionId).slice(6);
      const target = officialCodeSideSessionTarget.parse({
        target: "local", picks: source.proposalPicks,
        useWorktree: info.useWorktree,
      });
      const parent = await get(source.sessionId, true);
      if (!parent || !localCode(parent) || parent.archived || ctx.readOnly)
        throw Error("The proposal is no longer available.");
      return localCall("officialCodeModelProposal", parent.id, source.taskId, {
        kind: "start", ...(requestedId ? { requestedId } : {}),
        ...(target.picks ? { picks: target.picks } : {}),
        ...(target.useWorktree === undefined ? {} : { useWorktree: target.useWorktree }),
      }, () => stillCurrent() && ctx.isCurrent?.() !== false && !ctx.readOnly);
    }
    const { fastMode, ultracode } = codeStartModes.parse(info);
    requireFastModeOff(fastMode);
    if (info.scheduledTaskId !== undefined || info.scheduledTaskManualStart !== undefined) {
      if (ctx.readOnly || !ctx.account()?.id || info.scheduledTaskManualStart !== true ||
          info.sessionId !== undefined || typeof info.scheduledTaskId !== "string" || ultracode)
        throw Error("Invalid scheduled Code task run.");
      const task = z.object({ id: z.string(), conversationId: z.string().uuid() })
        .parse(await localCall("officialCodeRoutineRun", info.scheduledTaskId, "code"));
      if (task.id !== info.scheduledTaskId) throw Error("The scheduled task run could not be confirmed.");
      return { sessionId: publicId(task.conversationId) };
    }
    if (
      info.sessionId !== undefined &&
      (typeof info.sessionId !== "string" ||
        !/^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          info.sessionId,
        ))
    )
      throw new Error("Invalid Code session identifier.");
    const requestedId =
      info.sessionId === undefined ? undefined : internalId(info.sessionId);
    const reservation = new CodeSendStart();
    if (requestedId) {
      if (startingIds.has(requestedId))
        throw new Error("This Code session is already being started.");
      startingIds.set(requestedId, reservation);
    }
    try {
      if (requestedId) {
        if (!ctx.localLoadConversation)
          throw new Error("Local Code is not available on this host.");
        const existing = await scope.guard(() => ctx.localLoadConversation!(requestedId));
        if (reservation.cancelledBeforeDispatch) throw new CodeSendCancelled();
        if (existing || ctx.isCloudConversation?.(requestedId))
          throw new Error(
            "This session already exists. Reopen it before continuing.",
          );
      }
      return await startSession(info, reservation, caller, { requestedId, ultracode });
    } catch (error) {
      if (requestedId && reservation.cancelledBeforeDispatch)
        throw Error(`[spawn-cancelled] ${publicId(requestedId)} cancelled during setup`);
      throw error;
    } finally {
      if (requestedId && startingIds.get(requestedId) === reservation)
        startingIds.delete(requestedId);
    }
  });
  on("LocalSessions.getSessionsForScheduledTask", async (raw: unknown) => {
    const id = z.string().min(1).max(256).parse(raw);
    return Promise.all((await list()).filter((c) => c.scheduledTaskId === id).map((c) => view(c, false)));
  });
  on(
    "LocalSessions.sendMessage",
    async (
      id: string,
      message: string,
      images?: unknown[],
      toolStates?: unknown[],
      attachments?: unknown[],
      ...other: unknown[]
    ) => {
      const caller = host.caller;
      const marks = z.strictObject({
        personSent: z.boolean().optional(),
        skillReferences: z.unknown().optional(),
      }).nullish().parse(other[9] === false || other[9] === "" ? undefined : other[9]);
      const skillReferences = typeof message === "string"
        ? parseSkillReferences(message, marks?.skillReferences ?? []) : [];
      const leadingSkill = typeof message === "string" && skillReferences[0]?.start ===
        message.length - message.trimStart().length;
      const slash = typeof message === "string" && !leadingSkill ? leadingSlashCommand(message.trimStart()) : null;
      const name = slash?.name.toLowerCase();
      const typed = !leadingSkill && typeof other[4] === "string" ? leadingSlashCommand(other[4].trimStart()) : null;
      const clear = name === "clear" || typed?.name.toLowerCase() === "clear";
      if (clear) {
        if (images?.length || attachments?.length || toolStates?.length ||
            name !== "clear" || (typeof other[4] === "string" && other[4].trim() !== message.trim()))
          throw Error("Remove attachments and folder references before clearing the Code conversation.");
        if (slash?.args.trim())
          throw Error("Use /clear without arguments.");
      }
      const autoCompact = name === "autocompact" ? slash?.args : undefined;
      const review = name === "review" ? slash?.args : undefined;
      const compact = name === "compact" && !slash?.args.trim();
      if (!compact && name === "compact")
        throw Error("Compaction instructions are not supported here. Use /compact without arguments.");
      // Metadata/compact reads must not migrate or drain saved user input.
      const c = clear || compact || autoCompact !== undefined || review !== undefined
        ? await readOpenedSession(id, clear) : await get(id, true);
      if (!c) throw new Error("Code session not found");
      if (c.importedSessionResumePending)
        throw Error("Confirm that you trust this imported session before resuming it.");
      if (managing.has(c.id) || c.archived || c.worktree?.state === "deleted")
        throw Error("Restore the Code session and wait for its changes before sending.");
      if (
        typeof message !== "string" ||
        (!message.trim() && !images?.length && !attachments?.length)
      )
        throw new Error("A message is required.");
      if (toolStates?.length)
        throw new Error("Code session file references are not supported yet.");
      const priority =
        other[0] === "now" || other[0] === "next" || other[0] === "later"
          ? other[0]
          : undefined;
      const steeringGates =
        other[1] && typeof other[1] === "object" && !Array.isArray(other[1])
          ? (other[1] as Record<string, boolean>)
          : undefined;
      const uuid =
        typeof other[2] === "string" ? other[2] : `local-${randomUUID()}`;
      if (message.length > 200_000 || !uuid || uuid.length > 500)
        throw Error("The Code message or its identifier is too long.");
      const compactionAttempt = [...c.turns, ...(c.savedBranches ?? []).flatMap(branch => branch.turns)]
        .some(turn => turn.compactionRequestId === uuid);
      if (compactionAttempt && (!compact || images?.length || attachments?.length))
        throw Error("This message id already belongs to a compaction request.");
      const isRunning = running(c);
      const paneAnchors = () => new Set([
        uuid,
        ...convert(c).rows.map((row) => row.uuid),
        ...queueFor(c.id).map((entry) => entry.uuid),
        ...c.turns.flatMap((turn) => turn.items.flatMap((item) =>
          item.type === "contextCompaction" ? [codeCompactionProgressUuid(turn.id, item.id)] : [],
        )),
        ...c.turns.flatMap((turn) =>
          turn.status !== "inProgress" && !turn.compaction && !turn.id.startsWith("pending-")
            ? [resultUuid(turn.id)]
            : [],
        ),
      ]);
      const unsupported = other.findIndex((value, index) => {
        if (
          index === 0 &&
          (value === "now" || value === "next" || value === "later")
        )
          return false;
        if (
          index === 1 &&
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.entries(value).every(
            ([key, enabled]) =>
              [
                "ccdSteering",
                "queuedMessageBar",
                "sessionPresets",
                "steerDetach",
                "asides",
              ].includes(key) && typeof enabled === "boolean",
          )
        )
          return false;
        if (index === 2 && typeof value === "string") return false; // The page's optimistic message id.
        // The wire message includes official attachment/context markers;
        // typedText is the editor's original text, not a replacement prompt.
        if (index === 4 && typeof value === "string" && value.length <= 200_000)
          return false;
        // Pasted spans are already part of the wire message.
        if (index === 8 && Array.isArray(value) && value.length <= 100 &&
            value.every(part => typeof part === "string" && part.length <= 200_000))
          return false;
        if (index === 9) return false;
        if (
          index === 6 &&
          value &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          // The official pane reports the rows it holds. Our source is the full
          // Claudex transcript, so it is safe only if those anchors are present.
          const held = value as { uuids?: unknown; earlierCursor?: unknown };
          const known = paneAnchors();
          if (
            Array.isArray(held.uuids) &&
            held.uuids.every(
              (uuid) => typeof uuid === "string" && known.has(uuid),
            ) &&
            (held.earlierCursor === undefined ||
              (typeof held.earlierCursor === "string" &&
                known.has(held.earlierCursor)))
          )
            return false;
        }
        return (
          value !== undefined &&
          value !== null &&
          value !== false &&
          value !== "" &&
          (!Array.isArray(value) || value.length)
        );
      });
      if (unsupported >= 0) {
        const value = other[unsupported];
        let keys =
          unsupported === 1 &&
          value &&
          typeof value === "object" &&
          !Array.isArray(value)
            ? ` (${Object.keys(value).join(", ")})`
            : "";
        if (
          unsupported === 6 &&
          value &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          const held = value as { uuids?: unknown; earlierCursor?: unknown };
          const known = paneAnchors();
          const unknown = Array.isArray(held.uuids)
            ? held.uuids.filter(
                (uuid) => typeof uuid !== "string" || !known.has(uuid),
              ).length
            : -1;
          keys = ` (held=${Array.isArray(held.uuids) ? held.uuids.length : -1}, unknown=${unknown}, cursorKnown=${held.earlierCursor === undefined || (typeof held.earlierCursor === "string" && known.has(held.earlierCursor))})`;
        }
        throw new Error(
          `Code message option ${["priority", "steering", "messageUuid", "seededSummon", "typedText", "mentions", "paneHolds", "seededKind", "pastes", "marks"][unsupported] ?? unsupported}${keys} is not supported yet.`,
        );
      }
      const requestHash = inputHash(
        JSON.stringify([message, images ?? [], attachments ?? [],
          ...(skillReferences.length ? [skillReferences] : [])]),
      );
      const receipt = commandReceipts.get(c.id)?.get(uuid);
      if (receipt) {
        if (
          receipt.inputHash !== inputHash(message) ||
          (receipt.requestHash !== undefined &&
            receipt.requestHash !== requestHash)
        )
          throw Error("This message id already belongs to another input.");
        return;
      }
      const existing = queueFor(c.id).find((entry) => entry.uuid === uuid);
      if (existing) {
        if (
          existing.message !== message ||
          (existing.requestHash !== undefined &&
            existing.requestHash !== requestHash)
        )
          throw Error("This message id already belongs to another input.");
        return;
      }
      // Older hosts persisted UUID mappings before plain-text receipts existed.
      // Do not replay those IDs merely because they predate the receipt format.
      if ([...(messageIds.get(c.id)?.values() ?? [])].includes(uuid)) {
        const row = convert(c).rows.find((row) => row.uuid === uuid);
        if (!row)
          throw Error("This message id was already submitted; its history is no longer available.");
        const [previousRow] = hydrateTranscript(c, [row]);
        if (
          previousRow.type !== "user" ||
          previousRow.message.content !== message ||
          images?.length || attachments?.length || skillReferences.length
        )
          throw Error("This message id already belongs to another input.");
        return;
      }
      if (
        pending.has(c.id) ||
        draining.has(c.id) ||
        stagingAttachments.has(c.id)
      )
        throw new Error("A Code message is still being submitted.");
      if (clear) return clearSession(id);
      if (compact) {
        if (images?.length || attachments?.length)
          throw Error("Remove attachments before compacting context; they will not be sent.");
        if (isRunning || queueFor(c.id).length || c.codeNewTask || isStopping(c.id))
          throw Error("Wait for the current turn to finish and resolve queued input before compacting context.");
        if (c.incognito || !ctx.account()?.id ||
            (c.sessionAuthors && c.sessionAuthors.viewerAccountUuid !== ctx.account()?.id))
          throw Error("Local Code compaction is unavailable.");
        const start = new CodeSendStart();
        const submission = { uuid, start };
        pending.set(c.id, submission);
        try {
          await localCall("compactConversation", c.id, uuid, { [officialCodeSendStart]: start });
        } finally {
          if (stillCurrent() && pending.get(c.id) === submission) pending.delete(c.id);
        }
        return;
      }
      if (autoCompact !== undefined) {
        if (images?.length || attachments?.length)
          throw Error("Remove attachments before changing auto-compact settings.");
        const tokens = parseCodeAutoCompact(autoCompact);
        if (tokens === undefined)
          throw Error("Use /autocompact auto or enter a context limit of at least 1,000 tokens.");
        if (!localCode(c) || c.incognito)
          throw Error("Auto-compact settings are unavailable for this Code session.");
        const settings = await localCall("saveSettings", { ...ctx.settings(), codeAutoCompactTokens: tokens });
        if (!settings || typeof settings !== "object" || !("codeAutoCompactTokens" in settings) ||
            settings.codeAutoCompactTokens !== tokens)
          throw Error("The auto-compact setting could not be confirmed.");
        return;
      }
      if (review !== undefined) {
        if (images?.length || attachments?.length)
          throw Error("Remove attachments before starting a Code review.");
        if (!localCode(c) || c.incognito || isRunning || c.codeNewTask || !noQueuedInput(c.id))
          throw Error("Wait for the current turn to finish and resolve queued input before reviewing.");
        const target = parseReviewArguments(review);
        if ("error" in target) throw Error(target.error);
        const start = new CodeSendStart();
        const submission = { uuid, start };
        pending.set(c.id, submission);
        try {
          await localCall("startReview", c.id, target, message.trim(), { [officialCodeSendStart]: start, uuid });
        } finally {
          if (stillCurrent() && pending.get(c.id) === submission) pending.delete(c.id);
        }
        return;
      }
      if (name && localCode(c) && isReservedCodeSlashCommand(name))
        throw Error(`/${name} is unavailable in this local Code session.`);
      stagingAttachments.add(c.id);
      const cancellation = cancellations.get(c.id);
      let fileAttachments: import("../../../shared/types").Attachment[];
      let prepared: PreparedNativeCommand = { message };
      try {
        prepared = c.environment?.kind === "ssh"
          ? await prepareNativeSshCommand(names =>
              readNativeSshCommands(localCall, { kind: "session", conversationId: c.id }, names),
            message, skillReferences)
          : await prepareCommand(message, { sessionId: id }, skillReferences);
        if (cancellations.get(c.id) !== cancellation)
          throw Error("The Code message was cancelled before dispatch.");
        if (
          (prepared.command || images?.length || attachments?.length || skillReferences.length) &&
          receiptCount() >= 2000
        )
          throw Error("The saved message receipt limit has been reached.");
        fileAttachments = await storeCodeAttachments(
          localCall,
          images,
          attachments,
          selectedFiles(caller, message, id),
        );
      } finally {
        if (stillCurrent()) stagingAttachments.delete(c.id);
      }
      if (cancellations.get(c.id) !== cancellation)
        throw Error("The Code message was cancelled before dispatch.");
      // Do not let a newer same-text send be mistaken for an older unknown
      // dispatch during history reconciliation. Resolve/take back held input first.
      const holdsInput = queueFor(c.id).some(
        (entry) =>
          entry.requiresConfirmation ||
          (entry.state === "submitting" &&
            (!isRunning ||
              (entry.sendText ?? entry.message) ===
                (prepared.sendText ?? prepared.message))),
      );
      const shouldQueue =
        (!!prepared.command && !isRunning) ||
        (isRunning &&
          (skillReferences.length || priority === "later" || steeringGates?.ccdSteering === false)) ||
        holdsInput;
      if (shouldQueue) {
        const entries = queueFor(c.id);
        const sendSkills = prepared.command ? prepared.skillReferences ?? [] : skillReferences;
        setQueue(c.id, [
          ...entries,
          {
            uuid,
            ...prepared,
            ...(sendSkills.length ? { skillReferences: sendSkills } : {}),
            requestHash,
            state: "queued",
            createdAt: Date.now(),
            ...(fileAttachments.length ? { attachments: fileAttachments } : {}),
            ...(holdsInput
              ? { requiresConfirmation: true }
              : {}),
            ...(steeringGates ? { steeringGates } : {}),
          },
        ]);
        emitQueuedMessage(c, uuid, message);
        host.emit("LocalSessions", "onEvent", {
          type: "session_updated",
          sessionId: id,
          session: sessionDetails(c),
        });
        const latest = await get(id, true);
        if (latest)
          await drainQueued(
            latest,
            prepared.command && !isRunning && entries.length === 0
              ? uuid
              : undefined,
          );
        if (
          prepared.command &&
          queueFor(c.id).some(
            (entry) => entry.uuid === uuid && entry.state === "submitting",
          )
        )
          throw Error(
            "The command delivery is unconfirmed. It is retained and will not be replayed automatically.",
          );
        return;
      }
      const start = isRunning ? undefined : new CodeSendStart(uuid);
      const submission = { uuid, start };
      pending.set(c.id, submission);
      try {
        if (isRunning) {
          await steerQueued(c, {
            uuid,
            ...prepared,
            requestHash,
            state: "queued",
            createdAt: Date.now(),
            ...(fileAttachments.length ? { attachments: fileAttachments } : {}),
            ...(steeringGates ? { steeringGates } : {}),
          });
          emitQueuedMessage(c, uuid, message);
          return;
        }
        // Persist before dispatch: a lost acknowledgement or account change
        // must not turn reopening the session into an implicit second send.
        setQueue(c.id, [
          ...queueFor(c.id),
          {
            uuid,
            ...prepared,
            requestHash,
            state: "submitting",
            ...(skillReferences.length && !prepared.command ? { skillReferences } : {}),
            before: c.turns.map((turn) => turn.id),
            createdAt: Date.now(),
            ...(fileAttachments.length ? { attachments: fileAttachments } : {}),
          },
        ]);
        const updated = (await localCall("send", {
          conversationId: c.id,
          ...(marks?.personSent === true && !prepared.command && offerable(c) ? {} : { continueCodeSession: true }),
          mode: "code",
          text: message,
          ...(skillReferences.length && !prepared.command ? { skillReferences } : {}),
          attachments: fileAttachments.map((a) => ({ id: a.id })),
          providerId: c.providerId,
          model: c.model,
        }, { [officialCodeSendStart]: start,
          ...(marks?.personSent === true && !prepared.command && offerable(c) ? { [officialCodeNewTaskInput]: { uuid, createdAt: Date.now() } } : {}),
        })) as Conversation;
        if (updated?.id === c.id) {
          reconcileQueued(updated);
          if (updated.codeNewTask?.nativeInput?.uuid === uuid) {
            const entry = queueFor(c.id).find(item => item.uuid === uuid);
            if (entry) { rememberMessage(c.id, entry, true); persist(); }
            host.emit("LocalSessions", "onEvent", { type: "session_updated", sessionId: id, session: sessionDetails(updated) });
            if (preference(ctx.settings(), "ccNewTaskPrompt") === "new_session")
              await resolveNativeOffer(updated, updated.codeNewTask.id, "new_session", { worktree: offerWorktreeDefault(updated) });
          }
        }
      } catch (error) {
        if (start?.cancelledBeforeDispatch && stillCurrent()) {
          holdUnsent(c.id, uuid);
        } else if (start && stillCurrent() && ctx.localLoadConversation) {
          const current = await scope.guard(() => ctx.localLoadConversation!(c.id))
            .catch(() => undefined);
          if (current && stillCurrent() && readable(current)) {
            reconcileQueued(current);
            const ids = messageIds.get(c.id);
            if (current.turns.some(turn =>
              !turn.id.startsWith("pending-") &&
              (turn.officialCodeEventId === uuid ||
                ids?.get(turn.officialCodeEventId ?? `${turn.id}:user`) === uuid),
            )) return;
          }
        }
        throw error;
      } finally {
        if (stillCurrent() && pending.get(c.id) === submission)
          pending.delete(c.id);
      }
    },
  );
  const resolveNativeOffer = async (c: Conversation, taskId: string, choice: "here" | "new_session", placement?: CodeSideSessionPlacement) => {
    const offer = c.codeNewTask;
    if (!offer?.nativeInput || offer.cloudTarget || offer.id !== taskId || c.archived || !offerable(c) || ctx.readOnly || resolvingOffers.has(c.id)) return false;
    const { uuid } = offer.nativeInput;
    const resolution = { uuid };
    resolvingOffers.set(c.id, resolution);
    try {
      const result = await localCall("officialResolveCodeNewTask", c.id, taskId, choice, () => stillCurrent() && ctx.isCurrent?.() !== false && !ctx.readOnly, placement) as Conversation;
      if (!result?.turns.some(turn => turn.officialCodeEventId === uuid) ||
          (choice === "here" ? result.id !== c.id : result.parentSessionId !== c.id || result.nativeSideSession?.taskId !== taskId)) return false;
      if (choice === "here") reconcileQueued(result);
      else {
        const entry = queueFor(c.id).find(item => item.uuid === uuid);
        if (entry) rememberMessage(c.id, entry, true);
        setQueue(c.id, queueFor(c.id).filter(item => item.uuid !== uuid));
      }
      const latest = await get(publicId(c.id), true);
      if (latest) host.emit("LocalSessions", "onEvent", { type: "session_updated", sessionId: publicId(c.id), session: sessionDetails(latest) });
      return true;
    } finally { if (resolvingOffers.get(c.id) === resolution) resolvingOffers.delete(c.id); }
  };
  on("LocalSessions.popBackgroundTaskSuggestionById", async (id: string, taskId: string, launched: boolean) => {
    if (typeof launched !== "boolean") return false;
    const c = await get(id, true);
    if (!c || ctx.readOnly) return false;
    if (c.codeModelProposals?.some(p => p.id === taskId))
      return localCall("officialCodeModelProposal", c.id, taskId, { kind: "pop", launched },
        () => stillCurrent() && ctx.isCurrent?.() !== false && !ctx.readOnly);
    return launched === false ? resolveNativeOffer(c, taskId, "here") : false;
  });
  const startCloudOffer = async (c: Conversation, taskId: string, selection: Extract<
    z.infer<typeof officialCodeSideSessionTarget>, { target: "cloud" }
  >) => {
    const cloud = ctx.officialDesktopCloudCode;
    const offer = c.codeNewTask;
    if (!offer?.nativeInput || offer.id !== taskId || c.archived || !localCode(c) ||
        ctx.readOnly || resolvingOffers.has(c.id) || selection.auto) return false;
    if (!cloud?.available()) throw Error("Cloud Code is unavailable. Check sync with the web.");
    if (offer.attachments.length)
      throw Error("Attachments in this offer are available on this computer. Start the task here to keep them.");
    if (selection.poolId && !selection.environmentId)
      throw Error("Choose a Cloud Code environment.");
    const { uuid } = offer.nativeInput;
    const resolution = { uuid };
    resolvingOffers.set(c.id, resolution);
    const current = () => stillCurrent() && ctx.isCurrent?.() !== false && !ctx.readOnly;
    try {
      const environmentId = selection.environmentId ?? "default";
      const saved = offer.cloudTarget;
      if (saved && saved.environmentId !== environmentId)
        throw Error("Retry the original cloud environment to confirm this offer.");
      const repository = saved?.repository ?? (c.cwd && workspaceRepository(c.cwd));
      if (!repository) throw Error("A GitHub repository is required to start this task in Cloud Code.");
      const target = saved ?? codeCloudSideSessionTarget.parse({
        environmentId,
        repository,
        model: selection.picks?.model && selection.picks.model !== "default" ? selection.picks.model : offer.model,
        effort: selection.picks?.effort ?? offer.effort,
        permissionMode: selection.picks?.permissionMode ?? "default",
      });
      if (!saved && !(await cloud.listCloudEnvironments()).some(row => row.id === target.environmentId))
        throw Error("The selected Cloud Code environment is unavailable.");
      if (!await localCall("officialUpdateCodeCloudOffer", c.id, taskId, { kind: "reserve", target }, current))
        return false;
      const sessionId = await scope.guard(() => cloud.startSideSession({
        target, requestId: uuid, parentId: c.id, taskId, text: offer.text, skillReferences: offer.skillReferences,
      }));
      if (!await localCall("officialUpdateCodeCloudOffer", c.id, taskId, { kind: "confirm", sessionId }, current))
        return false;
      const latest = await get(publicId(c.id));
      if (latest) host.emit("LocalSessions", "onEvent", { type: "session_updated", sessionId: publicId(c.id), session: sessionDetails(latest) });
      return true;
    } finally {
      if (resolvingOffers.get(c.id) === resolution) resolvingOffers.delete(c.id);
    }
  };
  on("LocalSessions.acceptSideSessionOffer", async (id: string, taskId: string, options: unknown) => {
    const target = officialCodeSideSessionTarget.safeParse(options);
    if (!target.success) return false;
    const c = await get(id, true);
    if (!c || ctx.readOnly) return false;
    if (c.codeModelProposals?.some(p => p.id === taskId && p.kind === "offer"))
      return localCall("officialCodeModelProposal", c.id, taskId, { kind: "acceptOffer", selection: target.data },
        () => stillCurrent() && ctx.isCurrent?.() !== false && !ctx.readOnly);
    if (!c.codeNewTask || c.codeNewTask.id !== taskId) return false;
    if (target.data.target === "cloud") return startCloudOffer(c, taskId, target.data);
    const { useWorktree, picks } = target.data;
    const provider = ctx.settings().providers.find(row => row.id === c.codeNewTask?.providerId);
    const model = picks?.model === "default" ? provider?.model : picks?.model;
    if (model && (!provider || ![provider.model, ...provider.models].includes(model))) return false;
    return resolveNativeOffer(c, taskId, "new_session", {
      worktree: useWorktree ?? picks?.useWorktree ?? offerWorktreeDefault(c),
      ...(model ? { model } : {}),
      ...(picks?.effort ? { effort: picks.effort } : {}),
      ...(picks?.permissionMode ? { codePermissionMode: codePermissionModes[picks.permissionMode] } : {}),
    });
  });
  on("LocalSessions.cancelQueuedMessage", async (id: string, uuid: string) => {
    const caller = host.caller;
    const c = await get(id, true);
    if (!c) throw new Error("Code session not found");
    if (offeredInput(c) === uuid) return false;
    const found = queueFor(c.id).find((entry) => entry.uuid === uuid);
    if (!found || found.state === "steered" || draining.get(c.id) === uuid)
      return false;
    if (
      found.state === "submitting" &&
      [...(messageIds.get(c.id)?.values() ?? [])].includes(uuid)
    )
      rememberMessage(c.id, found);
    setQueue(
      c.id,
      queueFor(c.id).filter((entry) => entry.uuid !== uuid),
    );
    const documents = found.attachments?.filter((file) => file.kind !== "image") ?? [];
    if (caller && documents.length) {
      try {
        const files = await localCall(
          "officialRestoreCodeAttachments",
          documents.map((file) => file.id),
        ) as typeof documents;
        if (files.length === documents.length && files.every((file, index) => file.path === documents[index].path))
          host.grantQueuedCodeAttachments(caller, files.map((file) => file.path), id);
      } catch {
        // A stale or missing attachment cannot grant filesystem access.
      }
    }
    await emitWithdrawnMessage(c, uuid);
    return true;
  });
  on(
    "LocalSessions.reorderQueuedMessage",
    async (id: string, uuid: string, overUuid: string) => {
      const c = await get(id, true);
      if (!c) throw new Error("Code session not found");
      const entries = [...queueFor(c.id)],
        from = entries.findIndex((entry) => entry.uuid === uuid),
        over = entries.findIndex((entry) => entry.uuid === overUuid);
      if (from < 0 || over < 0 || from === over) return false;
      if (
        [entries[from], entries[over]].some(
          (entry) => entry.state !== "queued",
        )
      )
        return false;
      if ([uuid, overUuid].includes(draining.get(c.id) ?? "")) return false;
      const [entry] = entries.splice(from, 1);
      const target = entries.findIndex((item) => item.uuid === overUuid);
      entries.splice(from < over ? target + 1 : target, 0, entry);
      setQueue(c.id, entries);
      return true;
    },
  );
  on("LocalSessions.promoteQueuedMessage", async (id: string, uuid: string) => {
    const c = await get(id, true);
    if (!c) throw new Error("Code session not found");
    if (offeredInput(c) === uuid) return false;
    if (draining.has(c.id)) return false;
    const entries = [...queueFor(c.id)],
      index = entries.findIndex((entry) => entry.uuid === uuid);
    if (entries[index]?.state !== "queued") return false;
    if (entries.some((entry) => entry.state === "submitting")) return false;
    const [entry] = entries.splice(index, 1);
    entries.unshift(entry);
    setQueue(c.id, entries);
    if (!running(c)) await drainQueued(c, uuid);
    else if (!entry.skillReferences?.length) await steerQueued(c, entry);
    return true;
  });
  on("LocalSessions.sendSteeredNow", async (id: string, uuid: string) => {
    const c = await get(id, true);
    if (!c) throw new Error("Code session not found");
    if (offeredInput(c) === uuid) return false;
    if (draining.has(c.id)) return false;
    const entries = queueFor(c.id);
    const entry = entries.find((item) => item.uuid === uuid);
    if (entry?.state !== "queued") return false;
    if (entries.some((item) => item.state === "submitting")) return false;
    if (!running(c)) {
      const accepted = await drainQueued(c, uuid);
      return (
        accepted === true ||
        !queueFor(c.id).some((item) => item.uuid === uuid)
      );
    }
    return steerQueued(c, entry);
  });
  const cancelPrepared = (id: string) => {
    cancellations.set(id, {});
    const entries = queueFor(id);
    if(entries.length) setQueue(id, entries.map(entry => ({...entry, requiresConfirmation:true})));
  };
  const interrupt = async (id: string, closeStarting: boolean) => {
    const preparedId = typeof id === "string" ? internalId(id) : "";
    const startup = startingIds.get(preparedId);
    const submission = startup ?? pending.get(preparedId)?.start;
    // Preparation is already owned by this account scope. Retire it before a
    // slow history read can let an attachment restore dispatch the input.
    const prepared = preparedId && (
      stagingAttachments.has(preparedId) || pending.has(preparedId) ||
      draining.has(preparedId) || queued.has(preparedId) || startup
    );
    if (prepared) cancelPrepared(preparedId);
    if (submission) {
      const result = await submission.stop();
      if (result.status === "mismatch")
        throw Error("The Code turn changed or its stop was not confirmed. Check the session before stopping again.");
      if (closeStarting && startup?.cancelledBeforeDispatch && stillCurrent())
        host.emit("LocalSessions", "onEvent", { type: "close", sessionId: id, code: 0 });
      return;
    }
    const c = await get(id, true);
    if (!c) throw new Error("Code session not found");
    if (!prepared) cancelPrepared(c.id);
    const turn = c.turns.at(-1);
    if (c.turns.some((entry) => entry !== turn && entry.status === "inProgress"))
      throw Error("The active Code turn is ambiguous. Refresh the session before stopping again.");
    // Stop also cancels input that has not reached the engine. In that case,
    // do not issue an unbound stop which could hit a newly started turn.
    if (!turn || ["completed", "failed", "interrupted"].includes(turn.status))
      return;
    if (
      turn.status !== "inProgress" ||
      !turn.id || (!turn.id.startsWith("pending-") && !c.threadId) ||
      !Number.isSafeInteger(turn.createdAt) || turn.createdAt < 0 ||
      !Number.isSafeInteger(c.createdAt) || c.createdAt < 0
    )
      throw Error("The Code turn is not ready for a confirmed stop. Check its state and try again.");
    const expected = {
      turnId: turn.id,
      turnCreatedAt: turn.createdAt,
      conversationCreatedAt: c.createdAt,
      ...(turn.id.startsWith("pending-")
        ? { kind: "starting" as const }
        : { threadId: c.threadId }),
    };
    const key = JSON.stringify([c.id, expected]);
    const existing = stopping.get(key);
    if (existing) return existing;
    const operation = (async () => {
      const result = await localCall("interrupt", c.id, expected);
      if (
        !result || typeof result !== "object" || !("status" in result) ||
        (result.status !== "accepted" && result.status !== "already_finished")
      )
        throw Error("The Code turn changed or its stop was not confirmed. Check the session before stopping again.");
    })();
    stopping.set(key, operation);
    try { await operation; }
    finally { if (stopping.get(key) === operation) stopping.delete(key); }
  };
  on("LocalSessions.stop", (id: string) => interrupt(id, false));
  on("LocalSessions.interrupt", (id: string) => interrupt(id, true));
  on(
    "LocalSessions.respondToToolPermission",
    async (requestId: string, decision: string, updatedInput?: unknown) => {
      if (typeof requestId !== "string")
        throw new Error("Invalid approval request.");
      if (requestId.startsWith(coworkComputerUsePrefix)) {
        const key = requestId.slice(coworkComputerUsePrefix.length);
        const shown = computerUseCards.get(key);
        const unavailable = () => Error("The computer-use request is no longer available.");
        if (!shown) throw unavailable();
        const c = await readOpenedSession(shown.sessionId);
        if (!computerUseFor(c)) throw unavailable();
        const state = await computerUseState();
        const pending = state.requests?.find(request => request.id === key && request.conversationId === c.id);
        if (!pending || computerUseCards.get(key)?.sessionId !== shown.sessionId) throw unavailable();
        await localCall("answerComputerUseAccess", key, coworkComputerUseDecision(pending, decision, updatedInput));
        return;
      }
      if (
        requestId.startsWith("code-command:") ||
        requestId.startsWith("code-write:") ||
        requestId.startsWith("code-permissions:")
      ) {
        if (!ctx.codeCommandPermissions)
          throw new Error("Code approval is unavailable.");
        return ctx.codeCommandPermissions.respond(
          requestId, decision, updatedInput,
        );
      }
      if (decision !== "once" && decision !== "deny")
        throw new Error(
          "Only allow once or deny is supported for this Code approval.",
        );
      if (requestId.startsWith(elicitationPrefix)) {
        const pending = outstanding.get(requestId);
        const unavailable = () =>
          new Error("The elicitation request is no longer available.");
        if (!pending || !ctx.respondToLocalCodeElicitation) throw unavailable();
        const c = await readOpenedSession(pending.request.sessionId, true);
        const matching = (await approvals()).filter(
          (approval) => String(approval.id) === String(pending.approval.id),
        );
        const offer = elicitationFor(pending.approval, c);
        if (
          outstanding.get(requestId) !== pending ||
          matching.length !== 1 ||
          matching[0] !== pending.approval ||
          !offer ||
          !isDeepStrictEqual(pending.request, { ...offer, requestId })
        )
          throw unavailable();
        const answer = mcpElicitationResponse(pending.approval, updatedInput);
        if (!answer || (answer.action === "accept") !== (decision === "once"))
          throw new Error(
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
        throw new Error("The approval request is no longer available.");
      const approval = matching[0];
      if (approval.method === "item/commandExecution/requestApproval")
        throw new Error(
          "The command approval is no longer available. Reopen the session.",
        );
      if (
        approval.method === "item/fileChange/requestApproval" ||
        approval.method === "item/permissions/requestApproval"
      )
        throw new Error(
          "The approval is no longer available. Reopen the session.",
        );
      const c = await get(publicId(approval.conversationId));
      if (!c)
        throw new Error(
          "The approval does not belong to a local Code session.",
        );
      const request = toolPermission(approval, c, ctx.settings?.().mcpServers);
      if (!request) throw new Error("This approval type is not supported yet.");
      if (
        updatedInput !== undefined &&
        JSON.stringify(updatedInput) !== JSON.stringify(request.input)
      )
        throw new Error("Edited approval input is not supported yet.");
      await localCall(
        "approve",
        approval.id,
        approvalResponse(approval, decision === "once" ? "once" : "deny"),
      );
    },
  );
  on(
    "LocalSessions.updateSession",
    async (id: string, options: Record<string, unknown>) => {
      if (!options || typeof options !== "object" || Array.isArray(options))
        throw new Error("Invalid Code session update.");
      const allowed = new Set(["title", "titleSource", "isStarred"]);
      if (Object.keys(options).some((key) => !allowed.has(key)))
        throw new Error("This Code session update is not supported yet.");
      // The renderer sends this marker when its starred-session cache starts empty.
      if (id === "local_star-sync-notice" && options.isStarred === false &&
          Object.keys(options).length === 1) {
        if (ctx.readOnly || ctx.isCurrent?.() === false)
          throw Error("Local Code session updates are unavailable.");
        return;
      }
      if (
        options.titleSource !== undefined &&
        options.titleSource !== "user" && options.titleSource !== "auto"
      )
        throw new Error("This Code title source is not supported yet.");
      const c = await readOpenedSession(id, true).catch(error => {
        if (error instanceof Error && /not found/.test(error.message) &&
            options.titleSource === "auto" && options.title === "" &&
            Object.keys(options).every(key => key === "title" || key === "titleSource"))
          return undefined;
        throw error;
      });
      // The landing page clears its automatic title before start creates the session.
      // A nonempty title must never report success without a stored session.
      if (
        !c && options.titleSource === "auto" && options.title === "" &&
        Object.keys(options).every(
          (key) => key === "title" || key === "titleSource",
        )
      )
        return;
      if (!c) throw new Error("Code session not found");
      if (options.titleSource !== undefined && options.title === undefined)
        throw new Error("A title is required with its source.");
      const patch: {
        title?: string;
        titleSource?: "auto" | "user";
        pinned?: boolean;
      } = {};
      if (
        options.title !== undefined &&
        !(options.titleSource === "auto" && options.title === "")
      ) {
        if (typeof options.title !== "string" || !options.title.trim())
          throw new Error("The Code title cannot be empty.");
        patch.title = options.title;
        patch.titleSource = options.titleSource === "auto" ? "auto" : "user";
      }
      if (options.isStarred !== undefined) {
        if (typeof options.isStarred !== "boolean")
          throw new Error("Invalid starred state.");
        patch.pinned = options.isStarred;
      }
      if (!Object.keys(patch).length) return;

      // The official page may submit a generated title while the user renames
      // the same session. Finish metadata writes in order without racing the
      // lifecycle lock or carrying a queued edit into a replacement session.
      const previous = metadataUpdates.get(c.id);
      const update = scope.guard(async () => {
        if (previous) {
          await previous.catch(() => undefined);
          const latest = await readOpenedSession(id, true);
          if (latest.createdAt !== c.createdAt)
            throw Error("The Code session changed. Refresh before renaming it.");
        }
        if (managing.has(c.id))
          throw Error("A Code session change is already in progress.");
        managing.add(c.id);
        try {
          await localCall("updateConversation", c.id, patch);
        } finally {
          if (stillCurrent()) managing.delete(c.id);
        }
      });
      metadataUpdates.set(c.id, update);
      try {
        await update;
      } finally {
        if (metadataUpdates.get(c.id) === update) metadataUpdates.delete(c.id);
      }
    },
  );
  const manageSession = async <T>(
    id: string,
    kind: "archive" | "unarchive" | "delete" | "discardKept",
    operation: (c: Conversation) => Promise<T>,
  ) => {
    const key = typeof id === "string" ? internalId(id) : "";
    if (managing.has(key)) throw Error("A Code session change is already in progress.");
    managing.add(key);
    try {
      const c = await readOpenedSession(id, true);
      if (running(c) || pending.has(c.id) || draining.has(c.id) || stagingAttachments.has(c.id) ||
          (kind !== "unarchive" && (queueFor(c.id).length || c.codeNewTask)))
        throw Error("Wait for running or saved Code input to settle before changing this session.");
      return await operation(c);
    } finally { if (stillCurrent()) managing.delete(key); }
  };
  const deleteOptions = z.strictObject({
    discardChangesIn: z.array(z.string().min(1)).max(21).optional(),
  });
  const archiveOptions = deleteOptions.extend({
    cleanupWorktree: z.boolean().optional(),
    forceWorktreeCleanup: z.boolean().optional(),
  });
  const unsupportedOptions = (kind: "archive" | "delete") =>
    Error(`Code ${kind} options are not supported yet.`);
  const archiveDiscard = (c: Conversation, options: z.infer<typeof archiveOptions>) => {
    const worktrees = conversationWorktrees(c);
    if (options.cleanupWorktree === false) {
      if (!worktrees.length || options.forceWorktreeCleanup || options.discardChangesIn?.length)
        throw unsupportedOptions("archive");
      return [];
    }
    const paths = options.discardChangesIn ?? (c.worktree ? [c.worktree.path] : []);
    if (!options.forceWorktreeCleanup) {
      if (options.discardChangesIn?.length) throw unsupportedOptions("archive");
      return [];
    }
    if (!worktrees.length ||
        (!paths.length && options.discardChangesIn === undefined) ||
        paths.some(path => !worktrees.some(tree => tree.path === path)))
      throw unsupportedOptions("archive");
    return paths;
  };
  on("LocalSessions.archive", async (id: string, options?: unknown) => {
    const parsed = archiveOptions.safeParse(options === undefined ? {} : options);
    if (!parsed.success) throw unsupportedOptions("archive");
    await manageSession(id, "archive", async c => {
      const paths = archiveDiscard(c, parsed.data);
      const saved = (paths.length || parsed.data.cleanupWorktree === false
        ? await localCall("officialCodeWorktreeLifecycle", {
            kind: "archive", sessionId: c.id, paths, cleanupWorktree: parsed.data.cleanupWorktree,
          })
        : await localCall("updateConversation", c.id, { archived: true })) as Conversation;
      if (saved?.id !== c.id || saved.archived !== true)
        throw Error("The Code archive could not be confirmed. Reopen before retrying.");
      publishPromptSuggestion(id);
      host.emit("LocalSessions", "onEvent", { type: "archived", sessionId: id });
    });
  });
  on("LocalSessions.unarchive", async (id: string) => {
    await manageSession(id, "unarchive", async c => {
      const saved = await localCall("updateConversation", c.id, { archived: false }) as Conversation;
      if (saved?.id !== c.id || saved.archived !== false)
        throw Error("The Code restore could not be confirmed. Reopen before retrying.");
      host.emit("LocalSessions", "onEvent", {
        type: "unarchived", sessionId: id, session: await view(saved, false),
      });
    });
  });
  on("LocalSessions.setSessionAutoArchiveOnPrClose", async (id: string, raw: unknown) => {
    const enabled = z.boolean().parse(raw);
    const c = await readOpenedSession(id, true);
    if (c.incognito) throw Error("Code session not found.");
    if (c.prAutoArchive === enabled && !(enabled && c.codeAutoArchiveExempt)) return;
    await localCall("updateConversation", c.id, { prAutoArchive: enabled });
  });
  on("LocalSessions.setManualKeepAwake", async (rawId: unknown, rawEnabled: unknown) => {
    const id = internalId(z.string().parse(rawId));
    const enabled = z.boolean().parse(rawEnabled);
    const { localLoadConversation, setOfficialCodeManualKeepAwake } = ctx;
    if (!id || !localLoadConversation || !setOfficialCodeManualKeepAwake || !sessionMutationCurrent()) return;
    const c = await scope.guard(() => localLoadConversation(id));
    if (!c || c.id !== id || !canKeepAwake(c) || !sessionMutationCurrent()) return;
    if ((ctx.officialCodeManualKeepAwake?.(id) === true) !== enabled)
      setOfficialCodeManualKeepAwake(id, enabled);
  });
  on("LocalSessions.delete", async (id: string, options?: unknown) => {
    const parsed = deleteOptions.safeParse(options === undefined ? {} : options);
    if (!parsed.success) throw unsupportedOptions("delete");
    await manageSession(id, "delete", async c => {
      const paths = parsed.data.discardChangesIn ?? [];
      if (paths.length) {
        if (paths.some(path => !conversationWorktrees(c).some(tree => tree.path === path)))
          throw unsupportedOptions("delete");
        await localCall("officialCodeWorktreeLifecycle", { kind: "delete", sessionId: c.id, paths });
      } else await localCall("deleteConversation", c.id);
      if (!ctx.localListConversations ||
          (await scope.guard(() => ctx.localListConversations!())).some(row => row.id === c.id))
        throw Error("The Code deletion could not be confirmed. Refresh before retrying.");
      // Release adapter receipts only after a confirmed removal, never on a rejected attempt.
      queued.delete(c.id);
      messageIds.delete(c.id);
      commandReceipts.delete(c.id);
      pending.delete(c.id);
      recovering.delete(c.id);
      announced.delete(id);
      partialReplies.delete(id);
      activeRetries.delete(id);
      publishPromptSuggestion(id);
      autoArchivedSessions.delete(id);
      settledTurns.delete(id);
      runningSessions.delete(id);
      revisions.set(id, (revisions.get(id) ?? 0) + 1);
      try { persist(); }
      catch { ctx.log?.("[official-ui] Deleted Code session receipts need cleanup."); }
      host.emit("LocalSessions", "onEvent", { type: "deleted", sessionId: id });
    });
  });
  on("LocalSessions.discardKeptWorktree", (id: string) =>
    manageSession(id, "discardKept", async c => {
      if (!c.archived || !conversationWorktrees(c).some(tree => tree.state === "kept"))
        return { outcome: "not_kept" };
      return localCall("officialCodeWorktreeLifecycle", { kind: "discardKept", sessionId: c.id });
    }));
  const unsubscribe = ctx.onEvent((event) =>
    scope.run(() => {
      scope.sync();
      load();
      if (event.type === "resync") {
        host.emit("LocalSessions", "onEvent", { type: "initialized", loadGeneration: ++listGeneration });
        return;
      }
      if (event.type === "settings") {
        if (!preference(event.settings, "ccPromptSuggestions"))
          for (const id of promptSuggestions.keys()) publishPromptSuggestion(id);
        return;
      }
      if (event.type === "devices-changed") {
        host.emit("LocalSessions", "onEvent", { type: "initialized", loadGeneration: ++listGeneration });
        return;
      }
      if (event.type === "computer-use") {
        if (event.resolved) {
          const card = computerUseCards.get(event.resolved);
          computerUseCards.delete(event.resolved);
          if (card) host.emit("LocalSessions", "onEvent", {
            type: "tool_permission_resolved", sessionId: card.sessionId, request: card,
          });
        }
        if (event.request) {
          const { conversationId, id } = event.request;
          void scope.guard(() => ctx.localLoadConversation!(conversationId)).then(async (c) => {
            if (!c || c.id !== conversationId || !computerUseFor(c)) return;
            const state = await computerUseState();
            const pending = state.requests?.find(request => request.id === id && request.conversationId === c.id);
            if (!pending) return;
            const card = coworkComputerUseCard(pending, state);
            computerUseCards.set(id, card);
            host.emit("LocalSessions", "onEvent", {
              type: "tool_permission_request", sessionId: card.sessionId, request: card,
            });
          }).catch(error => ctx.log("[official-ui] Code computer-use update failed", String(error)));
        }
        return;
      }
      if (event.type === "ssh-status") {
        const { hostId, status } = event;
        const type = status.state === "ready" ? "ssh_connected" :
          status.state === "connecting" || status.state === "reconnecting" ? "ssh_reconnecting" :
          status.state === "error" || status.state === "idle" || status.state === "needs-auth" ? "ssh_disconnected" : undefined;
        if (!type) return;
        void list().then((sessions) => {
          for (const c of sessions) {
            if (c.archived || c.environment?.kind !== "ssh" || c.environment.hostId !== hostId) continue;
            host.emit("LocalSessions", "onEvent", {
              type,
              sessionId: publicId(c.id),
              ...(status.state === "error" && status.code === "auth-key-rejected" ?
                { sshFailureReason: "auth_key_rejected" } : {}),
            });
          }
        }).catch((error) => ctx.log("Code SSH status update failed", String(error)));
        return;
      }
      if (event.type === "approval") {
        const requestId = String(event.approval.id);
        const revision = (permissionRevisions.get(requestId) ?? 0) + 1;
        permissionRevisions.set(requestId, revision);
        void get(publicId(event.approval.conversationId), true)
          .then((c) => {
            if (permissionRevisions.get(requestId) !== revision) return;
            if (!c) {
              resolvePermission(requestId);
              return;
            }
            const request = permission(event.approval, c);
            if (!request) {
              resolvePermission(requestId);
              host.emit("LocalSessions", "onEvent", {
                type: "error",
                sessionId: publicId(c.id),
                error:
                  "This permission request is not supported by the experimental Code adapter.",
              });
              return;
            }
            rememberPermission(event.approval, request);
            host.emit("LocalSessions", "onEvent", {
              type: "tool_permission_request",
              sessionId: request.sessionId,
              request,
            });
          })
          .catch((error) =>
            ctx.log("[official-ui] Code approval update failed", String(error)),
          );
        return;
      }
      if (event.type === "approval-resolved") {
        const id = String(event.id);
        permissionRevisions.set(id, (permissionRevisions.get(id) ?? 0) + 1);
        resolvePermission(id);
        return;
      }
      const key =
        event.type === "conversation"
          ? event.conversation.id
          : event.type === "conversation-turn"
            ? event.conversationId
            : undefined;
      if (!key) return;
      const id = publicId(key);
      if (event.type === "conversation" && event.codeAutoArchived &&
          event.conversation.archived && readable(event.conversation))
        autoArchivedSessions.add(id);
      if (event.type === "conversation" && event.settledCodeTurnId &&
          readable(event.conversation) && !event.conversation.archived) {
        const c = event.conversation;
        const turn = c.turns.find((entry) => entry.id === event.settledCodeTurnId);
        if (turn && !turn.compaction) {
          const pendingResults = settledTurns.get(id) ?? [];
          pendingResults.push(turn);
          settledTurns.set(id, pendingResults);
          const read = ctx.readOfficialCodeArchivePullRequests;
          if (read && canSetPrMetadata(c) && sessionPullRequests({ turns: [turn] }).length)
            void scope.guard(() => read(c))
              .then(async prs => {
                if (prs && canSetPrMetadata(c)) await syncPrBindings(c, prs);
              })
              .catch(error => ctx.log("[official-ui] Code pull request binding failed", String(error)));
        }
      }
      if (event.type === "conversation" && readable(event.conversation)) {
        const c = event.conversation;
        const waiter = nextPrWaits.get(c.id);
        if (waiter) {
          if (c.archived) waiter.finish("dropped");
          else if (c.prAutoFixArm?.expiresAt === waiter.expiresAt) waiter.persisted = true;
          else if (waiter.persisted) waiter.finish(c.pullRequests?.some(pr =>
            pr.headRef === waiter.branch && !pr.dismissed && pr.autoFix?.ci) ? "armed" : "refused");
        }
      }
      const revision = (revisions.get(id) ?? 0) + 1;
      revisions.set(id, revision);
      const managementEvent = managing.has(key), recoveredInput = recovering.has(key);
      // Metadata notifications must not migrate legacy offers or revive saved sends.
      void scope.guard(() => ctx.localLoadConversation!(key))
        .then(async (c) => {
          if (!c || !readable(c) || revisions.get(id) !== revision) return;
          const last = c.turns.at(-1);
          const checkingOut = startingIds.has(key) &&
            last?.status === "inProgress" && last.worktreeStep === "creating";
          if (checkingOut !== initializingWorktrees.has(key)) {
            if (checkingOut) initializingWorktrees.add(key);
            else initializingWorktrees.delete(key);
            host.emit("LocalSessions", "onEvent", {
              type: "initialization_status",
              sessionId: id,
              initializationStatus: {
                step: "worktree_checkout",
                message: "Checking out worktree files...",
                isComplete: !checkingOut,
              },
            });
          }
          const session = await view(c);
          scope.sync();
          if (revisions.get(id) !== revision) return;
          host.emit("LocalSessions", "onEvent", {
            type: "session_updated",
            sessionId: id,
            session,
          });
          if (autoArchivedSessions.delete(id) && c.archived)
            host.emit("LocalSessions", "onEvent", {
              type: "archived", sessionId: id, session, alsoArchived: [],
            });
          const converted = convert(c);
          {
            const seen = announced.get(id) ?? new Map<string, string>();
            const changed: CodeTranscriptRow[] = [];
            const withdrawnUuids: string[] = [];
            const partial = pendingReplies(c);
            for (const uuid of partialReplies.get(id) ?? []) {
              if (!converted.rows.some(row => row.uuid === uuid) && seen.delete(uuid))
                withdrawnUuids.push(uuid);
            }
            if (partial.length) partialReplies.set(id, partial);
            else partialReplies.delete(id);
            for (const turn of c.turns) {
              for (const item of turn.items) {
                if (item.type !== "reasoning" ||
                    (turn.status === "inProgress" && item.lifecycleStatus !== "completed") ||
                    visibleThinkingSummary(item).length) continue;
                const uuid = `${turn.id}:item:${item.id}`;
                if (seen.delete(uuid)) withdrawnUuids.push(uuid);
              }
            }
            if (withdrawnUuids.length)
              host.emit("LocalSessions", "onEvent", {
                type: "held_input_withdrawn",
                sessionId: id,
                withdrawnUuids,
                session,
              });
            for (const row of converted.rows) {
              const fingerprint = JSON.stringify(row);
              if (seen.get(row.uuid) !== fingerprint) {
                seen.set(row.uuid, fingerprint);
                changed.push(row);
              }
            }
            for (const row of hydrateTranscript(c, changed))
              host.emit("LocalSessions", "onEvent", {
                type: "message",
                sessionId: id,
                message: row,
              });
            announced.set(id, seen);
          }
          publishRetry(c);
          const results = settledTurns.get(id);
          settledTurns.delete(id);
          for (const turn of results ?? []) {
            if (c.archived || !c.turns.some((entry) => entry.id === turn.id)) continue;
            const completed = turn.status === "completed";
            const isError = !completed && !codeTurnStoppedByUser(turn);
            host.emit("LocalSessions", "onEvent", {
              type: "message",
              sessionId: id,
              message: {
                type: "result",
                uuid: resultUuid(turn.id),
                session_id: id,
                timestamp: new Date(turn.createdAt).toISOString(),
                parent_tool_use_id: null,
                subtype: isError ? "error_during_execution" : "success",
                is_error: isError,
                ...(completed ? { stop_reason: "end_turn" } :
                  turn.error ? { errors: [turn.error] } : {}),
              },
            });
          }
          publishPromptSuggestion(id, session.promptSuggestion ? c.promptSuggestion : undefined);
          if (session.turnRunning) {
            runningSessions.add(id);
          } else {
            const ended = runningSessions.delete(id) || Boolean(results?.length);
            if (ended && !pending.has(key) && !stagingAttachments.has(key) && !startingIds.has(key))
              host.emit("LocalSessions", "onEvent", { type: "close", sessionId: id });
          }
          if (!managementEvent && !recoveredInput) await drainQueued(c);
        })
        .catch((error) =>
          ctx.log("[official-ui] Code session update failed", String(error)),
        );
    }),
  );
  return () => {
    unsubscribe();
    unregisterArchiveHold?.();
    clearNextPrWaits();
  };
}

