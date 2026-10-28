/**
 * The fixed shell scripts Claudex runs on an SSH host (R9), and the one way
 * they reach it.
 *
 * ssh hands its command line to the remote login shell, which may be sh,
 * bash, zsh, fish or csh. So the script itself never travels as shell
 * text: it is base64-encoded and the command line is always
 *
 *     sh -c 'eval "$(echo <base64> | base64 -d)"'
 *
 * which every one of those shells reads the same way (the single-quoted
 * part holds no quote, backslash, "!" or newline). Every value put into a
 * script (paths, names) goes through `shQuote` after `checkRemotePath`, so
 * nothing the renderer sends can become shell syntax on the host, and
 * nothing is ever run through a local shell.
 */

/** A remote path or folder name the scripts accept (absolute, "~" or "~/…"). */
export const MAX_REMOTE_PATH = 1024;

/** POSIX single-quoted string: 'it'\''s' for it's. */
export function shQuote(value: string): string {
  if (value.includes("\0")) throw new Error("The value contains a NUL byte.");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Accepts a remote path the person typed or picked: absolute ("/srv/app"),
 * the home folder ("~") or under it ("~/code"). No NUL, no line breaks, no
 * other control characters, at most 1024 characters. Returns it unchanged.
 */
export function checkRemotePath(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error("Enter a folder path.");
  if (value.length > MAX_REMOTE_PATH) throw new Error("The path is too long.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value))
    throw new Error("The path contains a line break or control character.");
  if (!(value === "~" || value.startsWith("~/") || value.startsWith("/")))
    throw new Error("Enter an absolute path, or one that starts with ~/.");
  return value;
}

/** The command line ssh sends for a script (see the file comment). */
export function remoteCommand(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `sh -c 'eval "$(echo ${encoded} | base64 -d)"'`;
}

/**
 * Sets P to the path in `value`, with "~" and "~/…" turned into the home
 * folder. Used at the top of scripts that take a path.
 */
function pathAssignment(value: string | undefined) {
  if (value === undefined) return `P=$HOME`;
  const quoted = shQuote(checkRemotePath(value));
  return [
    `P=${quoted}`,
    `case $P in "~") P=$HOME ;; "~/"*) P=$HOME/\${P#"~/"} ;; esac`,
  ].join("\n");
}

/**
 * Keeps the master connection's own session open while Claudex runs: it
 * reads until the app closes the pipe (quits or crashes), then the session
 * ends and so does the master, so no ssh process outlives the app.
 */
export const HOLD_SCRIPT = "exec cat >/dev/null";

/**
 * What the host is: key=value lines for the system, the machine, the home
 * folder, the login shell and the tools the runtime install needs.
 */
export const PROBE_SCRIPT = [
  `printf 'os=%s\\n' "$(uname -s 2>/dev/null)"`,
  `printf 'arch=%s\\n' "$(uname -m 2>/dev/null)"`,
  `printf 'home=%s\\n' "$HOME"`,
  `printf 'shell=%s\\n' "\${SHELL:-}"`,
  `for t in curl wget tar sha512sum shasum base64; do`,
  `  if command -v "$t" >/dev/null 2>&1; then printf 'tool=%s\\n' "$t"; fi`,
  `done`,
  `printf 'end=1\\n'`,
].join("\n");

export const INPUT_PROBE_SCRIPT = `${PROBE_SCRIPT}\nIFS= read -r input && [ "$input" = claudex-stdin ] || { printf 'EXEC_NO_INPUT\\n' >&2; exit 1; }`;

export interface HostProbe {
  /** `uname -s`, for example "Linux" or "Darwin". */
  os: string;
  /** `uname -m`, for example "x86_64" or "aarch64". */
  arch: string;
  home: string;
  shell?: string;
  tools: string[];
}

/** Reads PROBE_SCRIPT's output; undefined when it did not run to the end. */
export function parseProbe(output: string): HostProbe | undefined {
  const values = new Map<string, string>();
  const tools: string[] = [];
  let ended = false;
  for (const line of output.split("\n")) {
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1).replace(/\r$/, "");
    if (key === "tool") tools.push(value);
    else if (key === "end") ended = true;
    else if (!values.has(key)) values.set(key, value);
  }
  const os = values.get("os");
  const arch = values.get("arch");
  const home = values.get("home");
  if (!ended || !os || !arch || !home) return undefined;
  return {
    os,
    arch,
    home,
    ...(values.get("shell") ? { shell: values.get("shell") } : {}),
    tools,
  };
}

/** The host systems remote Codex runs on (Linux and macOS, x64 and arm64). */
export function supportedPlatform(
  probe: Pick<HostProbe, "os" | "arch">,
): boolean {
  return (
    (probe.os === "Linux" || probe.os === "Darwin") &&
    ["x86_64", "amd64", "aarch64", "arm64"].includes(probe.arch)
  );
}

/** "Linux x86_64", for the Add connection dialog and errors. */
export function platformLabel(probe: Pick<HostProbe, "os" | "arch">) {
  const os = probe.os === "Darwin" ? "macOS" : probe.os;
  return `${os} ${probe.arch}`.trim();
}

/**
 * Lists one folder: first line "path=<absolute path>", then one
 * NUL-terminated "d name" or "f name" per entry (hidden ones included).
 * Names may hold any byte but NUL, so the output is split on NUL.
 * Exits 3 when the path is not a folder it can enter.
 */
export function listDirectoryScript(path?: string): string {
  return [
    pathAssignment(path),
    `cd -- "$P" 2>/dev/null || exit 3`,
    `printf 'path=%s\\0' "$(pwd -P)"`,
    `for f in * .[!.]* ..?*; do`,
    `  [ -e "$f" ] || [ -L "$f" ] || continue`,
    `  if [ -d "$f" ]; then printf 'd %s\\0' "$f"; else printf 'f %s\\0' "$f"; fi`,
    `done`,
  ].join("\n");
}

export interface DirectoryListing {
  path: string;
  entries: { name: string; kind: "folder" | "file" }[];
}

/** At most this many entries come back from one folder. */
export const MAX_DIRECTORY_ENTRIES = 5000;

/** Reads listDirectoryScript's output: folders first, then files, by name. */
export function parseDirectoryListing(
  output: string,
): DirectoryListing | undefined {
  const parts = output.split("\0");
  const head = parts.shift();
  if (!head?.startsWith("path=")) return undefined;
  const path = head.slice("path=".length);
  if (!path.startsWith("/")) return undefined;
  const entries: DirectoryListing["entries"] = [];
  for (const part of parts) {
    if (entries.length >= MAX_DIRECTORY_ENTRIES) break;
    const kind = part.startsWith("d ")
      ? "folder"
      : part.startsWith("f ")
        ? "file"
        : undefined;
    const name = part.slice(2);
    if (!kind || !name || name === "." || name === "..") continue;
    entries.push({ name, kind });
  }
  entries.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name)
      : a.kind === "folder"
        ? -1
        : 1,
  );
  return { path, entries };
}

