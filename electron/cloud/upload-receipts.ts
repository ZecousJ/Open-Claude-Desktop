/** Local history of uploads this application actually made. No renderer paths,
 * no migration from legacy file registries, no credentials or read grants. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Attachment, Conversation } from "../../shared/types";

const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const id = z.string().min(1).max(500);
const name = z.string().min(1).max(120).refine(s => s !== "." && s !== ".." && !/[\x00-\x1f<>:"/\\|?*]/.test(s));
const rowSchema = z.object({
  localId: z.string().uuid(), name, size: z.number().int().min(0).max(32 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), rowId: id, conversationId: id,
}).strict();
export type ConfirmedUploadReceipt = z.infer<typeof rowSchema>;
const journalSchema = z.object({ version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), rows: z.array(rowSchema).max(2000) }).strict();
export interface UploadReceiptScope { root: string; service: string; current(): boolean }
export interface PendingUploadReceipt { localId: string; name: string; size: number; sha256: string; rowId: string }
// Pin each operation to its resolved profile while allowing stable parent aliases.
const canonicalRoots = new WeakMap<UploadReceiptScope, { root: string; dev: number; ino: number }>();
function check(scope: UploadReceiptScope) {
  if (scope.current() !== true) throw Error("The upload account changed.");
  if (!path.isAbsolute(scope.root)) throw Error("The upload profile changed.");
  const stat = fs.lstatSync(scope.root), resolved = fs.realpathSync(scope.root);
  const pinned = canonicalRoots.get(scope);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (pinned !== undefined && (pinned.root !== resolved || pinned.dev !== stat.dev || pinned.ino !== stat.ino)))
    throw Error("The upload profile changed.");
  canonicalRoots.set(scope, { root: resolved, dev: stat.dev, ino: stat.ino });
  return resolved;
}
const scopeId = (scope: UploadReceiptScope) => digest(JSON.stringify([check(scope), scope.service]));
const journalPath = (scope: UploadReceiptScope) => path.join(scope.root, "confirmed-upload-receipts-v1.json");
function read(scope: UploadReceiptScope) {
  check(scope);
  const file = journalPath(scope);
  if (!fs.existsSync(file)) return [];
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw Error("Invalid upload receipt journal.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const actual = fs.fstatSync(fd);
    if (actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size !== stat.size) throw Error("Upload receipts changed.");
    const buffer = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < buffer.length) { const n = fs.readSync(fd, buffer, count, buffer.length - count, count); if (!n) break; count += n; }
    const after = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== actual.mtimeMs || after.ctimeMs !== actual.ctimeMs ||
        named.isSymbolicLink() || named.dev !== actual.dev || named.ino !== actual.ino) throw Error("Upload receipts changed.");
    const data = journalSchema.parse(JSON.parse(buffer.subarray(0, count).toString("utf8")));
    if (data.scope !== scopeId(scope)) throw Error("Upload receipts belong to a different profile.");
    check(scope);
    return data.rows;
  } finally { fs.closeSync(fd); }
}
/** Canonical app-owned copies only. Never resolve a stored arbitrary path. */
function bytes(scope: UploadReceiptScope, localId: string, filename: string, size: number) {
  const canonicalRoot = check(scope);
  z.string().uuid().parse(localId); name.parse(filename);
  const dirs = [path.join(scope.root, "attachments"), path.join(scope.root, "attachments", localId)];
  const directoryStats = dirs.map(dir => {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== path.join(canonicalRoot, path.relative(scope.root, dir))) throw Error("Upload directory changed.");
    return stat;
  });
  const file = path.join(dirs[1], filename), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== size || size > 32 * 1024 * 1024) throw Error("Upload content changed.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (before.dev !== stat.dev || before.ino !== stat.ino || before.size !== size) throw Error("Upload content changed.");
    const buffer = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < buffer.length) { const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count; }
    const after = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (offset !== size || after.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev) throw Error("Upload content changed.");
    dirs.forEach((dir, index) => { const now = fs.lstatSync(dir); if (now.isSymbolicLink() || now.ino !== directoryStats[index].ino || now.dev !== directoryStats[index].dev) throw Error("Upload directory changed."); });
    check(scope);
    return buffer.subarray(0, size);
  } finally { fs.closeSync(fd); }
}
function matchingRow(conversation: Conversation, rowId: string, size: number, filename: string) {
  const rows = [...conversation.turns, ...(conversation.savedBranches ?? []).flatMap(branch => branch.turns)]
    .flatMap(turn => turn.attachments ?? []).filter(row => row.id === rowId);
  return rows.length > 0 && rows.every(row => row.size === size && row.name === filename && !row.github);
}
/** Only call with the exact selected local row, uploaded bytes and returned row. */
export function prepareUploadReceipt(scope: UploadReceiptScope, local: Attachment, uploaded: Uint8Array, remote: Attachment): PendingUploadReceipt {
  check(scope);
  const candidate = rowSchema.omit({ conversationId: true }).parse({ localId: local.id, name: local.name, size: uploaded.byteLength, sha256: digest(uploaded), rowId: remote.id });
  if (local.path !== path.join(scope.root, "attachments", local.id, local.name) || local.size !== candidate.size ||
      remote.name !== local.name || remote.size !== candidate.size || remote.github || local.github)
    throw Error("The upload response did not match its source.");
  if (digest(bytes(scope, candidate.localId, candidate.name, candidate.size)) !== candidate.sha256) throw Error("Uploaded content changed.");
  return candidate;
}
/** Commit only after the service returned the owned conversation containing the
 * exact uploaded rows. A persistence error must not cause a model send replay. */
