/**
 * Site icons for search results and citation cards (R5, design R45 §3.4).
 *
 * The main process fetches `https://<host>/favicon.ico` only where the
 * administrator allows remote images, and answers data URLs (null for the
 * initial-letter placeholder). The window asks once per host per session:
 * hosts requested in the same tick go in one call of at most 50, and every
 * component showing a host re-renders when its icon arrives. With remote
 * images off nothing is asked and every host shows the placeholder.
 */
import { useContext, useEffect, useReducer } from "react";
import { maxFaviconHosts } from "../../shared/favicon-api";
import { usePolicy } from "../policy/PolicyContext";
import { AppContext } from "../app/AppContext";

type Bridge = { getFavicons?: (hosts: string[]) => Promise<unknown> };

// Only raster images the main process can answer; never SVG or HTML.
const iconUrl =
  /^data:image\/(x-icon|png|gif|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
// A host name as `new URL(url).hostname` gives it.
const hostName = /^[a-z0-9.-]{1,253}$/;

const icons = new Map<string, string | null>();
const asked = new Set<string>();
let queued = new Set<string>();
let flushing: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const bridge = (): Bridge | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window.desktop as Bridge | undefined);

async function flush() {
  flushing = undefined;
  const hosts = [...queued];
  queued = new Set();
  for (let at = 0; at < hosts.length; at += maxFaviconHosts) {
    const batch = hosts.slice(at, at + maxFaviconHosts);
    let answer: unknown;
    try {
      answer = await bridge()?.getFavicons?.(batch);
    } catch {
      answer = undefined;
    }
    const found = (answer ?? {}) as Record<string, unknown>;
    for (const host of batch) {
      const value = found[host];
      icons.set(
        host,
        typeof value === "string" && iconUrl.test(value) ? value : null,
      );
    }
    for (const listener of listeners) listener();
  }
}

/** Ask the main process for the hosts not asked yet (batched per tick). */
export function requestFavicons(hosts: string[]) {
  for (const host of hosts) {
    if (asked.has(host) || !hostName.test(host)) continue;
    asked.add(host);
    queued.add(host);
  }
  if (queued.size && !flushing) flushing = setTimeout(() => void flush(), 0);
}

/** Forget every icon (tests). */
export function resetFavicons() {
  icons.clear();
  asked.clear();
  queued.clear();
  clearTimeout(flushing);
  flushing = undefined;
}

/** The icon known for a host: a data URL, null for the placeholder, undefined until answered. */
export const faviconFor = (host: string) => icons.get(host);

/**
 * Each host's icon: a data URL, or null (placeholder) when there is none,
 * remote images are off or it has not arrived yet.
 */
export function useFavicons(hosts: string[]): Record<string, string | null> {
  const { remoteImages } = usePolicy();
  const disableNonessentialServices =
    useContext(AppContext)?.snapshot.settings.disableNonessentialServices;
  const [, changed] = useReducer((count: number) => count + 1, 0);
  const key = hosts.join(" ");
  useEffect(() => {
    if (disableNonessentialServices) {
      for (const host of key.split(" ")) {
        asked.delete(host);
        queued.delete(host);
      }
      return;
    }
    if (!remoteImages || !key) return;
    listeners.add(changed);
    requestFavicons(key.split(" "));
    return () => {
      listeners.delete(changed);
    };
  }, [key, remoteImages, disableNonessentialServices]);
  return Object.fromEntries(
    hosts.map((host) => [
      host,
      remoteImages && !disableNonessentialServices
        ? (icons.get(host) ?? null)
        : null,
    ]),
  );
}
