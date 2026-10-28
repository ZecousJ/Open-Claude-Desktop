import fs from "node:fs";
import path from "node:path";
import {
  SnapshotError,
  SNAPSHOT_ROOTS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  checkRoots,
} from "./snapshot-common.ts";

// ---------------------------------------------------------------------------
// tar (ustar + pax)

export const BLOCK = 512;

export const ZERO_BLOCK = Buffer.alloc(BLOCK);

function octal(value: number, width: number) {
  // width includes the terminating NUL
  const s = Math.floor(value).toString(8);
  if (s.length > width - 1) return undefined;
  return s.padStart(width - 1, "0") + "\0";
}

function paxRecord(key: string, value: string) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len)
    len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

type EntryType = "file" | "dir" | "symlink";

interface TarEntry {
  name: string;
  type: EntryType;
  mode: number;
  mtime: number;
  size: number;
  linkname?: string;
}

function header(e: {
  name: string;
  type: string; // typeflag
  mode: number;
  mtime: number;
  size: number;
  linkname?: string;
}) {
  const b = Buffer.alloc(BLOCK);
  b.write(e.name.slice(0, 100), 0, 100, "utf8");
  b.write(octal(e.mode & 0o7777, 8)!, 100, 8, "ascii");
  b.write(octal(0, 8)!, 108, 8, "ascii");
  b.write(octal(0, 8)!, 116, 8, "ascii");
  b.write(octal(e.size, 12) ?? octal(0, 12)!, 124, 12, "ascii");
  b.write(octal(Math.max(0, e.mtime), 12) ?? octal(0, 12)!, 136, 12, "ascii");
  b.write("        ", 148, 8, "ascii");
  b.write(e.type, 156, 1, "ascii");
  if (e.linkname) b.write(e.linkname.slice(0, 100), 157, 100, "utf8");
  b.write("ustar\0", 257, 6, "ascii");
  b.write("00", 263, 2, "ascii");
  b.write("sandbox", 265, 32, "ascii");
  b.write("sandbox", 297, 32, "ascii");
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(octal(sum, 7)! + " ", 148, 8, "ascii");
  return b;
}

/** Header blocks for one entry (a pax header first when a field does not fit). */
export function tarHeader(e: TarEntry): Buffer[] {
  const typeflag = e.type === "file" ? "0" : e.type === "dir" ? "5" : "2";
  const name =
    e.type === "dir" && !e.name.endsWith("/") ? e.name + "/" : e.name;
  const pax: string[] = [];
  const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);
  if (Buffer.byteLength(name) > 100 || !ascii(name))
    pax.push(paxRecord("path", name));
  if (e.linkname && (Buffer.byteLength(e.linkname) > 100 || !ascii(e.linkname)))
    pax.push(paxRecord("linkpath", e.linkname));
  if (octal(e.size, 12) === undefined)
    pax.push(paxRecord("size", String(e.size)));
  const blocks: Buffer[] = [];
  if (pax.length) {
    const body = Buffer.from(pax.join(""), "utf8");
    blocks.push(
      header({
        name: "PaxHeader",
        type: "x",
        mode: 0o644,
        mtime: e.mtime,
        size: body.length,
      }),
      body,
      Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK),
    );
  }
  blocks.push(
    header({
      name,
      type: typeflag,
      mode: e.mode,
      mtime: e.mtime,
      size: e.type === "file" ? e.size : 0,
      linkname: e.linkname,
    }),
  );
  return blocks;
}

function parseOctal(b: Buffer) {
  if (b[0] & 0x80) {
    // base-256 (GNU); only what fits in a double
    let v = 0;
    for (let i = 1; i < b.length; i++) v = v * 256 + b[i];
    return v;
  }
  const s = b.toString("ascii").replace(/\0.*$/s, "").trim();
  return s ? parseInt(s, 8) : 0;
}

function cstr(b: Buffer) {
  const i = b.indexOf(0);
  return (i < 0 ? b : b.subarray(0, i)).toString("utf8");
}

function parsePax(body: Buffer) {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < body.length) {
    const sp = body.indexOf(0x20, pos);
    if (sp < 0) break;
    const len = parseInt(body.subarray(pos, sp).toString("ascii"), 10);
    if (!(len > 0) || pos + len > body.length) break;
    const rec = body.subarray(sp + 1, pos + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    pos += len;
  }
  return out;
}

