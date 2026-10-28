// Workspace snapshots for runner sandboxes (W-GVISOR, W-RUN 3.3).
//
// When a sandbox stops (idle timeout, runner drain), its data directory's
// `workspace` and `codex-home` (codex rollouts, so `thread/resume` works
// after a restore) are packed into a zstd-compressed tar and kept either on
// the runner's disk (`LocalSnapshotStore`, the session then sticks to this
// runner) or in S3-compatible object storage such as Cloudflare R2
// (`S3SnapshotStore`). On restart the archive is fetched, its SHA-256 is
// checked and it is unpacked into a fresh directory that replaces the old
// data.
//
// Everything in a workspace was written by untrusted code, so:
// - packing never follows symlinks (they are stored as links), opens files
//   with O_NOFOLLOW, skips sockets, FIFOs and devices, drops set-id bits and
//   stops at a size and entry limit;
// - unpacking accepts only relative names inside the expected roots (no
//   absolute paths, no `..`), creates every parent directory itself, creates
//   symlinks only after all files are written (so nothing is ever written
//   through a link), refuses hard links and special files, and enforces the
//   same limits on the decompressed stream (no zip bombs).
// The tar format is plain POSIX ustar with pax headers for long names, so
// `tar --zstd -tvf` can inspect an archive.
//
// Object storage credentials stay in the runner process; they never enter a
// sandbox and are never logged. Erasable TypeScript only.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { BLOCK, ZERO_BLOCK, tarHeader, extractTar } from "./snapshot-tar.ts";
import {
  SnapshotError,
  SNAPSHOT_ROOTS,
  SNAPSHOT_EXCLUDES,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  type SnapshotManifest,
  checkRoots,
  type SnapshotStore,
  checkKey,
} from "./snapshot-common.ts";

/**
 * Opens `abs` (never following a final symlink) and, on Linux, confirms
 * through /proc/self/fd that the file opened really is `expected`. A sandbox
 * that is still running could swap a directory on the path for a symlink
 * between our lstat/readdir and the open; the check makes the runner (often
 * root) refuse such a file instead of reading or changing a host file.
 * Returns undefined when the file cannot be opened or is not `expected`.
 */
export function openVerified(
  abs: string,
  expected: string,
  flags: number = fs.constants.O_RDONLY,
): number | undefined {
  let fd: number;
  try {
    fd = fs.openSync(
      abs,
      flags | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return undefined;
  }
  if (process.platform === "linux") {
    let real: string | undefined;
    try {
      real = fs.readlinkSync(`/proc/self/fd/${fd}`);
    } catch {}
    if (real !== expected) {
      fs.closeSync(fd);
      return undefined;
    }
  }
  return fd;
}

function realOrSelf(p: string) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isExcluded(rel: string, excludes: string[]) {
  return excludes.some((x) => rel === x || rel.startsWith(x + "/"));
}

/**
 * Streams a tar of `roots` under `baseDir` (pre-order, sorted names). Stats
 * accumulate in `stats`. Throws SnapshotError past the limits.
 */
export async function* tarStream(
  baseDir: string,
  opts: {
    roots?: string[];
    excludes?: string[];
    maxBytes?: number;
    maxEntries?: number;
    stats?: { entries: number; bytes: number; skipped: number };
  } = {},
): AsyncGenerator<Buffer> {
  const roots = opts.roots ?? SNAPSHOT_ROOTS;
  checkRoots(roots);
  const excludes = opts.excludes ?? SNAPSHOT_EXCLUDES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const stats = opts.stats ?? { entries: 0, bytes: 0, skipped: 0 };
  const chunk = Buffer.alloc(1024 * 1024);
  const realBase = realOrSelf(baseDir);
  const stack: string[] = [...roots].sort().reverse();
  while (stack.length) {
    const rel = stack.pop()!;
    if (isExcluded(rel, excludes)) continue;
    const abs = path.join(baseDir, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue; // vanished, or a root that does not exist
    }
    if (++stats.entries > maxEntries)
      throw new SnapshotError("The workspace has too many files to snapshot.");
    const mtime = Math.floor(st.mtimeMs / 1000);
    const mode = st.mode & 0o777;
    if (st.isDirectory()) {
      yield* tarHeader({ name: rel, type: "dir", mode, mtime, size: 0 });
      let names: string[] = [];
      try {
        names = fs.readdirSync(abs);
      } catch {}
      for (const n of names.sort().reverse()) stack.push(`${rel}/${n}`);
    } else if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = fs.readlinkSync(abs);
      } catch {
        continue;
      }
      yield* tarHeader({
        name: rel,
        type: "symlink",
        mode: 0o777,
        mtime,
        size: 0,
        linkname: target,
      });
    } else if (st.isFile()) {
      const fd = openVerified(abs, path.join(realBase, rel));
      if (fd === undefined) {
        stats.skipped++;
        continue;
      }
      try {
        const fst = fs.fstatSync(fd);
        if (!fst.isFile()) {
          stats.skipped++;
          continue;
        }
        const size = fst.size;
        stats.bytes += size;
        if (stats.bytes > maxBytes)
          throw new SnapshotError(
            "The workspace is larger than the snapshot limit.",
          );
        yield* tarHeader({ name: rel, type: "file", mode, mtime, size });
        let left = size;
        while (left > 0) {
          const n = fs.readSync(
            fd,
            chunk,
            0,
            Math.min(chunk.length, left),
            null,
          );
          if (n <= 0) break; // shrank while reading: pad below
          yield Buffer.from(chunk.subarray(0, n));
          left -= n;
        }
        if (left > 0) yield Buffer.alloc(left);
        const pad = (BLOCK - (size % BLOCK)) % BLOCK;
        if (pad) yield Buffer.alloc(pad);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      stats.skipped++; // sockets, FIFOs, devices
      stats.entries--;
    }
  }
  yield ZERO_BLOCK;
  yield ZERO_BLOCK;
}

