export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/** Default roots of a sandbox data directory (driver.ts `sandboxDataLayout`). */
export const SNAPSHOT_ROOTS = ["workspace", "codex-home"];

/**
 * Left out of snapshots: config.toml is rewritten by Engine on every start
 * (and must never be a sandbox-made link), tmp and caches are disposable.
 */
export const SNAPSHOT_EXCLUDES = [
  "codex-home/config.toml",
  "codex-home/tmp",
  "codex-home/.tmp",
  "codex-home/home/.cache",
];

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 * 1024;

// code class disk
export const DEFAULT_MAX_ENTRIES = 1_000_000;

export interface SnapshotManifest {
  format: "claudex-snapshot/1";
  createdAt: string;
  roots: string[];
  entries: number;
  /** Uncompressed file bytes. */
  bytes: number;
  /** Size of the .tar.zst archive. */
  compressedBytes: number;
  /** Hex SHA-256 of the archive. */
  sha256: string;
  /** Free-form labels from the runner (sandbox id, image version, codex version). */
  meta?: Record<string, string>;
}

export function checkRoots(roots: string[]) {
  for (const r of roots)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r))
      throw new SnapshotError(`Bad snapshot root: ${r}`);
}

// ---------------------------------------------------------------------------
// Stores

export interface SnapshotStore {
  readonly kind: "local" | "s3";
  /** Uploads `file` as `key`. */
  put(key: string, file: string, contentType?: string): Promise<void>;
  /** Downloads `key` into `file`; throws SnapshotError when missing. */
  get(key: string, file: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/** Object keys: relative, `/`-separated, no `..`, no leading dot segments. */
export function checkKey(key: string) {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(key) ||
    key.split("/").some((p) => p === "" || p.startsWith("."))
  )
    throw new SnapshotError(`Bad snapshot key: ${String(key).slice(0, 100)}`);
  return key;
}
