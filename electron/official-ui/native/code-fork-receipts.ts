/** Native Code fork tombstones, adapted from the independently reviewed REST algorithm.
 * Separate operation namespace and identity: never stored as Chat/message receipts.
 * No prompts, tokens or transcript bodies.
 * A tombstone is NOT proof of success and never authorizes a retry dispatch. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AdapterContext } from "../api/context";
export interface CodeForkReceiptInput {
  requestId: string;
  payloadHash: string;
}

export class CodeForkReceiptError extends Error {
  constructor(
    readonly status: 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
type ReceiptContext = Pick<
  AdapterContext,
  "account" | "stateDirectory" | "sessionIdentity" | "isCurrent"
>;
type Tombstone = {
  version: 1;
  key: string;
  payloadHash: string;
  operationId: string;
};
export const codeForkReceiptCapacity = 4096;
const quotaMarker = "capacity-v1";
const quotaMagic = "claudex-receipts-slots-v1\n";
function quotaUnavailable(): never {
  throw new CodeForkReceiptError(
    503,
    "Fork receipt capacity is unavailable or needs initialization. Existing outcomes may be read; no new fork was dispatched.",
  );
}
function initializeQuota(dir: string) {
  const fd = fs.openSync(
    path.join(dir, quotaMarker),
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, quotaMagic);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDir(dir);
}
function allocateSlot(dir: string, key: string) {
  let marker: number;
  try {
    marker = fs.openSync(
      path.join(dir, quotaMarker),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    quotaUnavailable();
  }
  try {
    const buffer = Buffer.alloc(64);
    const count = fs.readSync(marker, buffer, 0, buffer.length, 0);
    if (
      !fs.fstatSync(marker).isFile() ||
      buffer.subarray(0, count).toString() !== quotaMagic
    )
      quotaUnavailable();
  } finally {
    fs.closeSync(marker);
  }
  for (let slot = 0; slot < codeForkReceiptCapacity; slot++) {
    let fd: number;
    try {
      fd = fs.openSync(
        path.join(dir, `capacity-slot-${slot}`),
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    // Never recycle slots: an uncertain/crashed allocation only reduces capacity.
    try {
      fs.writeFileSync(fd, key);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    syncDir(dir);
    return;
  }
  quotaUnavailable();
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function conflict(): never {
  throw new CodeForkReceiptError(
    409,
    "Fork identity is already bound to another request.",
  );
}
function unavailable(): never {
  throw new CodeForkReceiptError(
    503,
    "The fork could not be recorded safely. No retry was dispatched.",
  );
}
function syncDir(dir: string) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function assertDirectory(dir: string) {
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink()) unavailable();
}
function read(file: string): Tombstone {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > 4096) unavailable();
    // Fixed allocation and explicit position: growth after fstat cannot cause an
    // unbounded read. Reject concurrent replacement/truncation or metadata change.
    const buffer = Buffer.alloc(4097);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(
        fd,
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd);
    if (
      length !== s.size ||
      length > 4096 ||
      after.size !== s.size ||
      after.dev !== s.dev ||
      after.ino !== s.ino ||
      after.mtimeMs !== s.mtimeMs ||
      after.ctimeMs !== s.ctimeMs
    )
      unavailable();
    const value = JSON.parse(
      buffer.subarray(0, length).toString("utf8"),
    ) as Tombstone;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.version !== 1 ||
      typeof value.key !== "string" ||
      typeof value.payloadHash !== "string" ||
      typeof value.operationId !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.key) ||
      !/^[a-f0-9]{64}$/.test(value.payloadHash) ||
      !uuid.test(value.operationId)
    )
      unavailable();
    return value;
  } finally {
    fs.closeSync(fd);
  }
}
/** Synchronous reserve before any send. Atomic wx and supported directory/file fsync protect process
 * restart replay. Windows flushes each receipt file; caller must treat any exception/uncertain write as no-dispatch.
 * Context root must be a trusted account-owned directory, not renderer input. */
