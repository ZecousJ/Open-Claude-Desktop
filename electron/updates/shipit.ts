import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { claudexBundleId } from "./scripts";

export const shipItLabel = `${claudexBundleId}.ShipIt`;
export const shipItDirectory = (home: string) =>
  path.join(home, "Library", "Caches", shipItLabel);

// .
export function shipItStderr(home: string) {
  const dir = shipItDirectory(home);
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith("ShipIt_stderr.log"))
      .map((name) => ({
        file: path.join(dir, name),
        stat: fs.lstatSync(path.join(dir, name)),
      }))
      .filter(({ stat }) => stat.isFile() && !stat.isSymbolicLink())
      .sort((first, second) => second.stat.mtimeMs - first.stat.mtimeMs);
    const latest = files[0];
    if (!latest) return undefined;
    const fd = fs.openSync(
      latest.file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const size = Math.min(fs.fstatSync(fd).size, 16_384);
      const buffer = Buffer.alloc(size);
      fs.readSync(
        fd,
        buffer,
        0,
        size,
        Math.max(0, fs.fstatSync(fd).size - size),
      );
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

export function clearShipItStage(home: string, removeJob: () => void) {
  const dir = shipItDirectory(home);
  if (fs.existsSync(dir)) {
    const parent = fs.realpathSync(path.dirname(dir));
    if (
      fs.lstatSync(dir).isSymbolicLink() ||
      fs.realpathSync(dir) !== path.join(parent, shipItLabel)
    )
      throw new Error("Unsafe ShipIt cache path.");
  }
  removeJob();
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name !== "ShipItState.plist" && !name.startsWith("update.")) continue;
    const target = path.resolve(dir, name);
    if (path.dirname(target) !== path.resolve(dir))
      throw new Error("Unsafe ShipIt cache path.");
    fs.rmSync(target, { recursive: true, force: true });
  }
}

export function removeUserShipItJob() {
  let privileged = false;
  try {
    execFileSync("/bin/launchctl", ["print", `system/${shipItLabel}`], {
      stdio: "ignore",
      timeout: 5000,
    });
    privileged = true;
  } catch {
    /* No system-domain job. */
  }
  if (privileged) throw new Error("The ShipIt job is in the system domain.");
  try {
    execFileSync(
      "/bin/launchctl",
      ["bootout", `gui/${process.getuid!()}/${shipItLabel}`],
      { stdio: "pipe", timeout: 5000 },
    );
  } catch (error) {
    if (
      !/No such process|Could not find service/i.test(
        String((error as { stderr?: unknown }).stderr),
      )
    )
      throw error;
  }
}
