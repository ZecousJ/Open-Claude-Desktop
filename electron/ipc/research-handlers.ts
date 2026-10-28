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
import { ResearchReports, createResearchExtension, id } from "./research";

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
  const catalogItem = (providerId: string, model: string) =>
    serviceCatalogItem(ctx, providerId, model);
  ctx.onAccountActivated(() => {
    const engine: Engine = ctx.engine;
    const reports = new ResearchReports(ctx.store.root);
    if (settleResearchTurns(ctx.store.conversations)) ctx.store.schedule();
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
      return { xSearch: item.webSearch === "native" && item.xSearch === true };
    };
    if (engine.extensions.has("research")) return;
    removeExtension?.();
    removeExtension = engine.extensions.add(
      createResearchExtension({
        policy: () => ctx.policy(),
        catalogItem,
        reports,
        push: (event) => ctx.push(event),
      }),
    );
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
    const markdown = new ResearchReports(ctx.store.root).read(stored.path);
    return { title: stored.title, markdown };
  };

  handle(
    "setConversationResearch",
    async (rawConversationId: unknown, rawEnabled: unknown) => {
      const conversationId = id.parse(rawConversationId);
      const enabled = z.boolean().parse(rawEnabled);
      const conversation = ctx.store.conversation(conversationId);
      if (enabled) {
        const provider = ctx.store.settings.providers.find(
          (item) => item.id === conversation.providerId,
        );
        const reason = researchUnavailable({
          policy: ctx.policy(),
          mode: conversation.mode,
          incognito: conversation.incognito,
          provider,
          model: conversation.model,
          catalogItem: catalogItem(conversation.providerId, conversation.model),
          searchIntegrationEnabled: researchConnectorEnabled(
            ctx.store.settings,
            ctx.policy(),
            conversation.connectorOverrides,
          ),
        });
        if (reason) throw new Error(researchUnavailableMessages[reason]);
      }
      if (conversation.turns.some((turn) => turn.status === "inProgress"))
        throw new Error("This conversation is still running.");
      const searchComesOn =
        enabled &&
        !conversation.webSearch &&
        !researchConnectorEnabled(
          ctx.store.settings,
          ctx.policy(),
          conversation.connectorOverrides,
        );
      if (Boolean(conversation.research) === enabled && !searchComesOn)
        return structuredClone(conversation);
      // Web search takes effect once the agent loads the thread again.
      if (searchComesOn) ctx.noActive();
      if (enabled) conversation.research = true;
      else delete conversation.research;
      if (searchComesOn) conversation.webSearch = true;
      ctx.store.flush();
      if (searchComesOn) await ctx.engineFor(conversationId).stop();
      const updated = structuredClone(conversation);
      ctx.push({ type: "conversation", conversation: updated });
      return updated;
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
