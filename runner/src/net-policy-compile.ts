import dns from "node:dns";
import net from "node:net";
import {
  clampNetworkLevel,
  type IsolationStrength,
  type NetworkLevel,
} from "./sandbox/driver.ts";
import { DEFAULT_TRUSTED_DOMAINS } from "../../shared/cloud-network-domains.ts";
import {
  NETWORK_LEVELS,
  INTERNAL_NAMES,
  MAIL_PORTS,
  WEB_PORTS,
  DEFAULT_MAX_BYTES,
  NetPolicyError,
  V4_MAPPED,
  ipToBigInt,
  range,
  inRange,
  isIpLiteral,
  embeddedV4,
  forbiddenAddress,
  ownAddresses,
  normalizeHost,
  parseDomainPattern,
  matches,
  portList,
} from "./net-policy.ts";
import type {
  NetPolicy,
  DenyReason,
  Verdict,
  CompiledPolicy,
} from "./net-policy.ts";

/**
 * Validates a policy and prepares its matchers. `own` lists addresses that
 * are always refused besides the configured ones (the runner's interfaces).
 */
export function compilePolicy(
  policy: NetPolicy,
  own: readonly string[] = [],
): CompiledPolicy {
  if (!NETWORK_LEVELS.includes(policy.level))
    throw new NetPolicyError(`Unknown network level: ${String(policy.level)}`);
  const trustedSource = policy.trustedDomains ?? DEFAULT_TRUSTED_DOMAINS;
  const trusted = trustedSource.map((d) => parseDomainPattern(d));
  const custom = (policy.customDomains ?? []).map((d) => parseDomainPattern(d));
  const internal = INTERNAL_NAMES.map((d) =>
    parseDomainPattern(d, { allowSingleLabel: true }),
  );
  const deniedHosts = (policy.deniedHosts ?? []).map((d) =>
    parseDomainPattern(d, { allowSingleLabel: true }),
  );
  const deniedRanges = (policy.deniedAddresses ?? []).map(range);
  const fakeRanges = (policy.fakeIpRanges ?? []).map(range);
  const ownValues = own
    .map((a) => ipToBigInt(a))
    .filter((v): v is bigint => v !== undefined);
  const ports = portList(policy.ports);
  const maxBytes = policy.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!(maxBytes > 0)) throw new NetPolicyError("maxBytes must be positive.");
  const level = policy.level;
  const restriction = policy.restriction
    ? compilePolicy(policy.restriction, own)
    : undefined;
  const allowedNames =
    level === "trusted"
      ? trusted
      : level === "custom"
        ? [...trusted, ...custom]
        : [];

  const portAllowed = (port: number) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    if (ports) return ports.has(port);
    if (level === "full") return !MAIL_PORTS.includes(port);
    return WEB_PORTS.includes(port);
  };

  const checkAddress = (address: string): Verdict => {
    const value = ipToBigInt(address);
    if (value === undefined) return { ok: false, reason: "reserved" };
    const special = forbiddenAddress(address);
    if (special) return { ok: false, reason: special };
    const v4 = embeddedV4(value);
    const forms = v4 === undefined ? [value] : [value, V4_MAPPED | v4];
    if (forms.some((f) => ownValues.includes(f)))
      return { ok: false, reason: "own-address" };
    if (forms.some((f) => deniedRanges.some((r) => inRange(f, r))))
      return { ok: false, reason: "denied-address" };
    return { ok: true };
  };

  const checkResolved = (address: string): Verdict => {
    const value = ipToBigInt(address);
    if (
      value !== undefined &&
      level !== "full" &&
      fakeRanges.some((r) => inRange(value, r))
    ) {
      if (ownValues.includes(value))
        return { ok: false, reason: "own-address" };
      return { ok: true };
    }
    return checkAddress(address);
  };

  return {
    level,
    maxBytes,
    source: {
      ...policy,
      trustedDomains: [...trustedSource],
      customDomains: [...(policy.customDomains ?? [])],
      maxBytes,
    },
    checkAddress,
    checkResolved,
    checkHost(input, port) {
      const limited = restriction?.checkHost(input, port);
      if (limited && !limited.ok) return limited;
      if (level === "none") return { ok: false, reason: "network-off" };
      const host = normalizeHost(input);
      if (!host) return { ok: false, reason: "bad-host" };
      if (!portAllowed(port)) return { ok: false, reason: "port" };
      if (isIpLiteral(host)) {
        const verdict = checkAddress(host);
        if (!verdict.ok) return verdict;
        // Below `full`, an address is reachable only when listed as such.
        if (level !== "full" && !matches(host, allowedNames))
          return { ok: false, reason: "not-allowed" };
        return { ok: true, host };
      }
      if (matches(host, internal))
        return { ok: false, reason: "internal-name" };
      if (matches(host, deniedHosts))
        return { ok: false, reason: "denied-host" };
      if (level !== "full" && !matches(host, allowedNames))
        return { ok: false, reason: "not-allowed" };
      return { ok: true, host };
    },
  };
}

