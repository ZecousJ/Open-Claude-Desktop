import { z } from "zod";
import { saveSessionConnectorPreference } from "../../electron/ipc/session-connector-preference";
import { loadKnowledgeOffer, loadKnowledgeCatalog } from "../../electron/ipc/knowledge";
import {
  cloudCodeConnectorInventory,
  cloudCodeMcpConfig,
} from "../../electron/official-ui/api/cloud-code-connectors";
import {
  cloudCodeSessionKey,
  isOwnedCloudCodeSession,
} from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { connectorUuid } from "../../electron/official-ui/api/connectors";
import { knowledgeConnector } from "../../electron/official-ui/api/knowledge-connector";
import { HIWONDER_KNOWLEDGE_SERVER, hiwonderKnowledgeAllowed, hiwonderKnowledgeEnabled } from "../../shared/knowledge-api";
import {
  officialUiRequestMaxBytes,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { sessionConnectorPreferenceSnapshot } from "../../shared/session-connector-preference";
import type { WebAppContext } from "./web-app-context";

export const cloudCodeConnectorSelection = z
  .object({
    mcp_servers: z.array(
      z
        .object({
          name: z.string().min(1),
          type: z.literal("http"),
          url: z.string().min(1),
          headers: z.object({ "X-MCP-Server-ID": z.string().uuid() }).strict(),
        })
        .strict(),
    ).max(256),
  })
  .strict();

export function cloudCodeConnectorOverrides(
  selectedRows: z.infer<typeof cloudCodeConnectorSelection>["mcp_servers"],
  inventory: ReturnType<typeof cloudCodeConnectorInventory>,
  previous: ConversationConnectorOverrides = {},
): ConversationConnectorOverrides | undefined {
  const byId = new Map(inventory.map((server) => [connectorUuid(server.key), server]));
  const selected = new Set<string>();
  for (const row of selectedRows) {
    const id = row.headers["X-MCP-Server-ID"];
    const server = byId.get(id);
    if (!server || selected.has(id) || row.url !== server.url ||
        (row.name !== id && row.name !== server.name)) return;
    selected.add(id);
  }
  const overrides = new Map(Object.entries(previous));
  for (const [id, server] of byId) {
    if (server.key === HIWONDER_KNOWLEDGE_SERVER) overrides.set(server.key, selected.has(id));
    else if (selected.has(id)) overrides.delete(server.key);
    else overrides.set(server.key, false);
  }
  return Object.fromEntries(overrides);
}

type ConversationConnectorOverrides = Record<string, boolean>;
export const codeKnowledgeConnectorUuid = connectorUuid(HIWONDER_KNOWLEDGE_SERVER);

export function officialSessionKnowledgeConnector(ctx: WebAppContext) {
  return knowledgeConnector({ knowledgeOffer: async () => {
    const offer = await loadKnowledgeOffer(ctx);
    return offer && hiwonderKnowledgeAllowed(ctx.policy(), offer.baseUrl) ? offer : undefined;
  } });
}

const json = (status: number, value: unknown): OfficialUiReadResponse => ({
  status,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify(value)),
});

export async function saveOfficialCodeConnectorSelection(
  ctx: WebAppContext,
  key: string,
  request: Record<string, unknown>,
  activationCurrent: () => boolean,
) {
  const account = ctx.activeAccount;
  if (!account || !activationCurrent())
    return json(409, { error: "The account activation changed." });
  if (
    typeof request.codeOrganizationId !== "string" ||
    request.codeOrganizationId.toLowerCase() !== organizationUuid(account.id)
  )
    return json(404, { error: "Organization not found." });
  if (
    request.body instanceof Uint8Array &&
    request.body.byteLength > officialUiRequestMaxBytes
  )
    return json(413, { error: "The Code connector selection is too large." });
  let selection: z.infer<typeof cloudCodeConnectorSelection>;
  try {
    if (
      !(request.body instanceof Uint8Array) ||
      typeof request.contentType !== "string" ||
      !/^application\/json(?:\s*;.*)?$/i.test(request.contentType)
    )
      throw Error();
    selection = cloudCodeConnectorSelection.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(request.body),
      ),
    );
  } catch {
    return json(400, { error: "Invalid Code connector selection." });
  }

  const store = ctx.store;
  const owns = (c: Parameters<typeof isOwnedCloudCodeSession>[0]) =>
    !c.archived && isOwnedCloudCodeSession(c, account.id);
  const conversation = store.conversations.find(
    (c) => owns(c) && cloudCodeSessionKey(c, account.id) === key,
  );
  if (!conversation) return json(404, { error: "Code session not found." });
  if (conversation.turns.some((turn) => turn.status === "inProgress"))
    return json(409, {
      error: "Cannot change connectors while the session is running.",
    });

  // The Code menu can change account tool permissions alongside this selection.
  const configuration = () =>
    cloudCodeConnectorInventory(store.settings.mcpServers);
  const knowledgeSelected = selection.mcp_servers.some(row => row.headers["X-MCP-Server-ID"] === codeKnowledgeConnectorUuid);
  const knowledge = knowledgeSelected || hiwonderKnowledgeEnabled(conversation)
    ? await officialSessionKnowledgeConnector(ctx)
    : undefined;
  const inventory = cloudCodeConnectorInventory(store.settings.mcpServers, knowledge);
  const overrides = cloudCodeConnectorOverrides(selection.mcp_servers, inventory, conversation.connectorOverrides);
  if (!overrides) return json(409, {
    error: "The connector list changed. Refresh and try again.",
  });
  const value = {
    connectorOverrides: overrides,
    connectorToolOverrides: conversation.connectorToolOverrides ?? {},
  };
  const expected = sessionConnectorPreferenceSnapshot(conversation);
  try {
    const current = () =>
      activationCurrent() && ctx.store === store && owns(conversation);
    if (!current() || store.conversation(conversation.id) !== conversation)
      return json(409, {
        error: "The Code session changed. Reopen it before continuing.",
      });
    const saved =
      expected === sessionConnectorPreferenceSnapshot(value)
        ? conversation
        : await saveSessionConnectorPreference(
            ctx,
            conversation.id,
            {
              connectorToolOverrides: {
                version: 1,
                expected,
                identity: {
                  id: conversation.id,
                  createdAt: conversation.createdAt,
                  mode: "code",
                },
                value,
              },
            },
            { current, configuration, knowledgeCatalog: () => loadKnowledgeCatalog(ctx) },
          );
    return json(200, { mcp_config: cloudCodeMcpConfig(saved, inventory) });
  } catch {
    return json(409, {
      error:
        "The connector save could not be confirmed. Reopen the Code session before retrying.",
    });
  }
}
