import type http from "node:http";
import {
  randomUUID,
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  fromBinary,
  fromJson,
  toBinary,
  toJson,
  type FileRegistry,
  type DescMessage,
  type JsonObject,
  type JsonValue,
} from "@bufbuild/protobuf";
import { isDeviceExecutionCopy } from "../../../shared/chat-devices-api";
import {
  historySearchResult,
  type HistorySearchOptions,
} from "../../../shared/history-search";
import { codeTurnStoppedByUser } from "../../../shared/official-code-followup";
import type { Approval, Conversation, Mode } from "../../../shared/types";
import {
  cloudCodeSessionKey,
  isOwnedCloudCoworkSession,
} from "./cloud-code-history";
import {
  isLocalCodeSession,
  isOwnedCloudCodeSession,
  isWslCodeSession,
} from "./code-session-ownership";
import { conversationRow, conversationTimes } from "./conversations";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedBytes, RequestBodyError } from "./request-body";
const packageName = "anthropic.claudeai_chats.api.v1alpha";
export const LIST_RECENTS_PATH = `/claudeai-rpc/${packageName}.RecentsService/ListRecents`;
class RecentsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new RecentsError(status, code, message);
};
/** Recovered descriptors omit json_name; accept exact standard camel/snake names without mutating the registry. */
export function recentsJson(schema: DescMessage, value: JsonValue): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const answer: JsonObject = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    const field = schema.fields.find(
      (f) => f.name === key || f.localName === key,
    );
    if (!field || field.name in answer)
      throw Error("Unknown or duplicate field");
    const descriptor =
      field.fieldKind === "message" ||
      (field.fieldKind === "list" && field.listKind === "message")
        ? field.message
        : undefined;
    answer[field.name] = descriptor
      ? Array.isArray(raw)
        ? raw.map((x) => recentsJson(descriptor, x))
        : recentsJson(descriptor, raw)
      : raw;
  }
  return answer;
}
/** Official TextRange indices are Unicode code points, not UTF-16 offsets. */
export function recentsMatches(text: string, query: string) {
  if (!query) return [];
  const chars = Array.from(text),
    offsets: number[] = [];
  let folded = "";
  chars.forEach((char, index) => {
    const lower = char.toLocaleLowerCase();
    folded += lower;
    for (let i = 0; i < lower.length; i++) offsets.push(index);
  });
  const needle = query.toLocaleLowerCase(),
    result: { start: number; end: number }[] = [];
  for (
    let at = folded.indexOf(needle);
    at >= 0 && result.length < 20;
    at = folded.indexOf(needle, at + needle.length)
  )
    result.push({
      start: offsets[at],
      end: offsets[at + needle.length - 1] + 1,
    });
  return result;
}

// RecentSurface and SurfaceState from the pinned Recents descriptor.
const modeSurface = { chat: 1, cowork: 2, code: 3 } as const;
const surfaceOk = 1;
const surfaceIncomplete = 3;
const defaultSurfaces = Object.values(modeSurface);
const sourcePageSize = 50;
const maxSourceHits = 5000;
const maxSearchBytes = 4 * 1024 * 1024;

interface RecentRow {
  id: string;
  mode: Mode;
  title: string;
  updatedAt: number;
  projectId?: string;
  archived: boolean;
  pinned: boolean;
  item: JsonObject;
}

function ownedHistory(c: Conversation, owner: string) {
  return (
    !c.incognito &&
    !isDeviceExecutionCopy(c) &&
    (!c.sessionAuthors ||
      (c.sessionAuthors.ownerAccountUuid === owner &&
        c.sessionAuthors.viewerAccountUuid === owner))
  );
}

function nativeSessionId(c: Conversation, ctx: AdapterContext) {
  if (
    ctx.readOnly ||
    !ctx.localListConversations ||
    !ctx.localLoadConversation ||
    c.cloudHosted ||
    ctx.isCloudConversation?.(c.id) ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(c.id)
  )
    return;
  const localCowork =
    c.mode === "cowork" && (!c.environment || c.environment.kind === "local");
  const sshCode =
    c.mode === "code" &&
    !c.cloudEnvironmentId &&
    c.environment?.kind === "ssh" &&
    !!ctx.sshCodeEnvironment?.(c);
  if (
    (localCowork && !c.linkedToComputer && !c.chatDeviceBinding) ||
    isLocalCodeSession(c) ||
    isWslCodeSession(c) ||
    sshCode
  )
    return "local_" + c.id;
}

