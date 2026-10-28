/**
 * The Codex engine on an SSH host (R9-S2): the same version Claudex runs
 * locally, installed per client under ~/.claudex-remote/<clientId>/ (or
 * <the host's "Remote folder for Claudex">/<clientId>/, so a folder like
 * "~" or "/tmp" is never chmodded or cleaned up itself):
 *
 *     bin/codex-<version>-<triple>/bin/codex   the engine (and its rg, zsh)
 *     codex-home/   attachments/   run/   tmp/
 *
 * `ensure()` checks the host and installs when needed:
 *   1. already installed (the folder's marker holds the package's sha512
 *      and the engine is executable) → nothing to do;
 *   2. otherwise this computer's copy (runtime-cache.ts, fetched ahead of
 *      time and checked against the manifest) is uploaded over the
 *      connection in chunks, resuming a partial upload, and its size and
 *      sha512 are checked again on the host. The host never downloads
 *      anything itself.
 * The host then unpacks only package/vendor/<triple>, checks the engine
 * runs and moves it into place in one rename. `run/install.lock` (an atomic
 * mkdir, taken over after 10 minutes) keeps two installs apart.
 *
 * `cleanup()` removes other versions and ends engines left from an earlier
 * run (their run/<engine>.pid, checked against the process's command line
 * so a reused pid is never killed), only inside this client's folder, so
 * two computers using one host never clean up each other.
 *
 * Every script is a fixed template; the values in it (the folder, version,
 * target, checksum, address) are checked against strict patterns and
 * single-quoted (remote-scripts.ts), and nothing runs through a local shell.
 */
import { createHash, randomBytes } from "node:crypto";
import type { SshStatus } from "../../shared/ssh-api";
import type { ExecOptions, ExecResult } from "./connection";
import {
  classifySshDiagnostic,
  sshDiagnosticMessage,
} from "../../shared/ssh-diagnostics";
import {
  checkRemotePath,
  platformLabel,
  shQuote,
  type HostProbe,
} from "./remote-scripts";
import {
  RuntimeCache,
  integrityHex,
  packageFileName,
  runtimeManifest,
  type RuntimeManifest,
  type RuntimePackage,
} from "./runtime-cache";
import { EXIT } from "./remote-runtime-support";
import { lines } from "./remote-runtime-support";
import * as remoteRuntimeUpload from "./remote-runtime-upload";
import { installMethods } from "./install-methods";

/** What the runtime needs from a host's connection (SshConnection has it). */
export interface RemoteShell {
  exec(script: string, options?: ExecOptions): Promise<ExecResult>;
}

/** uname -s / uname -m → the package's target. */
export function remoteTriple(
  probe: Pick<HostProbe, "os" | "arch">,
): string | undefined {
  const arch =
    probe.arch === "x86_64" || probe.arch === "amd64"
      ? "x86_64"
      : probe.arch === "aarch64" || probe.arch === "arm64"
        ? "aarch64"
        : undefined;
  if (!arch) return undefined;
  if (probe.os === "Linux") return `${arch}-unknown-linux-musl`;
  if (probe.os === "Darwin") return `${arch}-apple-darwin`;
  return undefined;
}

/**
 * This computer's folder name on hosts: the first 12 hex characters of the
 * sha256 of its device id (the id itself never leaves the computer).
 */
export function clientIdFor(deviceId: string): string {
  return createHash("sha256")
    .update(`claudex-remote:${deviceId}`)
    .digest("hex")
    .slice(0, 12);
}

export const defaultRemoteRoot = (clientId: string) =>
  `~/.claudex-remote/${clientId}`;

/**
 * The client's own folder: <remoteRoot>/<clientId> when the host names a
 * "Remote folder for Claudex", else the default. The runtime chmods this
 * folder and cleans its tmp/ and bin/, so it must never be the chosen
 * folder itself (which may be "~", "/tmp" or shared with other computers).
 */
export function clientRoot(clientId: string, remoteRoot?: string): string {
  if (!remoteRoot) return defaultRemoteRoot(clientId);
  const base = checkRemotePath(remoteRoot).replace(/\/+$/, "");
  return `${base}/${clientId}`;
}

/** Where the engine and its folders are on the host (absolute paths). */
export interface RemoteRuntimeLayout {
  /** The client's folder, symlinks resolved. */
  root: string;
  version: string;
  triple: string;
  /** bin/codex-<version>-<triple> */
  dir: string;
  /** The engine to start: <dir>/bin/codex */
  codex: string;
  /** CODEX_HOME */
  home: string;
  attachments: string;
  /** Where engines write <engineId>.pid */
  run: string;
}

