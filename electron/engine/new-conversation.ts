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

export interface SendInput {
  scheduledTaskSetup?: import("../../shared/scheduled-task-setup").ScheduledTaskSetupIntent;
  blankArtifactRevision?: import("../../shared/blank-artifacts").BlankArtifactRevision;
  artifactOutputKind?: ArtifactOutputKind;
  codePermissionMode?: CodePermissionMode;
  /** A computer's Chat permission mode, sent with a prompt for the cloud. */
  taskPermission?: "default" | "auto" | "bypass";
  parentSessionId?: string;
  notificationTrigger?: Turn["notificationTrigger"];
  notificationKey?: string;
  effort?: Settings["codeEffort"];
  thinkingSummariesWanted?: boolean;
  thinkingMode?: "standard" | "extended";
  cloudEnvironmentId?: string;
  conversationId?: string;
  text: string;
  mode: Mode;
  webSearch?: boolean;
  connectorOverrides?: Record<string, boolean>;
  connectorToolOverrides?: import("../../shared/conversation-tools").ConversationToolOverrides;
  toolSearchMode?: import("../../shared/tool-search-mode").ToolSearchMode;
  /** Start a new Chat in Research mode (R4); it brings web search with it. */
  research?: boolean;
  projectId?: string;
  cwd?: string;
  additionalFolders?: string[];
  attachments: Attachment[];
  providerId: string;
  model: string;
  incognito?: boolean;
  /** Where a new conversation runs (R9); missing means this computer. */
  environment?: EnvironmentRef;
  /**
   * Codex's clientUserMessageId for the turn: a message from the SSH
   * outbox sends its own id, which also names its waiting turn.
   */
  clientMessageId?: string;
  /** A new session that starts from another one's handoff note (handOffConversation). */
  handedOffFrom?: ConversationHandOffSource;
  /** A scheduled task's run (Conversation.scheduledRun). */
  scheduledRun?: boolean;
  /** The routine that started the run, and the permission mode it was saved with. */
  scheduledTaskId?: string;
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
  /** A cloud Code session's pull request after a push (Conversation.autoPullRequest). */
  autoPullRequest?: "ready" | "draft";
}

/** A new Chat asked to start in Research mode (never incognito). */
const startsInResearch = (input: SendInput) =>
  input.mode === "chat" && !input.incognito && Boolean(input.research);

export function newConversation(
  input: SendInput,
  provider: Provider,
  cwd: string,
  settings?: Settings,
): Conversation {
  const openingTitle = (
    input.text.trim() ||
    input.attachments[0]?.name ||
    "New chat"
  ).slice(0, 50);
  return {
    id: randomUUID(),
    // A handed-off session keeps the title of the one it continues; its
    // first message is the long handoff note.
    title: input.handedOffFrom?.title ?? openingTitle,
    mode: input.mode,
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
          classifySessionStates: preference(
            settings ?? {},
            "classifySessionStates",
          ),
          // Claudex Code → Connect new sessions to Remote Control.
          ...(settings && !preference(settings, "remoteControlNewSessions")
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
    providerId: provider.id,
    model: input.model,
    projectId: input.projectId,
    ...(input.parentSessionId
      ? { parentSessionId: input.parentSessionId }
      : {}),
    connectorOverrides: input.connectorOverrides,
    connectorToolOverrides: input.connectorToolOverrides,
    ...(input.toolSearchMode ? { toolSearchMode: input.toolSearchMode } : {}),
    cwd,
    ...(input.mode === "code" && input.additionalFolders?.length
      ? {
          additionalFolders: [...new Set(input.additionalFolders)].filter(
            (folder) => folder !== cwd,
          ),
        }
      : {}),
    pinned: false,
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turns: [],
    // Only Chat offers incognito.
    ...(input.incognito && input.mode === "chat" ? { incognito: true } : {}),
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