export function commitUploadReceipts(scope: UploadReceiptScope, conversation: Conversation, pending: PendingUploadReceipt[]) {
  check(scope);
  const records = pending.map(value => rowSchema.parse({ ...value, conversationId: conversation.id }));
  if (!records.length) return;
  for (const row of records) {
    if (!matchingRow(conversation, row.rowId, row.size, row.name)) throw Error("The conversation did not confirm this upload.");
    if (digest(bytes(scope, row.localId, row.name, row.size)) !== row.sha256) throw Error("Uploaded content changed.");
  }
  const old = read(scope);
  const keys = new Set(records.map(row => JSON.stringify([row.conversationId, row.rowId])));
  const conflicts = records.some(row => {
    const existing = old.find(item => item.conversationId === row.conversationId && item.rowId === row.rowId);
    return existing && JSON.stringify(existing) !== JSON.stringify(row);
  });
  const kept = old.filter(row => !keys.has(JSON.stringify([row.conversationId, row.rowId])));
  // A conflicting service row must not retain an earlier byte mapping.
  write(scope, conflicts ? kept : [...kept, ...records].slice(-2000));
  if (conflicts) throw Error("Conflicting upload receipt.");
}
function write(scope: UploadReceiptScope, rows: ConfirmedUploadReceipt[]) {
  check(scope);
  const target = journalPath(scope), temp = `${target}.${randomUUID()}.tmp`;
  try {
    const contents = JSON.stringify({ version: 1, scope: scopeId(scope), rows });
    if (Buffer.byteLength(contents) > 2 * 1024 * 1024) throw Error("Upload receipt journal is full.");
    fs.writeFileSync(temp, contents, { mode: 0o600, flag: "wx" });
    check(scope);
    if (fs.existsSync(target)) { const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Invalid upload receipt journal."); }
    fs.renameSync(temp, target);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }

}
/** `conversation` must come from the current account's owned service, not the
 * renderer or a file-registry alias. Legacy rows are deliberately not repaired. */
export function readConfirmedUploadReceipt(scope: UploadReceiptScope, conversation: Conversation, rowId: string): (ConfirmedUploadReceipt & { data: Uint8Array }) | undefined {
  id.parse(conversation.id); id.parse(rowId);
  const matches = read(scope).filter(row => row.conversationId === conversation.id && row.rowId === rowId);
  if (!matches.length) return undefined;
  if (matches.length !== 1) throw Error("Ambiguous upload receipt.");
  const row = matches[0];
  if (!matchingRow(conversation, rowId, row.size, row.name)) throw Error("The upload no longer belongs to this conversation.");
  const data = bytes(scope, row.localId, row.name, row.size);
  if (digest(data) !== row.sha256) throw Error("Uploaded content changed.");
  check(scope);
  return { ...row, data: new Uint8Array(data) };
}
