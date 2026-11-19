import { scheduledTaskSetupInput } from "../routines/scheduled-task-setup";
import { type CodePermissionMode } from "../../shared/code-session-permissions";
import { randomUUID } from "node:crypto";
import { preference, type TaskPermission } from "../../shared/settings-extras";
import type {
  Attachment,
  Conversation,
  ConversationHandOffSource,
  EnvironmentRef,
  Mode,
  Provider,
  Settings,
  Turn,
} from "../../shared/types";
import { type SessionSetupHook } from "../../shared/session-setup";
import { type ArtifactOutputKind } from "../../shared/artifact-output";
import type { OrganizationProjectBinding } from "./organization-project-chat";

export interface SendInput {
  sessionInstructions?: string;
  inlineAttachmentDisplays?: import("../../shared/inline-attachment-display").InlineAttachmentDisplay[];
  scheduledTaskSetup?: import("../../shared/scheduled-task-setup").ScheduledTaskSetupIntent;
  blankArtifactRevision?: import("../../shared/blank-artifacts").BlankArtifactRevision;
  artifactOutputKind?: ArtifactOutputKind;
  codePermissionMode?: CodePermissionMode;
  codeUltracode?: true;
  /** A computer's Chat permission mode, sent with a prompt for the cloud. */
  taskPermission?: "default" | "auto" | "bypass";
  coworkPermissionMode?: TaskPermission;
  parentSessionId?: string;
  codeHelperLink?: { taskId: string; title: string; parentTurnId: string; wakeWhenDone?: boolean };
  notificationTrigger?: Turn["notificationTrigger"];
  notificationKey?: string;
  effort?: Settings["codeEffort"];
  thinkingSummariesWanted?: boolean;
  thinkingMode?: "standard" | "extended";
  cloudEnvironmentId?: string;
  conversationId?: string;
  text: string;
  officialChatMessageIds?: Turn["officialChatMessageIds"];
  skillReferences?: import("../../shared/skill-references").SkillReference[];
  completionQuotes?: import("../../shared/completion-quotes").CompletionQuote[];
  mode: Mode;
  webSearch?: boolean;
  connectorOverrides?: Record<string, boolean>;
  connectorToolOverrides?: import("../../shared/conversation-tools").ConversationToolOverrides;
  toolSearchMode?: import("../../shared/tool-search-mode").ToolSearchMode;
  /** Start a new Chat in Research mode (R4); it brings web search with it. */
  research?: boolean;
  /** A new conversation's knowledge bases (shared/knowledge-api.ts). */
  knowledgeBases?: string[];
  projectId?: string;
  cwd?: string;
  additionalFolders?: string[];
  codeSessionFolderGrants?: string[];
  additionalWorktreeFolders?: { path: string; sourceBranch?: string }[];
  attachments: Attachment[];
  providerId: string;
  model: string;
  incognito?: boolean;
  memoryDisabled?: true;
  /** Where a new conversation runs (R9); missing means this computer. */
  environment?: EnvironmentRef;
  /**
   * Codex's clientUserMessageId for the turn: a message from the SSH
   * outbox sends its own id, which also names its waiting turn.
   */
  clientMessageId?: string;
  dispatchDeliveryId?: string;
  /** Host-supplied identity for an existing Cloud Code follow-up. */
  officialCodeEventId?: string;
  officialCodeInputHash?: string;
  officialCodeDisplayText?: string;
  /** The id a client chose for the new conversation (the official-interface adapter: the page already navigated to it). */
  newConversationId?: string;
  codeRemoteControlAtStart?: boolean;
  envScopeId?: Conversation["envScopeId"];
  startedFromEnvironmentId?: Conversation["startedFromEnvironmentId"];
  /** A new session that starts from another one's handoff note (handOffConversation). */
  handedOffFrom?: ConversationHandOffSource;
  /** A scheduled task's run (Conversation.scheduledRun). */
  scheduledRun?: boolean;
  /** The routine that started the run, and the permission mode it was saved with. */
  scheduledTaskId?: string;
  scheduledTaskTitle?: string;
  scheduledPermission?: TaskPermission;
  /** A new Cowork task from an outside prompt (Conversation.asksFirst). */
  asksFirst?: boolean;
  /**
   * A cloud Code session's repository fetch, run in the turn so the session
   * shows before it ends (runner/src/dispatcher.ts, shared/session-setup.ts).
   */
  setup?: SessionSetupHook;
  /** A new local Code session in its own worktree (electron/code-worktree.ts). */
  worktree?: boolean;
  /** The worktree's start branch (the folder menu's Branch). */
  worktreeBranch?: string;
  worktreeBranchHint?: string;
  /** A cloud Code session's pull request after a push (Conversation.autoPullRequest). */
  autoPullRequest?: "ready" | "draft";
}

/** A new Chat asked to start in Research mode (never incognito). */
const startsInResearch = (input: SendInput) =>
  input.mode === "chat" && !input.incognito && Boolean(input.research);

/** A client-chosen id names one creation, never a replacement or implicit retry. */
export function assertNewConversationIdAvailable(
  input: Pick<SendInput, "conversationId" | "newConversationId">,
  conversations: Pick<Conversation, "id">[],
) {
  // A resumed/queued send may retain its original creation input. Its existing
  // conversationId is authoritative and it does not create another row.
  if (input.newConversationId === undefined || input.conversationId !== undefined)
    return;
  if (
    conversations.some(
      (conversation) => conversation.id === input.newConversationId,
    )
  )
    throw new Error(
      "This conversation already exists. Reopen it before continuing.",
    );
}

