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
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { SnapshotError, checkKey } from "./snapshot-common.ts";
import type { SnapshotStore } from "./snapshot-common.ts";

// --- S3 (SigV4) -----------------------------------------------------------

export interface S3Config {
  /** e.g. https://<account id>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  /** R2 uses "auto". */
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix inside the bucket, e.g. "snapshots/". */
  prefix?: string;
  /** Multipart part size in bytes (default 64 MiB; single PUT below it). */
  partSize?: number;
  /** Attempts per request (network errors, 429 and 5xx are retried). */
  attempts?: number;
  fetch?: typeof fetch;
}

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** RFC 3986 encoding as S3 expects (also encodes !'()*). */
export function s3Encode(s: string, keepSlash = false) {
  const enc = encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return keepSlash ? enc.replace(/%2F/g, "/") : enc;
}

function hmac(key: Buffer | string, data: string) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * AWS Signature Version 4 for S3. `url` must already have its path encoded
 * with `s3Encode(…, true)`. Returns the headers to send (the given ones plus
 * x-amz-date, x-amz-content-sha256 and Authorization).
 */
export function signS3(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  date?: Date;
}) {
  const u = new URL(input.url);
  const amzDate = (input.date ?? new Date())
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {}))
    headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  headers.host = u.host;
  headers["x-amz-date"] = amzDate;
  headers["x-amz-content-sha256"] = input.payloadHash;
  const names = Object.keys(headers).sort();
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [s3Encode(k), s3Encode(v)])
    .sort((a, b) =>
      a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1,
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    input.method,
    u.pathname || "/",
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    names.join(";"),
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    crypto.createHash("sha256").update(canonical, "utf8").digest("hex"),
  ].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, input.region), "s3"), "aws4_request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(toSign, "utf8")
    .digest("hex");
  const out: Record<string, string> = { ...headers };
  delete out.host; // fetch sets it
  out.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return { headers: out, canonical, signature };
}