/** Normalizes an archive member name; undefined when it is unsafe. */
export function safeMemberName(name: string, roots: string[]) {
  let n = name.replace(/\/+$/, "");
  while (n.startsWith("./")) n = n.slice(2);
  if (!n || n.startsWith("/") || n.includes("\0") || n.includes("\\"))
    return undefined;
  const parts = n.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return undefined;
  if (!roots.includes(parts[0])) return undefined;
  return parts.join("/");
}

interface ExtractState {
  entries: number;
  bytes: number;
  dirs: Array<{ abs: string; mode: number; mtime: number }>;
  links: Array<{ abs: string; target: string; rel: string }>;
  created: Set<string>;
}

/**
 * A Transform-free tar reader: feed it chunks, it writes entries below
 * `dest`. Kept as a small state machine so extraction streams with bounded
 * memory (one pax header at most).
 */
class TarExtractor {
  private buf: Buffer[] = [];
  private buffered = 0;
  private dest: string;
  private roots: string[];
  private maxBytes: number;
  private maxEntries: number;
  private state: ExtractState = {
    entries: 0,
    bytes: 0,
    dirs: [],
    links: [],
    created: new Set(),
  };
  // current file being written
  private fileFd: number | undefined;
  private fileLeft = 0;
  private skipLeft = 0;
  private padLeft = 0;
  private paxNext: Record<string, string> | undefined;
  private paxBody: Buffer[] | undefined;
  private paxLeft = 0;
  private fileMeta: { abs: string; mode: number; mtime: number } | undefined;
  private zeroBlocks = 0;
  ended = false;

  constructor(
    dest: string,
    roots: string[],
    maxBytes: number,
    maxEntries: number,
  ) {
    this.dest = dest;
    this.roots = roots;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  private take(n: number) {
    const all = this.buf.length === 1 ? this.buf[0] : Buffer.concat(this.buf);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.buf = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }

  /** Ensures `rel`'s parent directories exist as real directories we made. */
  private ensureParents(rel: string) {
    const parts = rel.split("/");
    let cur = this.dest;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = path.join(cur, parts[i]);
      this.mkdirReal(cur);
    }
  }

