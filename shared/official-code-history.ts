import { z } from "zod";
import type { CodePermissionMode } from "./code-session-permissions";
import { routineIdFromOfficialCodeTrigger } from "./official-code-triggers";

export const officialCodeStreamTool = z.object({
  id: z.string(),
  name: z.string(),
  inputJson: z.string(),
});
export type OfficialCodeStreamTool = z.infer<typeof officialCodeStreamTool>;
export const officialCodeStreamSuggestion = z.object({
  resultUuid: z.string().min(1),
  text: z.string().min(1),
});
export type OfficialCodeStreamSuggestion = z.infer<typeof officialCodeStreamSuggestion>;

const sessionsPath = "/v1/code/sessions";
const sessionPath =
  /^\/v1\/code\/sessions\/(?:session|cse)_([A-Za-z0-9_-]{1,500})(\/events)?$/;
const streamPath =
  /^\/v1\/code\/sessions\/(?:session|cse)_([a-f0-9]{32})\/events\/stream$/;
const queuePath =
  /^\/v1\/code\/sessions\/(?:session|cse)_([a-f0-9]{32})\/events\/queue\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const teleportPath = /^\/v1\/code\/sessions\/(?:session|cse)_([a-f0-9]{32})\/teleport-events$/;
export const isOfficialCodeTeleportPath = (pathname: string) => teleportPath.test(pathname);
export const officialCodeTaskId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const officialCodeCommand = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
});
export type OfficialCodeCommand = z.infer<typeof officialCodeCommand>;
export const officialCodeTaskUpdate = z.looseObject({
  type: z.literal("system"),
  uuid: z.string(),
  subtype: z.enum(["task_progress", "task_notification"]),
  task_id: officialCodeTaskId,
});
const connectorSelectionPath =
  /^\/v1\/code\/sessions\/(?:session|cse)_([a-f0-9]{32})\/mcp-servers$/;
const markReadPath =
  /^\/v1\/code\/sessions\/(?:session|cse)_([a-f0-9]{32})\/mark_read$/;
const mutationPath =
  /^\/v1\/code\/sessions\/(?:session|cse)_([a-f0-9]{32})(?:\/(archive|unarchive))?$/;
const cursorPattern =
  /^(?:(?:session|cse)_[A-Za-z0-9_-]{1,500}|evt_[a-f0-9]{64})$/;
const sequencePattern = /^(?:0|[1-9][0-9]{0,15})$/;

export function officialCodeSessionCreation(method: string, path: string) {
  return method === "POST" && path === sessionsPath;
}

export const officialCodePermission = z.enum(["default", "acceptEdits", "plan", "auto", "bypassPermissions"])
  .transform((mode): CodePermissionMode => mode === "default" ? "manual" : mode === "bypassPermissions" ? "bypass" : mode);

export function officialCodePermissionName(mode: CodePermissionMode | undefined) {
  return mode === "manual" ? "default" : mode === "bypass" ? "bypassPermissions" : mode;
}

export function officialCodeConnectorSelection(method: string, path: string) {
  return method === "PUT" ? connectorSelectionPath.exec(path)?.[1] : undefined;
}

export function officialCodeMarkRead(method: string, path: string) {
  return method === "POST" ? markReadPath.exec(path)?.[1] : undefined;
}

export type OfficialCodeMutation = {
  key: string;
  kind: "metadata" | "archive" | "unarchive" | "delete";
};

export const officialCodeMutationMaxBytes = 4096;
export const officialCodeSessionTitle = z.string().trim().min(1).max(200);

export function officialCodeMutation(method: string, path: string): OfficialCodeMutation | undefined {
  const match = mutationPath.exec(path);
  if (!match) return;
  const [, key, suffix] = match;
  if (suffix === "archive" || suffix === "unarchive")
    return method === "POST" ? { key, kind: suffix } : undefined;
  if (method === "PUT") return { key, kind: "metadata" };
  if (method === "DELETE") return { key, kind: "delete" };
}

export const officialCodeReadBody = z.object({
  event_id: z.string().max(500).optional(),
}).strict();

export function officialCodeSequence(value: string) {
  const parsed = Number(value);
  return sequencePattern.test(value) && Number.isSafeInteger(parsed)
    ? parsed
    : undefined;
}

const statuses = ["active", "paused", "archived", "failed"] as const;
type Status = (typeof statuses)[number];
type TriggerSessions = { kind: "any" } | { kind: "scheduled" } | { kind: "trigger"; id: string };

export type OfficialCodeHistoryRequest =
  | {
      kind: "list";
      limit: number;
      cursor: string | null;
      statuses: Status[];
      tags: string[];
      includePinnedBeyondPage: boolean;
      triggerSessions: TriggerSessions;
    }
  | { kind: "session"; key: string }
  | { kind: "queue"; key: string; uuid: string }
  | { kind: "teleport"; key: string; agentId: string; limit: number; cursor: string | null }
  | OfficialCodeStreamRequest
  | {
      kind: "events";
      key: string;
      limit: number;
      cursor: string | null;
      descending: boolean;
      excludeTypes: string[];
    };

export interface OfficialCodeStreamRequest {
  kind: "stream";
  key: string;
  from: number;
  afterEventId?: string;
}