function reserveNativeCodeOperation(
  ctx: ReceiptContext,
  input: CodeForkReceiptInput,
  kind: "fork" | "rewind" | "undo",
): { fresh: boolean; operationId: string } {
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.(),
    root = ctx.stateDirectory?.();
  const current = () =>
    typeof owner === "string" &&
    !!owner &&
    activation !== undefined &&
    activation !== null &&
    !(typeof activation === "string" && activation.length === 0) &&
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === activation &&
    ctx.stateDirectory?.() === root &&
    ctx.isCurrent?.() !== false;
  if (!current())
    throw new CodeForkReceiptError(
      409,
      "The account changed. Reopen the conversation.",
    );
  if (typeof input.requestId !== "string" || !uuid.test(input.requestId) ||
      typeof input.payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(input.payloadHash))
    throw new CodeForkReceiptError(409, "Invalid fork request identity.");
  if (!root || !path.isAbsolute(root)) unavailable();
  try {
    assertDirectory(root);
    const dir = path.join(
      root,
      `official-native-code-${kind}-receipts-` + hash(owner).slice(0, 24),
    );
    if (!current())
      throw new CodeForkReceiptError(
        409,
        "The account changed. Reopen the conversation.",
      );
    fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
    syncDir(root);
    assertDirectory(dir);
    initializeQuota(dir);
    return reserveInDirectory(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const dir = path.join(
          root,
          `official-native-code-${kind}-receipts-` + hash(owner).slice(0, 24),
        );
        assertDirectory(dir);
        return reserveInDirectory(dir);
      } catch (inner) {
        if (inner instanceof CodeForkReceiptError) throw inner;
        unavailable();
      }
    }
    if (error instanceof CodeForkReceiptError) throw error;
    unavailable();
  }
  function reserveInDirectory(dir: string): {
    fresh: boolean;
    operationId: string;
  } {
    const key = hash([`native-code-${kind}-v1`, owner, input.requestId.toLowerCase()]);
    const candidate: Tombstone = {
      version: 1, key, payloadHash: input.payloadHash, operationId: randomUUID(),
    };
    const pair = reserve(key, candidate);
    if (!current())
      throw new CodeForkReceiptError(
        409,
        "The account changed. Reopen the conversation.",
      );
    return { fresh: pair.fresh, operationId: pair.value.operationId };
    function reserve(
      key: string,
      value: Tombstone,
    ): { fresh: boolean; value: Tombstone } {
      if (!current())
        throw new CodeForkReceiptError(
          409,
          "The account changed. Reopen the conversation.",
        );
      assertDirectory(dir);
      const file = path.join(dir, key + ".json");
      // Existing receipts remain readable at capacity and in legacy directories.
      try {
        const existing = read(file);
        if (existing.key !== key || existing.payloadHash !== value.payloadHash)
          conflict();
        return { fresh: false, value: existing };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // EEXIST does not establish that another creator durably published this
      // directory. Flush its parent before every new reservation can dispatch.
      assertDirectory(root!);
      syncDir(root!);
      allocateSlot(dir, key);
      if (!current())
        throw new CodeForkReceiptError(
          409,
          "The account changed. Reopen the conversation.",
        );
      let fd: number;
      try {
        fd = fs.openSync(
          file,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = read(file);
        if (existing.key !== key || existing.payloadHash !== value.payloadHash)
          conflict();
        return { fresh: false, value: existing };
      }
      try {
        fs.writeFileSync(fd, JSON.stringify(value));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      syncDir(dir);
      return { fresh: true, value };
    }
  }
}

export function reserveCodeFork(ctx: ReceiptContext, input: CodeForkReceiptInput) {
  return reserveNativeCodeOperation(ctx,input,"fork");
}
/** Host-only operation kind; renderer cannot choose receipt namespace. */
export function reserveCodeRewind(ctx: ReceiptContext, input: CodeForkReceiptInput, undo = false) {
  try { return reserveNativeCodeOperation(ctx,input,undo ? "undo" : "rewind"); }
  catch (error) {
    throw new CodeForkReceiptError(error instanceof CodeForkReceiptError ? error.status : 503,
      "Rewind could not be reserved safely. Check the session; no automatic retry was started.");
  }
}
