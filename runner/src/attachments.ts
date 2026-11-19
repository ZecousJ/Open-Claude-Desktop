/**
 * Attachments on the web (web plan §1.2, W-BRIDGE contract 2).
 *
 * - Uploads: the bridge sends a byte argument over 256 KiB (a dropped file,
 *   a skill) through Go's chunked `uploads` endpoint first and puts
 *   `{"$upload": "<id>"}` in its place. Before a handler runs, the runner
 *   swaps each reference for the bytes, read from webstore with
 *   `store.files.get {id, offset, length}` → `{size, bytes: {"$bytes": …}}`
 *   in 4 MiB pieces. Go answers only for the calling user's own uploads.
 * - Staging: `addAttachmentData` stores the file under
 *   `<profile>/attachments/<id>/` as on the desktop. That folder is mounted
 *   read-only into the user's sandbox, so Codex can read an image the turn
 *   refers to (`localImage`) and nothing else of the profile.
 * - Folders of attachments no conversation refers to are removed after 30
 *   days, so the runner's disk does not fill up with abandoned drafts.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Conversation } from "../../shared/types";
import { webErrorCodes } from "../../shared/web-protocol";
import { decodeWireValue } from "../../shared/web-wire";
import { isSteeredMessage } from "../../shared/agent-api";
import { type WebRunnerOp } from "../../shared/web-runner-frames";
import { attachmentObjectURL, readAttachmentObject } from "../../shared/attachment-object";

export interface UploadTransport {
  request(op: WebRunnerOp, userId: number, body?: unknown): Promise<unknown>;
}

/** Bytes read per `store.files.get` (base64 keeps a frame under 6 MiB). */
export const uploadPieceBytes = 4 * 1024 * 1024;
/** The most bytes one call may bring through uploads (addAttachmentData's cap). */
export const maxUploadBytes = 64 * 1024 * 1024;
/** Upload references one call may carry. */
export const maxUploadsPerCall = 12;
const uploadIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const attachmentRetentionMs = 30 * 24 * 60 * 60_000;

function refused(message: string) {
  return Object.assign(new Error(message), { code: webErrorCodes.badRequest });
}

/** `{"$upload": id}` → id; undefined for anything else. */
export function uploadRef(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "$upload") return undefined;
  const id = (value as { $upload: unknown }).$upload;
  if (typeof id !== "string" || !uploadIdPattern.test(id))
    throw refused("This upload reference is not valid.");
  return id;
}

/** Reads one upload of the user, piece by piece. */
export async function readUpload(
  transport: UploadTransport,
  userId: number,
  id: string,
  maxBytes = maxUploadBytes,
): Promise<Uint8Array> {
  let size = -1;
  let offset = 0;
  const pieces: Uint8Array[] = [];
  try {
    while (size < 0 || offset < size) {
      const query = { id, offset, length: uploadPieceBytes };
      const direct = offset === 0 && !id.startsWith("private_");
      let value: unknown;
      try {
        value = await transport.request("store.files.get", userId,
          direct ? { ...query, direct: true } : query);
      } catch (error) {
        if (!direct || !error || typeof error !== "object" || !("code" in error) ||
            error.code !== webErrorCodes.badRequest) throw error;
        value = await transport.request("store.files.get", userId, query);
      }
      const answer = decodeWireValue(value) as { size?: unknown; bytes?: unknown; url?: unknown };
      if (
        !answer ||
        typeof answer.size !== "number" ||
        !Number.isSafeInteger(answer.size) ||
        answer.size < 0
      )
        throw new Error("The Claudex service sent an invalid upload.");
      if (answer.size > maxBytes) throw refused("This file is too large.");
      if (offset === 0 && typeof answer.url === "string")
        return await readAttachmentObject(answer.url, answer.size);
      if (!(answer.bytes instanceof Uint8Array))
        throw new Error("The Claudex service sent an invalid upload.");
      if (size >= 0 && answer.size !== size)
        throw new Error("The upload changed while it was read.");
      size = answer.size;
      if (answer.bytes.byteLength === 0 && offset < size)
        throw new Error("The Claudex service sent an incomplete upload.");
      if (offset + answer.bytes.byteLength > size)
        throw new Error("The Claudex service sent an invalid upload.");
      pieces.push(answer.bytes);
      offset += answer.bytes.byteLength;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const piece of pieces) {
      out.set(piece, at);
      at += piece.byteLength;
    }
    return out;
  } finally {
    if (id.startsWith("private_")) await transport.request("store.files.delete", userId, { id }).catch(() => {});
  }
}

