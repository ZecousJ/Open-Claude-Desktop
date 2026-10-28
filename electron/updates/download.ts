/**
 * Background download of an update: resumes a partial file with an HTTP Range
 * request, retries dropped connections with backoff and accepts the file only
 * when its SHA-256 matches the release's. No Electron imports, so tests run it
 * against a local server.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class ChecksumMismatch extends Error {
  constructor() {
    super("The downloaded update doesn't match its published checksum.");
    this.name = "ChecksumMismatch";
  }
}

class Fatal extends Error {}

export interface DownloadOptions {
  url: string;
  /** Where the verified file ends up. `<file>.part` holds a partial download. */
  file: string;
  /** Lower-case hex SHA-256 the file must have. */
  sha256: string;
  fetchImpl?: typeof fetch;
  /** Connection attempts before giving up (default 8). */
  attempts?: number;
  /** Wait before attempt `n` (1-based retry count). */
  backoffMs?: (retry: number) => number;
  /** A connection that sends nothing this long is dropped and resumed (default 60 s). */
  idleTimeoutMs?: number;
  onProgress?: (received: number, total: number | undefined) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

/** SHA-256 of a file, as lower-case hex. */
export async function fileSha256(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `Content-Range: bytes 100-199/1000` → 1000. */
function rangeTotal(header: string | null) {
  const match = /\/(\d+)\s*$/.exec(header ?? "");
  return match ? Number(match[1]) : undefined;
}

function size(file: string) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Downloads `url` to `file` and checks its SHA-256. A file already there
 * with the right checksum is kept; a partial download of the same address
 * and checksum resumes. Throws ChecksumMismatch (after deleting the file)
 * when the checksum differs.
 */
export async function downloadVerified(options: DownloadOptions) {
  const {
    url,
    file,
    fetchImpl = fetch,
    attempts = 8,
    backoffMs = (retry) => Math.min(60_000, 2_000 * 2 ** (retry - 1)),
    idleTimeoutMs = 60_000,
    sleep = defaultSleep,
  } = options;
  const sha256 = options.sha256.toLowerCase();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    if ((await fileSha256(file)) === sha256) return;
    fs.rmSync(file, { force: true });
  }
  const partial = `${file}.part`;
  const meta = `${file}.part.json`;
  // A partial download of another address or checksum starts over.
  try {
    const previous = JSON.parse(fs.readFileSync(meta, "utf8"));
    if (previous?.url !== url || previous?.sha256 !== sha256)
      fs.rmSync(partial, { force: true });
  } catch {
    fs.rmSync(partial, { force: true });
  }
  fs.writeFileSync(meta, JSON.stringify({ url, sha256 }));
  const insecureRedirect = (finalUrl: string) =>
    url.startsWith("https:") && !!finalUrl && !finalUrl.startsWith("https:");

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) throw new Error("The download was stopped.");
    if (attempt > 1) await sleep(backoffMs(attempt - 1));
    const offset = size(partial);
    const controller = new AbortController();
    const stop = () => controller.abort();
    options.signal?.addEventListener("abort", stop);
    let idle: NodeJS.Timeout | undefined;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(stop, idleTimeoutMs);
    };
    try {
      armIdle();
      const response = await fetchImpl(url, {
        headers: {
          "User-Agent": "Claudex updater",
          ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}),
        },
        redirect: "follow",
        signal: controller.signal,
      });
      if (insecureRedirect(response.url))
        throw new Fatal("The update download was redirected to http.");
      let total: number | undefined;
      let received = offset;
      let append = false;
      if (response.status === 416 && offset > 0) {
        // The partial file is already whole (or longer): check it below.
        await response.body?.cancel();
      } else if (response.status === 206 && offset > 0) {
        total = rangeTotal(response.headers.get("content-range"));
        append = true;
      } else if (response.status === 200) {
        const length = Number(response.headers.get("content-length"));
        total = Number.isFinite(length) && length > 0 ? length : undefined;
        received = 0;
      } else if (
        response.status === 429 ||
        response.status === 408 ||
        response.status >= 500
      ) {
        await response.body?.cancel();
        throw new Error(`The update server answered ${response.status}.`);
      } else {
        await response.body?.cancel();
        throw new Fatal(`The update server answered ${response.status}.`);
      }
      if (response.status !== 416) {
        if (!response.body) throw new Error("The update server sent nothing.");
        const out = fs.createWriteStream(partial, {
          flags: append ? "a" : "w",
        });
        try {
          const reader = response.body.getReader();
          options.onProgress?.(received, total);
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            armIdle();
            if (!out.write(value))
              await new Promise<void>((resolve) => out.once("drain", resolve));
            received += value.byteLength;
            options.onProgress?.(received, total);
          }
        } finally {
          await new Promise<void>((resolve, reject) =>
            out.end((error?: Error | null) =>
              error ? reject(error) : resolve(),
            ),
          );
        }
        if (total !== undefined && size(partial) < total)
          throw new Error("The update download was interrupted.");
      }
      clearTimeout(idle);
      if ((await fileSha256(partial)) !== sha256) {
        fs.rmSync(partial, { force: true });
        fs.rmSync(meta, { force: true });
        throw new ChecksumMismatch();
      }
      fs.renameSync(partial, file);
      fs.rmSync(meta, { force: true });
      return;
    } catch (error) {
      if (error instanceof ChecksumMismatch || error instanceof Fatal)
        throw error;
      if (options.signal?.aborted) throw new Error("The download was stopped.");
      lastError = error;
    } finally {
      clearTimeout(idle);
      options.signal?.removeEventListener("abort", stop);
    }
  }
  throw new Error(
    `The update couldn't be downloaded: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
