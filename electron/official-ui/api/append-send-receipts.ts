/** Replay guard for the original client's send queue. */
import { createHash } from "node:crypto";
import { ScopedMap } from "./scope";
import fs from "node:fs";
import path from "node:path";
import type { AdapterContext } from "./context";

type Answer = { ack: Record<string, unknown> };
export interface AppendSendIdentity {
  key: string;
  hash: string;
}
interface Entry {
  hash: string;
  answer: Promise<Answer>;
}
const attempts = new ScopedMap<string, Entry>("ordinary-send-receipts");
export type AppendSendReceipt =
  | { kind: "missing" }
  | { kind: "conflict" }
  | { kind: "pending"; answer: Promise<Answer> }
  | { kind: "reserved"; finish: (answer: Answer) => void };

/** Legacy callers without an original mutation identity keep their old behavior. */
export function appendSendIdentity(
  mutation: { sessionId?: string; version?: bigint } | undefined,
  send: { messageId?: string; assistantMessageId?: string; parentMessageId?: string },
  bytes: Uint8Array,
  android?: { conversationId: string; retry: boolean },
): AppendSendIdentity | undefined {
  const sourceMessageId = android?.retry ? send.parentMessageId : send.messageId;
  if (
    !mutation?.sessionId ||
    typeof mutation.version !== "bigint" ||
    mutation.version <= 0n ||
    !sourceMessageId ||
    !send.assistantMessageId
  )
    return undefined;
  return {
    key: JSON.stringify(android
      ? android.retry
        ? [android.conversationId, sourceMessageId, send.assistantMessageId, "retry"]
        : [android.conversationId, sourceMessageId, send.assistantMessageId]
      : [mutation.sessionId, String(mutation.version)]),
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function lookupAppendSend(
  identity: AppendSendIdentity,
): AppendSendReceipt {
  const prior = attempts.get(identity.key);
  if (!prior) return { kind: "missing" };
  return prior.hash === identity.hash
    ? { kind: "pending", answer: prior.answer }
    : { kind: "conflict" };
}

/** Synchronous reservation before settings/attachment/send side effects. */
export function reserveAppendSend(
  identity: AppendSendIdentity,
): AppendSendReceipt {
  const prior = lookupAppendSend(identity);
  if (prior.kind !== "missing") return prior;
  let finish!: (answer: Answer) => void;
  const answer = new Promise<Answer>((resolve) => {
    finish = resolve;
  });
  attempts.set(identity.key, { hash: identity.hash, answer });
  return { kind: "reserved", finish };
}

/** Durable tombstones record uncertainty, never an acknowledgement or message content. */
export function durableAppendSend(
  ctx: AdapterContext,
  identity: AppendSendIdentity,
  reserve: boolean,
): "missing" | "reserved" | "pending" | "conflict" {
  const owner = ctx.account()?.id, activation = ctx.sessionIdentity?.(), root = ctx.stateDirectory?.();
  const current = () => !!owner && activation != null && !!root && path.isAbsolute(root) &&
    ctx.account()?.id === owner && ctx.sessionIdentity?.() === activation &&
    ctx.stateDirectory?.() === root && ctx.isCurrent?.() !== false;
  if (!current() || !root) throw Error("Send receipt storage is unavailable.");
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const dir = path.join(root, "official-append-send-receipts-" + digest(owner!).slice(0, 32));
  const file = path.join(dir, digest(identity.key));
  const checkDir = () => {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Invalid send receipt directory.");
  };
  const read = (): "missing" | "pending" | "conflict" => {
    try {
      checkDir();
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 64) throw Error("Invalid send receipt.");
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== 64)
          throw Error("Invalid send receipt.");
        const bytes = Buffer.alloc(65);
        let count = 0;
        while (count < bytes.length) {
          const n = fs.readSync(fd, bytes, count, bytes.length - count, count);
          if (!n) break;
          count += n;
        }
        const after = fs.fstatSync(fd), latest = fs.lstatSync(file);
        if (count !== 64 || after.size !== 64 || after.dev !== opened.dev || after.ino !== opened.ino ||
            after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
            !latest.isFile() || latest.isSymbolicLink() || latest.size !== 64 ||
            latest.dev !== opened.dev || latest.ino !== opened.ino ||
            latest.mtimeMs !== opened.mtimeMs || latest.ctimeMs !== opened.ctimeMs)
          throw Error("Send receipt changed during read.");
        const hash = bytes.subarray(0, count).toString("utf8");
        if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("Invalid send receipt.");
        return hash === identity.hash ? "pending" : "conflict";
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  };
  const prior = read();
  if (prior !== "missing" || !reserve) return prior;
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  checkDir();
  if (!current()) throw Error("The account changed. Reopen the conversation.");
  try {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, identity.hash); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (process.platform !== "win32") {
      for (const directory of [dir, root]) {
        const directoryFd = fs.openSync(directory, "r");
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      }
    }
    if (!current()) throw Error("The account changed. Reopen the conversation.");
    return "reserved";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = read();
    if (raced === "missing") throw Error("Send receipt changed during reservation.");
    return raced;
  }
}
