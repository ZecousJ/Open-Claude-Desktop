/**
 * Small adapter state that must survive a restart (conversation aliases, the
 * file registry, the page's message ids): one JSON file per key in the app's
 * data folder, written shortly after each change.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  currentAdapterScope,
  bindAdapterScope,
  type AdapterScope,
} from "./scope";

let dir: string | undefined;
interface PendingState {
  scope: AdapterScope;
  value: () => unknown;
  timer?: NodeJS.Timeout;
  failed: boolean;
}
// Activation scopes are independent, but their persisted destination can be the
// same account file. A new activation must observe its predecessor's pending save.
const pending = new Map<string, PendingState>();

function flushPending(file: string, job = pending.get(file)) {
  if (!job || pending.get(file) !== job) return;
  if (job.timer) clearTimeout(job.timer);
  job.timer = undefined;
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const contents = JSON.stringify(job.value());
    if (pending.get(file) !== job) return;
    fs.writeFileSync(temp, contents, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
    pending.delete(file);
  } catch {
    job.failed = true;
    // Preserve both the old file and the failed supplier; a later explicit
    // read/write retries this job rather than silently replacing unsaved state.
    throw new Error("Official UI state could not be saved.");
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
}

function stateDirectory() {
  const scope = currentAdapterScope();
  const base = scope.stateBase
    ? path.join(scope.stateBase, "official-ui")
    : dir;
  if (!base) return undefined;
  const owner = scope.owner;
  if (!owner) return base; // Legacy/unscoped callers keep their existing files.
  const account = createHash("sha256").update(owner).digest("hex");
  const folder = path.join(base, "accounts", account);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  return folder;
}

export function setStateDir(folder: string) {
  dir = path.join(folder, "official-ui");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readState<T>(key: string, fallback: T): T {
  const folder = stateDirectory();
  if (!folder) return fallback;
  const file = path.resolve(folder, `${key}.json`);
  // A known failed pending save is not equivalent to absent on-disk state.
  flushPending(file);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Read old, unscoped files without deleting or assigning them to an account. */
export function readLegacyState<T>(key: string, fallback: T): T {
  if (!dir) return fallback;
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dir, `${key}.json`), "utf8"),
    ) as T;
  } catch {
    return fallback;
  }
}

/** Atomic writes for migration; existing account-scoped data is never replaced. */
export function writeStateIfMissing(key: string, value: unknown) {
  const folder = stateDirectory();
  if (!folder) return false;
  const file = path.join(folder, `${key}.json`);
  const temp = path.join(folder, `.${key}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    // A hard link creates the destination only if no other request made it.
    fs.linkSync(temp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
}

/** Publish an ID only after its pending mapping has reached disk. */
export function flushState(key: string) {
  const folder = stateDirectory();
  if (folder) flushPending(path.resolve(folder, `${key}.json`));
}

/** Coalesce changes for half a second, retaining the original account scope. */
export function writeState(key: string, value: () => unknown) {
  const folder = stateDirectory();
  if (!folder) return;
  const file = path.resolve(folder, `${key}.json`);
  const scope = currentAdapterScope();
  const previous = pending.get(file);
  if (previous && (previous.scope !== scope || previous.failed))
    flushPending(file, previous);
  else if (previous) {
    previous.value = bindAdapterScope(value);
    return;
  }
  const job: PendingState = {
    scope,
    value: bindAdapterScope(value),
    failed: false,
  };
  pending.set(file, job);
  job.timer = setTimeout(() => {
    try {
      flushPending(file, job);
    } catch {
      console.error("Official UI state save failed; pending changes retained.");
    }
  }, 500);
}
