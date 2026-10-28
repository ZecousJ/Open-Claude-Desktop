import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { release } from "node:os";
import electron from "electron";

/** Native dictation capability. */
export function quickEntryDictationSupported() {
  return (
    process.platform === "darwin" &&
    Number(release().split(".")[0]) >= 23 &&
    typeof electron.systemPreferences?.getMediaAccessStatus === "function" &&
    electron.systemPreferences.getMediaAccessStatus("microphone") !==
      "restricted"
  );
}

/** Emits only the shortcut, never keys or text. */
export class QuickAccessMonitor {
  private child?: ChildProcess;
  constructor(
    private toggle: () => void,
    private dictation?: (action: "start" | "stop") => void,
  ) {}
  setEnabled(enabled: boolean) {
    if (!enabled) {
      this.child?.kill();
      this.child = undefined;
      return;
    }
    if (this.child || process.platform !== "darwin") return;
    const helper = path.join(
      path
        .dirname(fileURLToPath(import.meta.url))
        .replace(/app\.asar(?=\/)/, "app.asar.unpacked"),
      "quick-access-monitor",
    );
    if (!existsSync(helper)) return;
    const child = (this.child = spawn(helper, [], {
      stdio: ["ignore", "pipe", "ignore"],
    }));
    let pending = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (this.child !== child) continue;
        if (line === "toggle") this.toggle();
        else if (line === "dictation-start") this.dictation?.("start");
        else if (line === "dictation-stop") this.dictation?.("stop");
      }
    });
    const stopped = () => {
      if (this.child === child) this.child = undefined;
    };
    child.on("error", stopped);
    child.on("exit", stopped);
  }
}
