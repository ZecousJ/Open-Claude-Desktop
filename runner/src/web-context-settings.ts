import {
  historySearchInput,
  historySearchResult,
} from "../../shared/history-search";
import { slimConversation } from "../../shared/conversation-slim";
import { z } from "zod";
import type { Settings, Snapshot } from "../../shared/types";
import { webHost } from "../../shared/host";
import { anyFolder } from "../../shared/sandbox-policy";
import { settingsRefusal } from "../../shared/client-policy";
import { type IpcHandle } from "../../electron/app/app-context";
import { mergeSavedSettings } from "../../electron/store/settings-merge";
import {
  publicPreferences,
  withoutPreferences,
} from "../../electron/store/settings-preferences";
import { preference } from "../../shared/settings-extras";
import { settingsSchema, idString } from "./web-app-support";
import type { WebAppContext } from "./web-app-context";

export function publicSettings(this: WebAppContext): Settings {
  const settings = this.store.settings;
  return {
    theme: settings.theme,
    sidebarWidth: settings.sidebarWidth,
    name: settings.name,
    activeProviderId: settings.activeProviderId,
    effort: settings.effort,
    codeEffort: settings.codeEffort,
    sandbox: settings.sandbox,
    codeSandbox: settings.codeSandbox,
    bypassFolders: settings.bypassFolders,
    autoAcceptEdits: settings.autoAcceptEdits,
    codePlanMode: settings.codePlanMode,
    instructions: settings.instructions,
    mcpServers: settings.mcpServers,
    chatFont: settings.chatFont,
    motion: settings.motion,
    codeFont: settings.codeFont,
    hiddenNavItems: settings.hiddenNavItems,
    ...publicPreferences(settings),
    providers: settings.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: "",
      protocol: p.protocol,
      model: p.model,
      models: [...p.models],
      transcriptionModel: p.transcriptionModel,
      // Which service group serves each model (MG); no keys in it.
      ...(p.routes ? { routes: structuredClone(p.routes) } : {}),
    })),
  };
}

// ---- The main process's own calls

/** Registers snapshot, saveSettings and setReplyFeedback (main.ts on the desktop). */
export function registerCoreHandlers(this: WebAppContext, handle: IpcHandle) {
  handle("captureArtifactScreenshot", (raw: unknown) => {
    const html = z
      .string()
      .max(32 * 1024 * 1024)
      .parse(raw);
    return this.runtime.captureArtifactScreenshot!(html);
  });
  handle("snapshot", async (): Promise<Snapshot> => {
    await this.chatDeviceController.refresh();
    const snapshot = this.snapshot();
    return {
      ...snapshot,
      approvals: [
        ...snapshot.approvals,
        ...this.chatDeviceController.pendingApprovals(),
      ],
    };
  });
  handle(
    "searchConversations",
    async (query: unknown, options: unknown = {}) => {
      const parameters = historySearchInput.parse({
        ...(options && typeof options === "object" && !Array.isArray(options)
          ? options
          : {}),
        query,
      });
      return historySearchResult.parse(
        await this.runtime.transport.request(
          "store.search",
          this.userId,
          parameters,
        ),
      );
    },
  );
  handle("conversationTurns", (conversationId: unknown) => {
    const found = this.store.conversation(idString.parse(conversationId));
    return { turns: found.turns, savedBranches: found.savedBranches };
  });
  handle(
    "setReplyFeedback",
    (conversationId: unknown, turnId: unknown, rating: unknown) => {
      const id = idString.parse(conversationId);
      const turn = idString.parse(turnId);
      const found = this.store
        .conversation(id)
        .turns.find((item) => item.id === turn);
      if (!found || found.status !== "completed")
        throw Error("Only completed replies can be rated.");
      const value = z
        .union([z.literal("up"), z.literal("down"), z.null()])
        .parse(rating);
      const all = this.replyFeedback.set(id, turn, value);
      this.ratingListeners.emit({
        conversationId: id,
        turnId: turn,
        rating: value,
      });
      return all;
    },
  );
  handle("saveSettings", (raw: unknown, secrets: unknown = {}) =>
    this.saveSettings(raw, secrets),
  );
}

export function snapshot(this: WebAppContext): Snapshot {
  return {
    artifactShares: this.artifactShares.list(),
    artifactLibrary: this.artifactLibrary.list(),
    dismissedBackgroundTasks: this.backgroundHistory.list(),
    replyFeedback: this.replyFeedback.all(),
    settings: this.windowSettings(),
    // Over the network: commands' long texts follow when a chat opens.
    conversations: this.store.conversations.map(slimConversation),
    projects: this.store.projects,
    engine: this.engine.state,
    approvals: this.engine.approvals,
    platform: process.platform,
    modelUnavailable: this.engine.unavailableReason,
    host: this.runtime.host ?? webHost,
  };
}

export async function saveSettings(
  this: WebAppContext,
  raw: unknown,
  secrets: unknown,
) {
  const store = this.store;
  const previousCodeEmail = preference(store.settings, "notifyCodeEmail");
  const settings = mergeSavedSettings(
    store.settings,
    settingsSchema.parse(raw) as Settings,
    this.rendererBase,
    ["disabledSkills"],
  );
  const keys = z.record(z.string(), z.string().max(16000)).parse(secrets);
  if (Object.keys(keys).length)
    throw Error("Model credentials are managed by the Claudex service.");
  // The plan's provider, and nothing that names the server's folders or
  // starts programs on it: those stay as the service set them.
  settings.providers = structuredClone(store.settings.providers);
  settings.activeProviderId = store.settings.activeProviderId;
  settings.mcpServers = structuredClone(store.settings.mcpServers);
  // Bypass needs no folder here: every session runs in its own sandbox, so the
  // runner confirms them all.
  settings.bypassFolders = [anyFolder];
  const refusal = settingsRefusal(store.settings, settings, this.policy());
  if (refusal) throw Error(refusal);
  if (
    settings.codePlanMode &&
    (settings.codeSandbox !== "read-only" || settings.autoAcceptEdits)
  )
    throw Error(
      "Plan mode must remain read-only without automatic edit approval.",
    );
  const engineSettings = (value: Settings) =>
    JSON.stringify({
      ...withoutPreferences(value),
      theme: "",
      name: "",
      sidebarWidth: 0,
      effort: "",
      codeEffort: "",
      chatFont: "",
      motion: "",
      codeFont: "",
      hiddenNavItems: [],
    });
  const changedEngine =
    engineSettings(settings) !== engineSettings(store.settings);
  if (changedEngine) this.noActive();
  if (!settings.providers.some((p) => p.id === settings.activeProviderId))
    throw new Error("Choose a valid connection.");
  const codeEmailChanged =
    preference(settings, "notifyCodeEmail") !== previousCodeEmail;
  if (codeEmailChanged && preference(settings, "notifyCodeEmail")) {
    if (!(await this.codeEmailStatus()).available)
      throw new Error("Email notifications are unavailable for this account.");
    if (this.closed || this.signedOut)
      throw new Error("This account has signed out.");
  }
  store.settings = settings;
  store.flush();
  if (codeEmailChanged) {
    try {
      await store.persistCodeEmailPreference();
    } catch (error) {
      if (store.settings === settings) {
        store.settings.notifyCodeEmail = previousCodeEmail;
        store.flush();
      }
      throw error;
    }
  }
  this.settingsListeners.emit(store.settings);
  // A running engine picks the change up at its next start.
  if (changedEngine && this.engineRunning()) await this.engine.stop();
  return this.windowSettings();
}
