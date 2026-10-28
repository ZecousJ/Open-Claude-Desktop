/**
 * Which ssh program Claudex runs (R9). SSH connections always use the
 * computer's own OpenSSH, so the person's keys, agent (including 1Password
 * and similar agents) and ~/.ssh/config work as they do in a terminal.
 *
 * - An unset client path uses the first absolute PATH entry, matching the
 *   desktop client's system-OpenSSH setting. Windows falls back to its
 *   in-box client when PATH has no usable ssh.exe.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface SshBinaryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Is this an executable file? (tests replace it) */
  isFile?: (file: string) => boolean;
}

function executableFile(file: string) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The ssh program to use, or undefined when OpenSSH is not installed. */
export function findSsh(options: SshBinaryOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? executableFile;
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const candidates: string[] = [];
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of pathValue.split(platform === "win32" ? ";" : ":")) {
    // Only absolute PATH entries: a relative one would depend on the cwd.
    const absolute =
      platform === "win32" ? path.win32.isAbsolute(dir) : dir.startsWith("/");
    if (dir && absolute)
      candidates.push(join(dir, platform === "win32" ? "ssh.exe" : "ssh"));
  }
  if (platform === "win32") {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    candidates.push(join(root, "System32", "OpenSSH", "ssh.exe"));
  }
  return candidates.find((candidate) => isFile(candidate));
}

/**
 * A custom ssh program a host names under Advanced: an absolute path to an
 * existing file called ssh (ssh.exe on Windows). Anything else is refused,
 * so the setting cannot be used to start some other program.
 */
export function checkCustomSsh(
  file: unknown,
  options: SshBinaryOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? executableFile;
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (typeof file !== "string" || !file || file.length > 1024)
    throw new Error("Choose the ssh program.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(file) || !paths.isAbsolute(file))
    throw new Error("Enter the full path to the ssh program.");
  const name = paths.basename(file).toLowerCase();
  if (name !== (platform === "win32" ? "ssh.exe" : "ssh"))
    throw new Error(
      platform === "win32"
        ? "The SSH program must be an ssh.exe."
        : "The SSH program must be named ssh.",
    );
  if (!isFile(file)) throw new Error("That ssh program doesn't exist.");
  return file;
}

/** "OpenSSH_9.6p1" from `ssh -V`'s "OpenSSH_9.6p1, LibreSSL 3.3.6". */
export function parseSshVersion(output: string): string | undefined {
  const match = /(OpenSSH[_\w.-]*?\d[\w.]*)/.exec(output);
  return match?.[1];
}

/** The major and minor number of an "OpenSSH_9.6p1" version. */
export function sshVersionNumber(
  version: string | undefined,
): [number, number] | undefined {
  const match = /OpenSSH[_\w-]*?(\d+)\.(\d+)/.exec(version ?? "");
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/**
 * SSH_ASKPASS_REQUIRE=force (OpenSSH 8.4 and later) makes ssh ask Claudex
 * even when it could read a terminal. Unknown versions are assumed to have
 * it; older ones also need DISPLAY set and no terminal (see connection.ts).
 */
export function supportedSshVersion(
  version: string | undefined,
  platform: NodeJS.Platform = process.platform,
) {
  const number = sshVersionNumber(version);
  if (!number) return false;
  const [major, minor] = platform === "win32" ? [9, 4] : [7, 6];
  return number[0] > major || (number[0] === major && number[1] >= minor);
}

export function supportsAskpassRequire(version: string | undefined) {
  const number = sshVersionNumber(version);
  if (!number) return true;
  return number[0] > 8 || (number[0] === 8 && number[1] >= 4);
}

/** ssh's version (`ssh -V` writes it to stderr); undefined when it fails. */
export function readSshVersion(sshPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      sshPath,
      ["-V"],
      { timeout: 5_000, windowsHide: true },
      (_error, stdout, stderr) =>
        resolve(parseSshVersion(`${stderr}\n${stdout}`)),
    );
  });
}

/** Win32-OpenSSH has no connection sharing (ControlMaster). */
export function supportsControlMaster(platform: NodeJS.Platform) {
  return platform !== "win32";
}
