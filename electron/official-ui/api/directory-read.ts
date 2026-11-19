/** Approved connector discovery and account-owned marketplace discovery. */
import { createHash } from "node:crypto";
import type http from "node:http";
import type { PluginCatalog } from "../../../shared/collections-api";
import { isApprovedDirectoryEntries } from "../../../shared/connectors-catalogue";
import { connectorConfigurationError } from "../../../shared/connector-url-configuration";
import { connectorUrlError } from "../../../shared/custom-connector";
import { installedPluginLibrary, isPersonalRuntimePlugin } from "./library-plugins";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { officialUiReadMaxBytes } from "../../../shared/official-ui-web";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
export const runtimeMarketplaceId = (name: string) =>
  "marketplace_" + hash(name);

async function approvedDirectory(ctx: AdapterContext) {
  const raw: unknown = await ctx.call("listApprovedDirectory");
  if (!Array.isArray(raw)) throw Error("Invalid directory response.");
  const entries = raw.map((row) =>
    row && typeof row === "object" && !Array.isArray(row)
      ? Object.fromEntries(
          Object.entries(row).filter(([, value]) => value !== null),
        )
      : row,
  );
  if (!isApprovedDirectoryEntries(entries))
    throw Error("Invalid directory response.");
  return entries;
}

export async function approvedConnectorDirectory(ctx: AdapterContext) {
  return (await approvedDirectory(ctx)).filter((entry) => entry.kind === "mcp");
}