/**
 * Checks a folder the person chose: prints "path=<absolute path>" when it
 * is a folder they can enter, exits 3 otherwise.
 */
export function folderCheckScript(path: string): string {
  return [
    pathAssignment(path),
    `[ -d "$P" ] || exit 3`,
    `cd -- "$P" 2>/dev/null || exit 3`,
    `printf 'path=%s\\n' "$(pwd -P)"`,
  ].join("\n");
}

/**
 * Codex's workspace trust for a folder on the host (electron/workspace-
 * trust.ts does the same on this computer): prints "folder=<real path>",
 * "root=<Codex project root>" (the nearest folder with `.git`, a worktree's
 * main checkout through its `commondir`, else the folder) and one
 * "source=<file>" per `.codex/config.toml`, `hooks.json` or `rules` from the
 * folder up to the root. Exits 3 when the folder can't be entered.
 */
export function workspaceTrustScript(path: string): string {
  return [
    pathAssignment(path),
    `cd -- "$P" 2>/dev/null || exit 3`,
    `start=$(pwd -P)`,
    `root=$start`,
    `d=$start`,
    `while :; do`,
    `  if [ -d "$d/.git" ]; then root=$d; break; fi`,
    `  if [ -f "$d/.git" ]; then`,
    `    root=$d`,
    `    g=$(sed -n 's/^gitdir:[[:space:]]*//p' "$d/.git" 2>/dev/null | head -n 1)`,
    `    case $g in '') ;; /*) ;; *) g=$d/$g ;; esac`,
    `    if [ -n "$g" ] && [ -f "$g/commondir" ]; then`,
    `      c=$(head -n 1 "$g/commondir")`,
    `      case $c in /*) ;; *) c=$g/$c ;; esac`,
    `      c=$(cd -- "$c" 2>/dev/null && pwd -P)`,
    `      case $c in */.git) root=\${c%/.git} ;; esac`,
    `    fi`,
    `    break`,
    `  fi`,
    `  [ "$d" = / ] && break`,
    `  d=$(dirname -- "$d")`,
    `done`,
    `printf 'folder=%s\\n' "$start"`,
    `printf 'root=%s\\n' "$root"`,
    `d=$start`,
    `while :; do`,
    `  for n in config.toml hooks.json rules; do`,
    `    if [ -e "$d/.codex/$n" ]; then printf 'source=%s\\n' "$d/.codex/$n"; fi`,
    `  done`,
    `  [ "$d" = "$root" ] && break`,
    `  [ "$d" = / ] && break`,
    `  d=$(dirname -- "$d")`,
    `done`,
  ].join("\n");
}

/** Reads folderCheckScript's output. */
export function parseFolderCheck(output: string): string | undefined {
  const line = output.split("\n").find((l) => l.startsWith("path="));
  const path = line?.slice("path=".length).replace(/\r$/, "");
  return path?.startsWith("/") ? path : undefined;
}
