/**
 * Site icons for web search results and citations (R5, design R45 §3.4).
 *
 * The main process asks a site for `https://<host>/favicon.ico` only where
 * the administrator allows remote images from that host, without cookies or
 * a referrer, and never through a redirect to plain http, to an address on
 * this computer or the local network, or to a host the policy refuses. No
 * third-party icon service is used, so no one else learns which results
 * the person looked at. Icons are kept as data URLs in the account's folder
 * for 7 days (a failure for a day), so each site is asked at most once a
 * week; anything that fails leaves the window's initial-letter placeholder.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { remoteImageAllowed } from "../../shared/external-links";
import type { ClientPolicy } from "../../shared/client-policy";

/** Largest icon accepted. */
export const maxFaviconBytes = 64 * 1024;
export const faviconTimeoutMs = 5000;
export const faviconTtlMs = 7 * 24 * 60 * 60 * 1000;
export const faviconFailureTtlMs = 24 * 60 * 60 * 1000;
const maxRedirects = 3;
const maxConcurrent = 6;

export type IconPolicy = Pick<
  ClientPolicy,
  "remoteImages" | "remoteImageDomains"
>;

/** One icon download: the body when the site answered 200, else null. */
export type FetchIcon = (
  url: string,
  options: {
    signal: AbortSignal;
    maxBytes: number;
    /** Whether a redirect to this address may be followed. */
    allowRedirect(url: string): boolean;
  },
) => Promise<{ status: number; body: Buffer } | null>;

const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const privateSuffixes = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".home.arpa",
  ".intranet",
  ".corp",
];

/**
 * A public DNS host name (lowercase, ASCII or punycode, at least two
 * labels); undefined for IP addresses, ports, paths and local names.
 */
export function publicHost(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 253) return;
  let host: string;
  try {
    const url = new URL(`https://${value}/`);
    if (url.port || url.username || url.password || url.pathname !== "/")
      return;
    host = url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return;
  }
  if (host !== value.toLowerCase().replace(/\.$/, "")) return;
  if (ipv4.test(host) || host.includes(":") || host.startsWith("[")) return;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((part) => label.test(part))) return;
  if (/^\d+$/.test(labels.at(-1)!)) return;
  if (
    host === "localhost" ||
    privateSuffixes.some((suffix) => host.endsWith(suffix))
  )
    return;
  return host;
}

