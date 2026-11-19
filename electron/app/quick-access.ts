import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { release } from "node:os";
import electron from "electron";
import { acceleratorLabel } from "../../shared/accelerator";

/** Native dictation capability (desktop 2.37337.1, index.chunk-BWk6pVUt, kW). */
export function quickEntryDictationSupported() {
  return (
    process.platform === "darwin" &&
    Number(release().split(".")[0]) >= 23 &&
    typeof electron.systemPreferences?.getMediaAccessStatus === "function" &&
    electron.systemPreferences.getMediaAccessStatus("microphone") !==
      "restricted"
  );
}

export async function allowQuickEntryDictationShortcut(
  next: string | undefined,
  hotkey?: { openSettings(): void },
) {
  if (!next || next === "off") return true;
  if (!quickEntryDictationSupported()) return false;
  const { systemPreferences, dialog, shell } = electron;
  switch (systemPreferences.getMediaAccessStatus("microphone")) {
    case "not-determined":
      return systemPreferences.askForMediaAccess("microphone");
    case "denied": {
      const key = next === "capslock" || next === "double-tap-capslock"
        ? "Caps Lock"
        : acceleratorLabel(next, "darwin");
      const detail = "You'll need to grant Claudex access to your microphone in System Settings.";
      await dialog.showMessageBox({
        message: hotkey
          ? `You've used ${key} to speak to Claudex, but Claudex needs microphone permission.`
          : "Claudex needs microphone permission",
        detail: hotkey
          ? detail + "\n\nOr, you can turn off Claudex's dictation feature to avoid seeing this message when you press your hotkey."
          : detail,
        buttons: hotkey
          ? ["Open System Settings", "Open Claudex Settings", "Cancel"]
          : ["Open System Settings", "Cancel"],
        defaultId: 0,
        cancelId: hotkey ? 2 : 1,
      }).then(async ({ response }) => {
        if (response === 0)
          await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
        else if (response === 1) hotkey?.openSettings();
      });
      return false;
    }
    case "granted":
      return true;
    default:
      return false;
  }
}

/** Emits only the shortcut, never keys or text (desktop bundle 2.37337.1, optionDoubleTapped). */
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
