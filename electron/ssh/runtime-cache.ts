/**
 * The Codex engine packages Claudex keeps on this computer for SSH hosts that
 * can't download them themselves (R9-S2).
 *
 * `shared/codex-runtime-manifest.json` names every platform build of the
 * bundled engine with its npm URL and sha512. A package is fetched from the
 * administrator's mirror first when there is one, then from npm; the download
 * resumes where it stopped after a dropped connection, and a file only enters
 * the cache (<dataRoot>/runtime-cache/) once its sha512 matches the manifest. A
 * mirror can change where a package comes from, never what it holds.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bundledManifest from "../../shared/codex-runtime-manifest.json";

export interface RuntimePackage {
  /** The Rust target the package's vendor folder is named after. */
  triple: string;
  /** The Codex version, for example "0.144.1". */
  version: string;
  /** "linux", "darwin" or "win32". */
  os: string;
  /** "x64" or "arm64". */
  arch: string;
  npmPackage: string;
  /** Where npm serves the package. */
  url: string;
  /** "sha512-<base64>" from package-lock.json. */
  integrity: string;
}

export interface RuntimeManifest {
  version: string;
  platforms: Record<string, RuntimePackage>;
}

export const RUNTIME_CACHE_DIR = "runtime-cache";
const NPM_REGISTRY = "https://registry.npmjs.org/";
/** Largest package accepted (the Windows build is about 145 MB). */
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TRIPLE = /^[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(?:-[a-z0-9_]+)?$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

/**
 * An address a package may be fetched from: https, or plain http to this
 * computer's own loopback (tests and local mirrors). The sha512 check is
 * what makes a download trusted; this only keeps odd schemes and shell
 * syntax out.
 */
export function checkDownloadUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The Codex runtime address isn't a valid URL.");
  }
  const loopback =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !loopback)
    throw new Error("The Codex runtime address must use https.");
  if (url.username || url.password)
    throw new Error("The Codex runtime address can't hold a user name.");
  if (!/^[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$/.test(value) || value.length > 2048)
    throw new Error("The Codex runtime address has characters it can't use.");
  return value;
}

/** Checks a manifest's shape; throws on anything unexpected. */
export function parseManifest(value: unknown): RuntimeManifest {
  const input = value as {
    version?: unknown;
    platforms?: Record<string, Record<string, unknown>>;
  };
  if (
    !input ||
    typeof input.version !== "string" ||
    !VERSION.test(input.version) ||
    !input.platforms ||
    typeof input.platforms !== "object"
  )
    throw new Error("The Codex runtime manifest is damaged.");
  const platforms: Record<string, RuntimePackage> = {};
  for (const [triple, entry] of Object.entries(input.platforms)) {
    if (
      !TRIPLE.test(triple) ||
      !entry ||
      typeof entry.os !== "string" ||
      typeof entry.arch !== "string" ||
      typeof entry.npmPackage !== "string" ||
      typeof entry.url !== "string" ||
      typeof entry.integrity !== "string" ||
      !INTEGRITY.test(entry.integrity)
    )
      throw new Error("The Codex runtime manifest is damaged.");
    platforms[triple] = {
      triple,
      version: input.version,
      os: entry.os,
      arch: entry.arch,
      npmPackage: entry.npmPackage,
      url: checkDownloadUrl(entry.url),
      integrity: entry.integrity,
    };
  }
  return { version: input.version, platforms };
}

let bundled: RuntimeManifest | undefined;
/** The manifest built into this version of Claudex. */
export function runtimeManifest(): RuntimeManifest {
  bundled ??= parseManifest(bundledManifest);
  return bundled;
}

/** The manifest's sha512 as 128 lowercase hex characters. */
export function integrityHex(integrity: string): string {
  if (!INTEGRITY.test(integrity))
    throw new Error("The Codex runtime checksum is damaged.");
  return Buffer.from(integrity.slice("sha512-".length), "base64").toString(
    "hex",
  );
}

/**
 * Where to fetch a package, in order: the administrator's mirror (an https
 * prefix that stands in for https://registry.npmjs.org/), then npm.
 */
export function downloadUrls(
  pkg: Pick<RuntimePackage, "url">,
  mirror?: string | null,
): string[] {
  const urls: string[] = [];
  if (mirror && pkg.url.startsWith(NPM_REGISTRY)) {
    try {
      const prefix = mirror.endsWith("/") ? mirror : `${mirror}/`;
      const mirrored = prefix + pkg.url.slice(NPM_REGISTRY.length);
      if (new URL(prefix).protocol === "https:")
        urls.push(checkDownloadUrl(mirrored));
    } catch {
      // A mirror address that can't be used falls back to npm.
    }
  }
  urls.push(checkDownloadUrl(pkg.url));
  return urls;
}

/** The package's file name: codex-<version>-<triple>.tgz. */
export function packageFileName(
  pkg: Pick<RuntimePackage, "version" | "triple">,
) {
  if (!VERSION.test(pkg.version) || !TRIPLE.test(pkg.triple))
    throw new Error("The Codex runtime manifest is damaged.");
  return `codex-${pkg.version}-${pkg.triple}.tgz`;
}

export async function fileSha512Hex(file: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export type FetchFn = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

export interface RuntimeCacheOptions {
  /** <dataRoot>/runtime-cache */
  dir: string;
  fetch?: FetchFn;
  /** Attempts per address (default 5). */
  attempts?: number;
  /** Delay before retry n (1-based), in ms. */
  backoff?: (attempt: number) => number;
  /** Gives up on a download that sends nothing for this long (default 60 s). */
  idleTimeoutMs?: number;
}

export interface EnsureOptions {
  mirror?: string | null;
  /** Bytes so far and the total when known. */
  onProgress?: (received: number, total: number | undefined) => void;
  signal?: AbortSignal;
}

class DownloadError extends Error {
  constructor(
    message: string,
    /** Retrying the same address won't help. */
    readonly final = false,
  ) {
    super(message);
  }
}

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("The download was cancelled."));
      },
      { once: true },
    );
  });

