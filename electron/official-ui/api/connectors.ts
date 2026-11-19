import { officialCapabilityPreferences, saveOfficialCapabilityPreference } from "./capability-preferences";
import { hasOfficialCapabilityPreference } from "../../../shared/official-capability-preferences";
import { officialConnectorLifecycleTarget } from "../../../shared/official-ui-web";
import { approvedConnectorDirectory } from "./directory-read";
import { connectorConfigurationError } from "../../../shared/connector-url-configuration";
import { parseOfficialToolPreferences } from "../../../shared/official-connector-preferences";
import { parseOfficialCodeSettings } from "../../../shared/official-code-settings";
import { widgetToolMetadata } from "../../../shared/widget";
import { officialLocalServerName } from "../../connectors/extension-identity";
import { parseOfficialModelFallback } from "../../../shared/official-model-fallback";
import { saveOfficialClassification, saveOfficialCodeFlaggedSwitch, saveOfficialModelFallback } from "./classification-settings";
import { saveOfficialChatFont } from "./appearance";
/**
 * Customize › Connectors (official consumers: shared-m-2 remote server
 * queries and mutations, shared-m-1 `mcp/v2/bootstrap` stream reader with its
 * server_list / server_base / tools events, frame-shell-broker start-auth
 * popup), on the Claudex agent's MCP servers ("mcpServers",
 * "addCustomConnector", "removeConnector", "connectConnector",
 * "setConnectorTool"). The page names a server by uuid; Claudex by name,
 * so the uuid is a stable hash of the name.
 */
import { createHash } from "node:crypto";
import type http from "node:http";
import { z } from "zod";
import type {
  McpServers,
  McpServerState,
  ConnectorToolPermission,
  CustomConnector,
} from "../../../shared/settings-desktop-api";
import {
  connectorServerId,
  connectorUrlError,
} from "../../../shared/custom-connector";
import { connectorOAuthOverrides } from "../../../shared/connector-oauth-options";
import { ConnectorAddressError } from "../../../runner/src/connectors";
import { reservedMcpServerName } from "../../connectors/mcp-config-file";
import { ConnectorProbeError } from "../../connectors/connector-probe";
import {
  ConnectorClients,
  connectorHeaderName,
  connectorHeaderValue,
} from "../../connectors/connector-clients";
import { connectorSignInUrl } from "../../connectors/connector-owner";
import type { RemoteConnectorSkills } from "../../connectors/remote-skills";
import { empty, reply, organizationUuid, type AdapterContext } from "./context";
import { readState, writeState } from "./state";
import { ScopedMap, scopedValue } from "./scope";
import { captureConnectorInventoryReset, connectorInventory, readConnectorInventory } from "./connector-inventory";
import { connectorUuid, matchesConnectorAuthRejection } from "./connector-auth";
import { resolveConversationId } from "./conversations";
export { connectorUuid } from "./connector-auth";
import { readBoundedBytes, readBoundedJson, RequestBodyError } from "./request-body";
import {
  knowledgeConnector,
  knowledgeConnectorName,
  knowledgeConnectorTools,
  type KnowledgeConnector,
} from "./knowledge-connector";

const knowledgeConnectorUuid = connectorUuid(knowledgeConnectorName);
const managedConnectorFlag = "claudex_managed";

class ConnectorRouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const invalid = (message: string): never => {
  throw new ConnectorRouteError(400, message);
};
function fields(body: Record<string, unknown>, allowed: string[]) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !allowed.includes(key))
  )
    invalid("Unsupported connector fields.");
}
function textField(value: unknown, name: string, limit = 2048): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > limit ||
    /[\u0000-\u001f]/.test(value)
  )
    return invalid(`Invalid connector ${name}.`);
  return value.trim();
}

function connectorAddress(value: unknown) {
  const address = textField(value, "URL");
  const error = connectorUrlError(address);
  if (error) invalid(error);
  return new URL(address).href;
}

const transportSchema = z.enum(["sse", "streamable-http"]);
const emptyList = z.tuple([]);
const oauthClientId = z.strictObject({
  type: z.literal("oauth_method_input"),
  name: z.literal("client_id"),
  value: z.string(),
});
const oauthClientSecret = z.strictObject({
  type: z.literal("oauth_client_credential"),
  name: z.literal("client_secret"),
  value: z.string(),
});
const headerDeclaration = z.strictObject({
  name: connectorHeaderName,
  scope: z.literal("organization"),
  required: z.boolean(),
  display: z.strictObject({
    label: z.string().nullable(),
    description: z.string().optional(),
    format: z.strictObject({
      pattern: z.string().optional(),
      maxLength: z.int().positive().optional(),
      placeholder: z.string().optional(),
    }).optional(),
  }).nullish(),
});
const headerInput = z.strictObject({
  type: z.literal("mcp_request_header"),
  name: connectorHeaderName,
  value: connectorHeaderValue,
});
const oauthMethod = z.strictObject({
  type: z.literal("oauth"),
  mcp_request_headers: z.array(headerDeclaration).max(4).optional(),
});
const installBase = z.strictObject({
  type: z.literal("custom"),
  transport: transportSchema,
  oauth_overrides: connectorOAuthOverrides.nullish(),
  grant: z.strictObject({ grant_type: z.literal("auth_code") }).nullish(),
});
const oauthInstall = installBase.extend({
  posture: z.enum(["auth_required", "defer_auth"]),
});
const customInstall = z.union([
  installBase.extend({ posture: z.literal("no_auth"), inputs: emptyList }),
  installBase.extend({
    posture: z.literal("auth_required"),
    auth_method: z.strictObject({
      type: z.literal("static_headers"),
      mcp_request_headers: z.array(headerDeclaration).min(1).max(4),
    }),
    inputs: z.array(headerInput).min(1).max(4),
  }),
  oauthInstall.extend({
    auth_method: oauthMethod.extend({
      registration: z.strictObject({ type: z.enum(["dcr", "cimd"]) }),
    }),
    inputs: z.array(headerInput).max(4),
  }),
  oauthInstall.extend({
    auth_method: oauthMethod.extend({
      registration: z.strictObject({
        type: z.literal("static_per_installation"),
        client_credential: z.strictObject({ type: z.literal("none") }),
      }),
    }),
    inputs: z.tuple([oauthClientId], headerInput),
  }),
  oauthInstall.extend({
    auth_method: oauthMethod.extend({
      registration: z.strictObject({
        type: z.literal("static_per_installation"),
        client_credential: z.strictObject({ type: z.literal("client_secret") }),
      }),
    }),
    inputs: z.tuple([oauthClientId, oauthClientSecret], headerInput),
  }),
]);
const probeAnswer = z.object({
  authRequired: z.boolean(),
  suggestedRegistration: z.enum(["dcr", "cimd", "static_per_installation"]).optional(),
  transport: transportSchema,
});

