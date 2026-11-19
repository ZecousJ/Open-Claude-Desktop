import { z } from "zod";
import { createHash } from "node:crypto";
import { CloudEnvironments } from "../../electron/cloud/environments";
import { newConversation } from "../../electron/engine/new-conversation";
import { cloudCodeSession, isOwnedCloudCodeSession } from "../../electron/official-ui/api/cloud-code-history";
import { cloudCodeConnectorInventory } from "../../electron/official-ui/api/cloud-code-connectors";
import { readConnectorInventory } from "../../electron/official-ui/api/connector-inventory";
import { mcpServerStates } from "../../electron/connectors/mcp-config-file";
import { allowedMcpServers } from "../../shared/client-policy-rules";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { cloudEnvironmentId } from "../../shared/cloud-environments-input";
import { codeEffortLevels } from "../../shared/code-effort";
import { codeModelChoice } from "../../electron/ipc/code-model-preferences";
import { officialCodePermission } from "../../shared/official-code-history";
import { isConversationModel } from "../../shared/model-catalog-api";
import {
  officialUiRequestMaxBytes,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import {
  repositoryFullName,
  sessionRepositoryOf,
} from "../../shared/session-git";
import { mcpPolicyIdentity } from "../../shared/mcp-connection-identity";
import { HIWONDER_KNOWLEDGE_SERVER } from "../../shared/knowledge-api";
import {
  maxSessionRepositories,
  parseRepositories,
  validRepositoryRef,
} from "./code-workspace";
import { cloudCodeConnectorOverrides, cloudCodeConnectorSelection, codeKnowledgeConnectorUuid, officialSessionKnowledgeConnector } from "./official-code-connectors";
import { stageCodeWorkspace } from "./session-stage";
import type { WebAppContext } from "./web-app-context";
import { codeCloudSideSessionIdentity } from "../../shared/official-code-side-session";

const source = z.strictObject({
  type: z.literal("git_repository"),
  url: z.string(),
  revision: z
    .string()
    .regex(/^refs\/heads\/.+$/)
    .optional(),
});
const outcome = z.strictObject({
  type: z.literal("git_repository"),
  git_info: z.strictObject({
    type: z.literal("github"),
    repo: z.string(),
    branches: z.tuple([z.string().refine(validRepositoryRef)]),
  }),
});
const creation = z.strictObject({
  title: z.string().max(200).optional(),
  environment_id: cloudEnvironmentId,
  config: z.strictObject({
    sources: z.array(source).max(maxSessionRepositories),
    outcomes: z.array(outcome).max(maxSessionRepositories),
    model: z.string().min(1).max(200).optional(),
    effort_level: z.enum(codeEffortLevels).nullable().optional(),
    mcp_servers: cloudCodeConnectorSelection.shape.mcp_servers.optional(),
    permission_mode: officialCodePermission.optional(),
    append_system_prompt: z.string().optional(),
    reuse_outcome_branches: z.boolean().optional(),
  }),
  events: z.tuple([]),
  tags: z.array(z.string().max(100)).max(10).optional(),
  side_session: codeCloudSideSessionIdentity.optional(),
});

const sideSessionStarts = new WeakMap<WebAppContext["store"], Set<string>>();
const json = (status: number, value: object): OfficialUiReadResponse => ({
  status,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify(value)),
});
const fail = (status: number, message: string) =>
  json(status, { error: { message } });

