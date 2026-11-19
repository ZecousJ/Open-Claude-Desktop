/** Account-owned upload receipts. No content, filename paths or credentials are
 * stored here. Trusted host state root; no receipt deletion/replay recovery. */
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AdapterContext } from "./context";
export class ProjectUploadReceiptError extends Error {
  constructor(
    readonly status: 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
type Context = Pick<
  AdapterContext,
  "account" | "stateDirectory" | "sessionIdentity" | "isCurrent"
>;
export const projectUploadReceiptCapacity = 4096;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const unavailable = (): never => {
  throw new ProjectUploadReceiptError(
    503,
    "Project upload receipts are unavailable. No retry was dispatched.",
  );
};
const conflict = (): never => {
  throw new ProjectUploadReceiptError(
    409,
    "This upload ID belongs to different content or project. Choose a new upload ID.",
  );
};
async function sync(dir: string, current: () => void) {
  current();
  // Windows flushes the receipt file above; Node cannot fsync directory handles.
  if (process.platform === "win32") return;
  const fd = await fs.promises.open(
    dir,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    current();
    await fd.sync();
    current();
  } finally {
    await fd.close();
  }
  current();
}
async function read(
  file: string,
  current: () => void,
): Promise<any | undefined> {
  current();
  let fd: FileHandle;
  try {
    fd = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    current();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return unavailable();
  }
  try {
    current();
    const before = await fd.stat();
    current();
    if (!before.isFile() || before.size > 4096) return unavailable();
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await fd.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      current();
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await fd.stat();
    current();
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      return unavailable();
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } catch (error) {
    if (error instanceof ProjectUploadReceiptError) throw error;
    return unavailable();
  } finally {
    await fd.close();
  }
}
async function write(file: string, value: unknown, current: () => void) {
  current();
  const fd = await fs.promises.open(
    file,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    current();
    await fd.writeFile(JSON.stringify(value));
    current();
    await fd.sync();
    current();
  } finally {
    await fd.close();
  }
  current();
  await sync(path.dirname(file), current);
  current();
}
async function syncReceiptFile(file: string, current: () => void) {
  current();
  const fd = await fs.promises.open(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try {
    current();
    await fd.sync();
    current();
  } finally {
    await fd.close();
  }
  current();
}
/** Enumerate current on-disk entries on every attempt, never a cached index.
 * Only fixed slot files exist in this format; unknown/oversized directories fail
 * closed. Enumeration is not assumed atomic: wx collisions force a full rescan. */
async function entries(dir: string, current: () => void) {
  current();
  const before = await fs.promises.lstat(dir);
  current();
  if (!before.isDirectory() || before.isSymbolicLink()) return unavailable();
  const handle = await fs.promises.opendir(dir);
  const names = new Set<string>();
  try {
    current();
    for (;;) {
      const entry = await handle.read();
      current();
      if (!entry) break;
      const match = /^slot-(0|[1-9][0-9]*)(?:\.done)?\.json$/.exec(entry.name);
      if (
        !match ||
        Number(match[1]) >= projectUploadReceiptCapacity ||
        !entry.isFile() ||
        names.has(entry.name) ||
        names.size >= projectUploadReceiptCapacity * 2
      )
        return unavailable();
      names.add(entry.name);
    }
  } finally {
    await handle.close();
  }
  current();
  return { names, before };
}
/** Open-addressed slots are fixed capacity and never removed. Collision probing
 * preserves concurrency: a raced slot is reread before considering the next.
 * A reserved/uncertain result never authorizes a fresh mutation after restart. */
async function reserveProjectUploadOnce(
  ctx: Context,
  clientId: string,
  payloadHash: string,
  reuseFirstUpload: boolean,
) {
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.(),
    root = ctx.stateDirectory?.();
  const current = () => {
    if (
      !owner ||
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== activation ||
      ctx.isCurrent?.() === false
    )
      throw new ProjectUploadReceiptError(
        409,
        "The account changed. Upload outcome is not confirmed.",
      );
  };
  current();
  if (activation === undefined || activation === null) return unavailable();
  if (
    !root ||
    !clientId ||
    clientId.length > 128 ||
    !/^[a-f0-9]{64}$/.test(payloadHash)
  )
    return unavailable();
  try {
    const rootStat = await fs.promises.lstat(root);
    current();
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      return unavailable();
    const dir = path.join(
      root,
      "official-project-upload-receipts-v1-" + digest(owner!).slice(0, 32),
    );
    try {
      await fs.promises.mkdir(dir, { mode: 0o700 });
      current();
      await sync(root, current);
      current();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const directory = await fs.promises.lstat(dir);
    current();
    if (!directory.isDirectory() || directory.isSymbolicLink())
      return unavailable();
    // Another process may have just created this directory but not synced the
    // parent entry yet. EEXIST is not proof of durable directory publication.
    await sync(root, current);
    current();
    const key = digest(clientId),
      initial = parseInt(key.slice(0, 8), 16) % projectUploadReceiptCapacity;
    // Scan the entire bounded namespace before allocating: a lost earlier
    // collision-chain entry must not hide a later completed receipt. Never
    // assume an empty slot proves that this identity has never been used.
    for (let attempt = 0; attempt < 8; attempt++) {
      const { names, before: directoryBefore } = await entries(dir, current);
      current();
      let free: number | undefined, found: number | undefined;
      for (let probe = 0; probe < projectUploadReceiptCapacity; probe++) {
        current();
        const slot = (initial + probe) % projectUploadReceiptCapacity;
        const prior = names.has(`slot-${slot}.json`)
          ? await read(path.join(dir, `slot-${slot}.json`), current)
          : undefined;
        current();
        const saved = names.has(`slot-${slot}.done.json`)
          ? await read(path.join(dir, `slot-${slot}.done.json`), current)
          : undefined;
        current();
        if (
          (names.has(`slot-${slot}.json`) && prior === undefined) ||
          (names.has(`slot-${slot}.done.json`) && saved === undefined)
        )
          return unavailable();
        if (prior === undefined) {
          if (saved !== undefined) return unavailable();
          free ??= slot;
          continue;
        }
        if (
          !prior ||
          prior.version !== 1 ||
          Object.keys(prior).length !== 3 ||
          typeof prior.key !== "string" ||
          typeof prior.payloadHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(prior.key) ||
          !/^[a-f0-9]{64}$/.test(prior.payloadHash)
        )
          return unavailable();
        if (
          saved !== undefined &&
          (!saved ||
            saved.version !== 1 ||
            Object.keys(saved).length !== 4 ||
            saved.key !== prior.key ||
            saved.payloadHash !== prior.payloadHash ||
            saved.confirmed !== true)
        )
          return unavailable();
        if (prior.key === key) {
          if (found !== undefined) return unavailable();
          if (prior.payloadHash !== payloadHash) return conflict();
          found = slot;
        }
      }
      const directoryAfter = await fs.promises.lstat(dir);
      current();
      if (
        !directoryAfter.isDirectory() ||
        directoryAfter.isSymbolicLink() ||
        directoryAfter.dev !== directoryBefore.dev ||
        directoryAfter.ino !== directoryBefore.ino
      )
        return unavailable();
      if (
        directoryAfter.mtimeMs !== directoryBefore.mtimeMs ||
        directoryAfter.ctimeMs !== directoryBefore.ctimeMs
      )
        continue;
      const slot = found ?? free;
      if (slot === undefined) return unavailable();
      const file = path.join(dir, `slot-${slot}.json`);
      const donePath = path.join(dir, `slot-${slot}.done.json`);
      let fresh = false;
      if (found === undefined) {
        if ((await read(donePath, current)) !== undefined) return unavailable();
        try {
          current();
          await write(file, { version: 1, key, payloadHash }, current);
          current();
          fresh = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
      }
      const done = await read(donePath, current);
      current();
      if (fresh && done !== undefined) return unavailable();
      if (
        done !== undefined &&
        (!done ||
          done.version !== 1 ||
          Object.keys(done).length !== 4 ||
          done.key !== key ||
          done.payloadHash !== payloadHash ||
          done.confirmed !== true)
      )
        return unavailable();
      current();
      if (!fresh && !done && !reuseFirstUpload)
        throw new ProjectUploadReceiptError(
          409,
          "This upload may already be in progress or have completed. Its outcome is unknown; it will not be uploaded again.",
        );
      return {
        fresh,
        confirmed: done !== undefined,
        async confirm() {
          current();
          try {
            if (!fresh) await syncReceiptFile(file, current);
            if (done === undefined) {
              try {
                await write(
                  donePath,
                  { version: 1, key, payloadHash, confirmed: true },
                  current,
                );
                current();
                return;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                const confirmed = await read(donePath, current);
                if (confirmed?.version !== 1 || confirmed.key !== key ||
                    confirmed.payloadHash !== payloadHash || confirmed.confirmed !== true ||
                    Object.keys(confirmed).length !== 4) return unavailable();
              }
            }
            await syncReceiptFile(donePath, current);
            await sync(dir, current);
          } catch (error) {
            if (error instanceof ProjectUploadReceiptError) throw error;
            return unavailable();
          }
        },
      };
    }
    return unavailable();
  } catch (error) {
    if (error instanceof ProjectUploadReceiptError) throw error;
    return unavailable();
  }
}

const pendingReservations = new Set<string>();
const accountQueues = new Map<string, { tail: Promise<void>; count: number }>();
let queuedOperations = 0;
/** Serialize only receipt I/O for this host/account, never the actual upload.
 * Each item gets its own result, and a failed/deactivated predecessor releases
 * its gate in finally. No active entry is evicted to make capacity. */
async function queued<T>(
  namespace: string,
  current: () => void,
  operation: () => Promise<T>,
): Promise<T> {
  current();
  const entry = accountQueues.get(namespace) ?? {
    tail: Promise.resolve(),
    count: 0,
  };
  if (entry.count >= 16 || queuedOperations >= 128) return unavailable();
  const prior = entry.tail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  entry.tail = prior.then(() => gate);
  entry.count++;
  queuedOperations++;
  accountQueues.set(namespace, entry);
  try {
    await prior;
    current();
    const result = await operation();
    current();
    return result;
  } finally {
    release();
    entry.count--;
    queuedOperations--;
    if (!entry.count && accountQueues.get(namespace) === entry)
      accountQueues.delete(namespace);
  }
}
/** Same-process duplicates get an explicit conflict, never a shared fresh
 * capability. Explicit reuse can return a pending receipt for byte readback;
 * the caller must verify stored content before confirming, without uploading. */
export async function reserveProjectUpload(
  ctx: Context,
  clientId: string,
  payloadHash: string,
  reuseFirstUpload = false,
) {
  const owner = ctx.account()?.id,
    root = ctx.stateDirectory?.(),
    activation = ctx.sessionIdentity?.();
  const current = () => {
    if (
      ctx.account()?.id !== owner ||
      ctx.stateDirectory?.() !== root ||
      ctx.sessionIdentity?.() !== activation ||
      ctx.isCurrent?.() === false
    )
      throw new ProjectUploadReceiptError(
        409,
        "The account or upload request changed while waiting. Upload outcome is not confirmed.",
      );
  };
  const namespace = digest(JSON.stringify([root, owner]));
  const key = digest(JSON.stringify([namespace, clientId]));
  if (pendingReservations.has(key))
    throw new ProjectUploadReceiptError(
      409,
      "This upload is already being reserved. It was not uploaded again.",
    );
  if (pendingReservations.size >= 128) return unavailable();
  pendingReservations.add(key);
  try {
    const receipt = await queued(namespace, current, () =>
      reserveProjectUploadOnce(ctx, clientId, payloadHash, reuseFirstUpload),
    );
    return {
      fresh: receipt.fresh,
      confirmed: receipt.confirmed,
      confirm: () => queued(namespace, current, () => receipt.confirm()),
    };
  } finally {
    pendingReservations.delete(key);
  }
}
