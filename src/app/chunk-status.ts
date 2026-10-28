/**
 * What a script or stylesheet that did not load says about the build, after the
 * original's chunk recovery: the status of the failed file (the one the browser
 * recorded, else the server is asked again), where a 404 or 410 means "Claude
 * was updated"; and, in Chromium, whether the script itself arrived and only
 * something it imports failed. Shared by each lazily loaded piece
 * (src/app/chunk-recovery.ts) and the web's stale-build reload
 * (src-web/stale-build.ts); calls for one file while one is in flight share it.
 */

/** The original gives the server 2.5 s to answer before giving up. */
const PROBE_TIMEOUT_MS = 2500;

const assetUrl = /\b(https?:\/\/[^\s'"()<>]+?\.(?:m?js|css))(?=[?#\s'")<>]|$)/i;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

/**
 * The address of the file a failed dynamic import or stylesheet preload
 * names in its message (Chromium and Firefox name it; Safari does not), on
 * this page's own origin.
 */
export function failedAssetUrl(error: unknown): string | undefined {
  const match = assetUrl.exec(messageOf(error));
  if (!match) return undefined;
  try {
    const url = new URL(match[1]);
    if (typeof location !== "undefined" && url.origin !== location.origin)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** A script (not a stylesheet) that a fresh import can be pointed at. */
export function failedScriptUrl(error: unknown): string | undefined {
  const url = failedAssetUrl(error);
  return url && /\.m?js$/i.test(new URL(url).pathname) ? url : undefined;
}

/** A stylesheet the piece needs did not load (Vite's preload message). */
export function isStylesheetFailure(error: unknown): boolean {
  return /Unable to preload CSS|Loading CSS chunk/i.test(messageOf(error));
}

const asking = new Map<string, Promise<number | undefined>>();

/**
 * The HTTP status the server answers for `url` now, or undefined when it
 * cannot be asked (offline, timed out, a local file). Calls for the same
 * address while one is in flight share it.
 */
export function probeStatus(url: string): Promise<number | undefined> {
  if (!/^https?:/i.test(url) || typeof fetch !== "function")
    return Promise.resolve(undefined);
  const known = asking.get(url);
  if (known) return known;
  const controller =
    typeof AbortController === "function" ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = Promise.race([
    fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller?.signal,
    }).then(
      (response) => response.status,
      () => undefined,
    ),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller?.abort();
        resolve(undefined);
      }, PROBE_TIMEOUT_MS);
    }),
  ]).finally(() => {
    clearTimeout(timer);
    asking.delete(url);
  });
  asking.set(url, answer);
  return answer;
}

/** The original's test for a file a newer build removed. */
export function isGoneStatus(status: number | undefined): boolean {
  return status === 404 || status === 410;
}

/**
 * The scripts this page started from. Safari names no file in a failed
 * import, so there the page's own address is asked for again and the
 * scripts it starts from now are compared with these: different scripts are
 * a newer build.
 */
function entryScripts(html: string): string[] {
  const found: string[] = [];
  const tag = /<script\b[^>]*\btype=["']?module["']?[^>]*>/gi;
  for (const [element] of html.matchAll(tag)) {
    const src = /\bsrc=["']?([^"'\s>]+)/i.exec(element)?.[1];
    if (src) found.push(src);
  }
  return found;
}

async function entryChanged(): Promise<boolean | undefined> {
  if (typeof document === "undefined" || !/^https?:/i.test(location.href))
    return undefined;
  const running = Array.from(
    document.querySelectorAll<HTMLScriptElement>("script[type=module][src]"),
    (script) => script.getAttribute("src") ?? "",
  ).filter(Boolean);
  if (!running.length) return undefined;
  try {
    const response = await fetch(location.href, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return undefined;
    const served = entryScripts(await response.text());
    if (!served.length) return undefined;
    return running.some((src) => !served.includes(src));
  } catch {
    return undefined;
  }
}

/**
 * The status the browser recorded for the failed request itself (Resource
 * Timing's responseStatus, where the browser has it), which the original
 * reads before asking the server again.
 */
function recordedStatus(url: string): number | undefined {
  if (
    typeof performance === "undefined" ||
    typeof performance.getEntriesByName !== "function"
  )
    return undefined;
  const entries = performance.getEntriesByName(url) as (PerformanceEntry & {
    responseStatus?: number;
    initiatorType?: string;
  })[];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.initiatorType === "fetch") continue;
    const status = entry.responseStatus;
    if (typeof status === "number" && status > 0) return status;
  }
  return undefined;
}

/**
 * Whether the browser holds the failed script itself (live: `Lx`, a
 * modulepreload of the same address, Chromium only, 800 ms): "load" means
 * the script arrived and something it imports failed; "error" means the
 * script itself is what failed.
 */
function preloadProbe(url: string): Promise<"load" | "error" | "unknown"> {
  const chromium =
    typeof navigator !== "undefined" &&
    (navigator as Navigator & { userAgentData?: unknown }).userAgentData !==
      undefined;
  if (!chromium || typeof document === "undefined")
    return Promise.resolve("unknown");
  try {
    if (!document.createElement("link").relList.supports("modulepreload"))
      return Promise.resolve("unknown");
  } catch {
    return Promise.resolve("unknown");
  }
  return new Promise((resolve) => {
    const link = document.createElement("link");
    const done = (outcome: "load" | "error" | "unknown") => {
      clearTimeout(timer);
      link.remove();
      resolve(outcome);
    };
    const timer = setTimeout(() => done("unknown"), 800);
    link.rel = "modulepreload";
    link.crossOrigin = "";
    link.href = url;
    link.addEventListener("load", () => done("load"));
    link.addEventListener("error", () => done("error"));
    document.head.appendChild(link);
  });
}

/**
 * Whether a newer build replaced the file a failure names (or, with no
 * file named, the page's entry scripts).
 */
export async function buildReplaced(error: unknown): Promise<boolean> {
  const url = failedAssetUrl(error);
  if (url) return isGoneStatus(recordedStatus(url) ?? (await probeStatus(url)));
  return (await entryChanged()) === true;
}

/** What a failed load says, as far as it can be told. */
export type AssetVerdict = "updated" | "dependency" | "unknown";

/**
 * Asks about a failed load: "updated" when a newer build replaced the
 * file, "dependency" when the script itself arrived and something it needs
 * failed (a retry of the same script cannot help), "unknown" otherwise.
 */
export async function assetVerdict(error: unknown): Promise<AssetVerdict> {
  if (await buildReplaced(error)) return "updated";
  const url = failedScriptUrl(error);
  if (url && (await preloadProbe(url)) === "load") return "dependency";
  return "unknown";
}
