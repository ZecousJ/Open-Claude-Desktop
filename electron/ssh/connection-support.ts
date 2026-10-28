import { classifySshLocalFailure } from "../../shared/ssh-failures";
import { classifySshDiagnostic } from "../../shared/ssh-diagnostics";
import { type ChildProcess } from "node:child_process";
import type { ExecResult, ExecOptions } from "./connection";
import { stripVTControlCharacters } from "node:util";
import { sshLocalFailureMessage } from "../../shared/ssh-failures";
import { sshDiagnosticMessage } from "../../shared/ssh-diagnostics";
import type { SshErrorCode } from "../../shared/ssh-api";
import { effectiveConfig } from "./ssh-config";

import type { SshHost } from "../../shared/ssh-api";
import { createHash } from "node:crypto";
import path from "node:path";

/** Where a host's master connection listens (a short hash of the host id). */
export function controlPath(runtimeDir: string, hostId: string) {
  const name = createHash("sha256").update(hostId).digest("hex").slice(0, 16);
  return path.join(runtimeDir, "cm", name);
}

/** The options every ssh process of a host gets (before "--"). */
export function baseSshArgs(
  host: Pick<SshHost, "port" | "identityFile" | "forwardAgent">,
): string[] {
  return [
    "-T",
    "-e",
    "none",
    "-o",
    "BatchMode=no",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    "-o",
    "StrictHostKeyChecking=ask",
    "-o",
    "LogLevel=ERROR",
    "-o",
    `ForwardAgent=${host.forwardAgent ? "yes" : "no"}`,
    "-o",
    "ForwardX11=no",
    "-o",
    "PermitLocalCommand=no",
    ...(host.port ? ["-p", String(host.port)] : []),
    ...(host.identityFile ? ["-i", host.identityFile] : []),
  ];
}

export async function classifyConfiguredSshError(
  stderr: string,
  program: string,
  host: Pick<SshHost, "destination" | "port">,
  interactive = true,
): Promise<SshErrorCode> {
  const code = classifySshError(stderr, interactive);
  if (code !== "auth-failed" || !/Host key verification failed/i.test(stderr))
    return code;
  const config = await effectiveConfig(program, host.destination, host.port);
  if (
    config?.userKnownHostsFiles?.length &&
    config.userKnownHostsFiles.every(
      (file) => file === "/dev/null" || file === "none",
    )
  )
    return "host-keys-not-kept";
  return code;
}

/** The message the window shows for an error code. */
export function errorMessage(
  code: SshErrorCode,
  label: string,
  detail?: string,
): string {
  const diagnostic = sshDiagnosticMessage(code);
  if (diagnostic) return diagnostic.replaceAll("{host}", label);
  switch (code) {
    case "local_ssh_helper_blocked":
    case "local_ssh_login_refused":
      return sshLocalFailureMessage(code)!;
    case "ssh-missing":
      return "OpenSSH isn't installed on this computer.";
    case "auth-failed":
      return `Couldn't sign in to ${label}. Check your SSH key, ssh-agent or password.`;
    case "host-key-changed":
      return `The host key for ${label} has changed. If you trust the change, remove the old key from your known_hosts file and try again.`;
    case "host-unreachable":
      return `Can't reach ${label}.`;
    case "timeout":
      return `Connecting to ${label} timed out.`;
    case "unsupported-platform":
      return `Claudex can't run on ${detail ?? "this system"} yet.`;
    case "install-failed":
      return `Couldn't set up Claudex on ${label}.`;
    case "forward-failed":
      return `Couldn't open the connection Claudex needs on ${label}.`;
    case "engine-exited":
      return `Claudex stopped running on ${label}.`;
    case "policy-disabled":
      return "SSH connections are disabled by your organization's managed settings.";
    case "host-not-allowed":
      return `SSH host "${label}" is not allowed by your organization's managed settings.`;
  }
  return `Can't reach ${label}.`;
}

export function sshTechnicalDetails(stderr: string) {
  return stripVTControlCharacters(stderr)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, 8192)
    .trim();
}

/** Waits for an ssh process, keeping its output (4 MB, 8 KB of errors). */
export function collectOutput(
  child: ChildProcess,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const maxOutput = options.maxOutput ?? 4 * 1024 * 1024;
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, options.timeoutMs ?? 30_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutput) {
        child.kill();
        return finish(null);
      }
      stdout.push(chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input);
    child.once("error", () => {
      stderr ||= "ssh: not found";
      finish(null);
    });
    child.once("close", (code) => finish(code));
  });
}

export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Maps ssh's error output to a code (the text itself is not shown). */
export function classifySshError(
  stderr: string,
  interactive = true,
): SshErrorCode {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr))
    return "host-key-changed";
  const local = classifySshLocalFailure({
    stderr,
    interactive,
  });
  if (local) return local;
  const diagnostic = classifySshDiagnostic(stderr);
  if (diagnostic) return diagnostic;
  if (
    /Permission denied|Too many authentication failures|Authentication failed|Host key verification failed|No more authentication methods/i.test(
      stderr,
    )
  )
    return "auth-failed";
  if (/timed out/i.test(stderr)) return "timeout";
  if (
    /ssh: (?:command )?not found|No such file or directory.*ssh/i.test(stderr)
  )
    return "ssh-missing";
  return "host-unreachable";
}
