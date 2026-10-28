import { isDeviceExecutionCopy } from "../../shared/chat-devices-api";
import { registerDeviceTrustHandlers } from "../remote-control/account-device-state";
import { preference } from "../../shared/settings-extras";
import { desktopHost } from "../../shared/host";
import { copyNativeImage } from "./image-clipboard";
import { nativeTheme, nativeImage, clipboard, ClipboardItem } from "electron";
import fs from "node:fs";
import { z } from "zod";
import { searchLocalConversations } from "../conversations/history-search";
import { settingsSchema } from "../store/settings-schema";
import { withoutPreferences } from "../store/settings-preferences";
import { mcpConfigText } from "../connectors/mcp-config-file";
import { mergeSavedSettings } from "../store/settings-merge";
import { settingsRefusal } from "../../shared/client-policy";
import type { Settings } from "../../shared/types";
import { captionOverlay } from "./caption-overlay";
import { registerIpc } from "../ipc/index";
import { registerRemoteAccounts } from "../remote/host-wiring";
import { mainState } from "./main-state";
import {
  currentAccountDevices,
  deviceLink,
  integration,
  policy,
  ratingListeners,
  settingsListeners,
  callerWindows,
  string,
  rendererSettings,
  noActive,
  ctx,
  nativeExtensions,
  lifecycle,
} from "../main";
import { handle } from "./ipc-handle";

