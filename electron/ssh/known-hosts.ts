/**
 * "Remove the old key and try again". The host's real name and port come from
 * `ssh -G` (an alias of ~/.ssh/config resolves there, and so does a
 * HostKeyAlias), its known_hosts files too; each entry is removed with the
 * ssh-keygen next to the ssh Claudex uses. Nothing is trusted here: the next
 * connection asks about the new key as for any host seen the first time.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { effectiveConfig } from "./ssh-config";

/** Bind grants to the resolved endpoint and its trusted keys, never just a saved alias. */
export async function sshToolBinding(
  sshPath: string,
  host: { destination: string; port?: number },
) {
  const config = await effectiveConfig(sshPath, host.destination, host.port);
  if (!config?.hostname || !config.user) return;
  const name = knownHostsName(
    config.hostKeyAlias ?? config.hostname,
    config.port ?? 22,
  );
  const files = config.userKnownHostsFiles ?? [
    "~/.ssh/known_hosts",
    "~/.ssh/known_hosts2",
  ];
  const keys = new Set<string>();
  for (const file of [
    ...files,
    "/etc/ssh/ssh_known_hosts",
    "/etc/ssh/ssh_known_hosts2",
  ]) {
    if (file === "none" || file === "/dev/null") continue;
    const result = await run(keygenFor(sshPath), [
      "-F",
      name,
      "-f",
      expand(file),
    ]);
    if (result.code !== 0) continue;
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("#") || line.startsWith("@revoked")) continue;
      const fields = line.trim().split(/\s+/);
      const offset = fields[0]?.startsWith("@") ? 1 : 0;
      if (fields.length >= offset + 3)
        keys.add(fields.slice(offset + 1, offset + 3).join(" "));
    }
  }
  if (!keys.size) return;
  return {
    endpointKey: JSON.stringify([
      `${config.user}@${config.hostname}`,
      config.port ?? 22,
    ]),
    hostKey: createHash("sha256")
      .update([...keys].sort().join("\n"))
      .digest("hex"),
  };
}

const run = (file: string, args: string[]) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(
      file,
      args,
      { timeout: 15_000, windowsHide: true, maxBuffer: 1 << 20 },
      (error, stdout) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout: String(stdout),
        }),
    );
  });

/** The ssh-keygen beside an ssh program ("ssh" → "ssh-keygen"). */
export function keygenFor(sshPath: string) {
  const dir = path.dirname(sshPath);
  const name = process.platform === "win32" ? "ssh-keygen.exe" : "ssh-keygen";
  const beside = path.join(dir, name);
  return dir !== "." && fs.existsSync(beside) ? beside : name;
}

/** known_hosts writes a host on a port other than 22 as "[host]:port". */
export function knownHostsName(host: string, port: number) {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** What `ssh -G` says about a destination: the name, port and files to clean. */
export function parseSshG(output: string) {
  let host = "";
  let alias = "";
  let port = 22;
  const files: string[] = [];
  for (const line of output.split("\n")) {
    const [key, ...rest] = line.trim().split(/\s+/);
    const value = rest.join(" ");
    if (key === "hostname") host = value;
    else if (key === "hostkeyalias") alias = value;
    else if (key === "port") port = Number(value) || 22;
    else if (key === "userknownhostsfile") files.push(...rest);
  }
  return { host: alias || host, port, files };
}

const expand = (file: string) =>
  file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;

export async function forgetHostKey(options: {
  sshPath: string;
  destination: string;
  port?: number;
}): Promise<{ removed: boolean }> {
  const target = options.destination.includes("@")
    ? options.destination.slice(options.destination.lastIndexOf("@") + 1)
    : options.destination;
  const resolved = await run(options.sshPath, [
    "-G",
    ...(options.port ? ["-p", String(options.port)] : []),
    "--",
    target,
  ]);
  const seen = parseSshG(resolved.stdout);
  const host = seen.host || target;
  const port = seen.port || options.port || 22;
  const files = (seen.files.length ? seen.files : ["~/.ssh/known_hosts"])
    .map(expand)
    .filter((file) => fs.existsSync(file));
  const keygen = keygenFor(options.sshPath);
  let removed = false;
  for (const file of files)
    for (const name of new Set([knownHostsName(host, port), host])) {
      // A bare name is only its own entry on port 22.
      if (name === host && port !== 22) continue;
      const result = await run(keygen, ["-R", name, "-f", file]);
      // ssh-keygen keeps the previous file as <file>.old, as it always does.
      if (result.code === 0 && /updated/i.test(result.stdout)) removed = true;
    }
  return { removed };
}
