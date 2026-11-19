/** Maps original file IDs to the conversation's recorded output snapshots. */
import type http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GeneratedImage } from "../../../shared/artifacts-api";
import { officialUiTransferMaxBytes } from "../../../shared/official-ui-web";
import type {
  Conversation,
  GeneratedFile,
  Item,
  Turn,
} from "../../../shared/types";
import {
  GeneratedBlobs,
  maxBlobBytes as maxBytes,
} from "../../artifacts/generated-blobs";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { ScopedMap, scopedValue } from "./scope";
import { flushState, readState, writeState } from "./state";
import { attachmentResponseHeaders } from "./files";
import {
  isLocalCodeSession,
  isOwnedCloudCodeSession,
} from "./code-session-ownership";

const maxEntries = 2000;
const digestPattern = /^[a-f0-9]{64}$/;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const records = new ScopedMap<string, Binding>("generated-output-files");
const idsBySource = new ScopedMap<string, string>("generated-output-file-ids");
interface Binding {
  id: string;
  org: string;
  conversationId: string;
  turnId: string;
  itemId: string;
  sourceId: string;
  name: string;
  digest?: string;
  bytes?: number;
  blob: boolean;
  code?: {
    host: "desktop" | "runner";
    source:
      | { kind: "output" }
      | { kind: "image"; path: string; mime: GeneratedImage["mime"] };
  };
}
export interface CodeOutputAttachment {
  path: string;
  size: number;
  isImage: boolean;
  file_uuid?: string;
  unavailable?: true;
  unavailable_text?: string;
}
const mimeTypes: Record<string, string> = {
  txt: "text/plain",
  md: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};
const mediaType = (name: string) =>
  mimeTypes[name.split(".").at(-1)?.toLowerCase() ?? ""] ??
  "application/octet-stream";
// The original Chat consumer requires an absolute slash-separated session path.
const sessionPath = (filePath: string) =>
  /^[A-Za-z]:[\\/]/.test(filePath)
    ? "/" + filePath.replaceAll("\\", "/")
    : filePath;
function load() {
  const state = scopedValue("generated-output-files-loaded", () => ({
    loaded: false,
  }));
  if (state.loaded) return;
  const saved = readState<unknown>("generated-output-files", []);
  for (const row of Array.isArray(saved) ? saved.slice(-maxEntries) : [])
    if (
      row &&
      typeof row.id === "string" &&
      uuid.test(row.id) &&
      typeof row.conversationId === "string" &&
      typeof row.org === "string"
    ) {
      records.set(row.id, row);
      idsBySource.set(bindingKey(row), row.id);
    }
  state.loaded = true;
}
type BindingSource = Pick<
  Binding,
  "org" | "conversationId" | "turnId" | "itemId" | "sourceId" | "name"
>;
type CodeHost = NonNullable<Binding["code"]>["host"];
const sourceKey = (row: BindingSource) => [
  row.org,
  row.conversationId,
  row.turnId,
  row.itemId,
  row.sourceId,
  row.name,
];
const imageKey = (row: BindingSource, host: CodeHost, savedPath: string) =>
  JSON.stringify([...sourceKey(row), host, "image", savedPath]);
const bindingKey = (row: Omit<Binding, "id">) =>
  row.code?.source.kind === "image"
    ? imageKey(row, row.code.host, row.code.source.path)
    : JSON.stringify([
        ...sourceKey(row),
        row.digest,
        row.bytes,
        row.blob,
        row.code?.host,
      ]);
function binding(
  org: string,
  conversationId: string,
  turnId: string,
  itemId: string,
  file: GeneratedFile,
): Omit<Binding, "id"> {
  if (
    !file ||
    typeof file.id !== "string" ||
    !file.id ||
    typeof file.name !== "string" ||
    !file.name
  )
    throw Error("Invalid generated file metadata");
  const value = {
    org,
    conversationId,
    turnId,
    itemId,
    sourceId: file.id,
    name: file.name,
    digest: file.digest,
    bytes: file.bytes,
    blob: file.blob === true,
  };
  return value;
}
const readable = (file: GeneratedFile) =>
  file.state === "ready" &&
  ["create", "update"].includes(file.operation) &&
  !file.tooLarge &&
  typeof file.digest === "string" &&
  digestPattern.test(file.digest) &&
  Number.isSafeInteger(file.bytes) &&
  file.bytes! >= 0 &&
  file.bytes! <= maxBytes &&
  (file.blob === true || typeof file.content === "string");