export type RemoteRuntimeErrorCode =
  | "install-failed"
  | "unsupported-platform"
  | "remote-disk-full"
  | "remote-read-only";

export class RemoteRuntimeError extends Error {
  constructor(
    readonly code: RemoteRuntimeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface RemoteRuntimeOptions {
  shell: RemoteShell;
  /** What the host check found (SshConnection.probe). */
  probe: HostProbe;
  /** The host's name in messages. */
  label: string;
  /** From clientIdFor. */
  clientId: string;
  /** The host's "Remote folder for Claudex"; the client's folder is <remoteRoot>/<clientId> (default ~/.claudex-remote/<clientId>). */
  remoteRoot?: string;
  /** The local package cache (<dataRoot>/runtime-cache). */
  cache: RuntimeCache;
  /** The administrator's mirror (policy codexRuntimeMirror). */
  mirror?: string | null;
  /** installing … (SshConnection.setStatus). Progress is 0–1. */
  onStatus?: (status: SshStatus) => void;
  manifest?: RuntimeManifest;
  /** Upload chunk size (default 8 MB). */
  chunkBytes?: number;
  /** How long to wait for another install's lock (default 10 minutes). */
  lockWaitMs?: number;
  lockPollMs?: number;
}
const CLIENT_ID = /^[0-9a-f]{12}$/;

/** Sets R to the client's folder, "~" and "~/…" turned into the home folder. */
function rootAssignment(root: string) {
  return [
    `R=${shQuote(checkRemotePath(root))}`,
    `case $R in "~") R=$HOME ;; "~/"*) R=$HOME/\${R#"~/"} ;; esac`,
  ].join("\n");
}

export class RemoteRuntime {
  private readonly manifest: RuntimeManifest;
  private readonly root: string;
  private installing: Promise<RemoteRuntimeLayout> | undefined;
  /** The layout once ensure() finished. */
  layout: RemoteRuntimeLayout | undefined;

  constructor(readonly options: RemoteRuntimeOptions) {
    if (!CLIENT_ID.test(options.clientId))
      throw new Error("The client id is damaged.");
    this.manifest = options.manifest ?? runtimeManifest();
    this.root = checkRemotePath(
      clientRoot(options.clientId, options.remoteRoot),
    );
  }

  /** The package for the host, or an unsupported-platform error. */
  package(): RuntimePackage {
    const triple = remoteTriple(this.options.probe);
    const pkg = triple ? this.manifest.platforms[triple] : undefined;
    if (!pkg)
      throw new RemoteRuntimeError(
        "unsupported-platform",
        `Claudex can't run on ${platformLabel(this.options.probe)} yet.`,
      );
    return pkg;
  }

  /** Installs when needed; concurrent calls share one install. */
  ensure(): Promise<RemoteRuntimeLayout> {
    this.installing ??= this.run().finally(() => {
      this.installing = undefined;
    });
    return this.installing;
  }

  status(status: SshStatus) {
    this.options.onStatus?.(status);
  }

  fail(message: string): never {
    throw new RemoteRuntimeError("install-failed", message);
  }

  async exec(script: string, options?: ExecOptions) {
    try {
      const result = await this.options.shell.exec(script, options);
      const code =
        result.code !== 0 ? classifySshDiagnostic(result.stderr) : undefined;
      if (code === "remote-disk-full" || code === "remote-read-only")
        throw new RemoteRuntimeError(
          code,
          sshDiagnosticMessage(code)!.replaceAll("{host}", this.options.label),
        );
      return result;
    } catch (error) {
      if (error instanceof RemoteRuntimeError) throw error;
      this.fail((error as Error).message);
    }
  }

  private async run(): Promise<RemoteRuntimeLayout> {
    const pkg = this.package();
    const sum = integrityHex(pkg.integrity);
    this.status({ state: "installing", phase: "verify" });
    const layout = await this.prepare(pkg, sum);
    if (layout.installed) return (this.layout = layout.layout);

    const token = randomBytes(16).toString("hex");
    await this.lock(layout.layout.root, token);
    try {
      // Another install may have finished while this one waited.
      const again = await this.prepare(pkg, sum);
      if (!again.installed) {
        const shared = { root: again.layout.root, pkg, sum };
        const fetched = await this.upload(shared, token);
        if (!fetched)
          this.fail(
            `Couldn't copy the Codex runtime to ${this.options.label}.`,
          );
        this.status({ state: "installing", phase: "verify" });
        await this.unpack(shared);
      }
      this.layout = again.layout;
      return again.layout;
    } finally {
      await this.unlock(layout.layout.root, token);
    }
  }

  /** Makes the folders and reports whether this version is in place. */
  private async prepare(pkg: RuntimePackage, sum: string) {
    const result = await this.exec(
      [
        `umask 077`,
        rootAssignment(this.root),
        `mkdir -p "$R/bin" "$R/tmp" "$R/run" "$R/codex-home" "$R/attachments" || exit ${EXIT.root}`,
        `chmod 700 "$R" 2>/dev/null`,
        `cd -- "$R" 2>/dev/null || exit ${EXIT.root}`,
        `R=$(pwd -P)`,
        `printf 'root=%s\\n' "$R"`,
        `D="$R/bin/"${shQuote(`codex-${pkg.version}-${pkg.triple}`)}`,
        `if [ -x "$D/bin/codex" ] && [ "$(cat "$D/.claudex-installed" 2>/dev/null)" = ${shQuote(sum)} ]; then printf 'installed=1\\n'; fi`,
        `printf 'end=1\\n'`,
      ].join("\n"),
    );
    const values = lines(result.stdout);
    const root = values.get("root");
    if (result.code !== 0 || !root?.startsWith("/") || !values.has("end"))
      this.fail(
        result.code === EXIT.root
          ? `Claudex can't write to its folder on ${this.options.label}.`
          : `Couldn't reach ${this.options.label} to set up Claudex.`,
      );
    checkRemotePath(root);
    const dir = `${root}/bin/codex-${pkg.version}-${pkg.triple}`;
    return {
      installed: values.get("installed") === "1",
      layout: {
        root,
        version: pkg.version,
        triple: pkg.triple,
        dir,
        codex: `${dir}/bin/codex`,
        home: `${root}/codex-home`,
        attachments: `${root}/attachments`,
        run: `${root}/run`,
      } satisfies RemoteRuntimeLayout,
    };
  }

  private async lock(root: string, token: string) {
    const script = [
      rootAssignment(root),
      `L="$R/run/install.lock"`,
      `take() { mkdir "$L" 2>/dev/null && printf '%s' ${shQuote(token)} > "$L/owner" && printf 'lock=taken\\n' && exit 0; }`,
      `take`,
      // A lock nobody touched for 10 minutes was left by a lost install.
      `if [ -n "$(find "$L" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rm -rf "$L"; take; fi`,
      `printf 'lock=busy\\n'`,
    ].join("\n");
    const wait = this.options.lockWaitMs ?? 10 * 60_000;
    const poll = this.options.lockPollMs ?? 2_000;
    const started = Date.now();
    for (;;) {
      const result = await this.exec(script);
      const state = lines(result.stdout).get("lock");
      if (state === "taken") return;
      if (state !== "busy" || Date.now() - started > wait)
        this.fail(
          `Another copy of Claudex is setting up ${this.options.label}. Try again in a few minutes.`,
        );
      await new Promise((resolve) => setTimeout(resolve, poll));
    }
  }

  private async unlock(root: string, token: string) {
    try {
      await this.options.shell.exec(
        [
          rootAssignment(root),
          `L="$R/run/install.lock"`,
          `[ "$(cat "$L/owner" 2>/dev/null)" = ${shQuote(token)} ] && rm -rf "$L"`,
          `exit 0`,
        ].join("\n"),
      );
    } catch {
      // The lock expires by itself.
    }
  }

  tempFile(root: string, pkg: RuntimePackage) {
    return `${shQuote(root)}/tmp/${shQuote(packageFileName(pkg))}`;
  }

  async removeTemp(root: string, pkg: RuntimePackage) {
    const file = this.tempFile(root, pkg);
    await this.exec(`rm -f ${file} ${file}.dl ${file}.part`);
  }
}

export interface RemoteRuntime {
  upload: OmitThisParameter<typeof remoteRuntimeUpload.upload>;
  unpack: OmitThisParameter<typeof remoteRuntimeUpload.unpack>;
  cleanup: OmitThisParameter<typeof remoteRuntimeUpload.cleanup>;
}
installMethods(RemoteRuntime.prototype, remoteRuntimeUpload);
