/**
 * Starts the helper that installs the staged update once this process has
 * exited. The staged file is verified again first; nothing unverified is ever
 * installed. No Electron imports.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { macAppBundle } from "../../shared/app-update";
import { fileSha256 } from "./download";
import {
  applyResultFile,
  stagedRecordFile,
  writeStaged,
  type StagedUpdate,
} from "./staging";
import {
  linuxApplyCommand,
  linuxApplyScript,
  macApplyCommand,
  macApplyScript,
  windowsApplyCommand,
  windowsApplyScript,
  windowsAppPackScript,
  windowsTaskLaunchCommand,
} from "./scripts";

export interface InstallOptions {
  /** The updates folder the staged file is in. */
  dir: string;
  staged: StagedUpdate;
  /** Open the new version once installed. */
  relaunch: boolean;
  background?: boolean;
  /** This process, which the helper waits for. */
  pid: number;
  /** process.execPath of the running app. */
  execPath: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
}

/** Where the staged update goes: the running .app bundle, or the install folder. */
export function installTarget(
  execPath: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform === "darwin") {
    const bundle = macAppBundle(execPath);
    if (!bundle) throw new Error("Claudex isn't running from an app bundle.");
    return bundle;
  }
  if (platform === "linux") return path.posix.dirname(execPath);
  return path.win32.dirname(execPath);
}

/**
 * Checks the staged file, counts the attempt and starts the detached helper.
 * Throws (and starts nothing) when the file changed or the app's folder
 * can't be written; the attempt is counted in the second case.
 */
export async function startInstall(options: InstallOptions) {
  const { dir, staged } = options;
  const platform = options.platform ?? process.platform;
  if ((await fileSha256(staged.file)) !== staged.sha256)
    throw new Error(
      "The downloaded update changed on disk; it won't be installed.",
    );
  const target = installTarget(options.execPath, platform);
  // The attempt counts before the folder is checked: an install that cannot
  // even start still shows "Relaunch to retry update" at the next start.
  writeStaged(dir, { ...staged, attempts: staged.attempts + 1 });
  if (platform === "darwin")
    fs.accessSync(path.dirname(target), fs.constants.W_OK);
  fs.rmSync(applyResultFile(dir), { force: true });
  const args = {
    pid: options.pid,
    file: staged.file,
    target,
    relaunch: options.relaunch,
    background: options.background,
    resultFile: applyResultFile(dir),
    version: staged.version,
    stagedRecord: stagedRecordFile(dir),
    exeName: path.win32.basename(options.execPath),
  };
  let command: { command: string; args: string[] };
  if (staged.kind === "mac-zip") {
    const script = path.join(dir, "install-update.sh");
    fs.writeFileSync(script, macApplyScript, { mode: 0o700 });
    command = macApplyCommand(script, args);
  } else if (staged.kind.startsWith("linux-")) {
    const script = path.join(dir, "install-update.sh");
    fs.writeFileSync(script, linuxApplyScript, { mode: 0o700 });
    command = linuxApplyCommand(script, {
      ...args,
      kind: staged.kind,
      exePath: options.execPath,
    });
  } else {
    const script = path.join(dir, "install-update.ps1");
    fs.writeFileSync(
      script,
      staged.kind === "win-app" ? windowsAppPackScript : windowsApplyScript,
    );
    command = windowsApplyCommand(
      script,
      args,
      (options.env ?? process.env).SystemRoot,
    );
  }
  const stderr = fs.openSync(
    path.join(dir, "install-update.stderr.log"),
    "a",
    0o600,
  );
  // Windows: through a scheduled task, so the helper outlives Claudex's job
  // (scripts.ts windowsTaskLaunchCommand); started directly only when the
  // Task Scheduler can't take it.
  if (staged.kind === "win-nsis" || staged.kind === "win-app") {
    const launch = windowsTaskLaunchCommand(
      command,
      `Claudex Update ${options.pid}`,
      (options.env ?? process.env).SystemRoot,
    );
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = (options.spawnImpl ?? spawn)(
          launch.command,
          launch.args,
          { stdio: ["ignore", "ignore", stderr], windowsHide: true },
        );
        child.once("error", reject);
        child.once("exit", resolve);
      });
      if (code === 0) {
        fs.closeSync(stderr);
        return;
      }
    } catch {
      // Started directly below.
    }
  }
  try {
    const child = (options.spawnImpl ?? spawn)(command.command, command.args, {
      detached: true,
      stdio: ["ignore", "ignore", stderr],
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    fs.closeSync(stderr);
  }
}