  private mkdirReal(abs: string) {
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(abs);
    } catch {}
    if (!st) {
      fs.mkdirSync(abs, { mode: 0o700 });
      return;
    }
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new SnapshotError("The snapshot has conflicting entries.");
  }

  private countEntry() {
    if (++this.state.entries > this.maxEntries)
      throw new SnapshotError("The snapshot has too many entries.");
  }

  private startEntry(h: Buffer) {
    const type = String.fromCharCode(h[156] || 0x30);
    let size = parseOctal(h.subarray(124, 136));
    const pax = this.paxNext;
    this.paxNext = undefined;
    if (type === "x") {
      if (size > 1024 * 1024) throw new SnapshotError("Bad snapshot header.");
      this.paxBody = [];
      this.paxLeft = size;
      this.padLeft = (BLOCK - (size % BLOCK)) % BLOCK;
      return;
    }
    if (type === "g") {
      this.skipLeft = size;
      this.padLeft = (BLOCK - (size % BLOCK)) % BLOCK;
      return;
    }
    if (pax?.size !== undefined) size = Number(pax.size);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new SnapshotError("Bad snapshot header.");
    const prefix = cstr(h.subarray(345, 500));
    const rawName =
      pax?.path ??
      (prefix
        ? `${prefix}/${cstr(h.subarray(0, 100))}`
        : cstr(h.subarray(0, 100)));
    const mode = parseOctal(h.subarray(100, 108)) & 0o777;
    const mtime = parseOctal(h.subarray(136, 148));
    const rel = safeMemberName(rawName, this.roots);
    if (!rel)
      throw new SnapshotError(
        `Unsafe name in snapshot: ${rawName.slice(0, 200)}`,
      );
    const abs = path.join(this.dest, rel);
    this.padLeft = 0;
    if (type === "5") {
      this.countEntry();
      this.ensureParents(rel);
      this.mkdirReal(abs);
      this.state.dirs.push({ abs, mode, mtime });
      this.skipLeft = size;
      this.padLeft = (BLOCK - (size % BLOCK)) % BLOCK;
      return;
    }
    if (type === "0" || type === "\0" || type === "7") {
      this.countEntry();
      this.state.bytes += size;
      if (this.state.bytes > this.maxBytes)
        throw new SnapshotError("The snapshot is larger than the limit.");
      if (this.state.created.has(abs))
        throw new SnapshotError("The snapshot has conflicting entries.");
      this.ensureParents(rel);
      this.fileFd = fs.openSync(
        abs,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      this.state.created.add(abs);
      this.fileMeta = { abs, mode, mtime };
      this.fileLeft = size;
      this.padLeft = (BLOCK - (size % BLOCK)) % BLOCK;
      if (size === 0) this.finishFile();
      return;
    }
    if (type === "2") {
      this.countEntry();
      const target = pax?.linkpath ?? cstr(h.subarray(157, 257));
      if (!target || target.includes("\0"))
        throw new SnapshotError("Bad symlink in snapshot.");
      this.ensureParents(rel);
      this.state.links.push({ abs, target, rel });
      this.skipLeft = size;
      return;
    }
    // Hard links, devices, FIFOs: never produced by tarStream.
    throw new SnapshotError("The snapshot contains an unsupported entry type.");
  }

  private finishFile() {
    if (this.fileFd === undefined) return;
    fs.closeSync(this.fileFd);
    this.fileFd = undefined;
    const m = this.fileMeta!;
    fs.chmodSync(m.abs, m.mode | 0o600); // the runner must read it for the next snapshot
    fs.utimesSync(m.abs, m.mtime, m.mtime);
  }

  write(chunk: Buffer) {
    if (this.ended) return;
    this.buf.push(chunk);
    this.buffered += chunk.length;
    for (;;) {
      if (this.fileFd !== undefined && this.fileLeft > 0) {
        if (!this.buffered) return;
        const data = this.take(Math.min(this.fileLeft, this.buffered));
        fs.writeSync(this.fileFd, data);
        this.fileLeft -= data.length;
        if (this.fileLeft === 0) this.finishFile();
        continue;
      }
      if (this.paxBody && this.paxLeft > 0) {
        if (!this.buffered) return;
        const data = this.take(Math.min(this.paxLeft, this.buffered));
        this.paxBody.push(Buffer.from(data));
        this.paxLeft -= data.length;
        if (this.paxLeft === 0) {
          this.paxNext = parsePax(Buffer.concat(this.paxBody));
          this.paxBody = undefined;
        }
        continue;
      }
      if (this.skipLeft > 0) {
        if (!this.buffered) return;
        this.skipLeft -= this.take(
          Math.min(this.skipLeft, this.buffered),
        ).length;
        continue;
      }
      if (this.padLeft > 0) {
        if (!this.buffered) return;
        this.padLeft -= this.take(Math.min(this.padLeft, this.buffered)).length;
        continue;
      }
      if (this.buffered < BLOCK) return;
      const h = this.take(BLOCK);
      if (h.equals(ZERO_BLOCK)) {
        if (++this.zeroBlocks >= 2) this.ended = true;
        if (this.ended) return;
        continue;
      }
      this.zeroBlocks = 0;
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
      if (sum !== parseOctal(h.subarray(148, 156)))
        throw new SnapshotError(
          "The snapshot is corrupt (bad header checksum).",
        );
      this.startEntry(h);
    }
  }

  finish() {
    if (this.fileFd !== undefined || this.paxBody || !this.ended)
      throw new SnapshotError("The snapshot is truncated.");
    // Links last, so no file above was written through one.
    for (const l of this.state.links) {
      let exists = this.state.created.has(l.abs);
      try {
        fs.lstatSync(l.abs);
        exists = true;
      } catch {}
      if (exists)
        throw new SnapshotError("The snapshot has conflicting entries.");
      fs.symlinkSync(l.target, l.abs);
      this.state.created.add(l.abs);
    }
    for (const d of this.state.dirs.reverse()) {
      fs.chmodSync(d.abs, d.mode | 0o700); // the runner must be able to clean up
      fs.utimesSync(d.abs, d.mtime, d.mtime);
    }
    return { entries: this.state.entries, bytes: this.state.bytes };
  }

  abort() {
    if (this.fileFd !== undefined) {
      try {
        fs.closeSync(this.fileFd);
      } catch {}
      this.fileFd = undefined;
    }
  }
}

/** Extracts a tar stream (already decompressed) below `dest`. */
export async function extractTar(
  source: AsyncIterable<Buffer>,
  dest: string,
  opts: { roots?: string[]; maxBytes?: number; maxEntries?: number } = {},
) {
  const roots = opts.roots ?? SNAPSHOT_ROOTS;
  checkRoots(roots);
  const x = new TarExtractor(
    dest,
    roots,
    opts.maxBytes ?? DEFAULT_MAX_BYTES,
    opts.maxEntries ?? DEFAULT_MAX_ENTRIES,
  );
  try {
    for await (const chunk of source) {
      x.write(chunk);
      if (x.ended) break;
    }
    return x.finish();
  } catch (error) {
    x.abort();
    throw error;
  }
}