export async function publishAttachmentObject(
  transport: UploadTransport,
  userId: number,
  file: { name: string; mime: string; bytes: Uint8Array },
  signal?: AbortSignal,
) {
  const size = file.bytes.byteLength;
  const sha = createHash("sha256").update(file.bytes).digest("hex");
  const start = await transport.request("store.files.put", userId, {
    name: file.name, mime: file.mime, size, snapshotSha: sha,
  });
  if (!start || typeof start !== "object") return undefined;
  if ("url" in start && typeof start.url === "string")
    return { url: attachmentObjectURL(start.url), size };
  if (!("id" in start) || start.id !== sha || !("upload" in start) ||
      !start.upload || typeof start.upload !== "object" ||
      !("url" in start.upload) || typeof start.upload.url !== "string")
    return undefined;
  const response = await fetch(attachmentObjectURL(start.upload.url), {
    method: "PUT", credentials: "omit", redirect: "error",
    headers: { "If-None-Match": "*", "X-Amz-Content-Sha256": sha },
    body: file.bytes as Uint8Array<ArrayBuffer>,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  await response.body?.cancel();
  if (!response.ok && response.status !== 412) return undefined;
  const completed = await transport.request("store.files.put", userId, { id: sha, complete: true });
  if (!completed || typeof completed !== "object" || !("url" in completed) || typeof completed.url !== "string")
    throw Error("The attachment was not committed.");
  return { url: attachmentObjectURL(completed.url), size };
}

/**
 * The call's arguments with every upload reference replaced by its bytes.
 * References are looked for at any depth (the bridge replaces a Uint8Array
 * wherever it is); at most 12 per call and 64 MiB together. A profile
 * photo's $avatarPhoto wrapper restores its uploaded data URL as text.
 */
export async function resolveUploads(
  args: unknown[],
  read: (id: string, maxBytes: number) => Promise<Uint8Array>,
): Promise<unknown[]> {
  let count = 0;
  let total = 0;
  const visit = async (value: unknown, depth: number): Promise<unknown> => {
    if (depth > 32) return value;
    const id = uploadRef(value);
    if (id !== undefined) {
      if (++count > maxUploadsPerCall)
        throw refused("Too many files in one request.");
      const bytes = await read(id, maxUploadBytes - total);
      total += bytes.byteLength;
      if (total > maxUploadBytes) throw refused("These files are too large.");
      return bytes;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) out.push(await visit(item, depth + 1));
      return out;
    }
    if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
      if (Object.keys(value).length === 1 && "$avatarPhoto" in value) {
        const bytes = await visit(value.$avatarPhoto, depth + 1);
        if (!(bytes instanceof Uint8Array) || bytes.length > 700_000)
          throw refused("This file is too large.");
        const photo = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (
          !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(photo)
        )
          throw refused("This upload reference is not valid.");
        return photo;
      }
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value))
        Object.defineProperty(out, key, {
          value: await visit(item, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      return out;
    }
    return value;
  };
  return (await visit(args, 0)) as unknown[];
}

/** Whether any argument refers to an upload (so the call must read it). */
export function hasUploads(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (uploadRef(value) !== undefined) return true;
  if (Array.isArray(value)) return value.some((v) => hasUploads(v, depth + 1));
  if (value && typeof value === "object" && !(value instanceof Uint8Array))
    return Object.values(value).some((v) => hasUploads(v, depth + 1));
  return false;
}

/** The profile folder attachments are stored in (mounted read-only in the sandbox). */
export function attachmentsFolder(storeRoot: string) {
  const folder = path.join(storeRoot, "attachments");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  return folder;
}

/**
 * Removes attachment folders older than `maxAgeMs` that no stored turn or
 * draft refers to. Returns the ids removed.
 */
export function pruneAttachments(
  storeRoot: string,
  conversations: Conversation[],
  inUse: Iterable<string>,
  now = Date.now(),
  maxAgeMs = attachmentRetentionMs,
) {
  const folder = path.join(storeRoot, "attachments");
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const referenced = new Set(inUse);
  for (const conversation of conversations)
    for (const turn of [
      conversation.turns,
      conversation.officialCodeQueuedTurns ?? [],
      ...(conversation.savedBranches ?? []).map((branch) => branch.turns),
    ].flat()) {
      for (const attachment of turn.attachments ?? [])
        referenced.add(attachment.id);
      for (const item of turn.items ?? [])
        if (isSteeredMessage(item))
          for (const attachment of item.attachments ?? [])
            referenced.add(attachment.id);
    }
  const removed: string[] = [];
  for (const name of names) {
    if (referenced.has(name)) continue;
    const full = path.join(folder, name);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    if (now - stat.mtimeMs < maxAgeMs) continue;
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
