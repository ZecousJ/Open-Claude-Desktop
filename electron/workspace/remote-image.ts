import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Loads one remote Markdown image after the person chose to load it. The
 * renderer's policy only allows local and data: images, so the main process
 * fetches the file and hands back a bounded data: URL.
 *
 * The main process is not subject to the browser's private-network rules, so
 * a reply could otherwise point an "image" at this machine or the local
 * network (the gateway, a router, cloud metadata). Every hop, redirects
 * included, must resolve to a public address.
 */
export const maxRemoteImageBytes = 10 * 1024 * 1024;
const timeoutMs = 15_000;
const maxRedirects = 5;

const privateRanges = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  privateRanges.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  privateRanges.addSubnet(address, prefix, "ipv6");

export function isPrivateAddress(address: string) {
  const family = isIP(address);
  if (!family) return true;
  return privateRanges.check(address, family === 6 ? "ipv6" : "ipv4");
}

export type Resolve = (host: string) => Promise<string[]>;
const resolveHost: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

async function assertPublic(url: URL, resolve: Resolve) {
  if (!["https:", "http:"].includes(url.protocol) || url.username)
    throw new Error("Only HTTP(S) images can be loaded.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (!addresses.length || addresses.some(isPrivateAddress))
    throw new Error("Images on this computer or local network aren't loaded.");
}

/** Reads at most `limit` bytes; a longer body is refused without buffering it. */
async function readBounded(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel();
      throw new Error("The image is larger than 10 MB.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * `allowed` is the administrator's image domain list as a check; it runs for
 * the address and for every redirect, so an allowed host cannot hand the
 * request on to one that is not.
 */
export async function fetchRemoteImage(
  value: string,
  fetchImpl: typeof fetch = fetch,
  resolve: Resolve = resolveHost,
  allowed: (url: string) => boolean = () => true,
): Promise<string> {
  let url = new URL(value);
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  for (let hop = 0; ; hop++) {
    if (!allowed(url.href))
      throw new Error(
        "Your administrator doesn't allow images from this site.",
      );
    await assertPublic(url, resolve);
    response = await fetchImpl(url, {
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || !location) break;
    if (hop >= maxRedirects) throw new Error("The image redirected too often.");
    void response.body?.cancel();
    url = new URL(location, url);
  }
  if (!response.ok)
    throw new Error(`The image couldn't be loaded (HTTP ${response.status}).`);
  const type = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!/^image\/[\w.+-]+$/.test(type))
    throw new Error("The link does not point to an image.");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxRemoteImageBytes)
    throw new Error("The image is larger than 10 MB.");
  const bytes = await readBounded(response, maxRemoteImageBytes);
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}
