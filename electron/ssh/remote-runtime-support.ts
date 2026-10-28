export const ENGINE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Exit codes the scripts use. */
export const EXIT = {
  root: 3,
  download: 4,
  noDownloader: 5,
  offset: 6,
  unpack: 7,
  missing: 8,
  move: 9,
  run: 10,
  lock: 11,
};

/** Pulls a sha512 (128 hex characters) out of a hash tool's output. */
export function parseSha512(output: string): string | undefined {
  return /(?:^|[^0-9a-f])([0-9a-f]{128})(?![0-9a-f])/i
    .exec(output)?.[1]
    ?.toLowerCase();
}

/** key=value lines → a map (first value wins). */
export function lines(output: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at);
    if (!values.has(key))
      values.set(key, line.slice(at + 1).replace(/\r$/, ""));
  }
  return values;
}

/** The shell lines computing S = sha512 of "$F" (empty when no tool). */
export const HASH_LINES = [
  `S=`,
  `if command -v sha512sum >/dev/null 2>&1; then S=$(sha512sum < "$F")`,
  `elif command -v shasum >/dev/null 2>&1; then S=$(shasum -a 512 < "$F")`,
  `elif command -v openssl >/dev/null 2>&1; then S=$(openssl dgst -sha512 < "$F")`,
  `fi`,
  `printf 'sha512=%s\\n' "$S"`,
  `printf 'size=%s\\n' "$(wc -c < "$F" | tr -d ' ')"`,
];
