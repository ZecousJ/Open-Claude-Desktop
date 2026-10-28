/**
 * Which links may leave the app and which remote images may load under the
 * administrator's policy. The main process enforces these in
 * `electron/external-links.ts`; the window uses the same rules to say so before
 * asking.
 */
import { type ClientPolicy } from "./client-policy";
import { administratorUrls, urlListed } from "./client-policy-rules";

/** The host of a web address, lower case and without a trailing dot. */
export function webHost(value: string) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return undefined;
    return url.hostname.replace(/\.$/, "").toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a host is on a domain list: an entry names one host exactly
 * ("docs.example.com"), or with a leading "*." every host below it
 * ("*.example.org" matches "a.example.org" and "a.b.example.org", not
 * "example.org" itself). Entries have no port or path.
 */
export function hostMatches(host: string, domains: readonly string[]) {
  const name = asciiHost(host);
  if (!name) return false;
  return domains.some((entry) => {
    const trimmed = entry.trim();
    const wildcard = trimmed.startsWith("*.");
    const domain = asciiHost(wildcard ? trimmed.slice(2) : trimmed);
    if (!domain) return false;
    return wildcard ? name.endsWith(`.${domain}`) : name === domain;
  });
}

/** A host as URLs spell it: lower case, punycode, no trailing dot. */
function asciiHost(value: string) {
  const host = value.replace(/\.$/, "");
  if (!host || /[/:@?#\s*]/.test(host)) return undefined;
  try {
    return new URL(`https://${host}`).hostname;
  } catch {
    return undefined;
  }
}

type LinkPolicy = Pick<
  ClientPolicy,
  "externalLinks" | "trustedLinkDomains" | "links" | "update"
>;

/**
 * Whether a link opens in the browser: always while external links are on;
 * otherwise only the pages the administrator named and hosts on the
 * trusted domain list.
 */
export function linkOpens(url: string, policy: LinkPolicy) {
  const host = webHost(url);
  if (!host) return false;
  if (policy.externalLinks) return true;
  return (
    urlListed(url, administratorUrls(policy as ClientPolicy)) ||
    hostMatches(host, policy.trustedLinkDomains)
  );
}

/**
 * Whether a remote image may load from this address: remote images on and,
 * with a domain list, its host on the list. Checked again for every
 * redirect the image takes.
 */
export function remoteImageAllowed(
  url: string,
  policy: Pick<ClientPolicy, "remoteImages" | "remoteImageDomains">,
) {
  if (!policy.remoteImages) return false;
  const host = webHost(url);
  if (!host) return false;
  return (
    policy.remoteImageDomains === null ||
    hostMatches(host, policy.remoteImageDomains)
  );
}

/** Why a remote image does not load, for the placeholder; undefined when it may. */
export function remoteImageRefusal(
  url: string,
  policy: Pick<ClientPolicy, "remoteImages" | "remoteImageDomains">,
) {
  if (!policy.remoteImages)
    return "Remote images are turned off by your administrator.";
  if (!remoteImageAllowed(url, policy))
    return "Your administrator doesn't allow images from this site.";
  return undefined;
}

/** A plain https address without credentials, as the browser reads it; else undefined. */
export function httpsPage(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** The update's download page when it is a plain https address, else undefined. */
export function downloadPage(update: ClientPolicy["update"]) {
  return httpsPage(update?.downloadUrl);
}
