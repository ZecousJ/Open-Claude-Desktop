import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AppContext } from "../app/app-context";
import type { EnvironmentRef } from "../../shared/types";
import type { SshHost } from "../../shared/ssh-api";
import type { EditorSshTarget } from "./editors";
import {
  checkHostPath,
  rpcRunner,
  type RemoteRunner,
} from "../ssh/remote-workspace";

const statFile = [
  `root=$(cd -- "$1" && pwd -P) || exit 1`,
  `dir=$(cd -- "$(dirname -- "$2")" && pwd -P) || exit 1`,
  'file=${dir%/}/$(basename -- "$2")',
  `[ ! -L "$file" ] || exit 1`,
  `case "$(uname -s)" in`,
  `  Darwin|*BSD) stat=$(stat -f '%d %i %l %p' "$file") || exit 1 ; mode=octal ;;`,
  `  *) stat=$(stat -c '%d %i %h %f' "$file") || exit 1 ; mode=hex ;;`,
  `esac`,
  `printf '%s\\0%s\\0%s\\0%s' "$root" "$dir" "$stat" "$mode"`,
].join("\n");

export async function identifySshEditorFile(
  run: RemoteRunner,
  root: string,
  file: string,
) {
  const relative = posix.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith("../"))
    throw Error("Choose a file inside a session folder.");
  const result = await run({
    argv: [
      "/bin/sh",
      "-c",
      statFile,
      "sh",
      checkHostPath(root),
      checkHostPath(file),
    ],
    timeoutMs: 10_000,
    maxOutput: 24_576,
  });
  if (result.code !== 0)
    throw Error("The SSH file identity could not be checked.");
  const fields = result.stdout.split("\0");
  if (fields.length !== 4) throw Error("Invalid SSH file metadata.");
  const [realRoot, realDir, stat, radix] = fields;
  checkHostPath(realRoot);
  checkHostPath(realDir);
  if (realDir !== posix.dirname(posix.join(realRoot, relative)))
    throw Error("Symbolic links cannot be opened.");
  const identity = /^(\d+) (\d+) 1 ([0-9a-f]+)$/.exec(stat);
  const mode =
    identity &&
    (radix === "octal" && /^[0-7]+$/.test(identity[3])
      ? parseInt(identity[3], 8)
      : radix === "hex"
        ? parseInt(identity[3], 16)
        : 0);
  if (!identity || !mode || (mode & 0o170000) !== 0o100000)
    throw Error("The target must be a file with one hard link.");
  return {
    root: realRoot,
    real: posix.join(realDir, posix.basename(file)),
    dev: identity[1],
    ino: identity[2],
  };
}

type SshEnvironment = Extract<EnvironmentRef, { kind: "ssh" }>;
export type EditorSshWorkspace = {
  target: EditorSshTarget;
  current(): boolean;
  identify(
    root: string,
    file: string,
  ): Promise<{ real: string; dev: string; ino: string }>;
};

function hostConfig({ lastUsedAt: _seen, ...config }: SshHost) {
  return config;
}

export function sshEditorWorkspace(
  ctx: Pick<AppContext, "store"> &
    Partial<Pick<AppContext, "engines">> & {
      services?: Pick<AppContext["services"], "ssh">;
    },
  session: { id: string; cwd: string },
  environment: SshEnvironment,
): (EditorSshWorkspace & { verifyTrust(): Promise<string> }) | undefined {
  const service = ctx.services?.ssh;
  if (!service?.allowed()) return;
  const host = service.hosts.get(environment.hostId);
  const engines = ctx.engines;
  const engine = engines?.running(session.id);
  const rpc = engine?.rpc;
  if (
    !host ||
    !engines ||
    !engine ||
    engine.store !== ctx.store ||
    engine.environment.kind !== "ssh" ||
    engine.environment.hostId !== host.id ||
    !rpc?.connected
  )
    return;
  const config = hostConfig(host);
  const run = rpcRunner(rpc);
  let trusted: { root: string; folder: string } | undefined;
  const current = () => {
    if (
      ctx.services?.ssh !== service ||
      !service.allowed() ||
      engines.running(session.id) !== engine ||
      engine.rpc !== rpc ||
      !rpc.connected
    )
      return false;
    const latest = service.hosts.get(host.id);
    return (
      !!latest &&
      isDeepStrictEqual(hostConfig(latest), config) &&
      (!trusted || !!engine.sshTrust?.roots(host.id).includes(trusted.root))
    );
  };
  const verifyTrust = async () => {
    if (!current()) throw Error("The SSH connection changed.");
    const {
      trusted: allowed,
      root: trustRoot,
      folder,
    } = await engine.remoteWorkspaceTrust(session.cwd, false);
    const anchor = { root: trustRoot, folder };
    if (
      !allowed ||
      !current() ||
      (trusted && !isDeepStrictEqual(trusted, anchor))
    )
      throw Error("The SSH workspace is not trusted.");
    trusted = anchor;
    return folder;
  };
  return {
    target: { destination: host.destination, port: host.port },
    current,
    verifyTrust,
    async identify(root, file) {
      const folder = await verifyTrust();
      const identity = await identifySshEditorFile(run, root, file);
      if (root === session.cwd && identity.root !== folder)
        throw Error("The SSH workspace changed.");
      return identity;
    },
  };
}