function sessionWorker(
  c: Conversation,
  approval: Approval | undefined,
  savingStop: boolean,
): JsonObject {
  if (c.archived) return { idle: {} };
  if (approval)
    return {
      needsInput: {
        kind: approval.method === "item/tool/requestUserInput" ? 2 : 1,
      },
    };
  if (savingStop || c.turns?.some((turn) => turn.status === "inProgress"))
    return { running: {} };
  if (c.turns?.at(-1)?.status === "failed") return { failed: {} };
  return { idle: {} };
}

function recentRow(
  c: Conversation,
  id: string,
  projectName: string,
  approval: Approval | undefined,
  savingStop: boolean,
): RecentRow {
  const { created, updated } = conversationTimes(c);
  const title = c.title ?? "";
  const project = c.projectId
    ? { uuid: c.projectId, name: projectName }
    : undefined;
  const item: JsonObject = {};
  if (c.mode === "chat") {
    const row = conversationRow(c);
    item.chat = {
      uuid: row.uuid,
      name: row.name,
      ...(row.model === undefined ? {} : { model: row.model }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isStarred: row.is_starred,
      isTemporary: false,
      platform: 1,
      currentLeafMessageUuid: row.current_leaf_message_uuid,
      unread: c.unread === true,
      ...(c.readStateRevision && { revision: new Date(c.readStateRevision).toISOString() }),
      ...(project && { project }),
    };
  } else {
    item[c.mode === "code" ? "codeSession" : "coworkSession"] = {
      id,
      title,
      createdAt: new Date(created).toISOString(),
      updatedAt: new Date(updated).toISOString(),
      isStarred: !!c.pinned,
      unread: c.unread === true,
      status: c.archived ? 2 : 1,
      ...sessionWorker(c, approval, savingStop),
      ...(project && { project }),
    };
  }
  return {
    id: c.id,
    mode: c.mode,
    title,
    updatedAt: updated,
    projectId: c.projectId,
    archived: !!c.archived,
    pinned: !!c.pinned,
    item,
  };
}

async function readInventory(
  ctx: AdapterContext,
  owner: string,
  current: () => void,
) {
  const snapshot = await ctx.snapshot?.();
  const list = snapshot?.conversations ?? (await ctx.listConversations());
  current();
  if (!Array.isArray(list) || list.length > 100000)
    fail(413, "resource_exhausted", "History inventory is too large.");
  const conversations = new Map<string, Conversation>();
  const approvals = new Map<string, Approval[]>();
  for (const approval of snapshot?.approvals ?? []) {
    const pending = approvals.get(approval.conversationId) ?? [];
    pending.push(approval);
    approvals.set(approval.conversationId, pending);
  }
  const projects = new Map(
    (snapshot?.projects ?? []).map((project) => [project.id, project.name]),
  );
  const available = new Set<Mode>(["chat"]);
  const native =
    !ctx.readOnly && ctx.localListConversations && ctx.localLoadConversation;
  if (native || ctx.officialCodeHistory) available.add("code");
  if (native || ctx.officialCoworkHistory) available.add("cowork");
  const incomplete = new Set<Mode>();
  const rows: RecentRow[] = [];
  for (const c of list) {
    if (!c || typeof c.id !== "string" || !c.id || conversations.has(c.id))
      fail(503, "unavailable", "Invalid history inventory.");
    conversations.set(c.id, c);
    if (!ownedHistory(c, owner) || !available.has(c.mode)) continue;
    let id = c.id;
    if (c.mode !== "chat") {
      const cloud =
        c.mode === "code"
          ? ctx.officialCodeHistory && isOwnedCloudCodeSession(c, owner)
          : ctx.officialCoworkHistory && isOwnedCloudCoworkSession(c, owner);
      const publicId = cloud
        ? "session_" + cloudCodeSessionKey(c, owner)
        : nativeSessionId(c, ctx);
      if (!publicId) {
        incomplete.add(c.mode);
        continue;
      }
      id = publicId;
    }
    const running = c.turns?.at(-1);
    const approval =
      running?.status === "inProgress"
        ? approvals
            .get(c.id)
            ?.find(
              ({ params }) =>
                params?.turnId === running.id &&
                (!params.threadId || params.threadId === c.threadId),
            )
        : undefined;
    const savingStop =
      c.mode === "code" &&
      !!ctx.officialCodeStopPersistence &&
      !!c.turns?.some(codeTurnStoppedByUser) &&
      !ctx.officialCodeStopPersistence.confirmed(c);
    rows.push(
      recentRow(
        c,
        id,
        projects.get(c.projectId ?? "") ?? "",
        approval,
        savingStop,
      ),
    );
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  return {
    rows,
    conversations,
    available,
    incomplete,
    sourceFailed: snapshot?.projectCatalog?.status === "failed",
  };
}

interface SearchScope {
  archivedOnly: boolean;
  starredOnly: boolean;
  projectId?: string;
}

async function searchMode(
  ctx: AdapterContext,
  current: () => void,
  mode: Mode,
  query: string,
  scope: SearchScope,
  conversations: ReadonlyMap<string, Conversation>,
  snippets: Map<string, string>,
) {
  const seen = new Set<string>();
  let newestAllowed = Infinity;
  for (
    let offset = 0;
    offset <= Math.min(conversations.size, maxSourceHits);
    offset += sourcePageSize
  ) {
    const options: HistorySearchOptions = {
      mode,
      projectId: scope.projectId,
      limit: sourcePageSize,
      page: {
        offset,
        archive: scope.archivedOnly ? "archived" : "active",
        starredOnly: scope.starredOnly,
      },
    };
    const raw = await ctx.call("searchConversations", query, options);
    current();
    const parsed = historySearchResult.safeParse(raw);
    if (!parsed.success || parsed.data.results.length > sourcePageSize)
      return fail(503, "unavailable", "Invalid history search result.");
    if (offset + parsed.data.results.length > maxSourceHits)
      fail(
        413,
        "resource_exhausted",
        "Too many search hits. Refine the query.",
      );
    for (const hit of parsed.data.results) {
      const c = conversations.get(hit.conversationId);
      if (
        !c ||
        c.mode !== mode ||
        hit.mode !== mode ||
        seen.has(c.id) ||
        c.title !== hit.title ||
        c.updatedAt !== hit.updatedAt ||
        (hit.snippet !== undefined && hit.snippet.length > 100000) ||
        (!hit.snippet && !recentsMatches(c.title, query).length) ||
        hit.updatedAt > newestAllowed ||
        !!c.archived !== scope.archivedOnly ||
        hit.archived !== scope.archivedOnly ||
        (scope.starredOnly && !c.pinned) ||
        (scope.projectId !== undefined && c.projectId !== scope.projectId) ||
        (c.projectId || undefined) !== hit.projectId
      )
        return fail(
          503,
          "unavailable",
          "History changed or search results are invalid.",
        );
      seen.add(c.id);
      newestAllowed = hit.updatedAt;
      // Empty strings preserve title-only matches. Bound stored excerpts before snapshot assembly.
      snippets.set(c.id, hit.snippet?.slice(0, 1000) ?? "");
    }
    if (parsed.data.results.length < sourcePageSize) return;
  }
  fail(503, "unavailable", "History changed or search results are invalid.");
}

interface Page {
  owner: string;
  activation: unknown;
  expires: number;
  fingerprint: string;
  data: JsonObject[];
  surfaces: JsonObject[];
  searchId: string;
}
export function createRecentsRpc(ctx: AdapterContext, registry: FileRegistry) {
  const input = registry.getMessage(`${packageName}.ListRecentsRequest`),
    output = registry.getMessage(`${packageName}.ListRecentsResponse`);
  if (!input || !output) throw Error("Recents protocol is unavailable.");
  const snapshots = new Map<string, Page>();
  const cursorKey = randomBytes(32);
  const signature = (token: string) =>
    createHmac("sha256", cursorKey).update(token).digest();
  const cursorFor = (searchId: string, offset: number) => {
    const token = searchId + "." + offset;
    return token + "." + signature(token).toString("base64url");
  };
  const readCursor = (cursor: string) => {
    const match =
      /^([0-9a-f-]{36})\.([1-9][0-9]{0,5})\.([A-Za-z0-9_-]{43})$/.exec(cursor);
    if (!match) return;
    const [, searchId, rawOffset, mac] = match;
    if (
      !timingSafeEqual(
        Buffer.from(mac, "base64url"),
        signature(searchId + "." + rawOffset),
      )
    )
      return;
    return { page: snapshots.get(searchId), offset: Number(rawOffset) };
  };
  let activeOwner: string | undefined, activeIdentity: unknown;
  return async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    p: string,
  ): Promise<boolean> => {
    if (p !== LIST_RECENTS_PATH) return false;
    const owner = ctx.account()?.id,
      activation = ctx.sessionIdentity?.();
    const current = () => {
      if (
        ctx.isCurrent?.() === false ||
        ctx.account()?.id !== owner ||
        ctx.sessionIdentity?.() !== activation
      )
        fail(409, "failed_precondition", "The account changed. Search again.");
    };
    try {
      if (req.method !== "POST")
        fail(405, "unimplemented", "Use POST for Recents.");
      if (!owner) fail(401, "unauthenticated", "Sign in to search history.");
      if (activeOwner !== owner || activeIdentity !== activation) {
        snapshots.clear();
        activeOwner = owner;
        activeIdentity = activation;
      }
      const type = String(req.headers["content-type"] ?? "").split(";")[0];
      if (type !== "application/proto" && type !== "application/json")
        fail(415, "invalid_argument", "Unsupported Recents encoding.");
      const bytes = await readBoundedBytes(req, 64 * 1024);
      current();
      let request: any;
      try {
        request =
          type === "application/proto"
            ? fromBinary(input, bytes)
            : fromJson(
                input,
                recentsJson(input, JSON.parse(bytes.toString("utf8"))),
              );
      } catch {
        fail(400, "invalid_argument", "Invalid Recents request.");
      }
      if (request.organizationUuid !== organizationUuid(owner!))
        fail(404, "not_found", "Organization not found.");
      const orgHeader = req.headers["x-organization-uuid"];
      if (orgHeader !== undefined && orgHeader !== request.organizationUuid)
        fail(404, "not_found", "Organization not found.");
      const limit = request.limit ?? 30;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        fail(400, "invalid_argument", "Invalid page size.");
      if (
        request.targetSnippetSize !== undefined &&
        (!Number.isInteger(request.targetSnippetSize) ||
          request.targetSnippetSize < 1 ||
          request.targetSnippetSize > 500)
      )
        fail(400, "invalid_argument", "Invalid snippet size.");
      const { rows, conversations, available, incomplete, sourceFailed } =
        await readInventory(ctx, owner!, current);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([rows, [...available], [...incomplete]]))
        .digest("hex");
      for (const [id, snapshot] of snapshots)
        if (snapshot.expires <= Date.now()) snapshots.delete(id);
      let page: Page;
      let offset = 0;
      if (request.page.case === "cursor") {
        const continuation = readCursor(request.page.value);
        const found = continuation?.page;
        if (
          !found ||
          found.owner !== owner ||
          found.activation !== activation ||
          found.fingerprint !== fingerprint
        )
          return fail(
            400,
            "invalid_argument",
            "This search cursor expired or history changed. Search again.",
          );
        page = found;
        offset = continuation.offset;
      } else if (request.page.case === "first") {
        const q = request.page.value;
        if (
          q.intent !== 0 ||
          ![undefined, "organization", "projectUuid"].includes(q.scope.case)
        )
          fail(
            501,
            "unimplemented",
            "This Recents scope or intent is not mapped.",
          );
        const query = q.query.trim();
        if (Array.from(query).length > 200 || /[\u0000-\u001f]/.test(query))
          fail(400, "invalid_argument", "Search is limited to 200 characters.");
        if (
          q.scope.case === "projectUuid" &&
          (!q.scope.value ||
            q.scope.value.length > 100 ||
            /[\u0000-\u001f]/.test(q.scope.value))
        )
          fail(400, "invalid_argument", "Invalid project scope.");
        const surfaces: number[] = q.surfaces.length
          ? q.surfaces
          : defaultSurfaces;
        if (
          [...surfaces, ...q.include].some(
            (n) => !Number.isInteger(n) || n < 1 || n > 10,
          )
        )
          fail(400, "invalid_argument", "Invalid Recents surface.");
        const allSurfaces = new Set([...surfaces, ...q.include]);
        const scope: SearchScope = {
          archivedOnly: q.archivedOnly,
          starredOnly: q.starredOnly,
          projectId: q.scope.case === "projectUuid" ? q.scope.value : undefined,
        };
        const snippets = new Map<string, string>();
        if (query && !q.namesOnly) {
          const modes = [...available].filter((mode) =>
            allSurfaces.has(modeSurface[mode]),
          );
          if (sourceFailed && modes.length)
            fail(
              503,
              "unavailable",
              "History search is unavailable. Retry later.",
            );
          for (const mode of modes)
            await searchMode(
              ctx,
              current,
              mode,
              query,
              scope,
              conversations,
              snippets,
            );
        }
        const data: JsonObject[] = [];
        let bytes = 2;
        for (const row of rows) {
          if (
            !allSurfaces.has(modeSurface[row.mode]) ||
            row.archived !== scope.archivedOnly ||
            (scope.starredOnly && !row.pinned) ||
            (scope.projectId !== undefined && row.projectId !== scope.projectId)
          )
            continue;
          const titleMatches = recentsMatches(row.title, query);
          if (
            query &&
            (q.namesOnly ? !titleMatches.length : !snippets.has(row.id))
          )
            continue;
          const snippet = snippets.get(row.id);
          const text = snippet
            ? Array.from(snippet)
                .slice(0, request.targetSnippetSize ?? 500)
                .join("")
            : "";
          const item: JsonObject = {
            ...row.item,
            titleMatches,
            ...(text && {
              matchedSnippet: { text, matches: recentsMatches(text, query) },
            }),
          };
          bytes +=
            Buffer.byteLength(JSON.stringify(item)) + Number(data.length > 0);
          if (bytes > maxSearchBytes)
            fail(413, "resource_exhausted", "Search snapshot is too large.");
          data.push(item);
        }
        const complete = new Set<number>(
          [...available]
            .filter((mode) => !incomplete.has(mode))
            .map((mode) => modeSurface[mode]),
        );
        page = {
          owner: owner!,
          activation,
          expires: Date.now() + 5 * 60 * 1000,
          fingerprint,
          data,
          surfaces: [...allSurfaces].map((surface) => ({
            surface,
            state: complete.has(surface) ? surfaceOk : surfaceIncomplete,
          })),
          searchId: randomUUID(),
        };
      } else
        fail(400, "invalid_argument", "Choose the first page or a cursor.");
      current();
      const data = page!.data.slice(offset, offset + limit);
      let cursor: string | undefined;
      if (offset + limit < page!.data.length) {
        if (!snapshots.has(page!.searchId)) {
          if (snapshots.size >= 32)
            fail(
              429,
              "resource_exhausted",
              "Too many active searches. Start again later.",
            );
          snapshots.set(page!.searchId, page!);
        }
        cursor = cursorFor(page!.searchId, offset + limit);
      }
      const value = fromJson(
        output,
        recentsJson(output, {
          data,
          surfaces: page!.surfaces,
          searchId: page!.searchId,
          pageOffset: offset,
          ...(cursor ? { cursor } : {}),
        }),
      );
      current();
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(
        type === "application/proto"
          ? Buffer.from(toBinary(output, value))
          : JSON.stringify(toJson(output, value, { useProtoFieldName: true })),
      );
      return true;
    } catch (error) {
      return reply(
        res,
        {
          code: error instanceof RecentsError ? error.code : "unavailable",
          message:
            error instanceof RecentsError || error instanceof RequestBodyError
              ? error.message
              : "History search is unavailable. Retry later.",
        },
        error instanceof RecentsError || error instanceof RequestBodyError
          ? error.status
          : 503,
      );
    }
  };
}