/** The English message the sandbox sees for a refusal. */
export function denyMessage(reason: DenyReason, host = "", port = 0): string {
  const target = host ? `${host}${port ? `:${port}` : ""}` : "This address";
  switch (reason) {
    case "network-off":
      return "Network access is off for this environment.";
    case "not-allowed":
      return `${target} is not on this environment's list of allowed domains.`;
    case "port":
      return `Port ${port} can't be reached from this environment.`;
    case "bad-host":
      return "The requested host name is not valid.";
    case "unresolved":
      return `${host || "The host"} could not be resolved.`;
    case "allowance":
      return "This session has used up its network allowance.";
    case "internal-name":
    case "denied-host":
    case "private":
    case "loopback":
    case "link-local":
    case "metadata":
    case "reserved":
    case "multicast":
    case "denied-address":
    case "own-address":
      return `${target} is a private or internal address and can't be reached from the sandbox.`;
  }
}

// ---------------------------------------------------------------------------
// Resolution

export type Resolver = (host: string) => Promise<string[]>;

/** All addresses of a name, as the system resolver returns them. */
export const systemResolver: Resolver = async (host) => {
  const list = await dns.promises.lookup(host, { all: true, verbatim: true });
  return list.map((a) => a.address);
};

/**
 * Resolves a checked host to the addresses the proxy may connect to. A name
 * with any refused address is refused as a whole: mixing a public and a
 * private answer is how rebinding attacks look.
 */
export async function resolveAllowed(
  policy: CompiledPolicy,
  host: string,
  resolver: Resolver = systemResolver,
): Promise<
  { ok: true; addresses: string[] } | { ok: false; reason: DenyReason }
> {
  if (isIpLiteral(host)) {
    const verdict = policy.checkAddress(host);
    return verdict.ok ? { ok: true, addresses: [host] } : verdict;
  }
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    return { ok: false, reason: "unresolved" };
  }
  const unique = [...new Set(addresses)];
  if (!unique.length) return { ok: false, reason: "unresolved" };
  for (const a of unique) {
    const verdict = policy.checkResolved(a);
    if (!verdict.ok) return verdict;
  }
  return { ok: true, addresses: unique };
}

/**
 * A `lookup` for Node's http/https/net that only answers with public
 * addresses: runner-side fetches on behalf of a user (for example remote
 * images) can use it so the connection goes to the address that was checked.
 */
export function publicLookup(
  policy: CompiledPolicy = compilePolicy({ level: "full" }, ownAddresses()),
  resolver: Resolver = systemResolver,
) {
  return (
    hostname: string,
    options: dns.LookupOptions | number | undefined,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | dns.LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    const opts = typeof options === "object" && options ? options : {};
    void resolveAllowed(policy, hostname, resolver).then((result) => {
      if (!result.ok) {
        const error = new Error(
          denyMessage(result.reason, hostname),
        ) as NodeJS.ErrnoException;
        error.code = "ECLAUDEXEGRESS";
        callback(error, "", 4);
        return;
      }
      const all = result.addresses.map((address) => ({
        address,
        family: net.isIPv6(address) ? 6 : 4,
      }));
      if (opts.all) callback(null, all);
      else callback(null, all[0]!.address, all[0]!.family);
    });
  };
}

// ---------------------------------------------------------------------------
// A user's own network settings (Settings → Capabilities)

/** What a user chose for their sandbox; the runner's policy is the ceiling. */
export interface UserNetwork {
  /** "Allow network egress". */
  enabled: boolean;
  /** "Domain allowlist". */
  allowlist: "none" | "packages" | "all";
  /** "Additional allowed domains". */
  domains: readonly string[];
  /**
   * The hosts of the user's connectors (Settings → Connectors): their MCP
   * requests come from the sandbox, so these stay reachable even when the
   * user closed the rest of the network.
   */
  connectors?: readonly string[];
}

/**
 * The policy of one user's sandbox: the runner's `admin` policy narrowed by
 * their choices. Nothing here can reach further than the runner allows: at
 * `none` the network stays closed whatever was chosen, "All domains" needs a
 * runner at `full`, and extra domains only apply below `full` (at `custom`
 * they add to the runner's own list; at `trusted` they turn it into
 * `custom`). A malformed domain is left out rather than failing the sandbox.
 */
export function userNetworkPolicy(
  admin: NetPolicy,
  user: UserNetwork,
): NetPolicy {
  if (admin.level === "none") return admin;
  const valid = (entries: readonly string[] = []) => {
    const out: string[] = [];
    for (const entry of entries)
      try {
        parseDomainPattern(entry);
        out.push(entry.trim().toLowerCase());
      } catch {
        // Not a usable domain: skipped.
      }
    return out;
  };
  const connectors = valid(user.connectors);
  // Closed but for the given hosts: no package managers, nothing else.
  const only = (hosts: string[]): NetPolicy =>
    hosts.length
      ? { ...admin, level: "custom", trustedDomains: [], customDomains: hosts }
      : { ...admin, level: "none" };
  // Egress off: only the connectors' own hosts.
  if (!user.enabled) return only(connectors);
  // "None" (the original's custom template): only the domains the user
  // added, and the connectors' hosts.
  if (user.allowlist === "none")
    return only([...new Set([...valid(user.domains), ...connectors])]);
  if (admin.level === "full" && user.allowlist === "all") return admin;
  const domains = [...new Set([...valid(user.domains), ...connectors])];
  // Package managers only, on a runner that would let everything through:
  // the trusted list, plus what the user added.
  if (admin.level === "full")
    return { ...admin, level: "custom", customDomains: domains };
  if (!domains.length) return admin;
  return {
    ...admin,
    level: "custom",
    customDomains: [...new Set([...(admin.customDomains ?? []), ...domains])],
  };
}