function remember(source: Omit<Binding, "id">) {
  const key = bindingKey(source);
  const id = idsBySource.get(key);
  const existing = id && records.get(id);
  if (existing) return existing;
  const entry = { id: randomUUID(), ...source };
  records.set(entry.id, entry);
  idsBySource.set(key, entry.id);
  while (records.size > maxEntries) {
    const oldest = records.values().next().value!;
    records.delete(oldest.id);
    idsBySource.delete(bindingKey(oldest));
  }
  writeState("generated-output-files", () => [...records.values()]);
  return entry;
}

export function flushGeneratedOutputBindings() {
  flushState("generated-output-files");
}

const displayName = (filePath: string) =>
  path.posix.basename(filePath.replaceAll("\\", "/"));
const isImage = (mime: string) =>
  /^image\/(?:png|jpeg|gif|webp|bmp)$/.test(mime);

function chatOutputPath(file: GeneratedFile, entry: Binding) {
  if (readable(file) && isImage(mediaType(entry.name)))
    return `/claudex-output/${entry.id}/${displayName(entry.name)}`;
  return sessionPath(file.path);
}

type CodeOutputContext = Pick<AdapterContext,
  "account" | "stateDirectory" | "isCurrent" | "officialCodeHistory" |
  "localLoadConversation" | "localCall" | "generatedFileReadMaxBytes">;
const ownsCode = (
  ctx: CodeOutputContext,
  host: CodeHost,
  c: Conversation,
  owner: string,
) =>
  host === "runner"
    ? ctx.officialCodeHistory === true && isOwnedCloudCodeSession(c, owner)
    : !!ctx.localLoadConversation &&
      !!ctx.localCall &&
      !c.incognito &&
      isLocalCodeSession(c) &&
      (!c.sessionAuthors || c.sessionAuthors.ownerAccountUuid === owner);
const fileReadLimit = (ctx: CodeOutputContext, host?: CodeHost) =>
  host === "runner"
    ? officialUiTransferMaxBytes
    : (ctx.generatedFileReadMaxBytes ?? maxBytes);
const unavailableAttachment = (
  name: string,
  size = 0,
): CodeOutputAttachment => ({
  path: name,
  size,
  isImage: false,
  unavailable: true,
});

export function codeOutputAttachment(
  ctx: CodeOutputContext,
  conversation: Conversation,
  turn: Turn,
  item: Item,
  file?: GeneratedFile,
): CodeOutputAttachment | undefined {
  const owner = ctx.account()?.id;
  const root = ctx.stateDirectory?.();
  const host = ctx.officialCodeHistory ? "runner" : "desktop";
  if (
    !owner ||
    !root ||
    ctx.isCurrent?.() === false ||
    !ownsCode(ctx, host, conversation, owner)
  )
    return undefined;
  const org = organizationUuid(owner);
  const limit = Math.min(fileReadLimit(ctx, host), maxBytes);
  if (file) {
    const name = displayName(file.name);
    if (!readable(file) || file.bytes! > limit)
      return unavailableAttachment(name, file.bytes ?? 0);
    load();
    const entry = remember({
      ...binding(org, conversation.id, turn.id, item.id, file),
      code: { host, source: { kind: "output" } },
    });
    return {
      path: name,
      size: file.bytes!,
      isImage: isImage(mediaType(name)),
      file_uuid: entry.id,
    };
  }
  const savedPath: unknown = item.savedPath;
  if (item.type !== "imageGeneration" || typeof savedPath !== "string")
    return undefined;
  const name = displayName(savedPath);
  const source = {
    org,
    conversationId: conversation.id,
    turnId: turn.id,
    itemId: item.id,
    sourceId: item.id,
    name,
    blob: true,
  };
  load();
  const existing = idsBySource.get(imageKey(source, host, savedPath));
  if (existing) {
    const entry = records.get(existing);
    if (entry && entry.bytes !== undefined && entry.bytes <= limit)
      return {
        path: name,
        size: entry.bytes,
        isImage: true,
        file_uuid: entry.id,
      };
    return unavailableAttachment(name);
  }
  let snapshot: GeneratedImage | null = null;
  try {
    snapshot = new GeneratedBlobs(root).snapshotImage(savedPath);
  } catch {}
  if (!snapshot || snapshot.bytes > limit) return unavailableAttachment(name);
  const entry = remember({
    ...source,
    digest: snapshot.digest,
    bytes: snapshot.bytes,
    code: {
      host,
      source: { kind: "image", path: savedPath, mime: snapshot.mime },
    },
  });
  return {
    path: name,
    size: snapshot.bytes,
    isImage: true,
    file_uuid: entry.id,
  };
}

