import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { Engine } from "../engine/engine";
import type { ModelCatalogItem } from "../../shared/model-catalog-api";
import {
  reportFileName,
  researchFinished,
  researchUnavailable,
  researchUnavailableMessages,
  researchConnectorEnabled,
} from "../../shared/research";
import type { Conversation, Provider, Settings } from "../../shared/types";
import { modelProtocol } from "../../shared/provider-routes";
import { ResearchReports, createResearchExtension, id, portableResearchReport, hydrateResearchReports } from "./research";

/** Research turns left running when the app closed are stopped. */
export function settleResearchTurns(conversations: Conversation[]) {
  let changed = false;
  for (const conversation of conversations)
    for (const turn of [
      conversation.turns,
      ...(conversation.savedBranches ?? []).map((branch) => branch.turns),
    ].flat()) {
      const research = turn.research;
      if (!research || researchFinished(research)) continue;
      if (turn.status === "inProgress") continue;
      research.state = turn.status === "failed" ? "failed" : "interrupted";
      research.completedAt ??= research.startedAt;
      changed = true;
    }
  return changed;
}

/** The service catalog's entry for a model of the Claudex service. */
export function serviceCatalogItem(
  ctx: Pick<AppContext, "remote"> & { store: { settings: Settings } },
  providerId: string,
  model: string,
): ModelCatalogItem | undefined {
  const provider = ctx.store.settings.providers.find(
    (item: Provider) => item.id === providerId,
  );
  if (provider?.backend !== "sub2api") return undefined;
  return ctx.remote?.modelCatalog()?.items.find((item) => item.id === model);
}

function findTurn(conversation: Conversation, turnId: string) {
  return [
    conversation.turns,
    ...(conversation.savedBranches ?? []).map((branch) => branch.turns),
  ]
    .flat()
    .find((turn) => turn.id === turnId);
}

