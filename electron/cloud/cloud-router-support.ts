import type { Snapshot } from "../../shared/types";
import type { Approval } from "../../shared/types";

/** The value of the service's `{code, data}` answer. */
export const serviceData = (body: unknown): unknown =>
  body && typeof body === "object" && "data" in body
    ? (body as { data: unknown }).data
    : body;

/**
 * The GitHub connection the cloud environment's repository picker uses
 * (shared/github-api.ts). The service holds it, so on the desktop these go
 * to the service as a web page's do (shared/web-client/github.ts); without the
 * cloud the local handlers refuse them.
 */
export const githubConnectionCalls = new Set([
  "githubStatus",
  "githubConnect",
  "githubDisconnect",
  "githubRepositories",
  "githubBranches",
]);

/** Calls whose first argument is a conversation id. */
export const conversationCalls = new Set([
  "resolveCodeNewTask",
  "turnAttachment",
  "conversationTurns",
  "interrupt",
  "releaseRunner",
  "retryResponse",
  "editPrompt",
  "selectPromptVersion",
  "selectReplyVersion",
  "updateConversation",
  "setConversationWebSearch",
  "setConversationResearch",
  "deleteConversation",
  "discardIncognito",
  "compactConversation",
  "forkConversation",
  "handOffConversation",
  "askSideChat",
  "interruptSideChat",
  "endSideChat",
  "startReview",
  "codeGitStatus",
  "runShellCommand",
  "rewindConversation",
  "swapRewind",
  "setReplyFeedback",
  "shareConversation",
  "unshareConversation",
  "conversationShare",
  "inviteToShare",
  "removeShareInvite",
  "setShareAccess",
  "workingTreeChanges",
  "gitBranches",
  "listProjectFolder",
  "readProjectFile",
  "searchProjectFiles",
  "viewedImageSnapshot",
  "readWorkflowAgent",
  "refreshWorkflowAgents",
  "stopWorkflowAgent",
  "stopWorkflowRun",
  "readResearchReport",
  // A cloud conversation's folders, files and terminals are the runner's
  // (owner, 2026-10-20: on the desktop every Chat's folder read failed with
  // "Task conversation not found" and its terminals were asked of the
  // local store every 5 s).
  "coworkFolders",
  "listTaskFolderDirectory",
  "listCoworkFolder",
  "readCoworkFile",
  "readCoworkInstructions",
  "writeCoworkInstructions",
  "readCoworkResource",
  "listBackgroundTerminals",
]);

/** Calls whose first argument is a `MentionScope` ({conversationId?}). */
export const scopeCalls = new Set([
  "mentionFiles",
  "listSlashCommands",
  "readBlankArtifact",
  "saveBlankArtifact",
]);

/** Calls whose first argument is a project id. */
export const projectCalls = new Set([
  "deleteProject",
  "listProjectKnowledge",
  "readProjectKnowledge",
  "listProjectKnowledgeRepositories",
  "listProjectKnowledgeRepositoryFiles",
  "addProjectKnowledgeRepositoryFiles",
  "syncProjectKnowledge",
  "listProjectKnowledgeMcpServers",
  "listProjectKnowledgeMcpResources",
  "resolveProjectKnowledgeMcpUrl",
  "addProjectKnowledgeMcpResource",
  "listProjectKnowledgeDriveConnectors",
  "searchProjectKnowledgeDrive",
  "addProjectKnowledgeDriveFiles",
  "addProjectKnowledgeFiles",
  "confirmProjectKnowledgeUpload",
  "addProjectKnowledgeText",
  "removeProjectKnowledge",
]);

/**
 * Reads of stored things named by a path, digest or id that either side may
 * hold: asked locally first, then in the cloud when the local side has none.
 */
export const eitherSideReads = new Set([
  "imageGenerationSnapshot",
  "readGeneratedFile",
  "attachmentPreview",
]);

/** The cloud's own id of a prefixed approval id; undefined for a local one. */
export function cloudSideApproval(id: unknown): string | number | undefined {
  if (typeof id !== "string" || !id.startsWith(cloudApprovalPrefix))
    return undefined;
  const raw = id.slice(cloudApprovalPrefix.length);
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

export const cloudApprovalId = (id: string | number) =>
  `${cloudApprovalPrefix}${id}`;

export function cloudApproval(approval: Approval): Approval {
  return { ...approval, id: cloudApprovalId(approval.id) };
}

/** Compose a caller's result without changing the router's routing/cache state. */
export function mergedSnapshot(
  local: Snapshot,
  cloud: Snapshot | undefined,
  failed: boolean,
  migrated?: ReadonlySet<string>,
): Snapshot {
  if (!cloud)
    return failed
      ? { ...local, projectCatalog: { status: "failed", cached: false } }
      : local;
  const localTasks = new Set(
    local.conversations.filter((c) => c.linkedToComputer).map((c) => c.id),
  );
  const cloudConversations = new Set(cloud.conversations.map((c) => c.id));
  const cloudProjects = new Set((cloud.projects ?? []).map((p) => p.id));
  const migratedProjects = new Set<string>();
  const localConversations = local.conversations.filter((row) => {
    if (localTasks.has(row.id)) return true;
    if (!migrated?.has(row.id)) return !cloudConversations.has(row.id);
    if (row.projectId) migratedProjects.add(row.projectId);
    return false;
  });
  const localProjects = new Set(localConversations.flatMap(row => row.projectId ? [row.projectId] : []));
  return {
    ...local,
    projectCatalog: { status: failed ? "failed" : "ready", cached: true },
    // A conversation moved to the cloud (P5) shows once, from the cloud.
    conversations: [
      ...localConversations,
      ...cloud.conversations
        .filter((c) => !localTasks.has(c.id))
        .map((c) => ({ ...c, cloudHosted: true })),
    ],
    projects: [
      ...local.projects.filter((p) =>
        !cloudProjects.has(p.id) && (!migratedProjects.has(p.id) || localProjects.has(p.id))),
      ...(cloud.projects ?? []),
    ],
    approvals: [
      ...local.approvals,
      ...(cloud.approvals ?? []).map(cloudApproval),
    ],
    // A cloud conversation's ratings are kept where it runs.
    replyFeedback: { ...(cloud.replyFeedback ?? {}), ...local.replyFeedback },
  };
}

/** How long the snapshot waits for the cloud before showing the local part. */
export const cloudSnapshotTimeoutMs = 8_000;

export const retryMinMs = 15_000;

export const retryMaxMs = 120_000;

export const cloudApprovalPrefix = "cloud:";
