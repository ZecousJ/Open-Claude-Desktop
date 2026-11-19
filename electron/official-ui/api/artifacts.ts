/** Read-only Chat artifact versions and a fenced-code snippet catalog.
 * Wire: shared-0 qT8; shared-120 artifact_versions/result_state; c86d8805d snippet rows.
 */
import type http from "node:http";
import { createHash } from "node:crypto";
import type { ArtifactShareInput, Conversation, Turn } from "../../../shared/types";
import { versionKeyOf } from "../../artifacts/hosted-shares-support";
import { isDeviceExecutionCopy } from "../../../shared/chat-devices-api";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { artifactNoteKey } from "../../../shared/artifact-notes";
import { assistantMessageId, resolveConversationId } from "./conversations";
import { researchReportArtifactPrefix, researchReportArtifactRow, researchReportVersions } from "./research-report-artifact";

const maxSourceBytes = 16 * 1024 * 1024;
const maxContentBytes = 2 * 1024 * 1024;
const maxConversations = 200;
const maxSnippets = 1000;
const inlineArtifactTypes = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "application/vnd.ant.code",
  "image/svg+xml",
  "application/vnd.ant.mermaid",
  "application/vnd.ant.react",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class ArtifactReadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function stableId(parts: string[]) {
  const h = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function eligible(c: Conversation) {
  return (
    c.mode === "chat" &&
    !c.incognito &&
    !isDeviceExecutionCopy(c) &&
    (!c.sessionAuthors ||
      c.sessionAuthors.ownerAccountUuid === c.sessionAuthors.viewerAccountUuid)
  );
}
export interface ConversationSnippet {
  uuid: string;
  artifact_uuid: string;
  title: string;
  code_language: string;
  artifact_type: string;
  result_state: string;
  message_uuid: string;
  created_at: string;
  source: "w";
  conversation_uuid: string;
  project_uuid?: string;
  artifact_identifier?: string;
  version_number?: number;
  claudex_can_publish?: true;
  claudex_previously_unpublished?: true;
}
export const chatPublicationPrefix = "official-chat-artifact";
const publicationLanguages: Record<string, string> = {
  "text/plain": "text",
  "text/markdown": "markdown",
  "text/html": "html",
  "image/svg+xml": "svg",
  "application/vnd.ant.mermaid": "mermaid",
  "application/vnd.ant.code": "code",
};
export function chatArtifactPublicationInput(row: ConversationSnippet): ArtifactShareInput | undefined {
  const language = publicationLanguages[row.artifact_type];
  if (!row.artifact_identifier || !language) return;
  return {
    identity: JSON.stringify([chatPublicationPrefix, row.conversation_uuid, row.artifact_uuid]),
    versionId: row.uuid,
    title: row.title,
    language: language === "code" ? row.code_language || language : language,
    content: row.result_state,
  };
}
/** Same fenced-code interpretation as the existing account artifact library. */
export function conversationSnippets(
  owner: string,
  c: Conversation,
  budget = { bytes: 0, items: 0 },
  includeInlineVersions = false,
): ConversationSnippet[] {
  if (!eligible(c)) return [];
  const rows: ConversationSnippet[] = [];
  const revisions = new Map<string, number>();
  const reportSourceItems = new Map<Turn, string>();
  if (c.turns.length > 10_000)
    throw new ArtifactReadError(413, "Artifact history limit exceeded.");
  if (!c.sessionAuthors || c.sessionAuthors.ownerAccountUuid === owner) {
    const branches = includeInlineVersions ? c.savedBranches ?? [] : [];
    if (branches.length > 199 || branches.reduce((count, branch) => count + branch.turns.length, c.turns.length) > 10_000)
      throw new ArtifactReadError(413, "Artifact history limit exceeded.");
    const seen = new Set<string>();
    for (const turns of [c.turns, ...branches.map(branch => branch.turns)]) {
      for (const report of researchReportVersions(organizationUuid(owner), c, turns)) {
        if (report.sourceItemId) reportSourceItems.set(report.turn, report.sourceItemId);
        if (!includeInlineVersions || seen.has(report.versionUuid)) continue;
        seen.add(report.versionUuid);
        budget.bytes += report.bytes;
        if (budget.bytes > maxSourceBytes)
          throw new ArtifactReadError(413, "Artifact source limit exceeded.");
        rows.push(researchReportArtifactRow(c, report, assistantMessageId(report.turn)));
        if (rows.length > maxSnippets)
          throw new ArtifactReadError(413, "Artifact count limit exceeded.");
      }
    }
  }
  for (const turn of c.turns) {
    const readInlineVersions =
      includeInlineVersions && turn.status !== "inProgress";
    let assistantText = "";
    for (const item of turn.items) {
      if (++budget.items > 10_000)
        throw new ArtifactReadError(413, "Artifact history limit exceeded.");
      if (item.type !== "agentMessage" || item.id === reportSourceItems.get(turn)) continue;
      const text = item.text ?? "";
      budget.bytes += Buffer.byteLength(text);
      if (budget.bytes > maxSourceBytes)
        throw new ArtifactReadError(413, "Artifact source limit exceeded.");
      if (readInlineVersions) assistantText += text;
      let index = 0;
      for (const match of text.matchAll(
        /```([\w+.-]*)[^\n]*\n([\s\S]*?)```/g,
      )) {
        const language = match[1] || "text",
          content = match[2];
        if (Buffer.byteLength(content) > maxContentBytes)
          throw new ArtifactReadError(413, "Artifact content limit exceeded.");
        const id = stableId([
          "snippet",
          owner,
          c.id,
          turn.id,
          item.id,
          String(index++),
        ]);
        // A changed content snapshot gets a different version; old content is never invented.
        const version = stableId(["snippet-version", id, language, content]);
        const mime: Record<string, string> = {
          html: "text/html",
          svg: "image/svg+xml",
          markdown: "text/markdown",
          md: "text/markdown",
          text: "text/plain",
          mermaid: "application/vnd.ant.mermaid",
          jsx: "application/vnd.ant.react",
          tsx: "application/vnd.ant.react",
          react: "application/vnd.ant.react",
        };
        rows.push({
          uuid: version,
          artifact_uuid: id,
          title: `${c.title} · ${language}`,
          code_language: language,
          artifact_type: mime[language] ?? "application/vnd.ant.code",
          result_state: content,
          message_uuid: assistantMessageId(turn),
          created_at: new Date(
            turn.createdAt ?? c.updatedAt ?? 0,
          ).toISOString(),
          source: "w",
          conversation_uuid: c.id,
          ...(c.projectId ? { project_uuid: c.projectId } : {}),
        });
        if (rows.length > maxSnippets)
          throw new ArtifactReadError(413, "Artifact count limit exceeded.");
      }
    }
    let artifactIndex = 0;
    for (const [, attributes, content] of assistantText.matchAll(
      /```[^\n]*\n[\s\S]*?```|<antArtifact\s+([^>]*)>([\s\S]*?)<\/antArtifact>/g,
    )) {
      if (!attributes || !content) continue;
      const identifier = /\bidentifier="([^"]+)"/.exec(attributes)?.[1];
      if (!identifier || identifier.startsWith(researchReportArtifactPrefix)) continue;
      if (Buffer.byteLength(content) > maxContentBytes)
        throw new ArtifactReadError(413, "Artifact content limit exceeded.");
      const id = stableId(["chat-artifact", owner, c.id, identifier]);
      const version = (revisions.get(identifier) ?? 0) + 1;
      revisions.set(identifier, version);
      const type = /\btype="([^"]*)"/.exec(attributes)?.[1] ?? "";
      const language = /\blanguage="([^"]*)"/.exec(attributes)?.[1] ?? "";
      const title =
        /\btitle="([^"]*)"/.exec(attributes)?.[1] ?? "Untitled artifact";
      rows.push({
        uuid: stableId([
          "chat-artifact-version",
          id,
          turn.id,
          String(artifactIndex++),
        ]),
        artifact_uuid: id,
        artifact_identifier: identifier,
        version_number: version,
        title,
        code_language: language,
        artifact_type: inlineArtifactTypes.has(type) ? type : "text/plain",
        result_state: content,
        message_uuid: assistantMessageId(turn),
        created_at: new Date(turn.createdAt ?? c.updatedAt ?? 0).toISOString(),
        source: "w",
        conversation_uuid: c.id,
        ...(c.projectId ? { project_uuid: c.projectId } : {}),
      });
      if (rows.length > maxSnippets)
        throw new ArtifactReadError(413, "Artifact count limit exceeded.");
    }
  }
  return rows;
}
function boundedReply(res: http.ServerResponse, value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024)
    throw new ArtifactReadError(413, "Artifact response limit exceeded.");
  return reply(res, value);
}
function fail(res: http.ServerResponse, status: number, message: string) {
  return reply(
    res,
    {
      error: {
        type: status === 404 ? "not_found_error" : "invalid_request_error",
        message,
      },
    },
    status,
  );
}
export async function artifactsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  ctx: AdapterContext,
): Promise<boolean> {
  const versions =
    /^\/api\/organizations\/([^/]+)\/artifacts\/([^/]+)\/versions$/.exec(p);
  const listing = p === "/api/frame/artifacts";
  if (!listing && !versions) return false;
  if (req.method !== "GET") return fail(res, 405, "Artifacts are read-only.");
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.();
  if (!owner) return fail(res, 401, "Sign in to continue.");
  const current = () => {
    if (
      ctx.isCurrent?.() === false ||
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== activation
    )
      throw new ArtifactReadError(
        409,
        "The account changed during this request.",
      );
  };
  try {
    const params = url.searchParams;
    const allowed = versions
      ? new Set(["latest_only"])
      : new Set([
          "org",
          "rel",
          "q",
          "limit",
          "page_token",
          "ids",
          "view",
          "empty",
          "kind",
          "type",
          "soft_deleted",
          "include_system",
          "with_last_viewed",
          "sort",
        ]);
    for (const key of params.keys())
      if (!allowed.has(key) || params.getAll(key).length !== 1)
        throw new ArtifactReadError(400, "Unsupported artifact query.");
    if ((versions?.[1] ?? params.get("org")) !== organizationUuid(owner))
      return fail(res, 404, "Artifacts not found.");
    if (
      versions &&
      params.has("latest_only") &&
      params.get("latest_only") !== "true"
    )
      throw new ArtifactReadError(400, "Unsupported artifact query.");
    const rel = params.get("rel") ?? "all";
    if (!versions && !["all", "mine", "favorited"].includes(rel))
      throw new ArtifactReadError(
        501,
        "This artifact relationship is not supported.",
      );
    for (const [key, value] of [
      ["view", "lean"],
      ["empty", "exclude"],
      ["soft_deleted", "include"],
      ["include_system", "true"],
      ["with_last_viewed", "true"],
    ])
      if (params.has(key) && params.get(key) !== value)
        throw new ArtifactReadError(400, "Unsupported artifact query.");
    if (params.get("type"))
      throw new ArtifactReadError(
        501,
        "Hosted artifact types are not supported.",
      );
    const sort = params.get("sort");
    if (sort !== null && sort !== "last_viewed")
      throw new ArtifactReadError(400, "Unsupported artifact sort.");
    const metadataRequested =
      !versions &&
      (sort === "last_viewed" ||
        rel === "favorited" ||
        params.get("with_last_viewed") === "true");
    const limitText = params.get("limit") ?? "48";
    if (
      !/^[1-9][0-9]{0,2}$/.test(limitText) ||
      Number(limitText) > (rel === "favorited" ? 500 : 100)
    )
      throw new ArtifactReadError(400, "Invalid artifact limit.");
    const q = params.get("q") ?? "";
    if (q.length > 200)
      throw new ArtifactReadError(400, "Artifact search is too long.");
    const ids = params.get("ids")?.split(",");
    if (ids && (ids.length > 48 || ids.some((id) => !uuid.test(id))))
      throw new ArtifactReadError(400, "Invalid artifact IDs.");
    const kind = params.get("kind");
    if (kind && kind !== "snippet")
      throw new ArtifactReadError(
        501,
        "Hosted artifact kinds are not supported.",
      );
    const conversationId = versions
      ? resolveConversationId(versions[2])
      : undefined;
    current();
    const listed = await ctx.listConversations();
    current();
    if (listed.length > 10_000)
      throw new ArtifactReadError(413, "Conversation catalog limit exceeded.");
    const candidates = listed
      .filter(eligible)
      .filter((c) => !versions || c.id === conversationId);
    if (versions && candidates.length !== 1)
      return fail(res, 404, "Conversation artifacts not found.");
    if (candidates.length > maxConversations)
      throw new ArtifactReadError(413, "Artifact catalog scan limit exceeded.");
    const budget = { bytes: 0, items: 0 };
    let rows: ConversationSnippet[] = [];
    const batchSize = 8;
    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      current();
      const batch = candidates.slice(offset, offset + batchSize);
      const sources = await Promise.all(batch.map(({ id }) => ctx.loadConversation(id)));
      current();
      for (const [index, full] of sources.entries()) {
        if (!full || full.id !== batch[index].id)
          throw new ArtifactReadError(404, "Artifact source is unavailable.");
        rows.push(...conversationSnippets(owner, full, budget, !!versions));
        if (rows.length > maxSnippets)
          throw new ArtifactReadError(413, "Artifact count limit exceeded.");
      }
    }
    rows.sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) ||
        a.artifact_uuid.localeCompare(b.artifact_uuid) ||
        (b.version_number ?? 0) - (a.version_number ?? 0),
    );
    if (versions) {
      const publishing = (!ctx.readOnly || ctx.allowArtifactPublishing) && ctx.artifactPublishing?.();
      if (publishing) for (const row of rows) {
        const input = chatArtifactPublicationInput(row);
        if (!input) continue;
        row.claudex_can_publish = true;
        if (publishing.unpublished.size && publishing.unpublished.has(versionKeyOf(input)))
          row.claudex_previously_unpublished = true;
      }
      if (params.get("latest_only") === "true") {
        const latest = new Map<string, ConversationSnippet>();
        for (const row of rows)
          if (
            (row.version_number ?? 1) >
            (latest.get(row.artifact_uuid)?.version_number ?? 0)
          )
            latest.set(row.artifact_uuid, row);
        rows = rows.filter((row) => latest.get(row.artifact_uuid) === row);
      }
      return boundedReply(res, { artifact_versions: rows });
    }
    const metadata = new Map<
      string,
      { viewedAt: number | null; starred: boolean }
    >();
    if (metadataRequested) {
      current();
      const snapshot = await ctx.snapshot();
      current();
      const pins = snapshot?.artifactLibrary?.pinned;
      if (
        !Array.isArray(pins) ||
        pins.length > 1000 ||
        pins.some(
          (p) => typeof p !== "string" || Buffer.byteLength(p) > 2_000_200,
        )
      )
        throw new ArtifactReadError(
          503,
          "Artifact favorites could not be read.",
        );
      if (
        pins.reduce((total, p) => total + Buffer.byteLength(p), 0) >
        maxSourceBytes
      )
        throw new ArtifactReadError(
          413,
          "Artifact favorites metadata is too large.",
        );
      const notes = await ctx.call("artifactNotes");
      current();
      if (
        !notes ||
        typeof notes !== "object" ||
        Array.isArray(notes) ||
        Object.keys(notes).length > 5000
      )
        throw new ArtifactReadError(
          503,
          "Artifact viewing history could not be read.",
        );
      for (const [key, note] of Object.entries(notes)) {
        if (
          !/^[0-9a-f]{32}$/.test(key) ||
          !note ||
          typeof note !== "object" ||
          Array.isArray(note)
        )
          throw new ArtifactReadError(
            503,
            "Artifact viewing history could not be read.",
          );
        const viewed = (note as { viewedAt?: unknown }).viewedAt;
        if (
          viewed !== undefined &&
          (typeof viewed !== "number" ||
            !Number.isFinite(viewed) ||
            viewed < 0 ||
            !Number.isFinite(new Date(viewed).getTime()))
        )
          throw new ArtifactReadError(
            503,
            "Artifact viewing history could not be read.",
          );
      }
      const pinned = new Set(pins);
      for (const row of rows) {
        // Exact native snippet identity (artifact-metadata.tsx), not the new
        // official UUID: existing account history and favorites remain usable.
        const identity = JSON.stringify([
          row.conversation_uuid,
          row.result_state,
        ]);
        const note = (notes as Record<string, { viewedAt?: number }>)[
          artifactNoteKey(identity)
        ];
        metadata.set(row.artifact_uuid, {
          viewedAt: note?.viewedAt ?? null,
          starred: pinned.has(identity),
        });
      }
      if (sort === "last_viewed")
        rows.sort((a, b) => {
          const left = metadata.get(a.artifact_uuid)!.viewedAt,
            right = metadata.get(b.artifact_uuid)!.viewedAt;
          return left === null
            ? right === null
              ? a.artifact_uuid.localeCompare(b.artifact_uuid)
              : 1
            : right === null
              ? -1
              : right - left || a.artifact_uuid.localeCompare(b.artifact_uuid);
        });
    }
    rows = rows.filter(
      (r) =>
        (rel !== "favorited" ||
          metadata.get(r.artifact_uuid)?.starred === true) &&
        (!kind || kind.split(",").includes("snippet")) &&
        (!ids || ids.includes(r.artifact_uuid)) &&
        r.title.toLowerCase().includes(q.toLowerCase()) &&
        (params.get("empty") !== "exclude" || r.result_state.trim() !== ""),
    );
    // Cursor bound to the exact filtered snapshot: never silently skip on concurrent edits.
    const revision = createHash("sha256")
      .update(
        JSON.stringify([
          owner,
          q,
          ids,
          kind,
          rel,
          sort,
          metadataRequested,
          rows.map((r) => [r.uuid, metadata.get(r.artifact_uuid)]),
        ]),
      )
      .digest("hex")
      .slice(0, 20);
    const cursor = params.get("page_token");
    let offset = 0;
    if (cursor) {
      const match = /^([0-9a-f]{20}):([0-9]{1,4})$/.exec(cursor);
      if (!match || match[1] !== revision || Number(match[2]) > rows.length)
        throw new ArtifactReadError(
          409,
          "Artifact catalog changed or cursor is invalid.",
        );
      offset = Number(match[2]);
    }
    const limit = Number(limitText);
    const artifacts = rows.slice(offset, offset + limit).map((r) => ({
      id: r.artifact_uuid,
      kind: "snippet",
      rel: "mine",
      title: r.title,
      conversation_uuid: r.conversation_uuid,
      artifact_identifier: r.artifact_uuid,
      latest_artifact_version_uuid: r.uuid,
      artifact_type: r.artifact_type,
      preview: r.result_state.slice(0, 500),
      audience: "owner",
      created_at: r.created_at,
      updated_at: r.created_at,
      ...(metadataRequested
        ? {
            last_viewed_at:
              metadata.get(r.artifact_uuid)!.viewedAt === null
                ? null
                : new Date(
                    metadata.get(r.artifact_uuid)!.viewedAt!,
                  ).toISOString(),
            starred: metadata.get(r.artifact_uuid)!.starred,
            ...(sort === "last_viewed"
              ? {
                  sort_time:
                    metadata.get(r.artifact_uuid)!.viewedAt === null
                      ? null
                      : new Date(
                          metadata.get(r.artifact_uuid)!.viewedAt!,
                        ).toISOString(),
                }
              : {}),
          }
        : {}),
      ...(r.project_uuid ? { project_uuid: r.project_uuid } : {}),
    }));
    current();
    return boundedReply(res, {
      artifacts,
      ...(metadataRequested ? { last_viewed_filled: true } : {}),
      ...(sort ? { sort } : {}),
      next_page_token:
        offset + limit < rows.length ? `${revision}:${offset + limit}` : null,
    });
  } catch (error) {
    if (
      ctx.isCurrent?.() === false ||
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== activation
    )
      return fail(res, 409, "The account changed during this request.");
    if (error instanceof ArtifactReadError)
      return fail(res, error.status, error.message);
    return fail(res, 503, "Artifact sources could not be read.");
  }
}
