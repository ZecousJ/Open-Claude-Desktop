import { z } from "zod";
import { loadKnowledgeCatalog } from "../../electron/ipc/knowledge";
import { saveSessionConnectorPreference } from "../../electron/ipc/session-connector-preference";
import {
  cloudCodeSessionKey,
  isOwnedCloudCoworkSession,
} from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { HIWONDER_KNOWLEDGE_SERVER, hiwonderKnowledgeEnabled } from "../../shared/knowledge-api";
import { sessionConnectorPreferenceSnapshot } from "../../shared/session-connector-preference";
import {
  officialUiRequestMaxBytes,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import type { WebAppContext } from "./web-app-context";

const bodySchema = z
  .object({
    local_mcps: z.array(z.unknown()).optional(),
    builtin_servers: z.record(z.string(), z.boolean()).optional(),
    computer_tools: z.unknown().optional(),
    browser_tools: z.unknown().optional(),
  })
  .strict();

const json = (status: number, value: unknown): OfficialUiReadResponse => ({
  status,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify(value)),
});

export async function reconcileOfficialCoworkMcp(
  ctx: WebAppContext,
  route: { organizationId: string; key: string },
  request: Record<string, unknown>,
  current: () => boolean,
): Promise<OfficialUiReadResponse> {
  const account = ctx.activeAccount;
  if (!account || !current())
    return json(409, { error: "The account activation changed." });
  if (route.organizationId.toLowerCase() !== organizationUuid(account.id))
    return json(404, { error: "Organization not found." });
  const store = ctx.store;
  const session = store.conversations.find(
    (c) =>
      !c.archived &&
      isOwnedCloudCoworkSession(c, account.id) &&
      cloudCodeSessionKey(c, account.id) === route.key,
  );
  if (!session) return json(404, { error: "Cowork session not found." });
  if (
    !(request.body instanceof Uint8Array) ||
    request.body.byteLength > officialUiRequestMaxBytes ||
    typeof request.contentType !== "string" ||
    !/^application\/json(?:\s*;.*)?$/i.test(request.contentType)
  )
    return json(400, { error: "Invalid Cowork connector reconciliation." });
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(request.body),
      ),
    );
  } catch {
    return json(400, { error: "Invalid Cowork connector reconciliation." });
  }
  if (
    (body.local_mcps?.length ?? 0) > 0 ||
    Object.keys(body.builtin_servers ?? {}).some(name => name !== HIWONDER_KNOWLEDGE_SERVER) ||
    body.computer_tools !== undefined ||
    body.browser_tools !== undefined
  )
    return json(501, {
      error:
        "Cowork device and built-in connector reconciliation is unavailable on this host.",
    });
  const owned = () => current() && ctx.store === store &&
    store.conversations.includes(session) && !session.archived &&
    isOwnedCloudCoworkSession(session, account.id);
  const stable = () => {
    try {
      return owned() && store.conversation(session.id) === session;
    } catch {
      return false;
    }
  };
  if (!stable())
    return json(409, { error: "The Cowork session changed." });
  let saved = session;
  const enabled = body.builtin_servers?.[HIWONDER_KNOWLEDGE_SERVER];
  if (enabled !== undefined && enabled !== hiwonderKnowledgeEnabled(session)) {
    if (session.chatDeviceBinding)
      return json(409, { error: "Knowledge is unavailable for sessions bound to a computer." });
    try {
      saved = await saveSessionConnectorPreference(ctx, session.id, {
        connectorToolOverrides: {
          version: 1,
          expected: sessionConnectorPreferenceSnapshot(session),
          identity: { id: session.id, createdAt: session.createdAt, mode: "cowork" },
          value: {
            connectorOverrides: { ...session.connectorOverrides, [HIWONDER_KNOWLEDGE_SERVER]: enabled },
            connectorToolOverrides: session.connectorToolOverrides ?? {},
          },
        },
      }, { current: owned, configuration: () => ctx.store.settings.mcpServers, knowledgeCatalog: () => loadKnowledgeCatalog(ctx) });
    } catch {
      return json(409, { error: "The Cowork connector choice could not be saved." });
    }
  }
  return json(200, { server_names: hiwonderKnowledgeEnabled(saved) ? [HIWONDER_KNOWLEDGE_SERVER] : [] });
}