export class RuntimeCache {
  private readonly pending = new Map<string, Promise<string>>();
  private readonly fetchFn: FetchFn;

  constructor(private readonly options: RuntimeCacheOptions) {
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Where a package lives once it is cached. */
  file(pkg: Pick<RuntimePackage, "version" | "triple">) {
    return path.join(this.options.dir, packageFileName(pkg));
  }

  /**
   * The cached package, downloaded first when it is missing or its sha512
   * no longer matches. Two calls for one package share one download.
   */
  ensure(pkg: RuntimePackage, options: EnsureOptions = {}): Promise<string> {
    const file = this.file(pkg);
    let job = this.pending.get(file);
    if (!job) {
      job = this.fetchPackage(pkg, file, options).finally(() =>
        this.pending.delete(file),
      );
      this.pending.set(file, job);
    }
    return job;
  }

  private async fetchPackage(
    pkg: RuntimePackage,
    file: string,
    options: EnsureOptions,
  ): Promise<string> {
    const expected = integrityHex(pkg.integrity);
    fs.mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
      if ((await fileSha512Hex(file)) === expected) {
        this.prune(pkg);
        return file;
      }
      fs.rmSync(file, { force: true });
    }
    const partial = `${file}.partial`;
    const attempts = this.options.attempts ?? 5;
    const backoff =
      this.options.backoff ??
      ((attempt: number) => Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
    let lastError: Error | undefined;
    for (const url of downloadUrls(pkg, options.mirror)) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (options.signal?.aborted)
          throw new Error("The download was cancelled.");
        try {
          const resumed = await this.download(url, partial, options);
          if ((await fileSha512Hex(partial)) !== expected) {
            fs.rmSync(partial, { force: true });
            // A resumed file may have been damaged before: start over. A
            // whole download that doesn't match means the address serves
            // something else: try the next one.
            throw new DownloadError(
              "The downloaded Codex runtime didn't match its checksum.",
              !resumed,
            );
          }
          fs.renameSync(partial, file);
          this.prune(pkg);
          return file;
        } catch (error) {
          lastError = error as Error;
          if (options.signal?.aborted)
            throw new Error("The download was cancelled.");
          if (error instanceof DownloadError && error.final) break;
          if (attempt < attempts) await delay(backoff(attempt), options.signal);
        }
      }
    }
    throw new Error(
      lastError?.message ?? "Couldn't download the Codex runtime.",
    );
  }

  /**
   * One attempt: continues a partial file when the server allows ranges.
   * True when the result includes bytes from an earlier attempt.
   */
  private async download(
    url: string,
    partial: string,
    options: EnsureOptions,
  ): Promise<boolean> {
    let offset = 0;
    try {
      offset = fs.statSync(partial).size;
    } catch {
      // Starting fresh.
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const idle = this.options.idleTimeoutMs ?? 60_000;
    let timer = setTimeout(abort, idle);
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(abort, idle);
    };
    try {
      const response = await this.fetchFn(url, {
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
        signal: controller.signal,
      });
      if (response.status === 416 && offset > 0) {
        // Everything is here already (or the partial file is wrong: the
        // checksum decides, and a mismatch starts over).
        await response.body?.cancel();
        return true;
      }
      let append = false;
      let total: number | undefined;
      if (response.status === 206 && offset > 0) {
        const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(
          response.headers.get("content-range") ?? "",
        );
        if (!range || Number(range[1]) !== offset) {
          await response.body?.cancel();
          fs.rmSync(partial, { force: true });
          throw new DownloadError("The download server sent the wrong range.");
        }
        append = true;
        total = Number(range[2]);
      } else if (response.status === 200) {
        const length = Number(response.headers.get("content-length"));
        total = Number.isFinite(length) && length > 0 ? length : undefined;
      } else {
        await response.body?.cancel();
        throw new DownloadError(
          `The download server answered ${response.status}.`,
          response.status === 404 || response.status === 403,
        );
      }
      if (total !== undefined && total > MAX_PACKAGE_BYTES)
        throw new DownloadError(
          "The Codex runtime package is too large.",
          true,
        );
      if (!response.body) throw new DownloadError("The download was empty.");
      let received = append ? offset : 0;
      const out = fs.createWriteStream(partial, {
        flags: append ? "a" : "w",
        mode: 0o600,
      });
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          touch();
          received += chunk.length;
          if (received > MAX_PACKAGE_BYTES)
            throw new DownloadError(
              "The Codex runtime package is too large.",
              true,
            );
          if (!out.write(chunk))
            await new Promise<void>((resolve) => out.once("drain", resolve));
          options.onProgress?.(received, total);
        }
      } finally {
        await new Promise<void>((resolve) => out.end(resolve));
      }
      if (total !== undefined && received !== total)
        throw new DownloadError("The download stopped early.");
      return append;
    } catch (error) {
      if (error instanceof DownloadError) throw error;
      throw new DownloadError(
        controller.signal.aborted && !options.signal?.aborted
          ? "The download stalled."
          : "The download failed.",
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  /** Removes other versions' packages (the app only ever uses one). */
  private prune(keep: Pick<RuntimePackage, "version">) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.options.dir);
    } catch {
      return;
    }
    const prefix = `codex-${keep.version}-`;
    for (const name of names)
      if (
        name.startsWith("codex-") &&
        !name.startsWith(prefix) &&
        (name.endsWith(".tgz") || name.endsWith(".tgz.partial"))
      )
        fs.rmSync(path.join(this.options.dir, name), { force: true });
  }
}
