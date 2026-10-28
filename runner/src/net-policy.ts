import os from "node:os";
import { type NetworkLevel } from "./sandbox/driver.ts";

export type { NetworkLevel };

export const NETWORK_LEVELS: readonly NetworkLevel[] = [
  "none",
  "trusted",
  "custom",
  "full",
];

/**
 * Package registries and code hosts of the `trusted` level (W-RUN 4.2). An
 * entry matches the name itself and every subdomain. The service keeps the
 * maintained list in the `claudex_cloud` setting; this is the runner's
 * default when none is configured. Mirrors used from mainland China are
 * included because runner hosts may sit there.
 */
export { DEFAULT_TRUSTED_DOMAINS } from "../../shared/cloud-network-domains.ts";

/** Names that only ever mean the local machine or a private network. */
export const INTERNAL_NAMES: readonly string[] = [
  "localhost",
  "*.localhost",
  "*.local",
  "*.internal",
  "*.intranet",
  "*.lan",
  "*.home",
  "*.corp",
  "*.home.arpa",
  "*.in-addr.arpa",
  "*.ip6.arpa",
];

/** Mail submission ports stay closed even at `full` (spam relays). */
export const MAIL_PORTS: readonly number[] = [25, 465, 587, 2525];
/** Ports of `trusted` and `custom`: plain and TLS web. */
export const WEB_PORTS: readonly number[] = [80, 443];

/** Per-session transfer allowance (W-RUN 12.4): 5 GB. */
export const DEFAULT_MAX_BYTES = 5 * 1000 ** 3;

/** What a sandbox may reach; built by the runner, enforced by the proxy. */
export interface NetPolicy {
  restriction?: NetPolicy;
  level: NetworkLevel;
  /** Domains of `trusted` (and `custom`); default DEFAULT_TRUSTED_DOMAINS. */
  trustedDomains?: readonly string[];
  /** The environment's extra domains, used at `custom` only. */
  customDomains?: readonly string[];
  /** Host patterns refused at every level (the service, the runner). */
  deniedHosts?: readonly string[];
  /** Addresses or CIDR ranges refused at every level (DC6, runner hosts). */
  deniedAddresses?: readonly string[];
  /** Allowed destination ports; default web ports, or anything but mail at `full`. */
  ports?: readonly number[];
  /** Bytes a session may move through the proxy; default 5 GB. */
  maxBytes?: number;
  /**
   * The fake-IP ranges of a proxy on the runner host (Clash/mihomo-style
   * fake-ip DNS answers every name with an address in 198.18.0.0/15 and maps
   * it back to the name when connecting). An address in one of these ranges is
   * accepted only when it came from resolving a name the policy allowed, and
   * only below `full` (where every name is a listed one); an IP literal in the
   * range stays refused.
   */
  fakeIpRanges?: readonly string[];
}

/** Why a target was refused; also sent to the sandbox in X-Claudex-Egress. */
export type DenyReason =
  | "network-off"
  | "not-allowed"
  | "internal-name"
  | "denied-host"
  | "bad-host"
  | "port"
  | "private"
  | "loopback"
  | "link-local"
  | "metadata"
  | "reserved"
  | "multicast"
  | "denied-address"
  | "own-address"
  | "unresolved"
  | "allowance";

export type Verdict = { ok: true } | { ok: false; reason: DenyReason };

export class NetPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetPolicyError";
  }
}

// ---------------------------------------------------------------------------
// Addresses

export const V4_MAPPED = 0xffffn << 32n; // ::ffff:0:0/96

function parseIPv4(s: string): bigint | undefined {
  const parts = s.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIPv6(input: string): bigint | undefined {
  let s = input;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s || /[^0-9a-fA-F:.]/.test(s)) return undefined;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    tail = [Number(v4 >> 16n), Number(v4 & 0xffffn)];
    // Keep "::" when the dotted part follows it; drop a single separator.
    s = s.slice(0, lastColon + 1);
    if (!s.endsWith("::")) s = s.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const words = (h: string) => (h === "" ? [] : h.split(":"));
  const head = words(halves[0]!);
  const back = halves.length === 2 ? words(halves[1]!) : [];
  const hextets: number[] = [];
  for (const w of [...head, ...back])
    if (!/^[0-9a-fA-F]{1,4}$/.test(w)) return undefined;
  const count = head.length + back.length + tail.length;
  if (halves.length === 1) {
    if (count !== 8) return undefined;
    hextets.push(...head.map((w) => parseInt(w, 16)), ...tail);
  } else {
    if (count > 7) return undefined;
    hextets.push(
      ...head.map((w) => parseInt(w, 16)),
      ...new Array(8 - count).fill(0),
      ...back.map((w) => parseInt(w, 16)),
      ...tail,
    );
  }
  let value = 0n;
  for (const h of hextets) value = (value << 16n) | BigInt(h);
  return value;
}