export async function createOfficialCodeSession(
  ctx: WebAppContext,
  request: Record<string, unknown>,
  activationCurrent: () => boolean,
): Promise<OfficialUiReadResponse> {
  const owner = ctx.activeAccount?.id;
  if (!owner || !activationCurrent())
    return fail(409, "A current authenticated capability lease is required.");
  if (
    typeof request.codeOrganizationId !== "string" ||
    request.codeOrganizationId.toLowerCase() !== organizationUuid(owner)
  )
    return fail(404, "Organization not found.");

  const { body, contentType } = request;
  if (
    !(body instanceof Uint8Array) ||
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(contentType)
  )
    return fail(400, "Invalid Code session creation request.");
  if (body.byteLength > officialUiRequestMaxBytes)
    return fail(413, "The Code session creation request is too large.");

  let input: z.infer<typeof creation>;
  let repositories: ReturnType<typeof parseRepositories>;
  try {
    input = creation.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    );
    repositories = parseRepositories({
      repositories: input.config.sources.map(({ url, revision }) => ({
        url,
        ref: revision,
      })),
    });
    const sourcesByName = new Map(
      repositories.map((repository) => [
        repositoryFullName(repository.url)?.toLowerCase(),
        repository,
      ]),
    );
    const kind = input.config.reuse_outcome_branches ? "reuse" : "create";
    for (const { git_info } of input.config.outcomes) {
      const { repo, branches: [branch] } = git_info;
      const repository = sourcesByName.get(repo.toLowerCase());
      if (!repository || repository.outcome)
        return fail(400, "Code repository outcomes must match their sources.");
      repository.outcome = { kind, branch };
    }
  } catch {
    return fail(400, "Invalid Code session creation request.");
  }
  if (input.tags?.includes("cowork-warm-start"))
    return fail(501, "Cloud Code workspaces start with the first message.");

  const store = ctx.store;
  const current = () => activationCurrent() && ctx.store === store;
  const source = input.side_session;
  const requestId = source?.request_id.toLowerCase();
  const payloadHash = source && createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const activeStarts = sideSessionStarts.get(store) ?? new Set<string>();
  if (requestId) {
    if (activeStarts.has(requestId))
      return fail(409, "The Code side session is still starting.");
    sideSessionStarts.set(store, activeStarts);
    activeStarts.add(requestId);
  }
  try {
    const existing = requestId && store.conversations.find(row => row.id === requestId);
    if (existing) {
      if (!isOwnedCloudCodeSession(existing, owner) || existing.archived ||
          existing.cloudSideSessionSource?.payloadHash !== payloadHash)
        return fail(409, "This Code side session start conflicts with its saved request.");
      await store.confirmConversationMetadata(existing, current);
      return current()
        ? json(200, { session: cloudCodeSession(existing, owner) })
        : fail(409, "The account activation changed.");
    }
    const profile = new CloudEnvironments(store.root)
      .list()
      .find(({ id }) => id === input.environment_id);
    if (!profile) return fail(404, "Cloud environment not found.");
    const { config } = input;
    const { providers, activeProviderId } = store.settings;
    const selected = config.mcp_servers;
    const configured = store.settings.mcpServers;
    const knowledge = selected?.some(row => row.headers["X-MCP-Server-ID"] === codeKnowledgeConnectorUuid)
      ? await officialSessionKnowledgeConnector(ctx) : undefined;
    if (!current()) return fail(409, "The account activation changed.");
    const inventory = cloudCodeConnectorInventory(allowedMcpServers(configured, ctx.policy()), knowledge);
    const managedOnly = selected?.length === 1 && selected[0].headers["X-MCP-Server-ID"] === codeKnowledgeConnectorUuid;
    const inheritDefaults = selected === undefined || managedOnly;
    const knownTools = inheritDefaults && inventory.length
      ? readConnectorInventory(
          { settings: () => store.settings, account: () => ctx.activeAccount, sessionIdentity: () => ctx.officialSessionIdentity() },
          mcpServerStates(configured, false, new Map(), []),
        )
      : [];
    const defaults = Object.fromEntries(inventory.flatMap(({ key }) => {
      const tools = knownTools.find((server) => server.name === key)?.toolList?.filter((tool) => tool.definition);
      return tools?.length && tools.every((tool) => !tool.enabled) ? [[key, false]] : [];
    }));
    const connectorOverrides = selected === undefined ? defaults : cloudCodeConnectorOverrides(
      selected,
      managedOnly ? inventory.filter(server => server.key === HIWONDER_KNOWLEDGE_SERVER) : inventory,
      defaults,
    );
    if (selected !== undefined && !connectorOverrides)
      return fail(409, "The connector list changed. Refresh and try again.");
    const connectorPolicy = mcpPolicyIdentity(configured);
    const provider = providers.find(({ id }) => id === activeProviderId);
    if (!provider) return fail(503, "No model service is configured.");
    const model = config.model ?? provider.model;
    if (
      !isConversationModel(model) ||
      (provider.models.length > 0 &&
        model !== provider.model &&
        !provider.models.includes(model))
    )
      return fail(400, "The requested Code model is unavailable.");

    const catalogModel = ctx.remote?.modelCatalog()?.items.find(item => item.id === model);
    const effort = config.effort_level ?? (catalogModel
      ? codeModelChoice(catalogModel, store.settings.codeEffort, store.settings.codeEffort, { kind: "model" }).effort
      : undefined);

    const { cwd, environment, fetch } = await stageCodeWorkspace(
      ctx,
      profile,
      repositories,
    );
    if (!current()) {
      ctx.discardCodeSession(cwd);
      return fail(409, "The account activation changed.");
    }
    if (connectorPolicy !== mcpPolicyIdentity(store.settings.mcpServers)) {
      ctx.discardCodeSession(cwd);
      return fail(409, "The connector list changed. Refresh and try again.");
    }
    const [main] = repositories;
    const conversation = {
      ...newConversation(
        {
          mode: "code",
          ...(requestId ? { newConversationId: requestId } : {}),
          text: "",
          attachments: [],
          providerId: provider.id,
          model,
          codePermissionMode: config.permission_mode ?? "manual",
          sessionInstructions: config.append_system_prompt,
          connectorOverrides,
        },
        provider,
        cwd,
        store.settings,
      ),
      title: input.title || "New Code session",
      effort,
      ...(input.title ? { titleSetByUser: true } : {}),
      ...(input.tags?.includes("ui:pinned") ? { pinned: true } : {}),
      environment,
      cloudEnvironmentId: profile.id,
      sessionAuthors: { viewerAccountUuid: owner, ownerAccountUuid: owner },
      ...(source && requestId && payloadHash ? {
        cloudSideSessionSource: {
          requestId,
          parentId: source.parent_session_id,
          taskId: source.task_id,
          payloadHash,
        },
      } : {}),
      ...(main
        ? {
            repository: sessionRepositoryOf(main),
            sessionRepositories: repositories,
          }
        : {}),
      ...(fetch ? { pendingSetup: repositories } : {}),
      ...(profile.setupScript
        ? { pendingSetupScript: profile.setupScript }
        : {}),
    };
    store.conversations.unshift(conversation);
    await store.confirmConversationMetadata(conversation, current);
    if (!current()) return fail(409, "The account activation changed.");
    ctx.push({
      type: "conversation",
      conversation: structuredClone(conversation),
    });
    return json(200, { session: cloudCodeSession(conversation, owner) });
  } catch {
    return current()
      ? fail(
          503,
          "Code session creation could not be confirmed. Check your sessions before trying again.",
        )
      : fail(409, "The account activation changed.");
  } finally {
    if (requestId) activeStarts.delete(requestId);
  }
}