export function registerResearchHandlers(handle: IpcHandle, ctx: AppContext) {
  let removeExtension: (() => void) | undefined;
  // Include no-op toggles and engine reload in arrival order. A later Off must
  // not acknowledge the old state while an earlier On is still being saved.
  const researchQueues = new WeakMap<object, WeakMap<Conversation, Promise<void>>>();
  const catalogItem = (providerId: string, model: string) =>
    serviceCatalogItem(ctx, providerId, model);
  ctx.onAccountActivated(() => {
    const engine: Engine = ctx.engine;
    const reports = new ResearchReports(ctx.store.root);
    const settled = settleResearchTurns(ctx.store.conversations);
    const hydrated = hydrateResearchReports(reports, ctx.store.conversations);
    if (settled || hydrated) ctx.store.schedule();
    try {
      reports.removeOrphans(
        new Set(ctx.store.conversations.map((item) => item.id)),
      );
    } catch {
      // A report folder that can't be read now is tidied at the next start.
    }
    // The catalog says which models search X (grok); the gateway adds X search for them.
    engine.searchCapabilities = (providerId, model) => {
      const item = catalogItem(providerId, model);
      if (!item?.webSearch) return undefined;
      return { xSearch: item.webSearch === "native" && item.xSearch === true, webSearch: item.webSearch };
    };
    if (engine.extensions.has("research")) return;
    removeExtension?.();
    const extension = createResearchExtension({
      accountId: () => ctx.activeAccount?.id,
      policy: () => ctx.policy(),
      catalogItem,
      reports,
      push: (event) => ctx.push(event),
    });
    const removeLocal = engine.extensions.add(extension);
    engine.peerExtensions?.push(extension);
    removeExtension = () => {
      removeLocal();
      const index = engine.peerExtensions?.indexOf(extension) ?? -1;
      if (index >= 0) engine.peerExtensions.splice(index, 1);
    };
  });
  ctx.onAccountDeactivating(() => {
    removeExtension?.();
    removeExtension = undefined;
  });

  const report = (rawConversationId: unknown, rawTurnId: unknown) => {
    const conversation = ctx.store.conversation(id.parse(rawConversationId));
    const turn = findTurn(conversation, id.parse(rawTurnId));
    const stored = turn?.research?.report;
    if (!stored) throw new Error("This research report isn't available.");
    const { markdown } = portableResearchReport(new ResearchReports(ctx.store.root), conversation.id, turn!.id, stored);
    return { title: stored.title, markdown };
  };

  handle(
    "setConversationResearch",
    async (rawConversationId: unknown, rawEnabled: unknown, rawOptions?: unknown) => {
      const conversationId = id.parse(rawConversationId);
      const enabled = z.boolean().parse(rawEnabled);
      const options = z.object({ webSearch: z.boolean().optional() }).strict().optional().parse(rawOptions) ?? {};
      const store = ctx.store, account = ctx.activeAccount?.id;
      const generation = ctx.accountActivationIdentity;
      const localEngine = ctx.engine, remote = ctx.remote;
      const capturedConversation = store.conversations.find(item => item.id === conversationId);
      if (!capturedConversation) throw new Error("Conversation not found.");
      let queue = researchQueues.get(store);
      if (!queue) { queue = new WeakMap(); researchQueues.set(store, queue); }
      const previous = queue.get(capturedConversation) ?? Promise.resolve();
      const operation = previous.then(async () => {
      const conversation = capturedConversation;
      const lease = () => {
        try {
          return !!account && generation !== undefined && generation !== null &&
            !ctx.accountRetiring && ctx.store === store && ctx.engine === localEngine &&
            ctx.activeAccount?.id === account && ctx.accountActivationIdentity === generation &&
            store.conversations.includes(conversation) &&
            store.conversations.filter(item => item.id === conversationId).length === 1;
        } catch { return false; }
      };
      const check = () => {
        if (!lease())
          throw new Error("The account or conversation changed during this operation.");
      };
      let committed = false;
      let confirmingNoop = false;
      try {
      check();
      if (store.conversation(conversationId) !== conversation)
        throw new Error("The conversation changed during this operation.");
      const validate = () => {
        check();
        const provider = store.settings.providers.find(
          (item) => item.id === conversation.providerId,
        );
        if (options.webSearch === true) {
          if (conversation.mode === "code")
            throw new Error("This Web search control belongs to Chat and Cowork.");
          if (!ctx.policy().webSearch)
            throw new Error("Your administrator has turned off web search.");
          if (!provider || modelProtocol(provider, conversation.model) !== "responses")
            throw new Error("Web search requires a Responses-compatible model service.");
          if (provider.models.length && !new Set([provider.model, ...provider.models]).has(conversation.model))
            throw new Error("This account cannot use the selected model.");
        }
        if (!enabled) return;
        if (provider?.models.length && !new Set([provider.model, ...provider.models]).has(conversation.model))
          throw new Error("This account cannot use the selected model.");
        const integration = researchConnectorEnabled(store.settings, ctx.policy(), conversation.connectorOverrides);
        if (options.webSearch === false && !integration)
          throw new Error("Research requires web search or an enabled search integration.");
        const reason = researchUnavailable({
          policy: ctx.policy(),
          mode: conversation.mode,
          incognito: conversation.incognito,
          provider,
          model: conversation.model,
          catalogItem: serviceCatalogItem({ store, remote }, conversation.providerId, conversation.model),
          searchIntegrationEnabled: integration,
        });
        if (reason) throw new Error(researchUnavailableMessages[reason]);
      };
      validate();
      if (conversation.turns.some((turn) => turn.status === "inProgress"))
        throw new Error("This conversation is still running.");
      const webSearch = options.webSearch ?? (
        enabled && !researchConnectorEnabled(
          store.settings,
          ctx.policy(),
          conversation.connectorOverrides,
        ) ? true : undefined);
      const searchChanges = webSearch !== undefined && Boolean(conversation.webSearch) !== webSearch;
      if (Boolean(conversation.research) === enabled && !searchChanges) {
        confirmingNoop = true;
        await store.confirmConversationMetadata(conversation, lease, true);
        check();
        return structuredClone(conversation);
      }
      const inputs = () => JSON.stringify({
        mode: conversation.mode, incognito: conversation.incognito,
        providerId: conversation.providerId, model: conversation.model,
        environment: conversation.environment,
        connectorOverrides: conversation.connectorOverrides,
        research: conversation.research, webSearch: conversation.webSearch,
      });
      const expectedInputs = inputs();
      let selectedEngine: Engine | undefined;
      const current = () => {
        if (!lease() || inputs() !== expectedInputs ||
            conversation.turns.some(turn => turn.status === "inProgress")) return false;
        try {
          if (selectedEngine && ctx.engines.running(conversationId) !== selectedEngine) return false;
          validate(); return true;
        } catch { return false; }
      };
      // Web search takes effect once the agent loads the thread again.
      if (searchChanges) {
        ctx.noActive();
        selectedEngine = ctx.engineFor(conversationId);
        await selectedEngine.stop(current);
        if (!current()) throw new Error("The account or conversation changed during this operation.");
        ctx.noActive();
      }
      validate();
      if (!current()) throw new Error("The account or conversation changed during this operation.");
      await store.persistResearchPreference(conversation, enabled, webSearch, current);
      committed = true;
      check();
      const updated = structuredClone(conversation);
      ctx.push({ type: "conversation", conversation: updated });
      return updated;
      } catch (error) {
        // The original controls optimistically check both switches. Restore
        // only a readable, still-owned local snapshot and keep the rejection.
        // Cloud unknown/pending rows reject conversation(), so their old live
        // flags are never advertised as a confirmed rollback. An unsuccessful
        // no-op confirmation likewise provides no authoritative save receipt.
        if (!committed && !confirmingNoop && lease()) {
          try {
            if (store.conversation(conversationId) === conversation && lease())
              ctx.push({ type: "conversation", conversation: structuredClone(conversation) });
          } catch { /* Preserve the original failure, including unknown outcome. */ }
        }
        throw error;
      }
      });
      // The queue always settles, but the caller receives its own failure.
      const finished = operation.then(() => {}, () => {});
      queue.set(capturedConversation, finished);
      void finished.then(() => {
        if (queue.get(capturedConversation) === finished) queue.delete(capturedConversation);
      });
      return operation;
    },
  );
  handle(
    "readResearchReport",
    async (conversationId: unknown, turnId: unknown) =>
      report(conversationId, turnId),
  );
  handle(
    "saveResearchReport",
    async (conversationId: unknown, turnId: unknown) => {
      const { title, markdown } = report(conversationId, turnId);
      const { app, dialog } = await import("electron");
      const parent = ctx.callerWindow();
      const options = {
        title: "Save research report",
        defaultPath: path.join(app.getPath("downloads"), reportFileName(title)),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      };
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return false;
      await fs.promises.writeFile(result.filePath, markdown, "utf8");
      return true;
    },
  );
}
