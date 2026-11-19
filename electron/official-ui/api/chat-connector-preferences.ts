import type { Conversation } from "../../../shared/types";
import {
  HIWONDER_KNOWLEDGE_SERVER,
  HIWONDER_KNOWLEDGE_TOOLS,
  hiwonderKnowledgeEnabled,
} from "../../../shared/knowledge-api";
import { parseOfficialToolPreferences, type OfficialConnectorPreference } from "../../../shared/official-connector-preferences";
import { mcpConnectionIdentity } from "../../../shared/mcp-connection-identity";
import {
  sessionConnectorPreferenceSnapshot,
  type SessionConnectorPreference,
} from "../../../shared/session-connector-preference";
import { connectorUuid, permissionKeys, servers } from "./connectors";
import { organizationUuid, type AdapterContext } from "./context";
import { knowledgeConnector, knowledgeConnectorTools } from "./knowledge-connector";
import { ScopedMap } from "./scope";

const pending = new ScopedMap<string, Promise<unknown>>(
  "chat-connector-preferences",
);
const knowledgePrefix = `${connectorUuid(HIWONDER_KNOWLEDGE_SERVER)}:`;
const knowledgeEnabledKey = (tool: string) => knowledgePrefix + tool;

export function nativeChatKnowledgeChoices(tools: unknown) {
  const entries = Object.entries(parseOfficialToolPreferences(tools)).filter(([key]) => key.startsWith(knowledgePrefix));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function chatKnowledgeToolEnabled(conversation: Conversation | undefined, tool: string) {
  return !!conversation && hiwonderKnowledgeEnabled(conversation) &&
    conversation.connectorToolOverrides?.[HIWONDER_KNOWLEDGE_SERVER]?.[tool] !== false;
}

export function chatConnectorPreferences(
  ctx: AdapterContext,
  conversation: Conversation,
) {
  const hasKnowledge = hiwonderKnowledgeEnabled(conversation) ||
    conversation.connectorOverrides?.[HIWONDER_KNOWLEDGE_SERVER] === false;
  if (!conversation.connectorToolOverrides && !hasKnowledge) return undefined;
  const configured = ctx.settings().mcpServers ?? {};
  const entries = Object.entries(
    conversation.connectorToolOverrides ?? {},
  ).flatMap(([name, tools]) => {
    if (name === HIWONDER_KNOWLEDGE_SERVER || !Object.hasOwn(configured, name)) return [];
    return Object.entries(tools).map(
      ([tool, enabled]) => [connectorUuid(name) + ":" + tool, enabled] as const,
    );
  });
  const result = Object.fromEntries(entries);
  if (hasKnowledge)
    for (const tool of HIWONDER_KNOWLEDGE_TOOLS)
      result[knowledgeEnabledKey(tool)] = chatKnowledgeToolEnabled(conversation, tool);
  return result;
}

class ChatConnectorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type ConnectorChange = { kind: "save" } | { kind: "send"; newChat: boolean };

export function saveChatConnectorPreferences(
  ctx: AdapterContext,
  request: Extract<OfficialConnectorPreference, { kind: "chat" }>,
  resolve: (id: string) => string,
) {
  return withChatConnectorPreferences(ctx, request, resolve, { kind: "save" }, (row) => {
    if (!row) throw new ChatConnectorError(404, "Conversation not found.");
    return row;
  });
}

export async function withChatConnectorPreferences<T>(
  ctx: AdapterContext,
  request: Extract<OfficialConnectorPreference, { kind: "chat" }>,
  resolve: (id: string) => string,
  change: ConnectorChange,
  finish: (row?: Conversation, initial?: SessionConnectorPreference) => T | Promise<T>,
) {
  const owner = ctx.account()?.id;
  const activation = ctx.sessionIdentity?.();
  const root = ctx.stateDirectory?.();
  const id = resolve(request.pageId);
  if (!owner || request.organizationId !== organizationUuid(owner))
    throw new ChatConnectorError(404, "Conversation not found.");
  const current = () => {
    if (
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== activation ||
      ctx.stateDirectory?.() !== root ||
      ctx.isCurrent?.() === false ||
      resolve(request.pageId) !== id
    )
      throw new ChatConnectorError(409, "The account or conversation changed.");
    if (ctx.readOnly || ctx.strictActionSemantics) {
      if (!ctx.authorizeConnectorPreferences)
        throw new ChatConnectorError(
          403,
          "Connector preferences are unavailable.",
        );
      ctx.authorizeConnectorPreferences("chat", request.pageId);
    }
  };
  const owned = (row: Conversation | undefined): row is Conversation =>
    row?.id === id &&
    row.mode === "chat" &&
    row.environment?.kind !== "ssh" &&
    (!row.sessionAuthors ||
      row.sessionAuthors.ownerAccountUuid === owner &&
      row.sessionAuthors.viewerAccountUuid === owner);
  const newChat = change.kind === "send" && change.newChat;

  current();
  const choices = Object.entries(request.tools);
  const operation = (pending.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      current();
      const before = await ctx.loadConversation(id);
      current();
      if (newChat ? before !== undefined : !owned(before))
        throw new ChatConnectorError(404, "Conversation not found.");
      const expected = sessionConnectorPreferenceSnapshot(before ?? {});
      const selectedKnowledge = hiwonderKnowledgeEnabled(before ?? {});
      const connection = mcpConnectionIdentity(ctx.settings().mcpServers);
      const [catalog, knowledge] = await Promise.all([
        choices.some(([key]) => !key.startsWith(knowledgePrefix)) ? servers(ctx) : [],
        HIWONDER_KNOWLEDGE_TOOLS.some((tool) => request.tools[knowledgeEnabledKey(tool)] === true && !chatKnowledgeToolEnabled(before, tool))
          ? knowledgeConnector(ctx)
          : undefined,
      ]);
      current();
      const row = await ctx.loadConversation(id);
      current();
      if (
        (newChat ? row !== undefined : !owned(row)) ||
        row?.createdAt !== before?.createdAt ||
        hiwonderKnowledgeEnabled(row ?? {}) !== selectedKnowledge ||
        sessionConnectorPreferenceSnapshot(row ?? {}) !== expected ||
        mcpConnectionIdentity(ctx.settings().mcpServers) !== connection
      )
        throw new ChatConnectorError(
          409,
          "The connector choices changed. Reopen the conversation.",
        );

      const enabled = new Map<string, { server: string; tool: string; accountEnabled: boolean }>();
      const approvals = new Map<string, boolean>();
      if (choices.some(([key]) => key.startsWith(knowledgePrefix))) {
        const approved = ctx.connectorAlwaysAllow?.() !== false;
        for (const tool of knowledgeConnectorTools) {
          const keys = permissionKeys({ name: HIWONDER_KNOWLEDGE_SERVER, state: "stopped", tools: knowledgeConnectorTools.length }, tool);
          enabled.set(keys.enabled, { server: HIWONDER_KNOWLEDGE_SERVER, tool: tool.name, accountEnabled: false });
          approvals.set(keys.approved, approved);
        }
      }
      for (const server of catalog) {
        if (server.name === HIWONDER_KNOWLEDGE_SERVER) continue;
        for (const tool of server.toolList ?? []) {
          const keys = permissionKeys(server, tool);
          if (enabled.has(keys.enabled) || approvals.has(keys.approved))
            throw new ChatConnectorError(
              409,
              "The connector catalog contains ambiguous tools.",
            );
          enabled.set(keys.enabled, { server: server.name, tool: tool.name, accountEnabled: tool.enabled });
          approvals.set(keys.approved, tool.approval === "approve");
        }
      }
      const value: SessionConnectorPreference = {
        connectorOverrides: structuredClone(row?.connectorOverrides ?? {}),
        connectorToolOverrides: Object.assign(
          Object.create(null) as Record<string, Record<string, boolean>>,
          row?.connectorToolOverrides,
        ),
      };
      const saved = row ? chatConnectorPreferences(ctx, row) ?? {} : {};
      const nextKnowledge = new Map<string, boolean>();
      for (const [key, choice] of choices) {
        const target = enabled.get(key);
        if (!target) {
          if (
            (approvals.has(key) &&
              (choice === null || approvals.get(key) === choice)) ||
            (Object.hasOwn(saved, key) && saved[key] === choice)
          )
            continue;
          const staleApproval = /^(.*)-[0-9a-f]{32}$/.exec(key);
          if (
            choice === null &&
            staleApproval &&
            enabled.has(staleApproval[1]!)
          )
            continue;
          throw new ChatConnectorError(
            400,
            "A connector tool changed. Refresh its tools and try again.",
          );
        }
        if (target.server === HIWONDER_KNOWLEDGE_SERVER) {
          const wasEnabled = chatKnowledgeToolEnabled(row, target.tool);
          const nextEnabled = choice === true;
          if (nextEnabled && !wasEnabled && !knowledge?.base.available)
            throw new ChatConnectorError(409, "The knowledge base is unavailable. Try again when it reconnects.");
          if (change.kind === "send" && choice !== null && nextEnabled === wasEnabled) continue;
          nextKnowledge.set(target.tool, nextEnabled);
        } else if (change.kind === "send" && !Object.hasOwn(saved, key) && choice === target.accountEnabled) {
          continue;
        }
        const choices = Object.assign(
          Object.create(null) as Record<string, boolean>,
          value.connectorToolOverrides[target.server],
        );
        if (choice === null) delete choices[target.tool];
        else choices[target.tool] = choice;
        if (Object.keys(choices).length)
          value.connectorToolOverrides[target.server] = choices;
        else delete value.connectorToolOverrides[target.server];
      }
      if (nextKnowledge.size) {
        const selected = (tool: string) => nextKnowledge.get(tool) ?? chatKnowledgeToolEnabled(row, tool);
        const knowledgeEnabled = HIWONDER_KNOWLEDGE_TOOLS.some(selected);
        value.connectorOverrides[HIWONDER_KNOWLEDGE_SERVER] = knowledgeEnabled;
        if (knowledgeEnabled) {
          const overrides = { ...value.connectorToolOverrides[HIWONDER_KNOWLEDGE_SERVER] };
          for (const tool of HIWONDER_KNOWLEDGE_TOOLS) {
            if (!selected(tool)) overrides[tool] = false;
          }
          value.connectorToolOverrides[HIWONDER_KNOWLEDGE_SERVER] = overrides;
        }
      }
      if (newChat) return finish(undefined, value);
      if (!row) throw new ChatConnectorError(404, "Conversation not found.");
      const wanted = sessionConnectorPreferenceSnapshot(value);
      if (wanted === expected) return finish(row);
      const updated = (await ctx.call("updateConversation", id, {
        connectorToolOverrides: {
          version: 1,
          expected,
          connection,
          identity: { id, createdAt: row.createdAt ?? null, mode: row.mode },
          value,
        },
      })) as Conversation | undefined;
      current();
      if (
        !owned(updated) ||
        updated.createdAt !== row.createdAt ||
        sessionConnectorPreferenceSnapshot(updated) !== wanted
      )
        throw new ChatConnectorError(
          409,
          "The connector save could not be confirmed. Reopen the conversation.",
        );
      return finish(updated);
    });
  pending.set(id, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(id) === operation) pending.delete(id);
  }
}

export function chatConnectorErrorResponse(error: unknown) {
  return error instanceof ChatConnectorError
    ? { status: error.status, message: error.message }
    : {
        status: 503,
        message:
          "The connector save could not be confirmed. Reopen the conversation before retrying.",
      };
}