/**
 * An IP address as a 128-bit number; IPv4 addresses land in ::ffff:0:0/96.
 * Only canonical dotted-quad IPv4 is accepted (no octal, hex or short forms).
 */
export function ipToBigInt(address: string): bigint | undefined {
  const s =
    address.startsWith("[") && address.endsWith("]")
      ? address.slice(1, -1)
      : address;
  if (s.includes(":")) return parseIPv6(s);
  const v4 = parseIPv4(s);
  return v4 === undefined ? undefined : V4_MAPPED | v4;
}

interface Range {
  base: bigint;
  bits: number; // prefix length in the 128-bit space
}

export function range(cidr: string): Range {
  const slash = cidr.indexOf("/");
  const addr = slash >= 0 ? cidr.slice(0, slash) : cidr;
  const value = ipToBigInt(addr);
  if (value === undefined)
    throw new NetPolicyError(`Not an IP address or range: ${cidr}`);
  const v4 = !addr.includes(":");
  const max = v4 ? 32 : 128;
  let bits = max;
  if (slash >= 0) {
    const text = cidr.slice(slash + 1);
    if (!/^\d{1,3}$/.test(text) || Number(text) > max)
      throw new NetPolicyError(`Bad prefix length in ${cidr}`);
    bits = Number(text);
  }
  const prefix = v4 ? bits + 96 : bits;
  const mask =
    prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return { base: value & mask, bits: prefix };
}

export function inRange(value: bigint, r: Range) {
  if (r.bits === 0) return true;
  const shift = BigInt(128 - r.bits);
  return value >> shift === r.base >> shift;
}

/** True for a string that is an IP address (either family). */
export function isIpLiteral(s: string) {
  return ipToBigInt(s) !== undefined;
}

const table = (
  entries: Array<[string, DenyReason]>,
): Array<[Range, DenyReason]> => entries.map(([c, r]) => [range(c), r]);

/** Cloud metadata endpoints, named separately in logs. */
const METADATA = table([
  ["169.254.169.254/32", "metadata"], // AWS, GCP, Azure, OpenStack, …
  ["169.254.170.2/32", "metadata"], // ECS task metadata
  ["100.100.100.200/32", "metadata"], // Alibaba Cloud
  ["192.0.0.192/32", "metadata"], // Oracle Cloud
  ["fd00:ec2::254/128", "metadata"], // AWS over IPv6
]);

/** IPv4 ranges no sandbox may reach (IANA special-purpose registry). */
const V4_SPECIAL = table([
  ["0.0.0.0/8", "reserved"],
  ["10.0.0.0/8", "private"],
  ["100.64.0.0/10", "private"], // shared address space (CGNAT)
  ["127.0.0.0/8", "loopback"],
  ["169.254.0.0/16", "link-local"],
  ["172.16.0.0/12", "private"],
  ["192.0.0.0/24", "reserved"],
  ["192.0.2.0/24", "reserved"],
  ["192.88.99.0/24", "reserved"],
  ["192.168.0.0/16", "private"],
  ["198.18.0.0/15", "reserved"],
  ["198.51.100.0/24", "reserved"],
  ["203.0.113.0/24", "reserved"],
  ["224.0.0.0/4", "multicast"],
  ["240.0.0.0/4", "reserved"], // includes 255.255.255.255
]);

/** IPv6 ranges no sandbox may reach (other than the embedding forms). */
const V6_SPECIAL = table([
  ["::/128", "reserved"],
  ["::1/128", "loopback"],
  ["100::/64", "reserved"], // discard
  ["64:ff9b:1::/48", "private"], // local-use NAT64
  ["2001::/32", "reserved"], // Teredo: hides the real endpoint
  ["2001:2::/48", "reserved"],
  ["2001:10::/28", "reserved"],
  ["2001:20::/28", "reserved"],
  ["2001:db8::/32", "reserved"],
  ["3fff::/20", "reserved"],
  ["5f00::/16", "reserved"],
  ["fc00::/7", "private"], // unique local
  ["fe80::/10", "link-local"],
  ["fec0::/10", "private"], // deprecated site-local
  ["ff00::/8", "multicast"],
]);

const MAPPED = range("::ffff:0:0/96");
const COMPAT = range("::/96");
const NAT64 = range("64:ff9b::/96");
const SIX_TO_FOUR = range("2002::/16");

/**
 * The IPv4 address an IPv6 address stands for, when it embeds one in a
 * routable way (mapped, compatible, NAT64 well-known prefix, 6to4).
 */