function customConnectorOptions(
  body: Record<string, unknown>,
): Pick<CustomConnector, "transport" | "clientId" | "clientSecret" | "headers" | "staticAuth" | "oauth"> {
  if (body.install === undefined) {
    const id =
      body.custom_oauth_client_id == null
        ? undefined
        : textField(body.custom_oauth_client_id, "client ID", 4096);
    const secret =
      body.custom_oauth_client_secret == null
        ? undefined
        : textField(body.custom_oauth_client_secret, "client secret", 4096);
    if (secret && !id)
      invalid("Enter an OAuth client ID to use a client secret.");
    const overrides = connectorOAuthOverrides.nullish().safeParse(body.oauth_overrides);
    if (!overrides.success) return invalid("Invalid connector OAuth endpoints or scopes.");
    return {
      ...(id && { clientId: id }),
      ...(secret && { clientSecret: secret }),
      ...(overrides.data && { oauth: { overrides: overrides.data } }),
    };
  }
  if (body.oauth_overrides != null)
    return invalid("Supply connector OAuth overrides once.");
  if (
    body.custom_oauth_client_id != null ||
    body.custom_oauth_client_secret != null
  )
    invalid("Supply connector credentials once.");
  const parsed = customInstall.safeParse(body.install);
  if (!parsed.success)
    throw new ConnectorRouteError(
      501,
      "This connector installation method is not supported.",
    );
  const { transport, inputs } = parsed.data;
  if (parsed.data.posture === "no_auth") return { transport };
  const method = parsed.data.auth_method;
  const declarations = method.mcp_request_headers ?? [];
  const names = new Set<string>();
  for (const { name } of declarations) {
    if ((name === "authorization" && method.type === "oauth") ||
      [...names].some((other) => name === other ||
        ((name.includes(".") || other.includes(".")) &&
          name.replace(/[._]/g, "-") === other.replace(/[._]/g, "-"))))
      invalid("Invalid connector request header names.");
    names.add(name);
  }
  const headers = new Map<string, string>();
  for (const input of inputs) {
    if (input.type !== "mcp_request_header") continue;
    if (!names.has(input.name) || headers.has(input.name))
      invalid("Invalid connector request header inputs.");
    headers.set(input.name, input.value);
  }
  if (declarations.some(({ name, required }) => required && !headers.has(name)))
    invalid("Enter all required connector request headers.");
  const id = inputs.find((input) => input.type === "oauth_method_input");
  const secret = inputs.find((input) => input.type === "oauth_client_credential");
  return {
    transport,
    ...(id && { clientId: textField(id.value, "client ID", 4096) }),
    ...(secret && {
      clientSecret: textField(secret.value, "client secret", 4096),
    }),
    ...(headers.size && { headers: Object.fromEntries(headers) }),
    ...(method.type === "static_headers" && { staticAuth: true }),
    ...(method.type === "oauth" && { oauth: {
      registration: method.registration.type,
      posture: parsed.data.posture,
      ...(parsed.data.oauth_overrides && { overrides: parsed.data.oauth_overrides }),
    } }),
  };
}

const toolSettings = new ScopedMap<string, Record<string, boolean>>(
  "connector-tool-settings",
);
const consents = () =>
  scopedValue("connector-consents", () =>
    readState<Record<string, string>>("connector-consents", {}),
  );
const saveConsents = () => writeState("connector-consents", consents);
const policyChanges = () =>
  scopedValue("connector-policy-changes", () => ({
    tail: Promise.resolve(),
    version: 0,
  }));