export function officialCodeStreamRequest(
  method: string,
  pathname: string,
  search: string,
): OfficialCodeStreamRequest | undefined {
  const match = method === "GET" && streamPath.exec(pathname);
  if (!match || search.length > 160) return undefined;
  const params = new URLSearchParams(search);
  for (const key of params.keys()) {
    if (key !== "from_sequence_num" && key !== "after_event_id")
      return undefined;
    if (params.getAll(key).length !== 1) return undefined;
  }
  const sequence = params.get("from_sequence_num") ?? "0";
  const from = officialCodeSequence(sequence);
  const after = params.get("after_event_id");
  if (
    from === undefined ||
    (after !== null && (!from || !/^evt_[a-f0-9]{64}$/.test(after)))
  )
    return undefined;
  return {
    kind: "stream",
    key: match[1],
    from,
    ...(after ? { afterEventId: after } : {}),
  };
}

export function isOfficialCodeHistoryPath(pathname: string) {
  return (
    pathname === sessionsPath ||
    sessionPath.test(pathname) ||
    streamPath.test(pathname) ||
    queuePath.test(pathname) ||
    teleportPath.test(pathname)
  );
}

export function officialCodeHistoryRequest(
  method: string,
  pathname: string,
  search: string,
): OfficialCodeHistoryRequest | undefined {
  if (method !== "GET" || search.length > 1500) return undefined;
  if (streamPath.test(pathname))
    return officialCodeStreamRequest(method, pathname, search);
  const queued = queuePath.exec(pathname);
  if (queued) return search ? undefined : { kind: "queue", key: queued[1], uuid: queued[2] };
  const teleport = teleportPath.exec(pathname);
  if (teleport) {
    const query = new URLSearchParams(search);
    for (const name of query.keys())
      if (!["session_agent_id", "limit", "cursor"].includes(name) || query.getAll(name).length !== 1)
        return undefined;
    const agent = officialCodeTaskId.safeParse(query.get("session_agent_id"));
    const cursor = query.get("cursor");
    const rawLimit = query.get("limit") ?? "500";
    const limit = Number(rawLimit);
    if (!agent.success || !/^[1-9][0-9]{0,2}$/.test(rawLimit) || limit > 500 ||
        (cursor !== null && !/^evt_[a-f0-9]{64}$/.test(cursor))) return undefined;
    return { kind: "teleport", key: teleport[1], agentId: agent.data, cursor, limit };
  }
  const match = sessionPath.exec(pathname);
  if (pathname !== sessionsPath && !match) return undefined;
  if (match && !match[2])
    return search ? undefined : { kind: "session", key: match[1] };

  const query = new URLSearchParams(search);
  const list = !match;
  const repeated = list ? ["statuses", "tags"] : ["exclude_types"];
  const single = list
    ? ["limit", "cursor", "include_pinned_beyond_page", "trigger_id", "only_trigger_sessions", "exclude_tags"]
    : ["limit", "cursor", "sort_order"];
  for (const name of query.keys()) {
    if (!single.includes(name) && !repeated.includes(name)) return undefined;
    if (single.includes(name) && query.getAll(name).length !== 1)
      return undefined;
  }
  const rawLimit = query.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (rawLimit !== null && (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || limit > 500))
    return undefined;
  const cursor = query.get("cursor");
  if (
    cursor !== null &&
    !(!list && officialCodeSequence(cursor) !== undefined) &&
    (!cursorPattern.test(cursor) || list === cursor.startsWith("evt_"))
  )
    return undefined;
  if (list) {
    const selected = query.getAll("statuses") as Status[];
    const tags = query.getAll("tags");
    const pinned = query.get("include_pinned_beyond_page");
    const triggerId = query.get("trigger_id");
    const routineId = triggerId === null ? undefined : routineIdFromOfficialCodeTrigger(triggerId);
    const onlyTriggerSessions = query.get("only_trigger_sessions");
    const excludeTags = query.get("exclude_tags");
    if (
      selected.length > statuses.length ||
      selected.some((value) => !statuses.includes(value)) ||
      tags.length > 10 ||
      tags.some((tag) => !/^[A-Za-z0-9:_-]{1,100}$/.test(tag)) ||
      (pinned !== null && pinned !== "true" && pinned !== "false") ||
      (triggerId !== null && routineId === undefined) ||
      (onlyTriggerSessions !== null && onlyTriggerSessions !== "true") ||
      (excludeTags !== null && excludeTags !== "-")
    )
      return undefined;
    return {
      kind: "list",
      limit,
      cursor,
      statuses: selected,
      tags,
      includePinnedBeyondPage: pinned === "true",
      triggerSessions: routineId !== undefined ? { kind: "trigger", id: routineId }
        : onlyTriggerSessions === "true" ? { kind: "scheduled" } : { kind: "any" },
    };
  }

  const order = query.get("sort_order");
  const excludeTypes = query.getAll("exclude_types");
  if (
    (order !== null && order !== "asc" && order !== "desc") ||
    excludeTypes.length > 32 ||
    excludeTypes.some((value) => !/^[a-z][a-z_]{0,63}$/.test(value))
  )
    return undefined;
  return {
    kind: "events",
    key: match[1],
    limit,
    cursor,
    descending: order === "desc",
    excludeTypes,
  };
}