export async function approvedDirectoryReadRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: AdapterContext,
): Promise<boolean> {
  const plugins =
    url.pathname === "/api/directory/plugins" ||
    /^\/api\/organizations\/[^/]+\/directory\/plugins$/.test(url.pathname);
  if (url.pathname !== "/api/directory/servers" && !plugins) return false;
  if (req.method !== "GET") return reply(res, {}, 405);
  const owner = ctx.account()?.id;
  const activation = ctx.sessionIdentity?.();
  const current = () =>
    ctx.isCurrent?.() !== false &&
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === activation;
  if (!owner)
    return reply(res, { error: { message: "Sign in to continue." } }, 401);
  if (
    url.pathname.startsWith("/api/organizations/") &&
    url.pathname.split("/")[3] !== organizationUuid(owner)
  )
    return reply(res, { error: { message: "Organization not found." } }, 404);
  if (!current())
    return reply(res, { error: { message: "The account changed." } }, 409);
  const params = url.searchParams;
  const limit = Number(params.get("limit") ?? 5000);
  const offset = Number(params.get(plugins ? "page" : "cursor") ?? 0);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 5000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    return reply(res, { error: { message: "Invalid directory page." } }, 400);
  const filter = params.get("filter") ?? "";
  const slugFilter = /\bslug in \[([^\]]*)\]/.exec(filter)?.[1];
  const slugs =
    slugFilter &&
    new Set([...slugFilter.matchAll(/'([^']+)'/g)].map((match) => match[1]));
  const unavailableShelf =
    filter.includes("has(launch.banner)") ||
    filter.includes("t.type == 'trending'") ||
    filter ===
      "source.type == 'private_mcp_server' || source.type == 'uploaded_desktop_extension'";
  const respond = (data: unknown) =>
    Buffer.byteLength(JSON.stringify(data)) <= officialUiReadMaxBytes
      ? reply(res, data)
      : reply(
          res,
          {
            error: {
              message: "The connector directory response is too large.",
            },
          },
          413,
        );
  try {
    const entries = await approvedDirectory(ctx);
    if (!current())
      return reply(res, { error: { message: "The account changed." } }, 409);
    const search = params.get("q")?.trim().toLowerCase();
    const visible = entries.filter(
      (entry) =>
        !unavailableShelf &&
        (!slugs || slugs.has(entry.slug ?? "")) &&
        (!search || [entry.name, entry.description, entry.slug ?? ""].some(
          (value) => value.toLowerCase().includes(search),
        )),
    );
    const servers = visible.filter(entry => entry.kind === "mcp")
      .map((entry) => {
        if (
          connectorUrlError(entry.url) ||
          connectorConfigurationError(entry, entry.url)
        )
          throw Error("Invalid approved connector URL.");
        const templateKey = entry.remoteUrlTemplate?.match(
          /\{(?:user_config\.)?([a-z][a-z0-9_]*)\}/,
        )?.[1];
        const urlTemplate = entry.remoteUrlTemplate?.replace(
          /(?<!\$)\{([a-z][a-z0-9_]*)\}/,
          (_, key) => "${user_config." + key + "}",
        );
        return {
          id: entry.id,
          type: "remote",
          name: entry.name,
          slug: entry.slug,
          one_liner: entry.description,
          description: entry.description,
          tool_names: entry.tools,
          added_at: entry.added,
          documentation: entry.documentationUrl,
          support: entry.curation?.supportUrl ?? entry.supportUrl,
          privacy_policy: entry.curation?.privacyPolicyUrl,
          categories: entry.curation?.categories,
          verified_tier: "community",
          source_feed: "claudex",
          remote: {
            url: entry.url,
            is_authless: entry.isAuthless,
            url_options: entry.remoteUrlOptions?.map((option) => ({
              ...option,
              label: option.label || option.url,
            })),
            url_regex: entry.remoteUrlRegex,
            url_template: urlTemplate,
            user_config:
              entry.remoteUserConfig && templateKey
                ? { [templateKey]: entry.remoteUserConfig }
                : undefined,
          },
        };
      });
    const next = (length: number) =>
      offset + limit < length ? String(offset + limit) : null;
    if (!plugins)
      return respond({
        servers: servers.slice(offset, offset + limit),
        next_cursor: next(servers.length),
      });
    const slug = params.get("slug");
    const checks = {
      review: { state: "done", by: { type: "your_admin", name: "Claudex" } },
      scan: { state: "not_scanned", reason: "directory_mcp_server" },
    };
    const data = servers
      .map((server) => ({
        id: server.id,
        name: server.name,
        slug: server.slug,
        summary: server.one_liner,
        description: server.description,
        links: {
          documentation: server.documentation,
          support: server.support,
          privacy_policy: server.privacy_policy,
        },
        added_time: server.added_at,
        source: { type: "directory" },
        checks,
        verified_tier: server.verified_tier,
        ...(server.remote.url_template && {
          legacy: {
            verified_tier: server.verified_tier,
            url_template: server.remote.url_template,
            user_config: server.remote.user_config,
          },
        }),
        taxonomy: { object_acted_on: [] },
        components: [
          {
            type: "mcp_server",
            key: server.id,
            name: server.name,
            checks,
            endpoint: server.remote.url_options?.length
              ? { type: "one_of", options: server.remote.url_options }
              : server.remote.url_regex
                ? {
                    type: "user_provided_UNSAFE_LEGACY",
                    regex: server.remote.url_regex,
                  }
                : server.remote.url_template
                  ? { type: "user_provided_any_host" }
                  : { type: "fixed", url: server.remote.url },
            access: {
              type: "sends_data_to",
              service: new URL(server.remote.url).hostname,
              passes_on: false,
            },
            sign_in: server.remote.is_authless ? "none" : "required",
            tools: (server.tool_names ?? []).map((name) => ({ name })),
            prompts: [],
          },
        ],
        installation: {
          state: "not_installed",
          actions: { install: true },
          admin_policy: { type: "not_in_organization_catalog" },
        },
        metrics: {},
      }));
    const pluginCards = visible.filter(entry => entry.kind === "plugin").map(entry => ({
      id: entry.id,
      name: entry.name,
      slug: entry.slug,
      summary: entry.description,
      description: entry.description,
      links: { documentation: entry.documentationUrl, support: entry.curation?.supportUrl ?? entry.supportUrl,
        privacy_policy: entry.curation?.privacyPolicyUrl, homepage: entry.url },
      added_time: entry.added,
      source: { type: "directory" },
      checks: { review: checks.review, scan: { state: "unavailable" } },
      verified_tier: "community",
      taxonomy: { object_acted_on: [] },
      components: [],
      installation: {
        state: "not_installed",
        actions: { install: false },
        admin_policy: { type: "not_in_organization_catalog" },
      },
      metrics: {},
    }));
    const cards = [...data, ...pluginCards]
      .filter(card => !slug || slug === card.slug || slug === card.id)
      .sort((left, right) => right.added_time.localeCompare(left.added_time));
    return respond({
      data: cards.slice(offset, offset + limit),
      next_page: next(cards.length),
      facets: {},
    });
  } catch {
    return reply(
      res,
      {
        error: {
          message: current()
            ? "The connector directory could not be loaded."
            : "The account changed.",
        },
      },
      current() ? 503 : 409,
    );
  }
}
class DiscoveryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function stop(status: number, message: string): never {
  throw new DiscoveryError(status, message);
}
export async function directoryReadRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  ctx: AdapterContext,
): Promise<boolean> {
  const match =
    /^\/api\/organizations\/([^/]+)\/library\/discover\/browse$/.exec(p);
  if (!match || (!ctx.readOnly && !ctx.localCall)) return false;
  const desktop = !ctx.readOnly && !!ctx.localCall;
  const fail = (status: number, message: string) =>
    reply(res, { error: { type: "invalid_request_error", message } }, status);
  if (req.method !== "GET")
    return fail(405, "Marketplace discovery is read-only.");
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.();
  if (!owner) return fail(401, "Sign in to continue.");
  if (match[1] !== organizationUuid(owner))
    return fail(404, "Organization not found.");
  const current = () => {
    if (
      ctx.isCurrent?.() === false ||
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== activation
    )
      stop(409, "The account changed. Reopen discovery.");
  };
  try {
    const params = url.searchParams,
      allowed = new Set([
        "kind",
        "source",
        "marketplace_id",
        "q",
        "category",
        "sort",
        "include_added",
        "limit",
        "cursor",
      ]);
    if (
      [...params.keys()].some((k) => !allowed.has(k)) ||
      [...allowed].some((k) => k !== "kind" && params.getAll(k).length > 1)
    )
      stop(400, "Unsupported marketplace discovery query.");
    const source = params.get("source");
    if (!desktop && source !== "personal")
      stop(
        501,
        "Only explicitly scoped personal marketplace discovery is available. Provider and approved-directory discovery are not mapped.",
      );
    const kinds = params.getAll("kind");
    if (!desktop && (kinds.length !== 1 || kinds[0] !== "plugin"))
      stop(
        501,
        "Choose plugin discovery explicitly; standalone skill discovery is not mapped.",
      );
    const sort = params.get("sort") ?? "name";
    if (sort !== "name" && (!desktop || sort !== "installs"))
      stop(
        501,
        "This marketplace sort needs unavailable usage, date or ranking facts.",
      );
    if (
      params.has("include_added") &&
      !["true", "false"].includes(params.get("include_added")!)
    )
      stop(400, "Invalid installed-item filter.");
    const limitText = params.get("limit") ?? "50";
    if (!/^[1-9][0-9]{0,3}$/.test(limitText) || Number(limitText) > 1000)
      stop(400, "Invalid page limit.");
    const q = params.get("q") ?? "",
      category = params.get("category");
    if (
      q.length > 200 ||
      (category !== null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category))
    )
      stop(400, "Invalid marketplace search.");
    const market = params.get("marketplace_id");
    if (market !== null && !/^marketplace_[a-f0-9]{24}$/.test(market))
      stop(400, "Invalid marketplace identity.");
    if (desktop && ((source !== null && source !== "personal") ||
      (kinds.length > 0 && !kinds.includes("plugin"))))
      return reply(res, { items: [], next_cursor: null, facets: { categories: [] } });
    current();
    const value = await ctx.call("listPlugins");
    current();
    const catalog = value as PluginCatalog;
    if (
      !catalog ||
      !Array.isArray(catalog.plugins) ||
      catalog.plugins.length > 4096 ||
      catalog.plugins.some((e) => !e || typeof e.installed !== "boolean")
    )
      stop(500, "The runtime marketplace catalog is invalid.");
    if (
      catalog.plugins.some(
        (e) =>
          e.availableVersion !== undefined &&
          (typeof e.availableVersion !== "string" ||
            Buffer.byteLength(e.availableVersion, "utf8") > 256),
      )
    )
      stop(500, "Invalid available plugin version.");
    // Validate available rows too: the installed-only mapper deliberately ignores them.
    const mapped = installedPluginLibrary({
      ...catalog,
      plugins: catalog.plugins.map((e) => ({ ...e, installed: true })),
    }, desktop);
    if (
      new Set(catalog.marketplaces.map((m) => m.name)).size !==
      catalog.marketplaces.length
    )
      stop(500, "Duplicate marketplace identities.");
    if (
      catalog.plugins.some(
        (e) =>
          e.category !== undefined &&
          (typeof e.category !== "string" || e.category.length > 64),
      )
    )
      stop(500, "Invalid marketplace categories.");
    const personal = catalog.plugins
      .map((entry, index) => ({ entry, row: mapped[index] }))
      .filter(({ entry }) => desktop ? isPersonalRuntimePlugin(entry, catalog) : entry.personal === true);
    if (
      personal.some(
        (x) =>
          !catalog.marketplaces.some((m) => m.name === x.entry.marketplace),
      )
    )
      stop(500, "A personal marketplace is missing from the catalog.");
    if (
      market &&
      !personal.some(
        (x) => runtimeMarketplaceId(x.entry.marketplace) === market,
      )
    )
      return fail(404, "Personal marketplace not found.");
    let rows = personal
      .filter(
        ({ entry }) =>
          (!desktop || entry.installable || entry.installed) &&
          (params.get("include_added") === "true" || !entry.installed) &&
          (!market || runtimeMarketplaceId(entry.marketplace) === market) &&
          (!category || entry.category === category) &&
          (!q ||
            [entry.name, entry.title, entry.description ?? ""]
              .join("\n")
              .toLocaleLowerCase()
              .includes(q.toLocaleLowerCase())),
      )
      .map(({ entry, row }) => ({
        ...row,
        ...(desktop && { claudex_local_marketplace: true }),
        version: entry.availableVersion ?? null,
        plugin: { ...row.plugin, partition_by: "account" },
        provenance: {
          ...row.provenance,
          source: "personal",
          marketplace_id: runtimeMarketplaceId(entry.marketplace),
          marketplace_kind: "account_marketplace",
        },
        viewer: {
          ...row.viewer,
          added: entry.installed,
          installed: entry.installed ? row.viewer.installed : null,
        },
        categories:
          entry.category && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.category)
            ? [entry.category]
            : [],
      }));
    rows.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.id.localeCompare(b.id),
    );
    const scope = [...params].filter(([k]) => k !== "cursor");
    const revision = hash([owner, scope, rows]);
    let offset = 0;
    const cursor = params.get("cursor");
    if (cursor) {
      const match = /^([a-f0-9]{24}):([0-9]{1,5})$/.exec(cursor);
      if (!match || match[1] !== revision || Number(match[2]) > rows.length)
        stop(409, "The marketplace changed or the cursor is invalid.");
      offset = Number(match[2]);
    }
    const count = new Map<string, number>();
    for (const row of rows)
      for (const key of row.categories)
        count.set(key, (count.get(key) ?? 0) + 1);
    const limit = Number(limitText),
      body = {
        items: rows.slice(offset, offset + limit),
        next_cursor:
          offset + limit < rows.length ? `${revision}:${offset + limit}` : null,
        facets: {
          categories: [...count].map(([key, count]) => ({ key, count })),
        },
      };
    if (Buffer.byteLength(JSON.stringify(body)) > 4 * 1024 * 1024)
      stop(413, "The marketplace response is too large.");
    current();
    return reply(res, body);
  } catch (error) {
    return error instanceof DiscoveryError
      ? fail(error.status, error.message)
      : fail(503, "The personal marketplace catalog could not be read.");
  }
}
