import fs from "node:fs";
import { shQuote } from "./remote-scripts";
import { type RuntimePackage } from "./runtime-cache";
import { ENGINE_ID } from "./remote-runtime-support";
import { EXIT } from "./remote-runtime-support";
import { parseSha512 } from "./remote-runtime-support";
import { lines } from "./remote-runtime-support";
import { HASH_LINES } from "./remote-runtime-support";
import type { RemoteRuntime } from "./remote-runtime";

/**
 * This computer downloads the package (cached, checked) and sends it in
 * chunks, continuing an upload an earlier attempt left.
 */
export async function upload(
  this: RemoteRuntime,
  shared: { root: string; pkg: RuntimePackage; sum: string },
  token: string,
): Promise<boolean> {
  const { root, pkg, sum } = shared;
  this.status({ state: "installing", phase: "download", progress: 0 });
  let local: string;
  try {
    local = await this.options.cache.ensure(pkg, {
      mirror: this.options.mirror,
      onProgress: (received, total) => {
        if (total)
          this.status({
            state: "installing",
            phase: "download",
            progress: Math.min(1, received / total),
          });
      },
    });
  } catch (error) {
    this.fail(
      `Couldn't download the Codex runtime for ${this.options.label}: ${(error as Error).message}`,
    );
  }
  const size = fs.statSync(local).size;
  const chunk = this.options.chunkBytes ?? 8 * 1024 * 1024;
  const file = this.tempFile(root, pkg);
  const lockDir = `${shQuote(root)}/run/install.lock`;
  for (let round = 0; round < 2; round++) {
    const start = await this.exec(
      [
        `umask 077`,
        `F=${file}`,
        `[ -f "$F.part" ] || : > "$F.part" || exit ${EXIT.root}`,
        `printf 'offset=%s\\n' "$(wc -c < "$F.part" | tr -d ' ')"`,
      ].join("\n"),
    );
    let offset = Number(lines(start.stdout).get("offset"));
    if (start.code !== 0 || !Number.isSafeInteger(offset))
      this.fail(`Claudex can't write to its folder on ${this.options.label}.`);
    if (offset > size) {
      await this.removeTemp(root, pkg);
      offset = 0;
      await this.exec(`umask 077\n: > ${file}.part`);
    }
    const handle = fs.openSync(local, "r");
    try {
      while (offset < size) {
        this.status({
          state: "installing",
          phase: "upload",
          progress: offset / size,
        });
        const length = Math.min(chunk, size - offset);
        const buffer = Buffer.alloc(length);
        fs.readSync(handle, buffer, 0, length, offset);
        const result = await this.exec(
          [
            `umask 077`,
            `F=${file}`,
            `O=$(wc -c < "$F.part" 2>/dev/null | tr -d ' ')`,
            `if [ "$O" != ${shQuote(String(offset))} ]; then cat >/dev/null; printf 'offset=%s\\n' "$O"; exit ${EXIT.offset}; fi`,
            `cat >> "$F.part" || exit ${EXIT.root}`,
            // Keeps the install lock fresh while a slow upload runs.
            `[ "$(cat ${lockDir}/owner 2>/dev/null)" = ${shQuote(token)} ] && touch ${lockDir}`,
            `printf 'offset=%s\\n' "$(wc -c < "$F.part" | tr -d ' ')"`,
          ].join("\n"),
          { input: buffer, timeoutMs: 10 * 60_000 },
        );
        const next = Number(lines(result.stdout).get("offset"));
        if (result.code === 0 && next === offset + length) {
          offset = next;
          continue;
        }
        if (
          result.code === EXIT.offset &&
          Number.isSafeInteger(next) &&
          next >= 0 &&
          next <= size
        ) {
          offset = next;
          continue;
        }
        this.fail(
          `The connection to ${this.options.label} dropped while copying the Codex runtime.`,
        );
      }
    } finally {
      fs.closeSync(handle);
    }
    this.status({ state: "installing", phase: "verify" });
    const check = await this.exec(
      [
        `F=${file}.part`,
        ...HASH_LINES,
        `mv -f "$F" ${file} || exit ${EXIT.root}`,
      ].join("\n"),
      { timeoutMs: 5 * 60_000 },
    );
    const values = lines(check.stdout);
    const remoteSum = parseSha512(values.get("sha512") ?? "");
    // ssh already protects the bytes in transit; the size must match, and
    // the sha512 too when the host has a tool for it.
    if (
      check.code === 0 &&
      Number(values.get("size")) === size &&
      (remoteSum === undefined || remoteSum === sum)
    )
      return true;
    await this.removeTemp(root, pkg);
  }
  return false;
}

