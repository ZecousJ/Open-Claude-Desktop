/**
 * Each web user's data (`<state dir>/users/<id>/profile`) as a disk-quota
 * volume (sandbox/quota.ts): mounted before the user's context writes
 * anything, grown when the limit goes up, and, the first time, filled with
 * the data the user already had.
 */
import fs from "node:fs";
import path from "node:path";
import type { DiskQuota, QuotaStatus } from "./sandbox/quota";

/** One preparation at a time per folder (two tabs of one user). */
const pending = new Map<string, Promise<QuotaStatus>>();

/**
 * Makes `dir` a volume of at most `mb` MiB. A folder that already holds data
 * and has no volume yet is moved aside, the empty volume mounted in its place
 * and the data moved in (a rename when possible, else a copy); a failure
 * puts the folder back as it was.
 */
export function prepareUserVolume(
  quota: DiskQuota,
  dir: string,
  mb: number,
): Promise<QuotaStatus> {
  const running = pending.get(dir);
  if (running) return running;
  const work = Promise.resolve().then(() => prepareNow(quota, dir, mb));
  pending.set(dir, work);
  return work.finally(() => pending.delete(dir));
}

function hasData(dir: string) {
  try {
    return fs.readdirSync(dir).some((name) => name !== "lost+found");
  } catch {
    return false;
  }
}

function prepareNow(quota: DiskQuota, dir: string, mb: number): QuotaStatus {
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  // A mounted volume or a folder with no data yet: prepare in place.
  const status = tryPrepare(quota, dir, mb);
  if (status) return status;
  if (!hasData(dir)) return quota.prepare(dir, mb);
  const aside = `${dir}.moving-${process.pid}`;
  fs.renameSync(dir, aside);
  fs.mkdirSync(dir, { mode: 0o700 });
  try {
    const ready = quota.prepare(dir, mb);
    for (const name of fs.readdirSync(aside))
      fs.cpSync(path.join(aside, name), path.join(dir, name), {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    fs.rmSync(aside, { recursive: true, force: true });
    return quota.status(dir, mb) ?? ready;
  } catch (error) {
    // Put the data back where it was; the volume (if any) stays unmounted.
    try {
      quota.release(dir);
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(aside, dir);
    throw error;
  }
}

/** quota.prepare, or undefined when the folder holds data without a volume. */
function tryPrepare(
  quota: DiskQuota,
  dir: string,
  mb: number,
): QuotaStatus | undefined {
  try {
    return quota.prepare(dir, mb);
  } catch (error) {
    if (/is not empty/.test((error as Error).message)) return undefined;
    throw error;
  }
}