export function embeddedV4(value: bigint): bigint | undefined {
  if (inRange(value, MAPPED)) return value & 0xffffffffn;
  if (inRange(value, NAT64)) return value & 0xffffffffn;
  if (inRange(value, COMPAT) && value > 1n) return value & 0xffffffffn;
  if (inRange(value, SIX_TO_FOUR)) return (value >> 80n) & 0xffffffffn;
  return undefined;
}

/**
 * Whether an address is one no sandbox may reach, whatever the level: the
 * reason, or undefined for an ordinary public address. Unparseable input
 * counts as reserved.
 */
export function forbiddenAddress(address: string): DenyReason | undefined {
  const value = ipToBigInt(address);
  if (value === undefined) return "reserved";
  const v4 = embeddedV4(value);
  const subject = v4 === undefined ? value : V4_MAPPED | v4;
  for (const [r, reason] of METADATA) if (inRange(subject, r)) return reason;
  if (v4 !== undefined) {
    for (const [r, reason] of V4_SPECIAL)
      if (inRange(subject, r)) return reason;
    return undefined;
  }
  for (const [r, reason] of V6_SPECIAL) if (inRange(value, r)) return reason;
  // Only global unicast (2000::/3) is public.
  if (value >> 125n !== 1n) return "reserved";
  return undefined;
}

/** The host's own interface addresses (the runner must not be reachable). */
export function ownAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list ?? []) out.push(i.address);
  return out;
}

// ---------------------------------------------------------------------------
// Names

const LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;

/**
 * A host as the proxy compares it: lower case, no trailing dot, IPv6 without
 * brackets. Undefined when it is neither a valid DNS name nor an IP address.
 */
export function normalizeHost(host: string): string | undefined {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
    return h.includes(":") && isIpLiteral(h) ? h : undefined;
  }
  if (h.includes(":")) return isIpLiteral(h) ? h : undefined;
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h || h.length > 253) return undefined;
  if (isIpLiteral(h)) return h;
  const labels = h.split(".");
  if (!labels.every((l) => LABEL.test(l))) return undefined;
  // All-numeric names (2130706433, 0x7f.1, 127.1) are address tricks.
  if (/^[0-9.]+$/.test(h) || /^0x[0-9a-f]+$/.test(labels[0]!)) return undefined;
  return h;
}

interface Pattern {
  /** Matches the name itself (plain entries). */
  exact?: string;
  /** Matches names ending in `.<suffix>`. */
  suffix?: string;
}

/**
 * A domain entry: `example.com` matches the name and its subdomains,
 * `*.example.com` only the subdomains. A single label or a bare `*` is not
 * accepted (it would allow a whole top-level domain or everything), except
 * where `allowSingleLabel` is set (internal-name lists).
 */
export function parseDomainPattern(
  entry: string,
  opts: { allowSingleLabel?: boolean } = {},
): Pattern {
  const raw = entry.trim().toLowerCase();
  const wildcard = raw.startsWith("*.");
  const name = normalizeHost(wildcard ? raw.slice(2) : raw);
  if (!name)
    throw new NetPolicyError(`Not a domain name: ${entry.trim() || "(empty)"}`);
  if (isIpLiteral(name)) {
    if (wildcard) throw new NetPolicyError(`Not a domain name: ${entry}`);
    return { exact: name };
  }
  if (!opts.allowSingleLabel && !name.includes("."))
    throw new NetPolicyError(
      `A domain needs at least two labels (example.com): ${entry.trim()}`,
    );
  return wildcard ? { suffix: name } : { exact: name, suffix: name };
}

export function matches(host: string, patterns: Pattern[]) {
  return patterns.some(
    (p) => p.exact === host || (p.suffix && host.endsWith(`.${p.suffix}`)),
  );
}

// ---------------------------------------------------------------------------
// Compiled policy

export interface CompiledPolicy {
  readonly level: NetworkLevel;
  readonly maxBytes: number;
  /** The policy it was compiled from (normalized). */
  readonly source: NetPolicy;
  /** Name and port check, before any resolution. */
  checkHost(host: string, port: number): Verdict & { host?: string };
  /** Address check, for every address the proxy is about to connect to. */
  checkAddress(address: string): Verdict;
  /**
   * Address check for an address resolved from an allowed name: as
   * checkAddress, except the runner host's fake-IP ranges pass below `full`.
   */
  checkResolved(address: string): Verdict;
}

export function portList(ports: readonly number[] | undefined) {
  if (!ports) return undefined;
  for (const p of ports)
    if (!Number.isInteger(p) || p < 1 || p > 65535)
      throw new NetPolicyError(`Not a TCP port: ${p}`);
  return new Set(ports);
}
