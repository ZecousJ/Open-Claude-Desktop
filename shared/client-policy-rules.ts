import {
  attachmentTypes,
  builtInAttachmentBytes,
  attachmentKind,
  sameList,
} from "./client-policy";
import type { ClientUpdate, ClientPolicy, McpMap } from "./client-policy";
import { formatBytes } from "./format-bytes";

/**
 * Whether an address lies under an administrator's address prefix: both
 * are read as URLs (so case of the host, default ports and dot segments do
 * not matter), the prefix must be https, the origins must be the same, and
 * the prefix must end on a path boundary ("…/mcp" covers "…/mcp" and
 * "…/mcp/x", not "…/mcpx").
 */
export function urlUnderPrefix(url: string, prefix: string) {
  let target: URL, start: URL;
  try {
    target = new URL(url);
    start = new URL(prefix);
  } catch {
    return false;
  }
  if (
    start.protocol !== "https:" ||
    target.origin !== start.origin ||
    target.username ||
    target.password ||
    start.search ||
    start.hash
  )
    return false;
  const href = target.href;
  const base = start.href;
  if (!href.startsWith(base)) return false;
  return (
    base.endsWith("/") ||
    href.length === base.length ||
    "/?#".includes(href[base.length])
  );
}

/**
 * Whether a configured MCP server may run: with an allowlist, its name must
 * match a rule, and a rule that names a definition must match it: a program
 * with exactly its arguments (a rule without arguments allows the program
 * run without any), an address exactly, or an address under a prefix. So
 * renaming another server to an allowed name, or running the allowed
 * program with other arguments (`npx` with another package), does not let
 * it start.
 */
export function connectorAllowed(
  policy: Pick<
    ClientPolicy,
    "connectors" | "desktopExtensionsEnabled" | "developerMcpEnabled"
  >,
  name: string,
  server?: unknown,
) {
  const config =
    server && typeof server === "object" && !Array.isArray(server)
      ? (server as Record<string, unknown>)
      : undefined;
  if (config?.claudex_extension && policy.desktopExtensionsEnabled === false)
    return false;
  if (
    config?.command &&
    !config.claudex_extension &&
    policy.developerMcpEnabled === false
  )
    return false;
  if (!policy.connectors) return true;
  return policy.connectors.some((rule) => {
    if (rule.name !== name) return false;
    if (rule.command !== undefined)
      return (
        config?.command === rule.command &&
        sameList(config.args, rule.args) &&
        config.url === undefined
      );
    if (rule.url !== undefined)
      return config?.url === rule.url && config.command === undefined;
    if (rule.urlPrefix !== undefined)
      return (
        typeof config?.url === "string" &&
        config.command === undefined &&
        urlUnderPrefix(config.url, rule.urlPrefix)
      );
    return true;
  });
}

/** The MCP servers the agent may start: the connector allowlist applied. */
export function allowedMcpServers(
  servers: McpMap,
  policy: Pick<
    ClientPolicy,
    "connectors" | "desktopExtensionsEnabled" | "developerMcpEnabled"
  >,
) {
  if (
    !policy.connectors &&
    policy.desktopExtensionsEnabled !== false &&
    policy.developerMcpEnabled !== false
  )
    return servers;
  return Object.fromEntries(
    Object.entries(servers).filter(([name, server]) =>
      connectorAllowed(policy, name, server),
    ),
  );
}

/** The extension, lower case, without the dot. */
export const extensionOf = (name: string) =>
  /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";

/**
 * Why an attachment may not be sent, or undefined when it may. The sentences
 * are the live ones; a Code session says "session" where a chat says "chat".
 * They are English here and translated where they are shown (src/i18n
 * templates).
 */
export function attachmentRefusal(
  name: string,
  size: number,
  policy: ClientPolicy,
  surface: "chat" | "session" = "chat",
): string | undefined {
  const extension = extensionOf(name);
  if (!attachmentTypes.includes(extension))
    return `“${name}” can’t be attached in this ${surface} yet — this file type isn’t supported here. You can paste its contents into the message instead.`;
  if (!policy.attachments.types.includes(extension))
    return `${name} can't be attached: your administrator doesn't allow this file type.`;
  const kind = attachmentKind(extension);
  const builtIn = builtInAttachmentBytes[kind];
  const limit = Math.min(builtIn, policy.attachments.maxBytes ?? builtIn);
  if (size > limit) {
    if (kind === "image" && limit >= 1048576)
      return `Images larger than ${Math.floor(limit / 1048576)}MB can’t be attached.`;
    const megabytes = Number((limit / 1048576).toFixed(1));
    return `“${name}” is ${formatBytes(size)}, over the ${megabytes} MB limit. Choose a smaller file.`;
  }
  return undefined;
}

