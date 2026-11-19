import {
  mcpConnectionIdentity,
  mcpPolicyIdentity,
} from "../../../shared/mcp-connection-identity";
/** Official local session connector synchronization (shared cf6507c5a).
 * Only the account's configured connectors can be selected; no URL or tool
 * definition from the renderer is ever installed into the engine.
 */
import type { Conversation } from "../../../shared/types";
import { sessionConnectorPreferenceSnapshot } from "../../../shared/session-connector-preference";
import { HIWONDER_KNOWLEDGE_SERVER, hiwonderKnowledgeEnabled } from "../../../shared/knowledge-api";
import type {
  McpServers,
  McpServerState,
} from "../../../shared/settings-desktop-api";
import { officialLocalServerName } from "../../connectors/extension-identity";
import { mcpServerStates } from "../../connectors/mcp-config-file";
import { connectorUuid, permissionKeys } from "../api/connectors";
import type { AdapterContext } from "../api/context";
import {
  connectorInventory,
  readConnectorInventory,
} from "../api/connector-inventory";
import { knowledgeConnector, knowledgeConnectorTools } from "../api/knowledge-connector";

type ToolOverrides = NonNullable<Conversation["connectorToolOverrides"]>;
type Call = (name: string, ...args: unknown[]) => Promise<unknown>;
const remoteConnector = (server: McpServerState) =>
  !!server.url && !server.command;

/** Validate the homepage's connector snapshot before sending the first turn.
 * Reuse the same host-owned catalog checks as an existing session; no config
 * from the renderer is installed and no half-created session is needed.
 */
export async function initialSessionConnectors(
  ctx: AdapterContext,
  call: Call,
  input: { remoteMcpServers?: unknown; enabledMcpTools?: unknown },
) {
  const { remoteMcpServers, enabledMcpTools } = input;
  if (remoteMcpServers === undefined && enabledMcpTools === undefined)
    return {};
  if (remoteMcpServers !== undefined && !Array.isArray(remoteMcpServers))
    throw Error("Invalid session connector list.");
  if (
    enabledMcpTools !== undefined &&
    (!enabledMcpTools ||
      typeof enabledMcpTools !== "object" ||
      Array.isArray(enabledMcpTools))
  )
    throw Error("Invalid session tool settings.");
  const configured = Object.values(ctx.settings().mcpServers ?? {}).some(
    (raw) =>
      raw &&
      typeof raw === "object" &&
      (("url" in raw && typeof raw.url === "string") ||
        (ctx.localMcpConfig && "command" in raw && typeof raw.command === "string")),
  );
  if (
    !configured &&
    !(remoteMcpServers as unknown[] | undefined)?.length &&
    Object.values(enabledMcpTools ?? {}).every((value) => value === false || value === null)
  )
    return {};
  let draft = {
    id: "initial-session",
    turns: [],
    connectorOverrides: {},
    connectorToolOverrides: {},
  } as unknown as Conversation;
  const initial = sessionConnectors(
    async () => draft,
    async (name, ...args) => {
      if (name === "updateConversation") {
        const update = args[1] as {
          connectorToolOverrides: {
            version: number;
            expected: string;
            policy?: string;
            identity: {
              id: string;
              createdAt: number | null;
              mode: Conversation["mode"] | null;
            };
            value: Partial<Conversation>;
          };
        };
        const guard = update.connectorToolOverrides;
        if (
          guard.version !== 1 ||
          guard.expected !== sessionConnectorPreferenceSnapshot(draft) ||
          guard.identity.id !== draft.id ||
          guard.identity.createdAt !== (draft.createdAt ?? null) ||
          guard.identity.mode !== (draft.mode ?? null)
        )
          throw Error(
            "The session's connector choices changed. Refresh and try again.",
          );
        if (
          guard.policy !== undefined &&
          guard.policy !== mcpPolicyIdentity(ctx.settings().mcpServers)
        )
          return draft;
        draft = { ...draft, ...guard.value };
        return draft;
      }
      return call(name, ...args);
    },
    ctx,
    true,
  );
  if (remoteMcpServers !== undefined)
    await initial.replaceRemoteMcpServers(draft.id, remoteMcpServers);
  if (enabledMcpTools !== undefined)
    await initial.replaceEnabledMcpTools(draft.id, { tools: enabledMcpTools });
  return {
    connectorOverrides: draft.connectorOverrides,
    connectorToolOverrides: draft.connectorToolOverrides,
  };
}