export function register() {
  registerDeviceTrustHandlers(handle, currentAccountDevices);
  if (mainState.remoteAccounts)
    registerRemoteAccounts(handle, ctx, mainState.remoteAccounts, lifecycle);
  handle("copyImage", (raw: unknown) =>
    copyNativeImage(
      raw,
      (data) => nativeImage.createFromDataURL(data),
      (image) =>
        clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([Uint8Array.from(image.toPNG())], {
              type: "image/png",
            }),
          }),
        ]),
    ),
  );
  handle("copyText", async (raw: unknown, html?: unknown) => {
    const text = z.string().max(10_000_000).parse(raw);
    const rich = z.string().max(10_000_000).optional().parse(html);
    // Both forms in one item: a paste into a document keeps the formatting,
    // one into a plain field gets the text.
    if (rich)
      await clipboard.write([
        new ClipboardItem({ "text/plain": text, "text/html": rich }),
      ]);
    else await clipboard.writeText(text);
  });
  handle("conversationTurns", (conversationId: unknown) => {
    const found = mainState.store.conversation(
      z.string().min(1).parse(conversationId),
    );
    return { turns: found.turns, savedBranches: found.savedBranches };
  });
  handle("searchConversations", (query: unknown, options: unknown) =>
    searchLocalConversations(
      mainState.store.conversations.filter((c) => !isDeviceExecutionCopy(c)),
      query,
      options,
    ),
  );
  handle("snapshot", () => ({
    host: {
      ...desktopHost,
      capabilities: {
        ...desktopHost.capabilities,
        codeSessionPermissions: true,
      },
    },
    artifactShares: mainState.artifactShares.list(),
    artifactLibrary: mainState.artifactLibrary.list(),
    dismissedBackgroundTasks: mainState.backgroundHistory.list(),
    replyFeedback: mainState.replyFeedback.all(),
    settings: rendererSettings(),
    conversations: mainState.store.conversations.filter(
      (c) => !isDeviceExecutionCopy(c),
    ),
    projects: mainState.store.projects,
    engine: mainState.engine.state,
    approvals: mainState.engine.approvals.filter(
      (approval) =>
        !mainState.store.conversations.find(
          (c) => c.id === approval.conversationId,
        )?.deviceChatOrigin,
    ),
    platform: process.platform,
    modelUnavailable: mainState.engine.unavailableReason,
  }));
  handle(
    "setReplyFeedback",
    (conversationId: unknown, turnId: unknown, rating: unknown) => {
      const id = string.parse(conversationId),
        turn = string.parse(turnId);
      const found = mainState.store
        .conversation(id)
        .turns.find((item) => item.id === turn);
      if (!found || found.status !== "completed")
        throw Error("Only completed replies can be rated.");
      const value = z
        .union([z.literal("up"), z.literal("down"), z.null()])
        .parse(rating);
      const all = mainState.replyFeedback.set(id, turn, value);
      ratingListeners.emit({ conversationId: id, turnId: turn, rating: value });
      return all;
    },
  );
  handle("saveSettings", async (raw: any, secrets: any = {}) => {
    // Skill switches are changed through their own calls, never by a save.
    const settings = mergeSavedSettings(
      mainState.store.settings,
      settingsSchema.parse(raw) as Settings,
      mainState.rendererBase,
      ["disabledSkills"],
    );
    const parsedKeys = z
      .record(z.string(), z.string().max(16000))
      .parse(secrets);
    if (Object.keys(parsedKeys).length)
      throw Error("Model credentials are managed by the local server.");
    // Model providers come from the operator (or the Sub2API plan), never from the renderer.
    settings.providers = structuredClone(
      (!mainState.remote && mainState.operatorConfig?.providers) ||
        mainState.store.settings.providers,
    );
    settings.activeProviderId =
      (!mainState.remote && mainState.operatorConfig?.activeProviderId) ||
      mainState.store.settings.activeProviderId;
    const refusal = settingsRefusal(
      mainState.store.settings,
      settings,
      policy(),
    );
    if (refusal) throw Error(refusal);
    if (
      settings.codePlanMode &&
      (settings.codeSandbox !== "read-only" || settings.autoAcceptEdits)
    )
      throw Error(
        "Plan mode must remain read-only without automatic edit approval.",
      );
    // Preferences that only affect this window never restart the engine.
    const engineSettings = (value: Settings) =>
      JSON.stringify({
        ...withoutPreferences(value),
        extensionBuiltInNode: preference(value, "extensionBuiltInNode"),
        theme: "",
        name: "",
        sidebarWidth: 0,
        effort: "",
        codeEffort: "",
        chatFont: "",
        motion: "",
        codeFont: "",
        hiddenNavItems: [],
        // The permission picker's choice is read when a turn starts (and a
        // running turn keeps the mode it started with), so changing it mid-turn
        // neither restarts the engine nor is refused.
        codeSandbox: "",
        autoAcceptEdits: false,
        codePlanMode: false,
        bypassFolders: [],
      });
    const changedEngine =
      engineSettings(settings) !== engineSettings(mainState.store.settings);
    if (changedEngine || Object.keys(parsedKeys).length) noActive();
    if (!settings.providers.some((p) => p.id === settings.activeProviderId))
      throw new Error("Choose a valid connection.");
    if (
      new Set(settings.providers.map((p) => p.id)).size !==
      settings.providers.length
    )
      throw new Error("Duplicate connection ID.");
    for (const [name, value] of Object.entries(settings.mcpServers)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name) || !value || typeof value !== "object")
        throw new Error("The MCP configuration is not valid.");
    }
    const before = mainState.store.settings;
    mainState.store.settings = settings;
    try {
      integration.apply();
    } catch (error) {
      mainState.store.settings = before;
      integration.apply();
      throw error;
    }
    mainState.store.flush();
    if (
      mainState.mcpConfig &&
      JSON.stringify(settings.mcpServers) !== JSON.stringify(before.mcpServers)
    )
      fs.writeFileSync(
        mainState.mcpConfig.path,
        mcpConfigText(settings.mcpServers),
        {
          mode: 0o600,
        },
      );
    nativeTheme.themeSource = settings.theme;
    settingsListeners.emit(mainState.store.settings);
    deviceLink.refresh();
    if (changedEngine || Object.keys(parsedKeys).length) {
      await mainState.engine.stop();
      await mainState.engine.ensure(
        settings.providers.find((p) => p.id === settings.activeProviderId)!,
      );
    }
    return rendererSettings();
  });
  handle("windowAction", (value: any, colors?: unknown) => {
    const action = z
      .enum(["minimize", "maximize", "close", "caption"])
      .parse(value);
    // The window whose own controls were used (the main or a separate one).
    const target = callerWindows.getStore() ?? mainState.window;
    if (action === "caption") {
      // Windows draws the caption buttons (captionOverlay); the page says
      // which colours sit under them.
      const hex = z.string().regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
      const parsed = z
        .object({ background: hex, symbol: hex })
        .safeParse(colors);
      if (process.platform === "win32" && parsed.success && target)
        target.setTitleBarOverlay(
          captionOverlay(parsed.data.background, parsed.data.symbol),
        );
      return;
    }
    if (action === "minimize") target?.minimize();
    if (action === "maximize") {
      if (target?.isMaximized()) target.unmaximize();
      else target?.maximize();
    }
    if (action === "close") target?.close();
  });
  // Every other call, domain by domain (electron/ipc/index.ts).
  registerIpc(handle, ctx, {
    mcpLogs: { read: (name) => nativeExtensions.read(name) },
  });
  nativeExtensions.register(handle);
}
