import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { Readable } from "node:stream";
import { normalizeHost, type NetPolicy } from "./net-policy";
import {
  compilePolicy,
  denyMessage,
  resolveAllowed,
  systemResolver,
  publicLookup,
  type Resolver,
} from "./net-policy-compile";

export function connectorFetch(
  policy: NetPolicy,
  guard = connectorUrlGuard(policy),
): typeof fetch {
  const lookup = publicLookup(
    compilePolicy({ ...policy, level: "full", ports: [443] }),
  );
  return (async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    await guard(url.href);
    return new Promise<Response>((resolve, reject) => {
      const request = https.request(
        url,
        {
          method: init?.method ?? "GET",
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          lookup,
          signal: init?.signal ?? undefined,
          agent: false,
        },
        (response) => {
          const status = response.statusCode ?? 500;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(new Error("The request failed."));
            return;
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined)
              headers.set(
                name,
                Array.isArray(value) ? value.join(", ") : value,
              );
          resolve(
            new Response(
              [204, 205, 304].includes(status)
                ? null
                : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
              { status, headers },
            ),
          );
        },
      );
      request.on("error", reject);
      request.end(typeof init?.body === "string" ? init.body : undefined);
    });
  }) as typeof fetch;
}

/**
 * Whether the runner may call a connector's address: https, on a name and to
 * addresses the sandbox's egress proxy would let through at its most open
 * level (so no private, loopback, metadata or internal name, and none of the
 * names and addresses the runner denies, like the Claudex service). The
 * proxy checks again on every call; this only tells the user at once.
 */
export function connectorUrlGuard(
  policy: NetPolicy,
  resolver: Resolver = systemResolver,
) {
  const open = compilePolicy({ ...policy, level: "full", ports: [443] });
  return async (address: string) => {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw new Error(
        "Enter the server's full address, starting with https://.",
      );
    }
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("The address must start with https://.");
    if (url.port && url.port !== "443")
      throw new Error("Connectors must use the standard https port.");
    const host = normalizeHost(url.hostname);
    if (!host) throw new Error("That isn't a usable server name.");
    const named = open.checkHost(host, 443);
    if (!named.ok)
      throw new Error(
        denyMessage(named.reason, host, 443).replace(
          / is a private.*/,
          " can't be reached from Claudex.",
        ),
      );
    const found = await resolveAllowed(open, named.host ?? host, resolver);
    if (!found.ok)
      throw new Error(
        found.reason === "unresolved"
          ? `${host} could not be found.`
          : `${host} can't be reached from Claudex.`,
      );
  };
}

/** The bare host names of a connector list, for the sandbox's allowed domains. */
export function connectorHosts(servers: Record<string, unknown>): string[] {
  const hosts = new Set<string>();
  for (const server of Object.values(servers)) {
    const url = (server as { url?: unknown } | null)?.url;
    if (typeof url !== "string") continue;
    try {
      const host = normalizeHost(new URL(url).hostname);
      if (host) hosts.add(host);
    } catch {
      // Not an address: nothing to allow.
    }
  }
  return [...hosts];
}

/**
 * The bearer tokens of a user's connectors: one 0600 file in the profile
 * (the sandbox does not mount the profile's root, only codex-home and the
 * workspace), kept apart from the settings the page reads. They only leave
 * this file as the Authorization header of the connector's own requests.
 */
export class ConnectorTokens {
  private readonly file: string;
  private tokens: Record<string, string> = {};
  constructor(profile: string) {
    this.file = path.join(profile, "connector-tokens.json");
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (data && typeof data === "object" && !Array.isArray(data))
        for (const [name, token] of Object.entries(data))
          if (typeof token === "string") this.tokens[name] = token;
    } catch {
      // No tokens yet.
    }
  }
  get(name: string) {
    return this.tokens[name];
  }
  set(name: string, token: string | undefined) {
    if (token === undefined) {
      if (!(name in this.tokens)) return;
      delete this.tokens[name];
    } else this.tokens[name] = token;
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.tokens), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  /** Forgets the tokens of connectors that are no longer configured. */
  keepOnly(names: Iterable<string>) {
    const keep = new Set(names);
    for (const name of Object.keys(this.tokens))
      if (!keep.has(name)) this.set(name, undefined);
  }
}