/** The image type of an icon's bytes; SVG and anything unknown are refused. */
export function sniffIconType(body: Buffer): string | undefined {
  if (body.length < 4) return;
  if (body[0] === 0 && body[1] === 0 && body[2] === 1 && body[3] === 0)
    return "image/x-icon";
  if (
    body.length >= 8 &&
    body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (body.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)
    return "image/jpeg";
  if (
    body.length >= 12 &&
    body.subarray(0, 4).toString("latin1") === "RIFF" &&
    body.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return undefined;
}

interface CacheEntry {
  host: string;
  fetchedAt: number;
  icon: string | null;
}

export class FaviconService {
  private memory = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<string | null>>();
  private running = 0;
  private queue: (() => void)[] = [];
  readonly folder: string;
  constructor(
    accountRoot: string,
    private fetchIcon: FetchIcon,
    private now: () => number = Date.now,
  ) {
    this.folder = path.join(accountRoot, "favicons");
  }

  private file(host: string) {
    return path.join(
      this.folder,
      `${createHash("sha256").update(host).digest("hex").slice(0, 32)}.json`,
    );
  }
  private fresh(entry: CacheEntry | undefined) {
    if (!entry) return false;
    const age = this.now() - entry.fetchedAt;
    return age >= 0 && age < (entry.icon ? faviconTtlMs : faviconFailureTtlMs);
  }
  private cached(host: string): CacheEntry | undefined {
    const known = this.memory.get(host);
    if (known) return known;
    try {
      const entry = JSON.parse(
        fs.readFileSync(this.file(host), "utf8"),
      ) as CacheEntry;
      if (
        entry?.host === host &&
        typeof entry.fetchedAt === "number" &&
        (entry.icon === null ||
          (typeof entry.icon === "string" &&
            /^data:image\/(x-icon|png|gif|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(
              entry.icon,
            )))
      ) {
        this.memory.set(host, entry);
        return entry;
      }
    } catch {
      // Not cached yet, or unreadable: ask the site.
    }
    return undefined;
  }
  private remember(host: string, icon: string | null) {
    const entry: CacheEntry = { host, fetchedAt: this.now(), icon };
    this.memory.set(host, entry);
    try {
      fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file(host), JSON.stringify(entry), { mode: 0o600 });
    } catch {
      // Kept in memory for this session.
    }
  }
  private async slot<T>(run: () => Promise<T>): Promise<T> {
    if (this.running >= maxConcurrent)
      await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
    try {
      return await run();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
  private async download(host: string, policy: IconPolicy) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), faviconTimeoutMs);
    try {
      const response = await this.fetchIcon(`https://${host}/favicon.ico`, {
        signal: controller.signal,
        maxBytes: maxFaviconBytes,
        allowRedirect: (url) => redirectAllowed(url, policy),
      });
      if (!response || response.status !== 200) return null;
      if (!response.body.length || response.body.length > maxFaviconBytes)
        return null;
      const type = sniffIconType(response.body);
      return type
        ? `data:${type};base64,${response.body.toString("base64")}`
        : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  /** One host's icon, from the cache or the site; null for the placeholder. */
  async icon(rawHost: string, policy: IconPolicy): Promise<string | null> {
    const host = publicHost(rawHost);
    if (!host || !remoteImageAllowed(`https://${host}/favicon.ico`, policy))
      return null;
    const entry = this.cached(host);
    if (this.fresh(entry)) return entry!.icon;
    const running = this.inflight.get(host);
    if (running) return running;
    const task = this.slot(() => this.download(host, policy))
      .then((icon) => {
        this.remember(host, icon);
        return icon;
      })
      .finally(() => this.inflight.delete(host));
    this.inflight.set(host, task);
    return task;
  }
  /** Icons for several hosts, keyed by the host as asked. */
  async icons(hosts: string[], policy: IconPolicy) {
    const unique = [...new Set(hosts)];
    const icons = await Promise.all(
      unique.map((host) => this.icon(host, policy)),
    );
    return Object.fromEntries(
      unique.map((host, index) => [host, icons[index]]),
    ) as Record<string, string | null>;
  }
}

/** A redirect may go only to https on a public host the policy allows. */
export function redirectAllowed(url: string, policy: IconPolicy) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      return false;
    if (parsed.port && parsed.port !== "443") return false;
    const host = publicHost(parsed.hostname);
    return !!host && remoteImageAllowed(parsed.href, policy);
  } catch {
    return false;
  }
}

/**
 * Downloads with Electron's network stack (the system proxy applies) in a
 * separate in-memory session: no cookies, no cache on disk, no referrer,
 * and each redirect checked before it is followed.
 */
export function electronFetchIcon(): FetchIcon {
  return async (url, options) => {
    const electron = await import("electron");
    const net = electron.net;
    return new Promise((resolve) => {
      let redirects = 0;
      let settled = false;
      const finish = (value: { status: number; body: Buffer } | null) => {
        if (settled) return;
        settled = true;
        options.signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const request = net.request({
        url,
        method: "GET",
        partition: "claudex-favicons",
        credentials: "omit",
        useSessionCookies: false,
        redirect: "manual",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      const abort = () => {
        request.abort();
        finish(null);
      };
      options.signal.addEventListener("abort", abort);
      request.on("redirect", (_status, _method, redirectUrl) => {
        if (++redirects > maxRedirects || !options.allowRedirect(redirectUrl))
          abort();
        else request.followRedirect();
      });
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const length = Number(response.headers["content-length"]);
        if (response.statusCode !== 200 || length > options.maxBytes) {
          abort();
          return;
        }
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) abort();
          else chunks.push(chunk);
        });
        response.on("end", () =>
          finish({ status: response.statusCode, body: Buffer.concat(chunks) }),
        );
        response.on("error", () => finish(null));
      });
      request.on("error", () => finish(null));
      request.end();
    });
  };
}
