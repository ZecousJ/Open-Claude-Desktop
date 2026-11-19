import { createHash } from "node:crypto";
import { isDeviceExecutionCopy } from "../../../shared/chat-devices-api";
import { maxResearchReportBytes } from "../../../shared/research";
import type { Conversation, Turn } from "../../../shared/types";
import { researchOpaqueId, researchTaskId } from "./research-projection";

const reportMime = "text/markdown";
export const researchReportArtifactPrefix = "compass_artifact_";

export interface ResearchReportArtifact {
  artifactIdentifier: string;
  artifactUuid: string;
  versionUuid: string;
  version: number;
  turn: Turn;
  title: string;
  markdown: string;
  bytes: number;
  sourceItemId?: string;
}

export function researchReportArtifactIdentifier(org: string, conversation: Conversation, originTurn: Turn) {
  const taskId = researchTaskId(org, conversation, originTurn);
  return taskId ? `${researchReportArtifactPrefix}${taskId}` : undefined;
}

function reportVersion(
  artifactIdentifier: string,
  turn: Turn,
  version: number,
  snapshot: { title: string; markdown?: string; bytes: number; sha256?: string },
  sourceItemId?: string,
): ResearchReportArtifact | undefined {
  const { title, markdown, bytes, sha256 } = snapshot;
  if (typeof title !== "string" || title.length > 800 || typeof markdown !== "string" ||
      !Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxResearchReportBytes * 2 ||
      markdown.length > bytes || Buffer.byteLength(markdown) !== bytes || markdown.includes("\0") ||
      typeof sha256 !== "string" || createHash("sha256").update(markdown).digest("hex") !== sha256) return;
  const artifactUuid = researchOpaqueId(["research-report-artifact-v1", artifactIdentifier]);
  const versionUuid = researchOpaqueId(["research-report-version-v1", artifactUuid, turn.id, turn.createdAt, version, title, sha256]);
  return { artifactIdentifier, artifactUuid, versionUuid, version, turn, title, markdown, bytes, sourceItemId };
}

/** Each branch starts at the saved report and carries only the revisions it contains. */
export function researchReportVersions(org: string, conversation: Conversation, turns = conversation.turns) {
  if (!org || conversation.mode !== "chat" || conversation.incognito || isDeviceExecutionCopy(conversation) || turns.length > 10_000) return [];
  const latest = new Map<string, ResearchReportArtifact>();
  const versions: ResearchReportArtifact[] = [];
  for (const turn of turns) {
    if (turn.status === "inProgress" || !turn.id || turn.id.startsWith("pending-") ||
        !Number.isSafeInteger(turn.createdAt) || turn.createdAt <= 0 || turn.createdAt > 8.64e15) continue;
    const original = turn.research?.state === "done" ? turn.research.report : undefined;
    const revision = turn.status === "completed" ? turn.researchReportRevision : undefined;
    const identifier = original ? researchReportArtifactIdentifier(org, conversation, turn) : revision?.artifactId;
    if (!identifier) continue;
    const previous = latest.get(identifier);
    const version = original && !previous ? reportVersion(identifier, turn, 1, original)
      : revision && previous && revision.version === previous.version + 1
        ? reportVersion(identifier, turn, revision.version, revision, revision.sourceItemId)
        : undefined;
    if (!version) continue;
    latest.set(identifier, version);
    versions.push(version);
  }
  return versions;
}

export function researchReportArtifactBlock(report: ResearchReportArtifact, displayGroupId: string) {
  return {
    id: `${report.versionUuid}:artifact`, displayGroupId, isComplete: true, state: 2,
    text: report.markdown,
    displayContent: { content: { case: "file", value: {
      fileId: report.artifactIdentifier, artifactVersionUuid: report.versionUuid,
      title: report.title, fileType: reportMime, versionNumber: report.version,
      command: report.version === 1 ? 1 : 2,
    } } },
  };
}

export function researchReportArtifactRow(conversation: Conversation, report: ResearchReportArtifact, messageUuid: string) {
  return {
    uuid: report.versionUuid, artifact_uuid: report.artifactUuid,
    artifact_identifier: report.artifactIdentifier, version_number: report.version,
    title: report.title, code_language: "markdown", artifact_type: reportMime,
    result_state: report.markdown, message_uuid: messageUuid,
    created_at: new Date(report.turn.createdAt).toISOString(), source: "w" as const,
    conversation_uuid: conversation.id,
    ...(conversation.projectId ? { project_uuid: conversation.projectId } : {}),
  };
}