export function sessionConnectors(
  get: (id: string) => Promise<Conversation | undefined>,
  call: Call,
  ctx?: AdapterContext,
  opening = false,
) {
  const mutations = new Map<string, Promise<unknown>>();
  const sessionConnector = (server: McpServerState) =>
    server.name !== HIWONDER_KNOWLEDGE_SERVER &&
    (remoteConnector(server) ||
      (!!ctx?.localMcpConfig && !!server.command && !server.url));
  const configuredServers = (configured: Record<string, unknown>) =>
    mcpServerStates(configured, false, new Map(), []).filter(sessionConnector);
  const captureContext = () => {
    const identity = ctx?.sessionIdentity?.();
    const configuration = mcpConnectionIdentity(ctx?.settings?.()?.mcpServers);
    return () => {
      if (
        ctx?.sessionIdentity?.() !== identity ||
        mcpConnectionIdentity(ctx?.settings?.()?.mcpServers) !== configuration
      )
        throw Error(
          "The connector configuration or account changed. Refresh and try again.",
        );
    };
  };
  const serial = <T>(
    id: string,
    change: (assertCurrent: () => void) => Promise<T>,
  ) => {
    const assertCurrent = captureContext();
    const result = (mutations.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        assertCurrent();
        return change(assertCurrent);
      });
    mutations.set(id, result);
    void result
      .finally(() => {
        if (mutations.get(id) === result) mutations.delete(id);
      })
      .catch(() => {});
    return result;
  };
  const load = async (id: string, assertCurrent: () => void) => {
    let conversation = await get(id);
    assertCurrent();
    if (!conversation) throw Error("Session not found.");
    const original = {
      id: conversation.id,
      createdAt: conversation.createdAt ?? null,
      mode: conversation.mode ?? null,
    };
    let states: McpServers | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        assertCurrent();
        states = (await call("mcpServers")) as McpServers;
        assertCurrent();
        break;
      } catch (error) {
        if (
          attempt >= 3 ||
          !/engine is not connected|not running|starting|operation belongs to a retired account or connector/i.test(
            String(error),
          )
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
        // The guarded read rechecks account activation before retrying.
        assertCurrent();
        if (!(await get(id))) throw Error("Session not found.");
        assertCurrent();
      }
    }
    if (!Array.isArray(states?.servers) || states.configError)
      throw Error("Connector state is not available.");
    const discoveries = () => {
      const configured = new Map(
        configuredServers(ctx?.settings().mcpServers ?? {}).map((server) => [
          server.name,
          server,
        ]),
      );
      return states.servers.flatMap((server) => {
        if (!sessionConnector(server)) return [];
        if (!ctx) return [server];
        const config = configured.get(server.name);
        // Discovery may still report a retired connection after its configuration
        // was removed or replaced. Never attribute those tools to the new server.
        if (
          !config ||
          config.url !== server.url ||
          config.command !== server.command
        )
          return [];
        return [
          {
            ...server,
            state:
              config.state === "disabled"
                ? ("disabled" as const)
                : server.state === "disabled"
                  ? ("ready" as const)
                  : server.state,
          },
        ];
      });
    };
    const knowledge = ctx ? await knowledgeConnector(ctx) : undefined;
    assertCurrent();
    if (ctx) connectorInventory(ctx, discoveries());
    const project = () =>
      ctx ? [
        ...readConnectorInventory(ctx, discoveries()),
        ...(knowledge?.base.available ? [knowledge.server] : []),
      ] : discoveries();
    // Catalog discovery can await engine startup. Use the latest conversation,
    // including its current turn status and preferences, after that await.
    conversation = await get(id);
    assertCurrent();
    if (!conversation) throw Error("Session not found.");
    if (
      conversation.id !== original.id ||
      (conversation.createdAt ?? null) !== original.createdAt ||
      (conversation.mode ?? null) !== original.mode
    )
      throw Error("The session changed. Refresh and try again.");
    return {
      conversation,
      servers: project(),
      project,
    };
  };
  const settings = (conversation: Conversation, servers: McpServerState[]) =>
    Object.fromEntries(
      servers.flatMap((server) =>
        (server.toolList ?? []).flatMap((tool) => {
          const keys = permissionKeys(server, tool, ctx);
          return [
            [
              keys.enabled,
              (server.name === HIWONDER_KNOWLEDGE_SERVER
                ? hiwonderKnowledgeEnabled(conversation)
                : server.state !== "disabled" && tool.enabled &&
                  conversation.connectorOverrides?.[server.name] !== false) &&
                conversation.connectorToolOverrides?.[server.name]?.[
                  tool.name
                ] !== false,
            ],
            [keys.approved, tool.approval === "approve"],
          ];
        }),
      ),
    );
  const cachedEnabledMcpTools = (conversation: Conversation) => {
    const configured = ctx?.settings?.()?.mcpServers;
    if (!ctx) return {};

    const servers = readConnectorInventory(ctx, configuredServers(configured ?? {}));
    const result = settings(
      conversation,
      servers.map((server) => ({
        ...server,
        // Approval keys describe a specific schema. A configured name alone
        // cannot stand in for a tool definition from the host catalog.
        toolList: server.toolList?.filter((tool) => tool.definition),
      })),
    );
    if (ctx.knowledgeOffer) Object.assign(result, settings(conversation, [{
      name: HIWONDER_KNOWLEDGE_SERVER,
      state: "ready",
      tools: knowledgeConnectorTools.length,
      toolList: knowledgeConnectorTools.map(tool => ({
        ...tool,
        approval: ctx.connectorAlwaysAllow?.() === false ? "prompt" : "approve",
      })),
    }]));
    for (const server of servers) {
      const prefix = remoteConnector(server)
        ? `${connectorUuid(server.name)}:`
        : `local:${officialLocalServerName(server.name, configured?.[server.name])}:`;
      const disabled =
        server.state === "disabled" ||
        conversation.connectorOverrides?.[server.name] === false;
      for (const tool of server.toolList ?? []) {
        if (disabled || !tool.enabled) result[prefix + tool.name] = false;
      }
      for (const [tool, enabled] of Object.entries(
        conversation.connectorToolOverrides?.[server.name] ?? {},
      )) {
        if (disabled || enabled === false) result[prefix + tool] = false;
      }
    }
    return result;
  };
  const apply = async (
    conversation: Conversation,
    servers: McpServerState[],
    connectorOverrides: Record<string, boolean>,
    connectorToolOverrides: ToolOverrides,
    assertCurrent: () => void,
    project: () => McpServerState[],
    intent: { kind: "explicit" } | { kind: "snapshot"; policy: string },
  ) => {
    assertCurrent();
    // Normalize sparse true/default choices when comparing so the official
    // page's background synchronization does not write or restart a turn.
    const knowledgeChanged =
      conversation.connectorOverrides?.[HIWONDER_KNOWLEDGE_SERVER] !==
      connectorOverrides[HIWONDER_KNOWLEDGE_SERVER];
    const changed = knowledgeChanged || (
      intent.kind === "explicit"
        ? sessionConnectorPreferenceSnapshot(conversation) !==
          sessionConnectorPreferenceSnapshot({
            connectorOverrides,
            connectorToolOverrides,
          })
        : servers.some(
            (server) =>
              (conversation.connectorOverrides?.[server.name] !== false) !==
                (connectorOverrides[server.name] !== false) ||
              (server.toolList ?? []).some(
                (tool) =>
                  (conversation.connectorToolOverrides?.[server.name]?.[
                    tool.name
                  ] !==
                    false) !==
                  (connectorToolOverrides[server.name]?.[tool.name] !== false),
              ),
          ));
    if (changed) {
      if (conversation.turns.some((turn) => turn.status === "inProgress"))
        throw Error("Cannot modify connectors while message is processing.");
      const updated = (await call("updateConversation", conversation.id, {
        connectorToolOverrides: {
          version: 1,
          expected: sessionConnectorPreferenceSnapshot(conversation),
          ...(intent.kind === "snapshot" ? { policy: intent.policy } : {}),
          identity: {
            id: conversation.id,
            createdAt: conversation.createdAt ?? null,
            mode: conversation.mode ?? null,
          },
          value: { connectorOverrides, connectorToolOverrides },
        },
      })) as Conversation;
      assertCurrent();
      if (
        updated?.id === conversation.id &&
        intent.kind === "snapshot" &&
        intent.policy !== mcpPolicyIdentity(ctx?.settings?.()?.mcpServers) &&
        sessionConnectorPreferenceSnapshot(updated) ===
          sessionConnectorPreferenceSnapshot(conversation)
      )
        return { enabledMcpTools: settings(updated, project()) };
      if (
        !updated ||
        updated.id !== conversation.id ||
        sessionConnectorPreferenceSnapshot(updated) !==
          sessionConnectorPreferenceSnapshot({
            ...conversation,
            connectorOverrides,
            connectorToolOverrides,
          })
      )
        throw Error("The session's connector choices were not saved.");
      return { enabledMcpTools: settings(updated, project()) };
    }
    return { enabledMcpTools: settings(conversation, project()) };
  };
  const methods = {
    async getEnabledMcpTools(id: string, assertCurrent: () => void) {
      const { conversation, project } = await load(id, assertCurrent);
      assertCurrent();
      return settings(conversation, project());
    },
    async setMcpServers(id: string, input: unknown, assertCurrent: () => void) {
      if (!Array.isArray(input))
        throw Error("Invalid session connector changes.");
      const { conversation, servers: catalog, project } = await load(
        id,
        assertCurrent,
      );
      const servers = catalog.filter(remoteConnector);
      const known = new Map(
        servers.map((server) => [connectorUuid(server.name), server]),
      );
      const connectors = { ...conversation.connectorOverrides };
      const tools: Record<string, Record<string, boolean>> = structuredClone(
        conversation.connectorToolOverrides ?? {},
      );
      const seen = new Set<string>();
      for (const row of input) {
        if (
          !row ||
          typeof row !== "object" ||
          typeof row.uuid !== "string" ||
          typeof row.enabled !== "boolean"
        )
          throw Error("Invalid session connector change.");
        const server = known.get(row.uuid);
        if (
          !server ||
          seen.has(row.uuid) ||
          (row.url !== undefined && row.url !== server.url) ||
          (row.type !== undefined && row.type !== "remote")
        )
          throw Error(
            "The session connector list changed. Refresh and try again.",
          );
        seen.add(row.uuid);
        const keys = new Map(
          (server.toolList ?? []).map((tool) => [
            permissionKeys(server, tool).enabled,
            tool.name,
          ]),
        );
        if (
          row.toolKeys !== undefined &&
          (!Array.isArray(row.toolKeys) ||
            row.toolKeys.some(
              (key: unknown) => typeof key !== "string" || !keys.has(key),
            ))
        )
          throw Error("A selected connector tool is no longer available.");
        if (
          row.tools !== undefined &&
          (!Array.isArray(row.tools) ||
            row.tools.some(
              (tool: any) =>
                !tool ||
                !(server.toolList ?? []).some(
                  (real) => real.name === tool.name,
                ),
            ))
        )
          throw Error("A selected connector tool is no longer available.");
        connectors[server.name] = row.enabled;
        if (row.toolKeys && server.name !== HIWONDER_KNOWLEDGE_SERVER) {
          const choices = { ...tools[server.name] };
          for (const key of row.toolKeys) choices[keys.get(key)!] = row.enabled;
          tools[server.name] = choices;
        }
      }
      return apply(
        conversation,
        servers,
        connectors,
        tools,
        assertCurrent,
        project,
        { kind: "explicit" },
      );
    },
    async replaceRemoteMcpServers(
      id: string,
      input: unknown,
      policy: string,
      base: Promise<Conversation | undefined>,
      assertCurrent: () => void,
    ) {
      if (!Array.isArray(input)) throw Error("Invalid session connector list.");
      const initial = await base;
      const { conversation, servers: catalog, project } = await load(
        id,
        assertCurrent,
      );
      const servers = catalog.filter(remoteConnector);
      if (
        initial &&
        (initial.id !== conversation.id ||
          initial.createdAt !== conversation.createdAt ||
          initial.mode !== conversation.mode)
      )
        throw Error("The session changed. Refresh and try again.");
      if (
        !initial ||
        sessionConnectorPreferenceSnapshot(initial) !==
          sessionConnectorPreferenceSnapshot(conversation) ||
        policy !== mcpPolicyIdentity(ctx?.settings?.()?.mcpServers)
      )
        return { enabledMcpTools: settings(conversation, project()) };
      const known = new Map(
        servers.map((server) => [connectorUuid(server.name), server]),
      );
      const selected = new Set<string>();
      for (const row of input) {
        if (!row || typeof row !== "object" || typeof row.uuid !== "string")
          throw Error("Invalid session connector.");
        const server = known.get(row.uuid);
        if (
          !server ||
          selected.has(server.name) ||
          (row.url !== undefined && row.url !== server.url)
        )
          throw Error(
            "The session connector list changed. Refresh and try again.",
          );
        if (
          row.tools !== undefined &&
          (!Array.isArray(row.tools) ||
            row.tools.some(
              (tool: unknown) =>
                !tool ||
                typeof tool !== "object" ||
                !(server.toolList ?? []).some(
                  (real) => real.name === (tool as { name?: unknown }).name,
                ),
            ))
        )
          throw Error("A selected connector tool is no longer available.");
        selected.add(server.name);
      }
      const overrides = { ...conversation.connectorOverrides };
      for (const server of servers)
        if (server.name !== HIWONDER_KNOWLEDGE_SERVER)
          overrides[server.name] =
            selected.has(server.name) && overrides[server.name] !== false;
      return apply(
        conversation,
        servers,
        overrides,
        conversation.connectorToolOverrides ?? {},
        assertCurrent,
        project,
        { kind: "snapshot", policy },
      );
    },
    async replaceEnabledMcpTools(
      id: string,
      input: unknown,
      policy: string,
      base: Promise<Conversation | undefined>,
      assertCurrent: () => void,
    ) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== "tools")
      )
        throw Error("Invalid session tool settings.");
      const tools = (input as { tools?: unknown }).tools;
      if (
        !tools ||
        typeof tools !== "object" ||
        Array.isArray(tools) ||
        Object.values(tools).some(
          (value) => value !== null && typeof value !== "boolean",
        )
      )
        throw Error("Invalid session tool choices.");
      const initial = await base;
      const { conversation, servers, project } = await load(id, assertCurrent);
      if (
        initial &&
        (initial.id !== conversation.id ||
          initial.createdAt !== conversation.createdAt ||
          initial.mode !== conversation.mode)
      )
        throw Error("The session changed. Refresh and try again.");
      if (
        !initial ||
        sessionConnectorPreferenceSnapshot(initial) !==
          sessionConnectorPreferenceSnapshot(conversation) ||
        policy !== mcpPolicyIdentity(ctx?.settings?.()?.mcpServers)
      )
        return { enabledMcpTools: settings(conversation, project()) };
      const baseline = settings(
        { ...conversation, connectorOverrides: {}, connectorToolOverrides: {} },
        servers,
      );
      const known = new Set(Object.keys(baseline));
      const approvalKeys = new Set(
        servers.flatMap((server) =>
          (server.toolList ?? []).map(
            (tool) => permissionKeys(server, tool, ctx).approved,
          ),
        ),
      );
      for (const [key, value] of Object.entries(tools)) {
        // Official snapshots may contain obsolete fingerprints. They cannot
        // add an unknown grant; removal of one is harmless.
        if (!known.has(key) && value !== null && value !== false)
          throw Error("A selected connector tool is no longer available.");
        if (
          known.has(key) &&
          approvalKeys.has(key) &&
          value !== null &&
          value !== baseline[key]
        )
          throw Error("Per-session approval changes are not supported yet.");
      }
      const overrides: Record<
        string,
        Record<string, boolean>
      > = structuredClone(conversation.connectorToolOverrides ?? {});
      const connectors = { ...conversation.connectorOverrides };
      const enabledTools = new Map(Object.entries(tools));
      for (const server of servers) {
        if (server.name === HIWONDER_KNOWLEDGE_SERVER) {
          if (opening && (server.toolList ?? []).some(tool =>
            enabledTools.get(permissionKeys(server, tool, ctx).enabled) === true,
          )) connectors[server.name] = true;
          continue;
        }
        const choices = { ...overrides[server.name] };
        for (const tool of server.toolList ?? []) {
          const key = permissionKeys(server, tool, ctx).enabled;
          // The page replays account defaults on every mount. Preserve an
          // explicit session choice; setMcpServers is the user's mutation.
          if (
            Object.hasOwn(tools, key) &&
            (tools as Record<string, unknown>)[key] !== null &&
            !Object.hasOwn(choices, tool.name) &&
            (tools as Record<string, unknown>)[key] !== baseline[key]
          )
            choices[tool.name] =
              (tools as Record<string, unknown>)[key] !== false;
        }
        if (Object.keys(choices).length) overrides[server.name] = choices;
      }
      const result = await apply(
        conversation,
        servers,
        connectors,
        overrides,
        assertCurrent,
        project,
        { kind: "snapshot", policy },
      );
      return result;
    },
  };
  return {
    cachedEnabledMcpTools,
    getEnabledMcpTools: (id: string) =>
      serial(id, (assertCurrent) =>
        methods.getEnabledMcpTools(id, assertCurrent),
      ),
    setMcpServers: (id: string, input: unknown) =>
      serial(id, (assertCurrent) =>
        methods.setMcpServers(id, input, assertCurrent),
      ),
    replaceRemoteMcpServers: (id: string, input: unknown) => {
      const policy = mcpPolicyIdentity(ctx?.settings?.()?.mcpServers);
      const base = get(id).then((conversation) =>
        structuredClone(conversation),
      );
      void base.catch(() => {});
      return serial(id, (assertCurrent) =>
        methods.replaceRemoteMcpServers(id, input, policy, base, assertCurrent),
      );
    },
    replaceEnabledMcpTools: (id: string, input: unknown) => {
      const policy = mcpPolicyIdentity(ctx?.settings?.()?.mcpServers);
      const base = get(id).then((conversation) =>
        structuredClone(conversation),
      );
      void base.catch(() => {});
      return serial(id, (assertCurrent) =>
        methods.replaceEnabledMcpTools(id, input, policy, base, assertCurrent),
      );
    },
  };
}