/** Bootstrap must not capture a partially applied menu choice after navigation. */
export async function waitForConnectorToolChanges() {
  const state = policyChanges();
  for (;;) {
    const pending = state.tail;
    await pending;
    if (pending === state.tail) return;
  }
}
function changeToolPolicy<T>(work: () => Promise<T>): Promise<T> {
  const state = policyChanges();
  const result = state.tail.then(async () => {
    state.version++;
    try {
      return await work();
    } finally {
      state.version++;
    }
  });
  state.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
const engineChanging = (error: unknown) =>
  /engine is not connected|not running|starting/i.test(String(error));
function configuredServers(ctx: AdapterContext): McpServerState[] | undefined {
  const configured = ctx.settings?.()?.mcpServers;
  if (!configured) return undefined;
  return Object.entries(configured).flatMap(([name, raw]) => {
    if (name.toLowerCase() === knowledgeConnectorName || !raw || typeof raw !== "object")
      return [];
    const value = raw as Record<string, unknown>;
    if (typeof value.url !== "string" || value.command) return [];
    return [
      {
        name,
        url: value.url,
        displayName:
          typeof value.display_name === "string"
            ? value.display_name
            : undefined,
        directoryId: typeof value.claudex_directory_id === "string"
          ? value.claudex_directory_id : undefined,
        state:
          value.enabled === false
            ? ("disabled" as const)
            : ("stopped" as const),
        tools: 0,
      },
    ];
  });
}

/** Keys produced by official shared-p-m-0 u7/rp for our published tool schema. */
export function permissionKeys(
  server: McpServerState,
  tool: NonNullable<McpServerState["toolList"]>[number],
  ctx?: AdapterContext,
) {
  const configured = ctx?.settings?.()?.mcpServers?.[server.name];
  const localName = officialLocalServerName(server.name, configured);
  const enabled = `${server.command && !server.url ? `local:${localName}` : connectorUuid(server.name)}:${tool.name}`;
  // Original n8/rp hashes sorted parameter descriptions, not just the tool
  // description. The bootstrap now publishes these schemas, so the key must
  // agree with the consumer's fallback and stale-approval cleanup contract.
  const properties =
    toolMetadata({ ...tool, description: tool.description ?? "" }).inputSchema
      ?.properties ?? {};
  const parameters = Object.entries(properties)
    .map(([name, raw]) => {
      const entry =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : undefined;
      const valid =
        entry &&
        ["description", "type", "title"].every(
          (key) => entry[key] === undefined || typeof entry[key] === "string",
        );
      return [name, valid ? entry.description || "" : ""];
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const hash = createHash("md5")
    .update(JSON.stringify([tool.description || "", parameters, null]))
    .digest("hex");
  return { enabled, approved: `${enabled}-${hash}` };
}

export function connectorToolSettings(): Record<string, boolean> {
  return (
    toolSettings.get("current") ??
    readState<Record<string, boolean>>("connector-tool-settings", {})
  );
}

const knowledgePermissionKeys = () =>
  knowledgeConnectorTools.map((tool) =>
    permissionKeys({ name: knowledgeConnectorName, state: "ready", tools: 0 }, tool),
  );

function knowledgeToolSettings(ctx: AdapterContext) {
  if (!ctx.knowledgeOffer) return {};
  const approve = ctx.connectorAlwaysAllow?.() !== false;
  return Object.fromEntries(knowledgePermissionKeys().flatMap(({ enabled, approved }) => [
    [enabled, false], [approved, approve],
  ]));
}

export function accountConnectorToolSettings(ctx: AdapterContext) {
  return { ...connectorToolSettings(), ...knowledgeToolSettings(ctx) };
}

function rememberToolSettings(list: McpServerState[], ctx?: AdapterContext) {
  const settings: Record<string, boolean> = {};
  for (const server of list)
    for (const tool of server.toolList ?? []) {
      const keys = permissionKeys(server, tool, ctx);
      settings[keys.enabled] = tool.enabled;
      settings[keys.approved] = tool.approval === "approve";
    }
  toolSettings.set("current", settings);
  writeState("connector-tool-settings", () => connectorToolSettings());
}

/**
 * A connector change restarts the agent; a call made while it restarts is
 * answered "not connected". Wait for it (at most 30 s) and ask again.
 */
async function whenEngineReady<T>(call: () => Promise<T>): Promise<T> {
  const until = Date.now() + 30000;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (!engineChanging(error) || Date.now() > until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** Remote servers only: a local program is a desktop MCP server (MCP native domain). */
const remote = (server: McpServerState) => !!server.url && !server.command;
const portableServer = (ctx: AdapterContext, server: McpServerState) =>
  server.name.toLowerCase() !== knowledgeConnectorName &&
  (remote(server) || (!!ctx.localMcpConfig && !!server.command && !server.url));

export async function servers(ctx: AdapterContext, includeLocal = false, { cache = true } = {}) {
  const version = policyChanges().version;
  const configuration = JSON.stringify(ctx.settings?.()?.mcpServers);
  const all = await whenEngineReady(
    () => ctx.call("mcpServers") as Promise<McpServers>,
  );
  if (JSON.stringify(ctx.settings?.()?.mcpServers) !== configuration)
    throw new ConnectorRouteError(
      409,
      "The connector configuration changed. Refresh and try again.",
    );
  if (!all || !Array.isArray(all.servers) || all.configError)
    throw new ConnectorRouteError(
      503,
      "Connector configuration or inventory is unavailable. Check connector settings.",
    );
  const eligible = all.servers.filter((server) => portableServer(ctx, server));
  const list = cache ? connectorInventory(ctx, eligible) : readConnectorInventory(ctx, eligible);
  if (cache && version === policyChanges().version) rememberToolSettings(list, ctx);
  return includeLocal ? list : list.filter(remote);
}

async function setPermissions(
  ctx: AdapterContext,
  writes: {
    server: McpServerState;
    tool: { name: string };
    permission: ConnectorToolPermission;
  }[],
) {
  if (!writes.length) return;
  let failure: unknown;
  let list: McpServerState[] | undefined;
  try {
    const result = (await ctx.call(
      "setConnectorToolPermissions",
      writes.map(({ server, tool, permission }) => ({
        name: server.name,
        tool: tool.name,
        permission,
      })),
    )) as McpServers | undefined;
    if (result?.configError)
      throw new ConnectorRouteError(
        503,
        "The connector configuration was not applied. Check connector settings.",
      );
    if (Array.isArray(result?.servers)) {
      list = connectorInventory(ctx, result.servers.filter((server) => portableServer(ctx, server)));
    }
  } catch (error) {
    if (!engineChanging(error)) throw error;
    failure = error;
  }
  list ??= await servers(ctx, !!ctx.localMcpConfig);
  // A restart can invalidate the discovery response after configuration was
  // committed. Reconcile every tool; never repeat the mutation or accept half.
  if (
    writes.some(({ server, tool, permission }) => {
      const current = list!
        .find((s) => s.name === server.name)
        ?.toolList?.find((t) => t.name === tool.name);
      return (
        !current ||
        (permission === "block"
          ? current.enabled
          : !current.enabled ||
            (permission === "allow"
              ? current.approval !== "approve"
              : current.approval !== "prompt"))
      );
    })
  )
    throw (
      failure ??
      Error(
        "The connector tool choices were not saved completely. Refresh and try again.",
      )
    );
  rememberToolSettings(list, ctx);
}
export async function connectorNamed(ctx: AdapterContext, uuid: string) {
  return (await servers(ctx)).find((s) => connectorUuid(s.name) === uuid);
}

function serverRow(s: McpServerState, ctx: AdapterContext) {
  const root = ctx.stateDirectory?.();
  const credentials = root && s.url ? new ConnectorClients(root).get(s.name, s.url) : undefined;
  const overrides = credentials?.oauth?.overrides;
  const at = new Date(s.lastConnectedAt ?? 0).toISOString();
  return {
    uuid: connectorUuid(s.name),
    name: s.displayName || s.name,
    mcp_directory_server_uuid: s.directoryId,
    url: s.url ?? "",
    created_at: at,
    updated_at: at,
    custom_oauth_client_id: null,
    custom_oauth_client_secret_mask: null,
    oauth_overrides: overrides ?? null,
    is_enabled: s.state !== "disabled",
  };
}
function knowledgeServerRow(entry: KnowledgeConnector) {
  return {
    uuid: knowledgeConnectorUuid,
    name: entry.base.name,
    description: entry.base.description,
    url: entry.server.url,
    label: entry.base.name,
    label_is_automatic: true,
    label_editable: false,
    additional_install: false,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    is_enabled: true,
    cai_flags: [managedConnectorFlag],
  };
}

const connected = (s: McpServerState) =>
  s.state === "ready" &&
  (s.authStatus === "oAuth" ||
    s.authStatus === "bearerToken" ||
    s.authStatus === "staticHeaders" ||
    s.authStatus === "unsupported" ||
    (s.authStatus === undefined && s.tools > 0));
const usedAuthentication = (s: McpServerState) =>
  s.authStatus === "oAuth" || s.authStatus === "bearerToken" || s.authStatus === "staticHeaders";
const connectionStatus = (s: McpServerState) => {
  if (s.oauthStatus === "disconnected") return "user_disconnected";
  if (s.oauthStatus === "reconnect") return "error";
  if (connected(s)) return "connected";
  return null;
};
function authStatus(s: McpServerState) {
  if (s.oauthStatus === "reconnect") return "token_invalid";
  if (usedAuthentication(s)) return "authenticated";
  if (s.authStatus === "notLoggedIn") return "auth_required";
  if (connected(s)) return "not_required";
}

/** Bounded JSON metadata from the runtime, not renderer supplied schemas. */
function toolMetadata(tool: NonNullable<McpServerState["toolList"]>[number]) {
  if (
    typeof tool.name !== "string" ||
    !tool.name ||
    tool.name.length > 512 ||
    typeof tool.description !== "string" ||
    tool.description.length > 65536
  )
    throw new ConnectorRouteError(
      503,
      "Connector tool metadata is unavailable.",
    );
  const definition = tool.definition;
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(v));
  const fail = (): never => {
    throw new ConnectorRouteError(
      503,
      "Connector tool metadata is unavailable.",
    );
  };
  if (
    definition !== undefined &&
    (!object(definition) || definition.name !== tool.name)
  )
    fail();
  let inputSchema: Record<string, unknown> | undefined;
  if (definition?.inputSchema !== undefined) {
    if (!object(definition.inputSchema)) fail();
    let nodes = 0,
      textBytes = 0;
    const seen = new Set<object>();
    const check = (value: unknown, depth: number): void => {
      if (++nodes > 20000 || depth > 24) fail();
      if (typeof value === "string") {
        textBytes += Buffer.byteLength(value);
        if (textBytes > 256 * 1024) fail();
        return;
      }
      if (value === null || typeof value === "boolean") return;
      if (typeof value === "number") {
        if (!Number.isFinite(value)) fail();
        return;
      }
      if (!Array.isArray(value) && !object(value)) fail();
      const obj = value as object;
      if (seen.has(obj)) fail();
      seen.add(obj);
      const entries = Object.entries(obj);
      if (entries.length > 20000) fail();
      for (const [key, child] of entries) {
        textBytes += Buffer.byteLength(key);
        check(child, depth + 1);
      }
      seen.delete(obj);
    };
    check(definition.inputSchema, 0);
    const json = JSON.stringify(definition.inputSchema);
    if (Buffer.byteLength(json) > 256 * 1024) fail();
    inputSchema = JSON.parse(json);
  }
  const annotations: Record<string, string | boolean> = {};
  if (definition?.annotations !== undefined) {
    if (!object(definition.annotations)) fail();
    for (const key of [
      "title",
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ]) {
      const value = definition.annotations[key];
      if (value === undefined) continue;
      if (
        key === "title"
          ? typeof value !== "string" || value.length > 4096
          : typeof value !== "boolean"
      )
        fail();
      annotations[key] = value as string | boolean;
    }
  }
  // Access is a host-derived hint, never proof that executing a tool is safe.
  if (annotations.readOnlyHint === undefined && tool.access === "readOnly")
    annotations.readOnlyHint = true;
  if (annotations.readOnlyHint === undefined && tool.access === "write")
    annotations.readOnlyHint = false;
  const _meta = widgetToolMetadata(definition);
  return {
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(Object.keys(annotations).length ? { annotations } : {}),
    ...(_meta ? { _meta } : {}),
  };
}

/** The bootstrap stream: the servers, each one's state, then its tools. */
function bootstrapStream(
  res: http.ServerResponse,
  list: McpServerState[],
  alwaysAllow: boolean,
  remoteSkills: Awaited<ReturnType<RemoteConnectorSkills["list"]>> | undefined,
  knowledge: KnowledgeConnector | null | undefined,
) {
  const chunks: string[] = [];
  let bytes = 0;
  const event = (name: string, data: unknown) => {
    const chunk = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    bytes += Buffer.byteLength(chunk);
    if (bytes > 4 * 1024 * 1024)
      throw new ConnectorRouteError(503, "Connector inventory is too large.");
    chunks.push(chunk);
  };
  if (list.length > 1000 || list.some((s) => (s.toolList?.length ?? 0) > 1000))
    throw new ConnectorRouteError(503, "Connector inventory is too large.");
  for (const server of list) {
    if (
      typeof server.name !== "string" ||
      server.name.length > 512 ||
      (server.url !== undefined &&
        (typeof server.url !== "string" || server.url.length > 8192)) ||
      (server.displayName !== undefined &&
        (typeof server.displayName !== "string" ||
          server.displayName.length > 4096))
    )
      throw new ConnectorRouteError(503, "Connector inventory is unavailable.");
  }
  let toolBytes = 0;
  event("server_list", {
    ...(knowledge === null && { deleted_server_uuids: [knowledgeConnectorUuid] }),
    servers: list.map((s) => ({
      uuid: connectorUuid(s.name),
      name: s.displayName || s.name,
      url: s.url,
      label: s.displayName || s.name,
      labelIsAutomatic: true,
      labelEditable: false,
      ...(knowledge?.server === s && {
        additionalInstall: false,
        description: knowledge.base.description,
        cai_flags: [managedConnectorFlag],
      }),
    })),
  });
  for (const s of list) {
    const skills = remoteSkills?.get(s.name);
    const reported: McpServerState =
      !skills?.length || connected(s)
        ? s
        : { ...s, state: "ready", authStatus: s.authStatus ?? "unsupported" };
    event("server_base", {
      uuid: connectorUuid(s.name),
      name: s.displayName || s.name,
      url: s.url,
      ...(knowledge?.server === s && {
        description: knowledge.base.description,
        cai_flags: [managedConnectorFlag],
      }),
      connected: connected(reported),
      authStatus: authStatus(reported),
      usedAuthentication: usedAuthentication(reported),
      // The official consumer accepts an opaque connectionError string and
      // renders its generic transport-error branch. Do not invent OAuth,
      // timeout or retryability, and never leak raw runtime error details.
      ...(reported.state === "failed" ? { connectionError: "connection_failed" } : {}),
    });
    if (skills !== undefined)
      event("skills", { server_uuid: connectorUuid(s.name), skills });
    event("tools", {
      server_uuid: connectorUuid(s.name),
      // shared-m-1 nw consumes the keys from the server; it does not derive
      // them. Missing keys let the page render, then throw on a permission click.
      tools: (s.toolList ?? []).map((t) => {
        const keys = permissionKeys(s, t);
        const row = {
          name: t.name,
          description: t.description,
          ...toolMetadata(t),
          enabled_key: keys.enabled,
          always_approved_key: keys.approved,
          ...(!alwaysAllow && { org_max_permission: "ask", effective_max_permission: "ask" }),
        };
        toolBytes += Buffer.byteLength(JSON.stringify(row));
        if (toolBytes > 3 * 1024 * 1024)
          throw new ConnectorRouteError(
            503,
            "Connector inventory is too large.",
          );
        return row;
      }),
    });
    // No global resource catalog is exposed by the source service. Do not
    // claim an empty complete list (or invent a resource-level error event).
    // Project-scoped knowledge resources are a different authorization scope.
  }
  event("first_pass_complete", {});
  event("completed", {});
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const chunk of chunks) res.write(chunk);
  res.end();
  return true;
}

export async function connectorsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx: AdapterContext,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const org =
    /^\/api\/organizations\/([^/]+)\/mcp\/(?:v2\/bootstrap|remote_servers(?:_with_connection)?|remote_servers\/[^/]+(?:\/(?:tool_policies(?:\/[^/]+)?|clear_cache))?|logout\/[^/]+|start-auth\/[^/]+|probe)$/.exec(
      p,
    );
  const accountRoute =
    /^\/api\/accounts\/me\/consents(?:\/(?:check|revoke))?$/.test(p) ||
    p === "/api/account/settings";
  if (!org && !accountRoute) return false;
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.();
  const errorReply = (status: number, message: string) =>
    reply(
      res,
      { type: "error", error: { type: "invalid_request_error", message } },
      status,
    );
  if (!owner) return errorReply(401, "Sign in to continue.");
  if (org && org[1] !== organizationUuid(owner))
    return errorReply(404, "Organization not found.");
  const original = ctx;
  const current = () => {
    if (
      original.isCurrent?.() === false ||
      original.account()?.id !== owner ||
      original.sessionIdentity?.() !== activation
    )
      throw new ConnectorRouteError(
        409,
        "The account changed. Reopen connectors.",
      );
  };
  ctx = new Proxy(original, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function" || key === "log") return value;
      return (...args: unknown[]) => {
        current();
        const result = value.apply(target, args);
        if (result && typeof result.then === "function")
          return result.then(
            (answer: unknown) => {
              current();
              return answer;
            },
            (error: unknown) => {
              current();
              throw error;
            },
          );
        current();
        return result;
      };
    },
  });
  const bodyJson = async () => {
    const body = await readBoundedJson(req, 1024 * 1024);
    current();
    return body;
  };
  const readOperation =
    (method === "GET" && !p.includes("/start-auth/")) ||
    (p.endsWith("/consents/check") && method === "POST");
  const appearanceCandidate =
    p === "/api/account/settings" &&
    method === "PATCH" &&
    !!ctx.authorizeAppearanceSettings;
  const connectorCandidate =
    p === "/api/account/settings" &&
    method === "PATCH" &&
    !!ctx.authorizeConnectorPreferences;
  const customKind =
    !org || method !== "POST"
      ? undefined
      : p.endsWith("/mcp/probe")
        ? "probe"
        : p.endsWith("/mcp/remote_servers")
          ? "add"
          : undefined;
  const customCandidate =
    !!customKind &&
    ctx.allowCustomConnectorCreation === true &&
    !!ctx.authorizeCustomConnector;
  const lifecycle = officialConnectorLifecycleTarget(method, p);
  const lifecycleCandidate = lifecycle && ctx.authorizeConnectorLifecycle;
  if (
    ctx.readOnly &&
    !readOperation &&
    !appearanceCandidate &&
    !connectorCandidate &&
    !customCandidate &&
    !lifecycleCandidate
  )
    return errorReply(
      403,
      "Connector changes are unavailable in this read-only host.",
    );
  const notFound = () =>
    reply(
      res,
      {
        type: "error",
        error: { type: "not_found_error", message: "Connector not found" },
      },
      404,
    );
  const refused = (error: unknown) =>
    reply(
      res,
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      400,
    );
  try {
    const targetId = /^\/api\/organizations\/[^/]+\/mcp\/(?:remote_servers|start-auth|logout)\/([^/]+)/.exec(p)?.[1];
    const managedServerRoute = targetId === knowledgeConnectorUuid;
    if (managedServerRoute && (p.includes("/start-auth/") || method !== "GET"))
      return errorReply(403, "Claudex manages this connector.");
    const policies = /\/remote_servers\/([^/]+)\/tool_policies$/.exec(p);
    if (policies && method === "GET") {
      const server = managedServerRoute
        ? (await knowledgeConnector(ctx))?.server
        : (configuredServers(ctx) ?? await servers(ctx)).find(
          (item) => connectorUuid(item.name) === policies[1],
        );
      current();
      if (!server) return notFound();
      return reply(res, ctx.connectorAlwaysAllow?.() === false
        ? [{ tool_name: "*", max_permission: "ask" }]
        : []);
    }
    if (/\/tool_policies(?:\/[^/]+)?$/.test(p))
      throw new ConnectorRouteError(
        501,
        "Organization connector policy changes are unavailable.",
      );
    // shared-m-1 _o/i3/UI: the connector consent receipt belongs to this
    // account. Recording consent never changes its tool execution policy.
    if (/^\/api\/accounts\/me\/consents(?:\/(?:check|revoke))?$/.test(p)) {
      const check = p.endsWith("/check"),
        revoke = p.endsWith("/revoke");
      if (method !== (check || revoke ? "POST" : "PUT"))
        return refused(new Error("Unsupported consent operation."));
      const body = await bodyJson();
      fields(body, [
        "consent_type",
        "entity_type",
        "entity_id",
        ...(check || revoke ? [] : ["consent_hash"]),
      ]);
      if (
        body.consent_type !== "consumer_health" ||
        body.entity_type !== "mcp_remote_server" ||
        typeof body.entity_id !== "string" ||
        !/^[0-9a-f-]{36}$/.test(body.entity_id)
      )
        return refused(new Error("Invalid connector consent."));
      const id = body.entity_id;
      if (check) return reply(res, { has_consent: !!consents()[id] });
      if (revoke) {
        delete consents()[id];
        saveConsents();
        return empty(res);
      }
      if (!(await connectorNamed(ctx, id))) return notFound();
      if (
        typeof body.consent_hash !== "string" ||
        !body.consent_hash ||
        body.consent_hash.length > 1024
      )
        return refused(new Error("Invalid connector consent receipt."));
      consents()[id] = body.consent_hash;
      saveConsents();
      return empty(res);
    }
    // The person's Tool permissions controls PATCH account settings; the
    // /tool_policies endpoints are organization ceilings, a separate contract.
    if (p === "/api/account/settings" && method === "PATCH") {
      const body = await bodyJson();
      let codeSettings;
      try {
        codeSettings = parseOfficialCodeSettings(body);
      } catch (error) {
        return refused(error);
      }
      if (codeSettings) {
        if (ctx.readOnly || !ctx.localCall)
          return errorReply(403, "Code settings are unavailable on this host.");
        if (ctx.isCurrent?.() !== true || activation == null || activation === "")
          return errorReply(409, "The account activation changed. Reopen settings.");
        try {
          current();
          if (!(await ctx.saveOfficialCodeSettings?.(codeSettings.patch)))
            await ctx.localCall("saveSettings", { ...ctx.settings(), ...codeSettings.patch });
        } catch (error) {
          if (error instanceof ConnectorRouteError) throw error;
          return errorReply(503, "The Code settings could not be saved.");
        }
        return reply(res, codeSettings.wire);
      }
      let fallback;
      try {
        // The original Code switch producer carries the current tool search
        // choice along with model fallback. Accept it only as an unchanged
        // companion, never as a second preference write.
        let fallbackBody = body;
        if (Object.hasOwn(body, "ccr_switch_models_on_flag") &&
            Object.hasOwn(body, "enabled_model_auto_fallback") &&
            Object.hasOwn(body, "tool_search_mode")) {
          if (body.tool_search_mode !== officialCapabilityPreferences(ctx).tool_search_mode)
            return errorReply(409, "Tool access mode changed. Reload settings before saving.");
          const { tool_search_mode: _companion, ...rest } = body;
          fallbackBody = rest;
        }
        fallback = parseOfficialModelFallback(fallbackBody);
      } catch (error) {
        return refused(error);
      }
      if (fallback) {
        const result = await saveOfficialModelFallback(ctx, fallback);
        return reply(res, result.body, result.status);
      }
      if (hasOfficialCapabilityPreference(body)) {
        const result = await saveOfficialCapabilityPreference(ctx, body);
        return reply(res, result.body, result.status);
      }
      if (Object.hasOwn(body, "ccr_switch_models_on_flag")) {
        const result = await saveOfficialCodeFlaggedSwitch(ctx, body);
        return reply(res, result.body, result.status);
      }
      if (Object.hasOwn(body, "ccr_session_state_buckets")) {
        const result = await saveOfficialClassification(ctx, body);
        return reply(res, result.body, result.status);
      }
      if (Object.hasOwn(body, "chat_font")) {
        const result = await saveOfficialChatFont(ctx, body);
        return reply(res, result.body, result.status);
      }
      if (ctx.readOnly && !ctx.authorizeConnectorPreferences)
        return errorReply(
          403,
          "Other account settings remain unavailable in this read-only host.",
        );
      if (body.enabled_mcp_tools === undefined)
        return refused(
          new Error("These account settings are not supported yet."),
        );
      if (Object.keys(body).length !== 1)
        return refused(new Error("Invalid connector tool settings."));
      let changes;
      try { changes = { ...parseOfficialToolPreferences(body.enabled_mcp_tools) }; }
      catch (error) { return refused(error); }
      return await changeToolPolicy(async () => {
        if (ctx.readOnly) ctx.authorizeConnectorPreferences!("account");
        for (const { enabled, approved } of knowledgePermissionKeys()) {
          delete changes[enabled];
          delete changes[approved];
        }
        const list = Object.keys(changes).length
          ? await servers(ctx, !!ctx.localMcpConfig)
          : [];
        const known = new Set(
          list.flatMap((server) =>
            (server.toolList ?? []).flatMap((tool) => {
              const keys = permissionKeys(server, tool, ctx);
              return [keys.enabled, keys.approved];
            }),
          ),
        );
        const enabledKeys = list.flatMap((server) =>
          (server.toolList ?? []).map(
            (tool) => permissionKeys(server, tool, ctx).enabled,
          ),
        );
        const staleApproval = (key: string) =>
          enabledKeys.some(
            (enabled) =>
              key.startsWith(`${enabled}-`) &&
              /^[0-9a-f]{32}$/.test(key.slice(enabled.length + 1)),
          );
        // Official controls clear old approval fingerprints when a tool's
        // definition changes. Clearing is safe; a stale grant cannot be added.
        if (
          Object.entries(changes).some(
            ([key, value]) =>
              !known.has(key) && !((value === null || value === false) && staleApproval(key)),
          )
        )
          return refused(
            new Error(
              "A connector tool changed. Refresh its tools and try again.",
            ),
          );
        const merged: Record<string, boolean | null> = {
          ...connectorToolSettings(),
          ...changes,
        };
        const alwaysAllow = ctx.connectorAlwaysAllow?.() !== false;
        const writes = list.flatMap((server) =>
          (server.toolList ?? []).flatMap((tool) => {
            const keys = permissionKeys(server, tool, ctx);
            if (!Object.hasOwn(changes, keys.enabled) && !Object.hasOwn(changes, keys.approved))
              return [];
            const permission =
              merged[keys.enabled] === false
                ? "block"
                : merged[keys.approved] === true
                  ? "allow"
                  : "ask";
            const current = !tool.enabled
              ? "block"
              : tool.approval === "approve"
                ? "allow"
                : tool.approval === "prompt"
                  ? "ask"
                  : undefined;
            if (!alwaysAllow && permission === "allow" && (current !== "allow" || changes[keys.approved] === true))
              throw new ConnectorRouteError(403, "Your administrator requires approving each request. Choose Needs approval.");
            return permission === current ? [] : [{ server, tool, permission }];
          }),
        );
        if (ctx.readOnly) ctx.authorizeConnectorPreferences!("account");
        await setPermissions(
          ctx,
          writes.map((write) => ({
            ...write,
            permission: write.permission as ConnectorToolPermission,
          })),
        );
        return reply(res, {
          settings: { enabled_mcp_tools: accountConnectorToolSettings(ctx) },
        });
      });
    }
    if (p.endsWith("/mcp/v2/bootstrap")) {
      if (method !== "GET")
        return errorReply(405, "Unsupported connector operation.");
      const [list, knowledge] = await Promise.all([servers(ctx), knowledgeConnector(ctx)]);
      const configuration = ctx.settings().mcpServers;
      const remoteSkills = await ctx.remoteConnectorSkills?.()?.list(list);
      current();
      if (ctx.settings().mcpServers !== configuration)
        return errorReply(409, "The connector configuration changed. Refresh and try again.");
      return bootstrapStream(
        res,
        knowledge ? [...list, knowledge.server] : list,
        ctx.connectorAlwaysAllow?.() !== false,
        remoteSkills,
        knowledge ?? (ctx.knowledgeOffer ? null : undefined),
      );
    }
    if (
      /\/mcp\/remote_servers(_with_connection)?$/.test(p) &&
      method === "GET"
    ) {
      const withConnection = p.endsWith("_with_connection");
      const [list, knowledge] = await Promise.all([servers(ctx), knowledgeConnector(ctx)]);
      current();
      return reply(
        res,
        (knowledge ? [...list, knowledge.server] : list).map((s) => ({
          ...(knowledge?.server === s ? knowledgeServerRow(knowledge) : serverRow(s, ctx)),
          ...(withConnection
            ? {
                connected: connected(s),
                is_authenticated: usedAuthentication(s),
                connection_auth_type: s.oauthStatus ? "mcp_oauth" : null,
                connection_state: knowledge?.server === s && !knowledge.base.available
                  ? "error"
                  : connectionStatus(s),
                last_connected_at: s.lastConnectedAt ? new Date(s.lastConnectedAt).toISOString() : null,
                tools: (s.toolList ?? []).map((t) => ({
                  name: t.name,
                  description: t.description,
                })),
              }
            : {}),
        })),
      );
    }
    if (p.endsWith("/mcp/remote_servers") && method === "POST") {
      const body = await bodyJson();
      fields(body, [
        "name",
        "url",
        "custom_oauth_client_id",
        "custom_oauth_client_secret",
        "attestations",
        "oauth_overrides",
        "user_confirmed",
        "install",
        "mcp_directory_server_uuid",
      ]);
      if (
        (body.attestations !== undefined &&
          (!Array.isArray(body.attestations) || body.attestations.length))
      )
        throw new ConnectorRouteError(
          501,
          "Connector attestations are not supported.",
        );
      if (
        body.user_confirmed !== undefined &&
        typeof body.user_confirmed !== "boolean"
      )
        invalid("Invalid connector confirmation.");
      const displayName = textField(body.name, "name", 128);
      const url = connectorAddress(body.url);
      const directoryId = body.mcp_directory_server_uuid === undefined ? undefined
        : textField(body.mcp_directory_server_uuid, "directory ID", 128);
      if (directoryId) {
        const entry = (await approvedConnectorDirectory(ctx)).find(row => row.id === directoryId);
        if (!entry) throw new ConnectorRouteError(404, "This connector is no longer in the directory.");
        if (entry.serverUrlType === undefined || entry.serverUrlType === "universal") {
          if (new URL(entry.url).href !== url) invalid("The address does not match the directory entry.");
        } else if (connectorConfigurationError(entry, url)) {
          invalid("The address does not match the directory entry.");
        }
      }
      const options = customConnectorOptions(body);
      if (ctx.readOnly) ctx.authorizeCustomConnector?.("add");
      const configured = ctx.settings()?.mcpServers;
      const existing = configured
        ? Object.keys(configured)
        : (await servers(ctx, !!ctx.localMcpConfig)).map((s) => s.name);
      const base = connectorServerId(displayName, []);
      const reserved = base.toLowerCase() === knowledgeConnectorName || reservedMcpServerName(base);
      const name = connectorServerId(
        displayName,
        reserved ? [...existing, base] : existing,
      );
      const matches = (server: McpServerState) =>
        remote(server) && server.name === name && server.url === url;
      const input: CustomConnector = { name, displayName, url, ...options, ...(directoryId && { directoryId }) };
      let result: McpServers | undefined;
      try {
        result = (await ctx.call("addCustomConnector", input)) as
          McpServers | undefined;
      } catch (error) {
        if (!engineChanging(error)) throw error;
        const added = (configuredServers(ctx) ?? (await servers(ctx))).find(
          matches,
        );
        if (!added) throw error;
        return reply(res, serverRow(added, ctx));
      }
      if (result?.configError)
        throw new ConnectorRouteError(
          503,
          "The connector configuration was not applied. Check connector settings.",
        );
      const added =
        configuredServers(ctx)?.find(matches) ??
        result?.servers?.find(matches) ??
        (await servers(ctx)).find(matches);
      if (!added)
        throw new ConnectorRouteError(
          503,
          "The connector was not saved. Check connector settings and retry.",
        );
      return reply(res, serverRow(added, ctx));
    }
    if (lifecycle) {
      if (new URL(req.url ?? p, "http://localhost").search)
        invalid("Unsupported connector query.");
      if ((await readBoundedBytes(req, 1)).byteLength)
        invalid("Connector lifecycle requests do not accept a body.");
      current();
      const configured = configuredServers(ctx);
      const server = configured
        ? configured.find((item) => connectorUuid(item.name) === lifecycle.serverId)
        : await connectorNamed(ctx, lifecycle.serverId);
      if (!server) return notFound();
      if (lifecycle.kind === "refresh" && server.state === "disabled")
        return errorReply(409, "The connector is disabled.");
      if (ctx.readOnly) ctx.authorizeConnectorLifecycle!(lifecycle, server.name);
      const resetInventory = captureConnectorInventoryReset(ctx, server);
      if (lifecycle.kind === "refresh") {
        const refreshed: unknown = await ctx.call("refreshConnectorTools", server.name);
        if (refreshed !== true)
          return errorReply(503, "Connector tools are unavailable.");
        resetInventory(lifecycle.kind);
      } else {
        const absent = async () => !(configuredServers(ctx) ?? await servers(ctx))
          .some((item) => item.name === server.name);
        let reconciled = false;
        try {
          await ctx.call("removeConnector", server.name);
        } catch (error) {
          if (ctx.readOnly || !engineChanging(error) || !(await absent())) throw error;
          reconciled = true;
        }
        if (!reconciled && !(await absent()))
          return errorReply(503, "The connector was not removed.");
        resetInventory(lifecycle.kind);
        delete consents()[lifecycle.serverId];
        saveConsents();
      }
      return empty(res);
    }
    const one = /\/mcp\/remote_servers\/([^/]+)$/.exec(p);
    if (one) {
      if (managedServerRoute) {
        const entry = await knowledgeConnector(ctx);
        current();
        return entry ? reply(res, knowledgeServerRow(entry)) : notFound();
      }
      if (method === "DELETE")
        return errorReply(404, "Connector not found.");
      const server = await connectorNamed(ctx, one[1]);
      if (!server) return notFound();
      if (method === "GET") return reply(res, serverRow(server, ctx));
      if (method === "PUT" || method === "PATCH") {
        const body = await bodyJson();
        fields(body, ["name", "url"]);
        if (!Object.keys(body).length)
          invalid("No connector changes were supplied.");
        if (body.name !== undefined) textField(body.name, "name", 256);
        if (body.url !== undefined) textField(body.url, "URL");
        if (typeof body.url === "string" || typeof body.name === "string")
          await ctx.call("addCustomConnector", {
            replaceName: server.name,
            name: server.name,
            displayName:
              typeof body.name === "string" ? body.name : server.displayName,
            url: typeof body.url === "string" ? body.url : server.url,
          });
        const after = (await servers(ctx)).find((s) => s.name === server.name);
        if (!after)
          throw new ConnectorRouteError(
            409,
            "The connector changed. Refresh its settings.",
          );
        return reply(res, serverRow(after, ctx));
      }
    }

    const logout = /\/mcp\/logout\/([^/?]+)$/.exec(p);
    if (logout) {
      if (method !== "POST")
        return errorReply(405, "Unsupported connector operation.");
      const query = new URL(req.url ?? p, "http://localhost").search;
      if (query && query !== "?via=wallet")
        invalid("Unsupported connector query.");
      if ((await readBoundedBytes(req, 1)).byteLength)
        invalid("Connector sign-out does not accept a body.");
      current();
      const server = (configuredServers(ctx) ?? await servers(ctx))
        .find((item) => connectorUuid(item.name) === logout[1]);
      if (!server?.url) return notFound();
      const revoked = await (ctx.localCall ?? ctx.call)("revokeConnector", server.name, server.url);
      if (revoked !== true)
        return errorReply(501, "This connector's authorization cannot be disconnected here.");
      return empty(res);
    }
    // Connect: the page opens start-auth in a popup; Claudex signs in through the browser itself.
    const start = /\/mcp\/start-auth\/([^/?]+)$/.exec(p);
    if (start) {
      if (method !== "GET")
        return errorReply(405, "Unsupported connector operation.");
      const server = await connectorNamed(ctx, start[1]);
      if (!server) return notFound();
      const query = new URL(req.url ?? p, "http://localhost").searchParams;
      const afterRejection = query.get("after_auth_rejection") === "true";
      const conversationId = query.get("conversation_uuid");
      const toolUseId = query.get("tool_use_id");
      if (afterRejection) {
        if (conversationId !== null || toolUseId !== null) {
          if (!server.url || !conversationId || !toolUseId || !matchesConnectorAuthRejection(
            await ctx.loadConversation(resolveConversationId(conversationId)),
            server.name,
            server.url,
            toolUseId,
          )) return errorReply(404, "Connector tool call not found.");
        } else if (server.authStatus !== "notLoggedIn") {
          return errorReply(409, "The connector no longer requires authentication.");
        }
      }
      if (query.get("response_format") === "json") {
        if (!afterRejection && connected(server)) return reply(res, { connected: true });
        if (server.state === "disabled" || !server.url)
          return errorReply(503, "Connector authentication is unavailable.");
        const address = connectorSignInUrl(
          await ctx.call("connectConnector", server.name, undefined, true),
        );
        const state = new URL(address).searchParams.get("state");
        if (!state)
          return errorReply(503, "Connector authentication is unavailable.");
        return reply(res, { auth_url: address, state });
      }
      await ctx.call("connectConnector", server.name);
      current();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><title>Claudex</title><p>Continue in your browser.</p><script>setTimeout(() => window.close(), 500)</script>",
      );
      return true;
    }
    // Add custom connector › Continue (shared-m-2 probe): an event stream of steps
    // ending in a "result" (shared-p-m-0 PA); Claudex's probe says whether it signs in.
    if (p.endsWith("/mcp/probe") && method === "POST") {
      const body = await bodyJson();
      fields(body, ["url", "exclude_server_uuid"]);
      const url = connectorAddress(body.url);
      if (
        body.exclude_server_uuid !== undefined &&
        (typeof body.exclude_server_uuid !== "string" ||
          !/^[0-9a-f-]{36}$/.test(body.exclude_server_uuid))
      )
        invalid("Invalid excluded connector.");
      if (ctx.readOnly) ctx.authorizeCustomConnector?.("probe");
      const exists = (await servers(ctx)).some(
        (s) =>
          s.url &&
          URL.parse(s.url)?.href === url &&
          connectorUuid(s.name) !== body.exclude_server_uuid,
      );
      let status: "detected" | "already_exists" | "no_server" | "unknown" =
        "already_exists";
      let step: Record<string, unknown> | undefined;
      let answer: z.infer<typeof probeAnswer> | undefined;
      if (!exists) {
        try {
          if (ctx.readOnly) ctx.authorizeCustomConnector?.("probe");
          const parsed = probeAnswer.safeParse(
            await ctx.call("probeConnector", url),
          );
          if (!parsed.success)
            throw new ConnectorRouteError(
              503,
              "Connector probe returned an invalid result.",
            );
          answer = parsed.data;
          status = "detected";
        } catch (error) {
          if (!(error instanceof ConnectorProbeError)) throw error;
          status = error.failure === "not_found" ? "no_server" : "unknown";
          step = {
            step: "initialize",
            outcome: error.failure === "not_found" ? "not_found" : "failed",
            http_status: error.httpStatus ?? null,
            error: error.failure === "not_found" ? null : error.failure,
          };
        }
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      const result = {
        step: "result",
        status,
        reason: null,
        transport: answer?.transport ?? null,
        posture: answer
          ? answer.authRequired
            ? "auth_required"
            : "no_auth"
          : null,
        suggested_registration: answer?.suggestedRegistration ?? null,
        discovery_timed_out: false,
      };
      if (step) res.write(`event: message\ndata: ${JSON.stringify(step)}\n\n`);
      res.end(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
      return true;
    }
    return errorReply(405, "Unsupported connector operation.");
  } catch (error) {
    if (error instanceof ConnectorAddressError && error.reason === "denied")
      return errorReply(403, "This connector address is unavailable.");
    return errorReply(
      error instanceof ConnectorRouteError || error instanceof RequestBodyError
        ? error.status
        : 503,
      error instanceof ConnectorRouteError || error instanceof RequestBodyError
        ? error.message
        : "The connector operation failed. Check connector settings and retry.",
    );
  }
  return false;
}