/** Snapshots in S3-compatible storage (Cloudflare R2 recommended, plan Q30). */
export class S3SnapshotStore implements SnapshotStore {
  readonly kind = "s3" as const;
  private cfg: Required<Omit<S3Config, "fetch" | "prefix">> & {
    prefix: string;
    fetch: typeof fetch;
  };
  constructor(cfg: S3Config) {
    const endpoint = cfg.endpoint.replace(/\/+$/, "");
    const u = new URL(endpoint);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
      throw new SnapshotError("Object storage must use HTTPS.");
    if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(cfg.bucket))
      throw new SnapshotError("Bad bucket name.");
    if (!cfg.accessKeyId || !cfg.secretAccessKey)
      throw new SnapshotError("Object storage credentials are missing.");
    this.cfg = {
      endpoint,
      bucket: cfg.bucket,
      region: cfg.region ?? "auto",
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      prefix: cfg.prefix ?? "",
      partSize: Math.max(5 * 1024 * 1024, cfg.partSize ?? 64 * 1024 * 1024),
      attempts: Math.max(1, cfg.attempts ?? 5),
      fetch: cfg.fetch ?? fetch,
    };
    if (this.cfg.prefix) checkKey(this.cfg.prefix.replace(/\/$/, ""));
  }

  /** Never prints the secret. */
  toJSON() {
    return {
      kind: this.kind,
      endpoint: this.cfg.endpoint,
      bucket: this.cfg.bucket,
      prefix: this.cfg.prefix,
    };
  }

  private url(key: string, query = "") {
    const full = this.cfg.prefix + checkKey(key);
    return `${this.cfg.endpoint}/${this.cfg.bucket}/${s3Encode(full, true)}${query}`;
  }

  private async request(
    method: string,
    url: string,
    body?: Buffer,
    extra: Record<string, string> = {},
    okStatuses: number[] = [200],
  ) {
    const payloadHash = body
      ? crypto.createHash("sha256").update(body).digest("hex")
      : EMPTY_SHA256;
    let lastError = "";
    for (let attempt = 1; attempt <= this.cfg.attempts; attempt++) {
      const { headers } = signS3({
        method,
        url,
        headers: body
          ? { ...extra, "content-length": String(body.length) }
          : extra,
        payloadHash,
        accessKeyId: this.cfg.accessKeyId,
        secretAccessKey: this.cfg.secretAccessKey,
        region: this.cfg.region,
      });
      delete headers["content-length"]; // fetch computes it from the body
      try {
        const res = await this.cfg.fetch(url, {
          method,
          headers,
          body: body ? new Uint8Array(body) : undefined,
        });
        if (okStatuses.includes(res.status)) return res;
        const text = (await res.text().catch(() => "")).slice(0, 300);
        lastError = `HTTP ${res.status}${text ? `: ${text.replace(/\s+/g, " ")}` : ""}`;
        if (res.status !== 429 && res.status < 500)
          throw new SnapshotError(
            `Object storage refused ${method}: ${lastError}`,
          );
      } catch (error) {
        if (error instanceof SnapshotError) throw error;
        lastError = (error as Error).message;
      }
      if (attempt < this.cfg.attempts)
        await new Promise((r) =>
          setTimeout(r, Math.min(8000, 250 * 2 ** attempt)),
        );
    }
    throw new SnapshotError(`Object storage ${method} failed: ${lastError}`);
  }

  async put(key: string, file: string, contentType = "application/zstd") {
    const size = fs.statSync(file).size;
    if (size <= this.cfg.partSize) {
      const res = await this.request(
        "PUT",
        this.url(key),
        fs.readFileSync(file),
        {
          "content-type": contentType,
        },
      );
      await res.arrayBuffer().catch(() => undefined);
      return;
    }
    // Multipart upload, one part in memory at a time.
    const init = await this.request(
      "POST",
      this.url(key, "?uploads"),
      undefined,
      {
        "content-type": contentType,
      },
    );
    const initXml = await init.text();
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(initXml)?.[1];
    if (!uploadId)
      throw new SnapshotError("Object storage did not start the upload.");
    const q = (extra: string) =>
      `?${extra}${extra ? "&" : ""}uploadId=${s3Encode(uploadId)}`;
    const etags: string[] = [];
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(this.cfg.partSize);
      for (let part = 1, offset = 0; offset < size; part++) {
        const n = fs.readSync(
          fd,
          buf,
          0,
          Math.min(buf.length, size - offset),
          offset,
        );
        offset += n;
        const res = await this.request(
          "PUT",
          this.url(key, q(`partNumber=${part}`)),
          Buffer.from(buf.subarray(0, n)),
        );
        const etag = res.headers.get("etag");
        await res.arrayBuffer().catch(() => undefined);
        if (!etag) throw new SnapshotError("Object storage returned no ETag.");
        etags.push(etag);
      }
      const xml =
        "<CompleteMultipartUpload>" +
        etags
          .map(
            (e, i) =>
              `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</ETag></Part>`,
          )
          .join("") +
        "</CompleteMultipartUpload>";
      const done = await this.request(
        "POST",
        this.url(key, q("")),
        Buffer.from(xml),
        { "content-type": "application/xml" },
      );
      const doneText = await done.text();
      if (/<Error>/.test(doneText))
        throw new SnapshotError("Object storage could not finish the upload.");
    } catch (error) {
      await this.request(
        "DELETE",
        this.url(key, q("")),
        undefined,
        {},
        [200, 204, 404],
      ).catch(() => {});
      throw error;
    } finally {
      fs.closeSync(fd);
    }
  }

  async get(key: string, file: string) {
    const res = await this.request(
      "GET",
      this.url(key),
      undefined,
      {},
      [200, 404],
    );
    if (res.status === 404 || !res.body)
      throw new SnapshotError("The snapshot was not found.");
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await pipeline(
        Readable.fromWeb(res.body as WebReadableStream),
        fs.createWriteStream(tmp, { mode: 0o600 }),
      );
      fs.renameSync(tmp, file);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw new SnapshotError(
        `Snapshot download failed: ${(error as Error).message}`,
      );
    }
  }

  async exists(key: string) {
    const res = await this.request(
      "HEAD",
      this.url(key),
      undefined,
      {},
      [200, 404],
    );
    return res.status === 200;
  }

  async delete(key: string) {
    const res = await this.request(
      "DELETE",
      this.url(key),
      undefined,
      {},
      [200, 204, 404],
    );
    await res.arrayBuffer().catch(() => undefined);
  }
}
