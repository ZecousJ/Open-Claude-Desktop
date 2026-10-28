import fs from "node:fs";
import path from "node:path";

// .
export function beginUpdateSession(
  userData: string,
  pid: number,
  bootEpochMs: number,
  alive: (pid: number) => boolean,
) {
  const file = path.join(userData, "update-running-instance.json");
  let previousExitUnclean = false;
  try {
    const previous = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      typeof previous.pid === "number" &&
      typeof previous.bootEpochMs === "number"
    ) {
      if (
        Math.abs(previous.bootEpochMs - bootEpochMs) < 5000 &&
        alive(previous.pid)
      )
        return { previousExitUnclean: false, clean: () => {} };
      previousExitUnclean = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return { previousExitUnclean: false, clean: () => {} };
  }
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid, bootEpochMs }), { mode: 0o600 });
  return {
    previousExitUnclean,
    clean: () => {
      try {
        if (JSON.parse(fs.readFileSync(file, "utf8")).pid === pid)
          fs.rmSync(file, { force: true });
      } catch {
        /* A missing sentinel is already clean. */
      }
    },
  };
}
