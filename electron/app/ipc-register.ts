import { localEdition } from "./edition";
import { registerLocalProvider } from "./local-provider";
import { desktopPreferences } from "../store/desktop-preferences";
import {isDeepStrictEqual} from 'node:util';
import {localeSaveStage,localeSaveFailure} from '../official-ui/api/locale-save-diagnostics';
import { isDeviceExecutionCopy } from "../../shared/chat-devices-api";
import { registerDeviceTrustHandlers } from "../remote-control/account-device-state";
import { preference } from "../../shared/settings-extras";
import { preferenceFields } from "../../shared/settings-extras-schema";
import { remoteFolderValid } from "../../shared/remote-devices";
import { completedReply } from "../../shared/branches";
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
  saveDeviceDesktopPreferences,
  policy,
  ratingListeners,
  settingsListeners,
  sendSettings,
  push,
  callerWindows,
  string,
  rendererSettings,
  noActive,
  ctx,
  nativeExtensions,
  lifecycle,
} from "../main";
import { handle } from "./ipc-handle";
import { desktopShortcuts } from "./desktop-integration";
import { allowQuickEntryDictationShortcut } from "./quick-access";
import { dispatchOfficialLayoutCommand } from "../official-ui/window";

export function register() {
  registerDeviceTrustHandlers(handle, currentAccountDevices);
  if (localEdition) registerLocalProvider(handle);
  else if (mainState.remoteAccounts)
    registerRemoteAccounts(handle, ctx, mainState.remoteAccounts, lifecycle);
  handle("referenceFonts", () => []);
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
    (conversationId: unknown, turnId: unknown, rating: unknown, options: unknown) => {
      const id = string.parse(conversationId),
        turn = string.parse(turnId);
      const found = completedReply(mainState.store.conversation(id), turn);
      if (!found)
        throw Error("Only completed replies can be rated.");
      const value = z
        .union([z.literal("up"), z.literal("down"), z.null()])
        .parse(rating);
      const policy = z.object({ localOnly: z.literal(true) }).strict().optional().parse(options);
      const all = mainState.replyFeedback.set(id, turn, value);
      ratingListeners.emit({ conversationId: id, turnId: turn, rating: value, ...policy });
      return all;
    },
  );
  handle("saveOfficialThemeMode", (raw: unknown) => {
    const theme = z.enum(["system", "light", "dark"]).parse(raw);
    if (!mainState.activeAccount || mainState.accountRetirement.accountRetiring)
      throw Error("This account window has retired.");
    const changed = mainState.store.settings.theme !== theme;
    if (changed) {
      const next = { ...mainState.store.settings, theme };
      mainState.store.write("settings.json", next);
      mainState.store.settings = next;
    }
    nativeTheme.themeSource = theme;
    if (changed) sendSettings();
  });
  handle("saveOfficialDispatchReceiving", (raw: unknown) => {
    if (!mainState.activeAccount || mainState.accountRetirement.accountRetiring)
      throw Error("This account window has retired.");
    const patch = z.strictObject({
      remoteControl: preferenceFields.remoteControl,
      dispatchMobileNotifications: preferenceFields.dispatchMobileNotifications,
      remoteFolders: preferenceFields.remoteFolders,
      remoteFolderWorktree: z.strictObject({
        folder: z.string().refine(remoteFolderValid),
        enabled: z.boolean(),
      }).optional(),
    }).parse(raw);
    const store = mainState.store;
    const { remoteFolderWorktree, ...receiving } = patch;
    const next = { ...store.settings, ...receiving };
    const folders = preference(next, "remoteFolders");
    if (remoteFolderWorktree && !folders.includes(remoteFolderWorktree.folder))
      throw Error("This Remote Control folder is no longer shared.");
    if (receiving.remoteFolders || remoteFolderWorktree) {
      const overrides = preference(next, "remoteFolderSpawnModes").filter(
        ({ folder }) => folders.includes(folder) && folder !== remoteFolderWorktree?.folder,
      );
      if (remoteFolderWorktree) overrides.push({
        folder: remoteFolderWorktree.folder,
        mode: remoteFolderWorktree.enabled ? "worktree" : "same-dir",
      });
      next.remoteFolderSpawnModes = overrides;
    }
    if (isDeepStrictEqual(store.settings, next)) return;
    store.write("settings.json", next);
    store.settings = next;
    integration.refreshKeepAwake();
    sendSettings();
  });
  handle("saveSettings", async (raw: any, secrets: any = {}) => {
    localeSaveStage("native-schema");
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
    localeSaveStage("native-policy");
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
        // running turn keeps the mode it started with), so changing it
        // mid-turn neither restarts the engine nor is refused (owner,
        // 2026-10-22: Bypass mid-turn also said "Wait for or stop the
        // running task first.").
        codeSandbox: "",
        autoAcceptEdits: false,
        codePlanMode: false,
        bypassFolders: [],
      });
    const changedEngine =
      // Preserve the existing JSON projection (including omitted undefined
      // fields), but do not treat property insertion order as an engine change.
      !isDeepStrictEqual(
        JSON.parse(engineSettings(settings)),
        JSON.parse(engineSettings(mainState.store.settings)),
      );
    if (changedEngine || Object.keys(parsedKeys).length) noActive();
    localeSaveStage("native-validation");
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
    settings.legacyQuickEntryEnabled ??= before.legacyQuickEntryEnabled;
    settings.keepAwake ??= before.keepAwake;
    settings.keepAwakeWhileCoding ??= before.keepAwakeWhileCoding;
    settings.keepAwakeOnBattery ??= before.keepAwakeOnBattery;
    settings.notificationLevels ??= before.notificationLevels;
    settings.notificationSound ??= before.notificationSound;
    settings.drawAttention ??= before.drawAttention;
    const voiceShortcut = settings.quickEntryDictationShortcut;
    if (voiceShortcut && voiceShortcut !== "off" && voiceShortcut !== before.quickEntryDictationShortcut) {
      const store = mainState.store;
      const generation = mainState.accountRetirement.accountActivationIdentity;
      const allowed = await allowQuickEntryDictationShortcut(voiceShortcut);
      if (mainState.store !== store || store.settings !== before ||
          mainState.accountRetirement.accountActivationIdentity !== generation)
        throw Error("Settings changed while enabling the voice shortcut. Try again.");
      if (!allowed) return rendererSettings();
    }
    const integrationOptions = {
      preserveShortcuts: isDeepStrictEqual(desktopShortcuts(before), desktopShortcuts(settings)),
      observe: localeSaveStage,
    };
    mainState.store.settings = settings;
    try {
      localeSaveStage("integration-before");
      integration.apply(integrationOptions);
      const desktop = desktopPreferences(settings);
      if (!isDeepStrictEqual(desktopPreferences(before), desktop))
        saveDeviceDesktopPreferences(desktop);
      localeSaveStage("integration-after");
    } catch (error) {
      localeSaveFailure(error);
      localeSaveStage("rollback-before");
      mainState.store.settings = before;
      integration.apply(integrationOptions);
      localeSaveStage("rollback-after");
      throw error;
    }
    localeSaveStage("flush-before");
    mainState.store.flush();
    localeSaveStage("flush-after");
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
    localeSaveStage("native-theme");
    nativeTheme.themeSource = settings.theme;
    localeSaveStage("native-notify");
    settingsListeners.emit(mainState.store.settings);
    if (
      before.keepAwake !== settings.keepAwake ||
      before.keepAwakeWhileCoding !== settings.keepAwakeWhileCoding ||
      before.keepAwakeOnBattery !== settings.keepAwakeOnBattery ||
      !isDeepStrictEqual(before.notificationLevels, settings.notificationLevels) ||
      before.notificationSound !== settings.notificationSound ||
      before.drawAttention !== settings.drawAttention ||
      preference(before, "remoteControl") !== preference(settings, "remoteControl") ||
      preference(before, "remoteControlStayReachable") !== preference(settings, "remoteControlStayReachable") ||
      preference(before, "dispatchMobileNotifications") !== preference(settings, "dispatchMobileNotifications") ||
      !isDeepStrictEqual(preference(before, "remoteFolders"), preference(settings, "remoteFolders"))
    ) push({ type: "settings", settings: rendererSettings() });
    localeSaveStage("device-refresh-before");
    deviceLink.refresh();
    localeSaveStage("device-refresh-after");
    if (changedEngine || Object.keys(parsedKeys).length) {
      localeSaveStage("native-engine-stop");
      await mainState.engine.stop();
      localeSaveStage("native-engine-ensure");
      await mainState.engine.ensure(
        settings.providers.find((p) => p.id === settings.activeProviderId)!,
      );
    }
    localeSaveStage("native-return");
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
    dispatchOfficialLayout: dispatchOfficialLayoutCommand,
    mcpLogs: { read: (name) => nativeExtensions.read(name) },
    prepareExtensionUpgrade: (id, manifest, target) =>
      nativeExtensions.lifecycle.prepareUpgrade(id, manifest, target),
    prepareExtensionMaintenance: () => nativeExtensions.prepareMaintenance("installing"),
    publishExtensionServers: (servers) =>
      nativeExtensions.lifecycle.options.update(servers),
  });
  nativeExtensions.register(handle);
}