// ---------------------------------------------------------------------------
// Runner configuration

export interface NetConfig {
  /** The policy each sandbox gets (level already clamped to the driver). */
  policy: NetPolicy;
  /** Notes for the runner log (clamping, overrides). */
  warnings: string[];
}

export const list = (value: string | undefined) =>
  (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Reads the runner's network settings from its environment:
 *
 *   CLAUDEX_RUNNER_NETWORK          none | trusted (default) | custom | full
 *   CLAUDEX_RUNNER_TRUSTED_DOMAINS  replaces the default trusted list
 *   CLAUDEX_RUNNER_CUSTOM_DOMAINS   extra domains of `custom`
 *   CLAUDEX_RUNNER_EGRESS_DENY      addresses, CIDR ranges or host names
 *                                   refused at every level (DC6, runners)
 *   CLAUDEX_RUNNER_EGRESS_PORTS     allowed destination ports
 *   CLAUDEX_RUNNER_EGRESS_MAX_GB    per-session allowance (default 5)
 *   CLAUDEX_RUNNER_FAKE_IP_RANGES   the host proxy's fake-IP ranges (e.g.
 *                                   198.18.0.0/15), accepted for allowed
 *                                   names below `full` (see fakeIpRanges)
 *
 * `serviceHosts` (the service and public URLs) are always denied by name;
 * the level is clamped to what the driver's isolation allows.
 */
export function parseNetConfig(
  env: NodeJS.ProcessEnv,
  isolation: IsolationStrength,
  serviceHosts: readonly string[] = [],
): NetConfig {
  const warnings: string[] = [];
  const wanted = (
    env.CLAUDEX_RUNNER_NETWORK || "trusted"
  ).trim() as NetworkLevel;
  if (!NETWORK_LEVELS.includes(wanted))
    throw new NetPolicyError(
      "CLAUDEX_RUNNER_NETWORK must be none, trusted, custom or full.",
    );
  const level = clampNetworkLevel(wanted, isolation);
  if (level !== wanted)
    warnings.push(
      `network level ${wanted} is not available with ${isolation} isolation; using ${level}.`,
    );
  const deniedAddresses: string[] = [];
  const deniedHosts: string[] = [];
  for (const entry of list(env.CLAUDEX_RUNNER_EGRESS_DENY)) {
    const bare = entry.split("/")[0]!;
    if (isIpLiteral(bare)) {
      range(entry); // validates
      deniedAddresses.push(entry);
    } else {
      parseDomainPattern(entry, { allowSingleLabel: true });
      deniedHosts.push(entry);
    }
  }
  for (const host of serviceHosts) {
    const h = normalizeHost(host);
    if (!h) continue;
    if (isIpLiteral(h)) deniedAddresses.push(h);
    else deniedHosts.push(h);
  }
  const trustedDomains = env.CLAUDEX_RUNNER_TRUSTED_DOMAINS
    ? list(env.CLAUDEX_RUNNER_TRUSTED_DOMAINS)
    : undefined;
  const customDomains = list(env.CLAUDEX_RUNNER_CUSTOM_DOMAINS);
  // e.g. 198.18.0.0/15 on a host whose proxy answers DNS with fake IPs.
  const fakeIpRanges = list(env.CLAUDEX_RUNNER_FAKE_IP_RANGES);
  for (const entry of fakeIpRanges) range(entry); // validates
  const ports = env.CLAUDEX_RUNNER_EGRESS_PORTS
    ? list(env.CLAUDEX_RUNNER_EGRESS_PORTS).map(Number)
    : undefined;
  let maxBytes: number | undefined;
  if (env.CLAUDEX_RUNNER_EGRESS_MAX_GB) {
    const gb = Number(env.CLAUDEX_RUNNER_EGRESS_MAX_GB);
    if (!(gb > 0))
      throw new NetPolicyError(
        "CLAUDEX_RUNNER_EGRESS_MAX_GB must be positive.",
      );
    maxBytes = Math.round(gb * 1000 ** 3);
  }
  const policy: NetPolicy = {
    level,
    ...(trustedDomains ? { trustedDomains } : {}),
    ...(customDomains.length ? { customDomains } : {}),
    deniedHosts,
    deniedAddresses,
    ...(ports ? { ports } : {}),
    ...(maxBytes ? { maxBytes } : {}),
    ...(fakeIpRanges.length ? { fakeIpRanges } : {}),
  };
  compilePolicy(policy); // throws on any bad entry
  return { policy, warnings };
}