// ---------------------------------------------------------------------------
// Archives (.tar.zst)

class HashCount extends Transform {
  hash = crypto.createHash("sha256");
  bytes = 0;
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    cb(null, chunk);
  }
}

/** Hex SHA-256 of a file. */
export async function sha256File(file: string) {
  const h = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), h);
  return h.digest("hex");
}

/**
 * Packs `roots` of a sandbox data directory into `outFile` (.tar.zst). Stop
 * the sandbox first: a running one could keep changing files.
 */
export async function createSnapshot(opts: {
  dataDir: string;
  outFile: string;
  roots?: string[];
  excludes?: string[];
  maxBytes?: number;
  maxEntries?: number;
  /** zstd level (default 3). */
  level?: number;
  meta?: Record<string, string>;
}): Promise<SnapshotManifest> {
  const roots = opts.roots ?? SNAPSHOT_ROOTS;
  const stats = { entries: 0, bytes: 0, skipped: 0 };
  const counter = new HashCount();
  const tmp = `${opts.outFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await pipeline(
      Readable.from(
        tarStream(opts.dataDir, {
          roots,
          excludes: opts.excludes,
          maxBytes: opts.maxBytes,
          maxEntries: opts.maxEntries,
          stats,
        }),
      ),
      zlib.createZstdCompress({
        params: {
          [zlib.constants.ZSTD_c_compressionLevel]: opts.level ?? 3,
          [zlib.constants.ZSTD_c_checksumFlag]: 1,
        },
      }),
      counter,
      fs.createWriteStream(tmp, { mode: 0o600 }),
    );
    fs.renameSync(tmp, opts.outFile);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return {
    format: "claudex-snapshot/1",
    createdAt: new Date().toISOString(),
    roots,
    entries: stats.entries,
    bytes: stats.bytes,
    compressedBytes: counter.bytes,
    sha256: counter.hash.digest("hex"),
    meta: opts.meta,
  };
}

/**
 * Restores an archive into `dataDir`: verifies the SHA-256 (when given),
 * unpacks into a staging directory inside `dataDir` (same file system and
 * quota volume), then swaps each root into place. The old roots are removed
 * (without following links).
 */
export async function restoreSnapshot(opts: {
  archive: string;
  dataDir: string;
  sha256?: string;
  roots?: string[];
  maxBytes?: number;
  maxEntries?: number;
}) {
  const roots = opts.roots ?? SNAPSHOT_ROOTS;
  checkRoots(roots);
  if (opts.sha256) {
    const got = await sha256File(opts.archive);
    if (got !== opts.sha256.toLowerCase())
      throw new SnapshotError("The snapshot failed its integrity check.");
  }
  fs.mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(opts.dataDir, ".restore-"));
  try {
    const decompress = zlib.createZstdDecompress();
    const input = fs.createReadStream(opts.archive);
    input.on("error", (e) => decompress.destroy(e));
    const result = await extractTar(input.pipe(decompress), staging, {
      roots,
      maxBytes: opts.maxBytes,
      maxEntries: opts.maxEntries,
    });
    input.destroy();
    decompress.destroy();
    for (const r of roots) {
      const target = path.join(opts.dataDir, r);
      fs.rmSync(target, { recursive: true, force: true });
      const staged = path.join(staging, r);
      if (fs.existsSync(staged)) fs.renameSync(staged, target);
      else fs.mkdirSync(target, { mode: 0o700 });
    }
    return result;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Snapshots kept on this runner's disk (sessions stick to the runner). */
export class LocalSnapshotStore implements SnapshotStore {
  readonly kind = "local" as const;
  readonly root: string;
  constructor(root: string) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  private file(key: string) {
    return path.join(this.root, checkKey(key));
  }
  async put(key: string, file: string) {
    const dest = this.file(key);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.copyFileSync(file, tmp);
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, dest);
  }
  async get(key: string, file: string) {
    const src = this.file(key);
    if (!fs.existsSync(src))
      throw new SnapshotError("The snapshot was not found.");
    fs.copyFileSync(src, file);
  }
  async exists(key: string) {
    return fs.existsSync(this.file(key));
  }
  async delete(key: string) {
    fs.rmSync(this.file(key), { force: true });
  }
  /** Removes files older than `maxAgeMs` (retention; W-RUN 3.3 default 30 days). */
  prune(maxAgeMs: number, now = Date.now()) {
    const removed: string[] = [];
    const walk = (dir: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, d.name);
        if (d.isDirectory()) walk(abs);
        else if (d.isFile() && now - fs.statSync(abs).mtimeMs > maxAgeMs) {
          fs.rmSync(abs, { force: true });
          removed.push(path.relative(this.root, abs));
        }
      }
    };
    walk(this.root);
    return removed;
  }
}

// ---------------------------------------------------------------------------
// Service

/**
 * Saves and loads sandbox data directories through a store. The archive is
 * `<key>.tar.zst` and its manifest `<key>.json`; the control plane keeps the
 * manifest's sha256 with the session (W-CLOUD `snapshot_uri`) and passes it
 * back on load, so a replaced object is detected.
 */
export class SnapshotService {
  readonly store: SnapshotStore;
  private workDir: string;
  constructor(store: SnapshotStore, workDir = os.tmpdir()) {
    this.store = store;
    this.workDir = workDir;
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  }

  private temp(suffix: string) {
    return path.join(
      this.workDir,
      `snap-${process.pid}-${crypto.randomBytes(6).toString("hex")}${suffix}`,
    );
  }

  async save(
    key: string,
    dataDir: string,
    opts: {
      roots?: string[];
      excludes?: string[];
      maxBytes?: number;
      meta?: Record<string, string>;
    } = {},
  ): Promise<SnapshotManifest> {
    checkKey(key);
    const archive = this.temp(".tar.zst");
    const manifestFile = this.temp(".json");
    try {
      const manifest = await createSnapshot({
        dataDir,
        outFile: archive,
        ...opts,
      });
      await this.store.put(`${key}.tar.zst`, archive);
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), {
        mode: 0o600,
      });
      await this.store.put(`${key}.json`, manifestFile, "application/json");
      return manifest;
    } finally {
      fs.rmSync(archive, { force: true });
      fs.rmSync(manifestFile, { force: true });
    }
  }

  async manifest(key: string): Promise<SnapshotManifest> {
    const file = this.temp(".json");
    try {
      await this.store.get(`${checkKey(key)}.json`, file);
      const m = JSON.parse(fs.readFileSync(file, "utf8")) as SnapshotManifest;
      if (m.format !== "claudex-snapshot/1" || !/^[0-9a-f]{64}$/.test(m.sha256))
        throw new SnapshotError("Unknown snapshot format.");
      return m;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  /** Restores `key` into `dataDir`. `sha256` (from the control plane) wins over the stored manifest. */
  async load(
    key: string,
    dataDir: string,
    opts: {
      sha256?: string;
      roots?: string[];
      maxBytes?: number;
      maxEntries?: number;
    } = {},
  ) {
    const manifest = await this.manifest(key);
    const allowed = opts.roots ?? SNAPSHOT_ROOTS;
    if (
      !Array.isArray(manifest.roots) ||
      !manifest.roots.every((r) => allowed.includes(r))
    )
      throw new SnapshotError("The snapshot has unexpected contents.");
    const expected = opts.sha256 ?? manifest.sha256;
    const archive = this.temp(".tar.zst");
    try {
      await this.store.get(`${key}.tar.zst`, archive);
      const result = await restoreSnapshot({
        archive,
        dataDir,
        sha256: expected,
        roots: manifest.roots,
        maxBytes: opts.maxBytes,
        maxEntries: opts.maxEntries,
      });
      return { manifest, ...result };
    } finally {
      fs.rmSync(archive, { force: true });
    }
  }

  async remove(key: string) {
    checkKey(key);
    await this.store.delete(`${key}.tar.zst`);
    await this.store.delete(`${key}.json`);
  }
}