export function generatedOutputFiles(
  org: string,
  conversationId: string,
  turn: Turn,
) {
  load();
  const result = new Map<
    string,
    { binding: Binding; file: GeneratedFile; readable: boolean }
  >();
  for (const item of turn.items ?? [])
    for (const file of item.generatedFiles ?? []) {
      if (file.previousPath && file.previousPath !== file.path)
        result.delete(file.previousPath);
      const entry = remember(
        binding(org, conversationId, turn.id, item.id, file),
      );
      result.set(file.path || file.id, {
        binding: entry,
        file,
        readable: readable(file),
      });
    }
  return [...result.values()];
}
export function generatedOutputAttachments(
  org: string,
  conversationId: string,
  turn: Turn,
  durable = false,
) {
  const files = generatedOutputFiles(org, conversationId, turn);
  if (durable) flushGeneratedOutputBindings();
  return files
    .filter(
      ({ file }) => file.state !== "deleted" && file.operation !== "delete",
    )
    .map(({ binding: b, readable, file }) => ({
      id: b.id,
      fileName: readable ? b.name : sessionPath(file.path),
      path: file.path,
      sessionPath: chatOutputPath(file, b),
      fileSize: BigInt(
        Number.isSafeInteger(b.bytes) && b.bytes! >= 0 ? b.bytes! : 0,
      ),
      mediaType: mediaType(b.name),
      fileKind: 2,
      presentationKind: 1,
      url: `/api/organizations/${org}/files/${b.id}/contents`,
      downloadUrl: `/api/organizations/${org}/files/${b.id}/contents`,
      ...(!readable
        ? {
            unavailable: true,
            unavailableText: "This generated file snapshot is unavailable.",
          }
        : {}),
    }));
}
export function generatedWorkspaceOutputs(
  org: string,
  conversationId: string,
  turns: Turn[],
) {
  const latest = new Map<
    string,
    ReturnType<typeof generatedOutputFiles>[number]
  >();
  for (const turn of turns)
    for (const entry of generatedOutputFiles(org, conversationId, turn)) {
      if (
        entry.file.previousPath &&
        entry.file.previousPath !== entry.file.path
      )
        latest.delete(sessionPath(entry.file.previousPath));
      latest.set(chatOutputPath(entry.file, entry.binding), entry);
    }
  return [...latest.values()]
    .filter((e) => e.readable)
    .map(({ binding: b, file }) => ({
      displayName: b.name,
      path: chatOutputPath(file, b),
      fileId: b.id,
      title: b.name,
      sizeBytes: BigInt(b.bytes!),
      mediaType: mediaType(b.name),
      url: `/api/organizations/${org}/files/${b.id}/contents`,
      downloadUrl: `/api/organizations/${org}/files/${b.id}/contents`,
    }));
}
class OutputReadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
/** Authenticated bytes from the current conversation's recorded snapshot only. */
export async function generatedOutputFileRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  ctx: AdapterContext,
) {
  const match =
    /^\/api\/(?:organizations\/)?([^/]+)\/files\/([^/]+)\/(contents|preview|thumbnail|content_preview|document_pdf)$/.exec(
      p,
    );
  if (!match) return false;
  load();
  const saved = records.get(match[2]);
  if (!saved) return false;
  const owner = ctx.account()?.id,
    identity = ctx.sessionIdentity?.(),
    root = ctx.stateDirectory?.();
  const check = () => {
    if (
      !owner ||
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== identity ||
      ctx.stateDirectory?.() !== root ||
      ctx.isCurrent?.() === false
    )
      throw new OutputReadError(
        409,
        "The file account changed. Reopen its conversation.",
      );
  };
  try {
    check();
    if (match[1] !== organizationUuid(owner!) || saved.org !== match[1])
      throw new OutputReadError(404, "File not found.");
    if (!["GET", "HEAD"].includes(req.method ?? "") || url.search)
      throw new OutputReadError(400, "Unsupported generated file request.");
    const image =
      saved.code?.source.kind === "image" ? saved.code.source : undefined;
    let persistent = false;
    const readOwned = async () => {
      const c =
        saved.code?.host === "desktop"
          ? await ctx.localLoadConversation?.(saved.conversationId)
          : await ctx.loadConversation(saved.conversationId);
      check();
      if (
        !c ||
        c.id !== saved.conversationId ||
        (saved.code
          ? !ownsCode(ctx, saved.code.host, c, owner!)
          : c.mode !== "chat" ||
            (c.sessionAuthors?.ownerAccountUuid &&
              c.sessionAuthors.ownerAccountUuid !== owner))
      )
        throw new OutputReadError(404, "File not found.");
      persistent = !c.incognito;
      const turns = [
        ...(c.turns ?? []),
        ...(c.savedBranches ?? []).flatMap((b) => b.turns),
      ];
      const items = turns
        .filter((t) => t.id === saved.turnId)
        .flatMap((t) => t.items.filter((i) => i.id === saved.itemId));
      const changed = () =>
        new OutputReadError(
          409,
          "The generated file changed or is unavailable. Reopen its conversation.",
        );
      if (image) {
        if (
          !items.length ||
          items.some(
            (item) =>
              item.type !== "imageGeneration" || item.savedPath !== image.path,
          )
        )
          throw changed();
        return undefined;
      }
      const candidates = items.flatMap((item) =>
        (item.generatedFiles ?? []).filter(
          (file) => file.id === saved.sourceId,
        ),
      );
      if (
        !candidates.length ||
        candidates.some(
          (file) =>
            !readable(file) ||
            bindingKey({
              ...binding(saved.org, c.id, saved.turnId, saved.itemId, file),
              code: saved.code,
            }) !== bindingKey(saved),
        )
      )
        throw changed();
      return candidates[0];
    };
    const file = await readOwned();
    const limit = fileReadLimit(ctx, saved.code?.host);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      saved.bytes! > Math.min(limit, maxBytes)
    )
      throw new OutputReadError(
        413,
        "This file exceeds the current host download limit.",
      );
    let bytes: Buffer;
    if (image && root && saved.digest) {
      const blobs = new GeneratedBlobs(root);
      try {
        bytes = blobs.read(saved.digest);
      } catch {
        if (blobs.snapshotImage(image.path)?.digest !== saved.digest)
          throw new OutputReadError(
            503,
            "The file snapshot could not be read.",
          );
        bytes = blobs.read(saved.digest);
      }
    } else if (file?.blob) {
      const encoded =
        saved.code?.host === "desktop"
          ? await ctx.localCall?.("readGeneratedFile", file.digest)
          : await ctx.call("readGeneratedFile", file.digest);
      check();
      if (
        typeof encoded !== "string" ||
        encoded.length > Math.ceil(maxBytes / 3) * 4
      )
        throw new OutputReadError(503, "The file snapshot could not be read.");
      bytes = Buffer.from(encoded, "base64");
    } else if (typeof file?.content === "string")
      bytes = Buffer.from(file.content, "utf8");
    else throw new OutputReadError(503, "The file snapshot could not be read.");
    if (bytes.length !== saved.bytes)
      throw new OutputReadError(
        503,
        "The generated file snapshot has an unexpected size.",
      );
    check();
    let type = image?.mime ?? mediaType(saved.name);
    if (saved.code && match[3] === "thumbnail" && ctx.image && isImage(type)) {
      const thumbnail = ctx.image.thumbnail?.(bytes, 400);
      if (thumbnail) {
        bytes = thumbnail;
        type = "image/png";
      }
    }
    if (match[3] === "content_preview") {
      if (!type.startsWith("text/") && type !== "application/json")
        throw new OutputReadError(
          501,
          "Text preview is unavailable for this file type.",
        );
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (content.includes("\0"))
        throw new OutputReadError(415, "Binary data cannot be shown as text.");
      return reply(res, { content: content.slice(0, 20000) });
    }
    if (match[3] === "document_pdf" && type !== "application/pdf")
      throw new OutputReadError(
        501,
        "PDF conversion is unavailable for this file type.",
      );
    const descriptor = {
      id: saved.id,
      name: saved.name,
      size: saved.bytes!,
      mediaType: type,
      kind: "blob" as const,
      createdAt: 0,
    };
    const headers = attachmentResponseHeaders(descriptor, type);
    const downloadable = attachmentResponseHeaders(
      descriptor,
      "application/octet-stream",
    );
    if (!("Content-Disposition" in downloadable))
      throw new OutputReadError(503, "The download could not be prepared.");
    res.writeHead(200, {
      ...headers,
      "Content-Length": bytes.length,
      ...(persistent && req.headers?.["x-claudex-object-transfer"] === "1"
        ? { "X-Claudex-Store-Attachment": encodeURIComponent(saved.name) } : {}),
      ...(match[3] === "contents"
        ? { "Content-Disposition": downloadable["Content-Disposition"] }
        : {}),
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
    return true;
  } catch (error) {
    try {
      check();
    } catch (changed) {
      error = changed;
    }
    return reply(
      res,
      {
        error: {
          type: "invalid_request_error",
          message:
            error instanceof OutputReadError
              ? error.message
              : "The generated file could not be read.",
        },
      },
      error instanceof OutputReadError ? error.status : 503,
    );
  }
}
