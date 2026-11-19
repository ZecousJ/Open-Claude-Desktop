import { reserveWindowsReceipt } from "./windows-rest-receipts";
/** Durable once-only REST send tombstones. No prompts, tokens or stream bodies.
 * A tombstone is NOT proof of success and never authorizes a retry dispatch. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AdapterContext } from "./context";
export interface RestCompletionReceiptInput {
  conversationId: string;
  humanId: string;
  assistantId: string;
  requestId?: string;
  payloadHash: string;
  /** Retry reuses an existing opaque human message identity, not a new UUID. */
  operation?: "retry";
}
export class RestCompletionReceiptError extends Error {
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
export const restCompletionReceiptCapacity = 4096;
const quotaMarker = "capacity-v1";
const quotaMagic = "claudex-receipts-slots-v1\n";
function quotaUnavailable(): never {
  throw new RestCompletionReceiptError(
    503,
    "Completion receipt capacity is unavailable or needs initialization. Existing outcomes may be read; no new send was dispatched.",
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
function verifyQuotaMarker(dir: string) {
  let marker: number;
  try {
    const file = path.join(dir, quotaMarker),
      before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 64)
      quotaUnavailable();
    marker = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(marker),
        buffer = Buffer.alloc(65);
      const count = fs.readSync(marker, buffer, 0, buffer.length, 0),
        after = fs.fstatSync(marker);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        count !== opened.size ||
        buffer.subarray(0, count).toString() !== quotaMagic
      )
        quotaUnavailable();
    } finally {
      fs.closeSync(marker);
    }
  } catch (error) {
    if (error instanceof RestCompletionReceiptError) throw error;
    quotaUnavailable();
  }
}
function allocateSlot(dir: string, key: string) {
  verifyQuotaMarker(dir);
  for (let slot = 0; slot < restCompletionReceiptCapacity; slot++) {
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
  throw new RestCompletionReceiptError(
    409,
    "Completion identity is already bound to another request.",
  );
}
function unavailable(): never {
  throw new RestCompletionReceiptError(
    503,
    "The completion could not be recorded safely. No retry was dispatched.",
  );
}
function syncDir(dir: string) {
  if (process.platform === "win32") unavailable();
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
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) unavailable();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (
      !s.isFile() ||
      s.size > 4096 ||
      s.dev !== before.dev ||
      s.ino !== before.ino
    )
      unavailable();
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
 * restart replay; Windows uses the flushed registry hive; caller must treat any exception/uncertain write as no-dispatch.
 * Context root must be a trusted account-owned directory, not renderer input. */
export function reserveRestCompletion(
  ctx: ReceiptContext,
  input: RestCompletionReceiptInput,
  // Only account-local, adapter-owned aliases; never copied from request JSON.
  options: { equivalentConversationIds?: readonly string[] } = {},
): { fresh: boolean; operationId: string } {
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.(),
    root = ctx.stateDirectory?.();
  const current = () =>
    typeof owner === "string" &&
    !!owner &&
    activation !== undefined &&
    activation !== null &&
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === activation &&
    ctx.stateDirectory?.() === root &&
    ctx.isCurrent?.() !== false;
  if (!current())
    throw new RestCompletionReceiptError(
      409,
      "The account changed. Reopen the conversation.",
    );
  if (
    typeof input.conversationId !== "string" ||
    typeof input.humanId !== "string" ||
    typeof input.assistantId !== "string" ||
    typeof input.payloadHash !== "string" ||
    (input.requestId !== undefined && typeof input.requestId !== "string") ||
    !uuid.test(input.conversationId) ||
    (input.operation === "retry"
      ? !input.humanId || input.humanId.length > 512
      : !uuid.test(input.humanId)) ||
    (input.operation !== undefined && input.operation !== "retry") ||
    !uuid.test(input.assistantId) ||
    input.humanId.toLowerCase() === input.assistantId.toLowerCase() ||
    (input.requestId !== undefined && !uuid.test(input.requestId)) ||
    !/^[a-f0-9]{64}$/.test(input.payloadHash)
  )
    throw new RestCompletionReceiptError(409, "Invalid completion identity.");
  const equivalents = options.equivalentConversationIds ?? [];
  if (
    equivalents.length > 5000 ||
    equivalents.some((id) => typeof id !== "string" || !uuid.test(id))
  )
    throw new RestCompletionReceiptError(
      409,
      "Invalid completion conversation aliases.",
    );
  const conversationIds = [
    ...new Set(
      [input.conversationId, ...equivalents].map((id) => id.toLowerCase()),
    ),
  ];
  if (!root || !path.isAbsolute(root)) unavailable();
  try {
    assertDirectory(root);
    const dir = path.join(
      root,
      "official-rest-completion-receipts-" + hash(owner).slice(0, 24),
    );
    if (!current())
      throw new RestCompletionReceiptError(
        409,
        "The account changed. Reopen the conversation.",
      );
    if (process.platform === "win32") {
      // Windows registry flush provides a durable publication boundary without
      // relying on an unsupported directory fsync. Legacy file receipts remain authoritative.
      let exists = false,
        legacySlots = 0;
      try {
        assertDirectory(dir);
        exists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const turnKeys = conversationIds.map((conversationId) =>
        hash([
          "turn",
          owner,
          conversationId,
          input.operation === "retry"
            ? input.humanId
            : input.humanId.toLowerCase(),
          input.assistantId.toLowerCase(),
        ]),
      );
      const requestKey = input.requestId
        ? hash(["request", owner, input.requestId.toLowerCase()])
        : undefined;
      let legacyTurn: string | undefined,
        legacyRequest: string | undefined,
        legacyCanonical: string | undefined;
      if (exists) {
        const entries = fs.opendirSync(dir);
        let count = 0;
        try {
          for (
            let entry = entries.readSync();
            entry;
            entry = entries.readSync()
          ) {
            if (++count > restCompletionReceiptCapacity * 3 + 128)
              unavailable();
            if (/^capacity-slot-(0|[1-9][0-9]*)$/.test(entry.name))
              legacySlots++;
          }
        } finally {
          entries.closeSync();
        }
        if (legacySlots > restCompletionReceiptCapacity) unavailable();
        for (const key of [...turnKeys, ...(requestKey ? [requestKey] : [])]) {
          try {
            const prior = read(path.join(dir, key + ".json"));
            if (prior.key !== key || prior.payloadHash !== input.payloadHash)
              conflict();
            if (key === requestKey) {
              if (legacyRequest && legacyRequest !== prior.operationId)
                conflict();
              legacyRequest = prior.operationId;
            } else {
              if (legacyTurn && legacyTurn !== prior.operationId) conflict();
              legacyTurn = prior.operationId;
              if (key === turnKeys[0]) legacyCanonical = prior.operationId;
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        if (
          legacyCanonical &&
          (!requestKey || legacyRequest === legacyCanonical)
        ) {
          if (!current())
            throw new RestCompletionReceiptError(
              409,
              "The account changed. Reopen the conversation.",
            );
          return { fresh: false, operationId: legacyCanonical };
        }
        // A missing or damaged legacy quota marker must never authorize new work.
        verifyQuotaMarker(dir);
      }
      if (!current())
        throw new RestCompletionReceiptError(
          409,
          "The account changed. Reopen the conversation.",
        );
      const result = reserveWindowsReceipt({
        scope: hash(["windows-rest-v1", owner]),
        payload: input.payloadHash,
        candidate: randomUUID(),
        turnKeys,
        ...(requestKey ? { requestKey } : {}),
        ...(legacyTurn ? { legacyTurn } : {}),
        ...(legacyRequest ? { legacyRequest } : {}),
        legacySlots,
        capacity: restCompletionReceiptCapacity,
      });
      if (!current())
        throw new RestCompletionReceiptError(
          409,
          "The account changed. Reopen the conversation.",
        );
      if (result.status === "conflict") conflict();
      if (result.status === "capacity") quotaUnavailable();
      if (!result.operationId) unavailable();
      return {
        fresh: result.status === "fresh",
        operationId: result.operationId,
      };
    }
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
          "official-rest-completion-receipts-" + hash(owner).slice(0, 24),
        );
        assertDirectory(dir);
        return reserveInDirectory(dir);
      } catch (inner) {
        if (inner instanceof RestCompletionReceiptError) throw inner;
        unavailable();
      }
    }
    if (error instanceof RestCompletionReceiptError) throw error;
    unavailable();
  }
  function reserveInDirectory(dir: string): {
    fresh: boolean;
    operationId: string;
  } {
    const turnKey = (conversationId: string) =>
      hash([
        "turn",
        owner,
        conversationId,
        input.operation === "retry"
          ? input.humanId
          : input.humanId.toLowerCase(),
        input.assistantId.toLowerCase(),
      ]);
    const key = turnKey(conversationIds[0]);
    // Recognize legacy URL-ID receipts as the same once-only operation. Missing
    // request IDs must not turn an already dispatched turn into a fresh send.
    let legacy: Tombstone | undefined, canonicalReceipt: Tombstone | undefined;
    for (const conversationId of conversationIds) {
      const candidateKey = turnKey(conversationId);
      try {
        const prior = read(path.join(dir, candidateKey + ".json"));
        if (
          prior.key !== candidateKey ||
          prior.payloadHash !== input.payloadHash ||
          (legacy && legacy.operationId !== prior.operationId)
        )
          conflict();
        legacy = prior;
        if (candidateKey === key) canonicalReceipt = prior;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const candidate: Tombstone = {
      version: 1,
      key,
      payloadHash: input.payloadHash,
      operationId: legacy?.operationId ?? randomUUID(),
    };
    // Persist the real-ID binding before acknowledging a legacy outcome.
    // Display aliases are capped and may disappear on restart; replay protection
    // must survive independently. Reuse the original operation and never grant
    // dispatch permission merely because this canonical binding is new.
    const pair = canonicalReceipt
      ? { fresh: false, value: canonicalReceipt }
      : reserve(key, candidate);
    if (legacy && pair.value.operationId !== legacy.operationId) conflict();
    // Bind completion_request_id independently. It may change across reconnects,
    // but a reused id must never authorize a different turn/conversation.
    if (input.requestId) {
      const aliasKey = hash(["request", owner, input.requestId.toLowerCase()]);
      const alias = reserve(aliasKey, { ...pair.value, key: aliasKey });
      if (alias.value.operationId !== pair.value.operationId) conflict();
    }
    if (!current())
      throw new RestCompletionReceiptError(
        409,
        "The account changed. Reopen the conversation.",
      );
    return {
      fresh: !legacy && pair.fresh,
      operationId: pair.value.operationId,
    };
    function reserve(
      key: string,
      value: Tombstone,
    ): { fresh: boolean; value: Tombstone } {
      if (!current())
        throw new RestCompletionReceiptError(
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
      if (process.platform === "win32") unavailable();
      // EEXIST does not establish that another creator durably published this
      // directory. Flush its parent before every new reservation can dispatch.
      assertDirectory(root!);
      syncDir(root!);
      allocateSlot(dir, key);
      if (!current())
        throw new RestCompletionReceiptError(
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
