import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** gVisor's flock is sandbox-local. One host launcher may refresh the cache;
 * concurrent sandboxes cannot open its sync lock for writing. The rest of
 * .tmp stays writable (Codex also keeps executable helpers there).
 * The lease is outside user-writable mounts, and a crashed owner's PID expires.
 */
export function pluginCacheLease(stateRoot: string, cache: string) {
  const key = createHash("sha256").update(cache).digest("hex");
  const lock = path.join(stateRoot, `plugin-cache-${key}.lock`);
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = fs.openSync(lock, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, String(process.pid));
      } finally {
        fs.closeSync(descriptor);
      }
      return {
        writable: true,
        release: () => fs.rmSync(lock, { force: true }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid: number;
      try {
        pid = Number(fs.readFileSync(lock, "utf8"));
      } catch {
        continue;
      }
      const reap = `${lock}.reap`;
      let reaper: number;
      try {
        reaper = fs.openSync(reap, "wx", 0o600);
      } catch {
        break;
      }
      try {
        let owner: string;
        try {
          owner = fs.readFileSync(lock, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (Number(owner) !== pid) continue;
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          if (
            Date.now() -
              (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ??
                Date.now()) <
            60_000
          )
            break;
        } else {
          try {
            process.kill(pid, 0);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") break;
          }
        }
        fs.rmSync(lock, { force: true });
      } finally {
        fs.closeSync(reaper);
        fs.rmSync(reap, { force: true });
      }
    }
  }
  return { writable: false, release() {} };
}