/**
 * Semantic-version precedence: numeric parts compared as numbers ("1.10.0"
 * > "1.9.2"), a pre-release before its release ("1.2.0-beta.1" <
 * "1.2.0"), pre-release identifiers compared part by part (numbers as
 * numbers, below words), build metadata ("+…") ignored. The service
 * compares the same way.
 */
export function compareVersions(a: string, b: string) {
  const split = (value: string) => {
    const core = value.trim().split("+")[0];
    const dash = core.indexOf("-");
    const main = dash < 0 ? core : core.slice(0, dash);
    return {
      nums: main.split(".").map((part) => Number.parseInt(part, 10) || 0),
      pre: dash < 0 ? [] : core.slice(dash + 1).split("."),
    };
  };
  const x = split(a),
    y = split(b);
  for (let index = 0; index < Math.max(x.nums.length, y.nums.length); index++) {
    const difference = (x.nums[index] ?? 0) - (y.nums[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (!x.pre.length || !y.pre.length)
    return Math.sign(y.pre.length - x.pre.length);
  for (let index = 0; index < Math.max(x.pre.length, y.pre.length); index++) {
    const p = x.pre[index],
      q = y.pre[index];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p),
      qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Math.sign(Number(p) - Number(q));
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** Update available or required for this build, from the operator's versions. */
export function clientUpdate(
  currentVersion: string,
  client: {
    latestVersion?: string;
    minimumVersion?: string;
    downloadUrl?: string;
  },
): ClientUpdate | undefined {
  const latest = client.latestVersion ?? client.minimumVersion;
  if (!latest) return undefined;
  const required =
    !!client.minimumVersion &&
    compareVersions(currentVersion, client.minimumVersion) < 0;
  if (!required && compareVersions(currentVersion, latest) >= 0)
    return undefined;
  return {
    state: required ? "required" : "available",
    currentVersion,
    latestVersion:
      client.minimumVersion &&
      compareVersions(client.minimumVersion, latest) > 0
        ? client.minimumVersion
        : latest,
    ...(client.downloadUrl ? { downloadUrl: client.downloadUrl } : {}),
  };
}

/** The service's release information as far as updates need it (bootstrap `release`). */
export interface ReleaseInfo {
  /** The service compared this build: unknown, current, available or required. */
  state: string;
  enforced: boolean;
  latestVersion: string | null;
  minimumVersion: string | null;
  downloadUrl: string | null;
}

/**
 * The update for this build from the service's release information: the
 * service's own `state` and `enforced` when it compared the version, else
 * the versions compared here.
 */
export function releaseUpdate(
  currentVersion: string,
  release: ReleaseInfo,
): ClientUpdate | undefined {
  const versions = {
    ...(release.latestVersion ? { latestVersion: release.latestVersion } : {}),
    ...(release.minimumVersion
      ? { minimumVersion: release.minimumVersion }
      : {}),
    ...(release.downloadUrl ? { downloadUrl: release.downloadUrl } : {}),
  };
  if (release.state === "current") return undefined;
  if (release.state === "available" || release.state === "required") {
    const latest = release.latestVersion ?? release.minimumVersion;
    if (!latest) return undefined;
    return {
      state: release.state,
      currentVersion,
      latestVersion:
        release.minimumVersion &&
        compareVersions(release.minimumVersion, latest) > 0
          ? release.minimumVersion
          : latest,
      ...(release.downloadUrl ? { downloadUrl: release.downloadUrl } : {}),
      enforced: release.enforced,
    };
  }
  const update = clientUpdate(currentVersion, versions);
  return update && { ...update, enforced: release.enforced };
}

export const updateRefusal = (update: ClientUpdate) =>
  `This version of Claudex (${update.currentVersion}) is no longer supported. Update to ${update.latestVersion} to keep working.`;

/** Every page the administrator named, which open even when external links are off. */
export function administratorUrls(policy: ClientPolicy) {
  return [
    policy.links.help,
    policy.links.plans,
    policy.links.apps,
    policy.links.getMoreUsage,
    policy.links.usageLearnMore,
    ...policy.links.learnMore.map((link) => link.url),
    policy.update?.downloadUrl,
  ].filter((url): url is string => !!url);
}

/** The address as the browser reads it, or undefined when it is not one. */
function normalizedUrl(value: string) {
  try {
    return new URL(value).href;
  } catch {
    return undefined;
  }
}

/** Whether a link is one of the pages listed, compared as addresses (case of the host, trailing slash). */
export function urlListed(url: string, listed: string[]) {
  const target = normalizedUrl(url);
  return (
    target !== undefined &&
    listed.some((item) => normalizedUrl(item) === target)
  );
}