/** Unpacks package/vendor/<triple>, checks the engine runs, moves it in. */
export async function unpack(
  this: RemoteRuntime,
  shared: {
    root: string;
    pkg: RuntimePackage;
    sum: string;
  },
) {
  const { root, pkg, sum } = shared;
  const name = `codex-${pkg.version}-${pkg.triple}`;
  const result = await this.exec(
    [
      `umask 077`,
      `R=${shQuote(root)}`,
      `F=${this.tempFile(root, pkg)}`,
      `T=${shQuote(pkg.triple)}`,
      `D="$R/bin/"${shQuote(name)}`,
      `X="$R/tmp/extract-"${shQuote(name)}`,
      `rm -rf "$X" && mkdir -p "$X" || exit ${EXIT.unpack}`,
      `if ! tar -xzf "$F" -C "$X" "package/vendor/$T" 2>/dev/null; then`,
      `  rm -rf "$X" && mkdir -p "$X" || exit ${EXIT.unpack}`,
      `  gzip -dc < "$F" | tar -xf - -C "$X" "package/vendor/$T" 2>/dev/null || { rm -rf "$X"; exit ${EXIT.unpack}; }`,
      `fi`,
      `S="$X/package/vendor/$T"`,
      `[ -f "$S/bin/codex" ] || { rm -rf "$X"; exit ${EXIT.missing}; }`,
      `chmod -R go-rwx "$S" 2>/dev/null`,
      `chmod 700 "$S/bin/codex"`,
      `if [ "$(uname -s)" = Darwin ]; then xattr -dr com.apple.quarantine "$S" 2>/dev/null; fi`,
      `V=$("$S/bin/codex" --version 2>/dev/null)`,
      `case $V in *${shQuote(pkg.version)}*) ;; *) rm -rf "$X"; exit ${EXIT.run} ;; esac`,
      `printf '%s' ${shQuote(sum)} > "$S/.claudex-installed" || exit ${EXIT.move}`,
      `rm -rf "$D.old"`,
      `if [ -e "$D" ]; then mv "$D" "$D.old" || exit ${EXIT.move}; fi`,
      `mv "$S" "$D" || exit ${EXIT.move}`,
      `rm -rf "$D.old" "$X" "$F"`,
      `printf 'installed=1\\n'`,
    ].join("\n"),
    { timeoutMs: 5 * 60_000 },
  );
  if (result.code === 0 && lines(result.stdout).get("installed") === "1")
    return;
  this.fail(
    result.code === EXIT.run
      ? `The Codex runtime doesn't start on ${this.options.label}.`
      : result.code === EXIT.unpack
        ? `Couldn't unpack the Codex runtime on ${this.options.label} (it needs tar and gzip).`
        : `Couldn't install the Codex runtime on ${this.options.label}.`,
  );
}

/**
 * Ends engines this client left running (their run/<id>.pid, unless the
 * id is in `activeEngines`) and removes other versions and leftover
 * downloads. Only touches this client's folder.
 */
export async function cleanup(
  this: RemoteRuntime,
  activeEngines: string[] = [],
): Promise<void> {
  const layout = this.layout;
  if (!layout) throw new Error("Set up the runtime first.");
  for (const id of activeEngines)
    if (!ENGINE_ID.test(id)) throw new Error("The engine id is damaged.");
  const keep = `codex-${layout.version}-${layout.triple}`;
  const result = await this.exec(
    [
      `R=${shQuote(layout.root)}`,
      `A=${shQuote(` ${activeEngines.join(" ")} `)}`,
      `args() { (tr '\\000' ' ' < "/proc/$1/cmdline") 2>/dev/null || ps -o args= -p "$1" 2>/dev/null; }`,
      `if cd -- "$R/run" 2>/dev/null; then`,
      `  for f in *.pid; do`,
      `    [ -f "$f" ] || continue`,
      `    e=\${f%.pid}`,
      `    case $A in *" $e "*) continue ;; esac`,
      `    p=$(cat "$f" 2>/dev/null)`,
      `    case $p in ''|*[!0-9]*) rm -f "$f"; continue ;; esac`,
      `    if kill -0 "$p" 2>/dev/null; then`,
      `      case $(args "$p") in *"$R/bin/codex-"*) kill "$p" 2>/dev/null ;; esac`,
      `    fi`,
      `    rm -f "$f"`,
      `  done`,
      `fi`,
      // Taken once (a grep would find its own command line); a version
      // some process still runs from is kept.
      `PS=$(ps -A -o args= 2>/dev/null || ps -o args 2>/dev/null)`,
      `if cd -- "$R/bin" 2>/dev/null; then`,
      `  for d in codex-*; do`,
      `    [ -d "$d" ] || continue`,
      `    [ "$d" = ${shQuote(keep)} ] && continue`,
      `    case $PS in *"$R/bin/$d/"*) continue ;; esac`,
      `    rm -rf -- "$d"`,
      `  done`,
      `fi`,
      `if [ ! -d "$R/run/install.lock" ]; then rm -rf "$R/tmp" && mkdir -p "$R/tmp"; fi`,
      `printf 'cleaned=1\\n'`,
    ].join("\n"),
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0 || lines(result.stdout).get("cleaned") !== "1")
    this.fail(`Couldn't clean up Claudex's folder on ${this.options.label}.`);
}