export function newConversation(
  input: SendInput,
  provider: Provider,
  cwd: string,
  settings?: Settings,
  organizationProject?: OrganizationProjectBinding,
): Conversation {
  const openingText = (input.officialCodeDisplayText ?? input.text).trim();
  let openingTitle = (
    openingText ||
    input.attachments[0]?.name ||
    "New chat"
  ).slice(0, 50);
  if (input.mode === "code" && openingText) {
    // The original local transport recognizes this exact placeholder before
    // persisting a late generated title (cef1e6037-DIC2zPYg.js, fr/fi).
    // Match its six words and Unicode-code-point limit, not UTF-16 slicing.
    const points = Array.from(openingText.split(/\s+/).slice(0, 6).join(" "));
    openingTitle = points.length > 60
      ? points.slice(0, 59).join("") + "\u2026"
      : points.join("");
  }
  return {
    id: input.newConversationId ?? randomUUID(),
    // A handed-off session keeps the title of the one it continues; its
    // first message is the long handoff note.
    title: input.codeHelperLink?.title ?? input.handedOffFrom?.title ?? (input.scheduledRun ? input.scheduledTaskTitle : undefined) ?? openingTitle,
    ...(input.codeHelperLink || input.scheduledRun && input.scheduledTaskTitle ? { titleSetByUser: true } : {}),
    mode: input.mode,
    ...(input.mode === "cowork" && input.coworkPermissionMode
      ? { coworkPermissionMode: input.coworkPermissionMode }
      : {}),
    ...(input.sessionInstructions ? { sessionInstructions: input.sessionInstructions } : {}),
    ...(input.scheduledTaskSetup && input.mode !== "code" && !input.incognito
      ? {
          scheduledTaskSetup: scheduledTaskSetupInput.parse(
            input.scheduledTaskSetup,
          ),
        }
      : {}),
    ...(input.mode === "code" && input.artifactOutputKind
      ? { artifactOutputKind: input.artifactOutputKind }
      : {}),
    ...(input.mode === "code"
      ? {
          ...(input.codePermissionMode
            ? { codePermissionMode: input.codePermissionMode }
            : {}),
          ...(input.codeUltracode ? { codeUltracode: true } : {}),
          ...(input.envScopeId === undefined ? {} : { envScopeId: input.envScopeId }),
          ...(input.startedFromEnvironmentId === undefined ? {} : { startedFromEnvironmentId: input.startedFromEnvironmentId }),
          classifySessionStates: preference(
            settings ?? {},
            "classifySessionStates",
          ),
          // Claudex Code → Connect new sessions to Remote Control.
          ...((input.codeRemoteControlAtStart ??
            (settings ? preference(settings, "remoteControlNewSessions") : true)) === false
            ? { remoteControlOff: true }
            : {}),
          // Claudex Code → Local sandbox and Strict sandbox mode, kept for the
          // session's life (they apply to new sessions).
          ...(settings && !preference(settings, "codeLocalSandbox")
            ? { localSandboxOff: true as const }
            : settings && preference(settings, "codeStrictSandbox")
              ? { strictSandbox: true as const }
              : {}),
          // Claudex Code → Output style: what a new session starts with.
          ...(settings && preference(settings, "codeOutputStyle")
            ? { outputStyle: preference(settings, "codeOutputStyle") }
            : {}),
        }
      : {}),
    webSearch:
      input.mode !== "code" &&
      Boolean(input.webSearch || startsInResearch(input)),
    // R4: the research extension decides whether Research can run.
    ...(startsInResearch(input) ? { research: true } : {}),
    ...(input.knowledgeBases?.length
      ? { knowledgeBases: [...input.knowledgeBases] }
      : {}),
    providerId: provider.id,
    model: input.model,
    projectId: organizationProject?.projectId ?? input.projectId,
    ...(organizationProject ? { projectOrganizationId: organizationProject.projectOrganizationId } : {}),
    ...(input.parentSessionId
      ? { parentSessionId: input.parentSessionId }
      : {}),
    ...(input.mode === "code" && input.parentSessionId && input.codeHelperLink ? {
      nativeSideSession: { taskId: input.codeHelperLink.taskId },
      codeHelperParentTurnId: input.codeHelperLink.parentTurnId,
      ...(input.codeHelperLink.wakeWhenDone ? { codeHelperWakeWhenDone: true } : {}),
    } : {}),
    connectorOverrides: input.connectorOverrides,
    connectorToolOverrides: input.connectorToolOverrides,
    ...(input.toolSearchMode ? { toolSearchMode: input.toolSearchMode } : {}),
    cwd,
    ...(input.mode === "code" && input.additionalFolders?.length
      ? {
          additionalFolders: [...new Set(input.additionalFolders)].filter(
            (folder) => folder !== cwd,
          ),
          ...(input.codeSessionFolderGrants?.length ? {
            codeSessionFolderGrants: input.codeSessionFolderGrants.filter(folder => folder !== cwd),
          } : {}),
        }
      : {}),
    pinned: false,
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turns: [],
    // Only Chat offers incognito (R-0001).
    ...(input.incognito && input.mode === "chat" ? { incognito: true } : {}),
    ...(input.memoryDisabled && (input.mode === "chat" || input.mode === "cowork")
      ? { memoryDisabled: true }
      : {}),
    ...(input.scheduledRun
      ? {
          scheduledRun: true,
          ...(input.scheduledTaskId
            ? { scheduledTaskId: input.scheduledTaskId }
            : {}),
          ...(input.scheduledPermission
            ? { scheduledPermission: input.scheduledPermission }
            : {}),
        }
      : {}),
    ...(input.asksFirst && input.mode === "cowork" ? { asksFirst: true } : {}),
    ...(input.handedOffFrom ? { handedOffFrom: input.handedOffFrom } : {}),
  };
}

