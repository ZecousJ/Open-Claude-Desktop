/**
 * Site icons for web search results and citations (design R45 §3.4). The
 * main process fetches `https://<host>/favicon.ico` only where the policy
 * allows remote images, and answers data URLs; null means "show the
 * initial-letter placeholder". Icons are cached per account for 7 days
 * (electron/favicons.ts); pass host names as `new URL(url).hostname` gives
 * them (lowercase, punycode). Addresses and local names always answer null.
 */
import { bridgeMethods } from "./bridge-methods";

/** Most hosts one `getFavicons` call takes. */
export const maxFaviconHosts = 50;

export interface FaviconAPI {
  /** Each host's icon as a data URL, or null for the placeholder. */
  getFavicons(hosts: string[]): Promise<Record<string, string | null>>;
}

export const faviconMethods = bridgeMethods<FaviconAPI>({
  getFavicons: true,
});
