/**
 * AppPreferences, AppFeatures, Startup, GlobalShortcut: the official app's
 * preference store (official main `u_` schema). Keys that
 * have a Claudex setting read and write that setting, so the classic app,
 * the tray, quick entry and keep-awake follow what the official Settings
 * page shows; every other key is kept in the adapter's own store.
 */
import { z } from "zod";
import path from "node:path";
import {
  defaultDictationShortcut,
  preference,
  type DictationShortcutPreference,
  type SettingsPreferences,
} from "../../../shared/settings-extras";
import type { Settings } from "../../../shared/types";
import { readState, writeState } from "../api/state";
import type { NativeHost } from "./host";
import { inAdapterScope, newAdapterScope } from "../api/scope";
import { mainOnlyPreferences } from "./preferences-main-only";
import { sessionAccountScope } from "./session-account-scope";
import { scheduledTaskPreferenceKeys } from "../scheduled-task-preferences";
import { remoteControlSpawnModes } from "../../../shared/remote-devices";
import { computerUseFeatures, computerUsePreferenceKeys, computerUsePreferences, officialComputerUsePreference, type OfficialComputerUsePreference } from "./computer-use";

const customShortcut = z.object({ accelerator: z.string().max(100) });
const quickEntry = z.union([z.enum(["double-tap-option", "off"]), customShortcut]);
const quickEntryDictation = z.union([
  z.enum(["capslock", "double-tap-capslock", "off"]),
  customShortcut,
]);

const chatDictation = z.union([z.enum(["default", "off"]), customShortcut]);
const startupState = z.object({ runOnStartup: z.boolean() });
const chromeImportPrompt = z.enum(["pending", "dismissed", "done"]);

function startupOnLoginEnabled(state: unknown) {
  const result = startupState.safeParse(state);
  if (!result.success) throw Error("Startup-on-login status is unavailable on this host.");
  return result.data.runOnStartup;
}

/** Official preference key → Claudex setting, with value conversions where they differ. */
const mapped: Record<
  string,
  {
    key: keyof SettingsPreferences;
    read?: (v: any) => unknown;
    write?: (v: any) => unknown;
  }
> = {
  menuBarEnabled: { key: "menuBar", write: (value) => z.boolean().parse(value) },
  keepAwakeEnabled: { key: "keepAwake" },
  ccKeepAwakeWhileWorking: { key: "keepAwakeWhileCoding" },
  ccKeepAwakeOnBattery: { key: "keepAwakeOnBattery" },
  ccPromptSuggestions: { key: "ccPromptSuggestions" },
  ccNewTaskPrompt: { key: "ccNewTaskPrompt" },
  notificationLevels: { key: "notificationLevels" },
  notificationSound: { key: "notificationSound" },
  dockBounceEnabled: { key: "drawAttention" },
  bypassPermissionsModeEnabled: { key: "allowBypassPermissions" },
  ccAutoArchiveInactiveDays: { key: "autoArchiveDays" },
  ccAutoArchiveOnPrClose: { key: "prAutoArchive" },
  ccRemoteControlDefaultEnabled: { key: "remoteControlNewSessions" },
  remoteControlStayReachable: { key: "remoteControlStayReachable", write: value => z.boolean().parse(value) },
  remoteControlSpawnMode: { key: "remoteControlSpawnMode", write: value => z.enum(remoteControlSpawnModes).parse(value) },
  claudeIosSimulatorAccessEnabled: { key: "iosSimulatorAccess" },
  claudeAndroidEmulatorAccessEnabled: { key: "androidEmulatorAccess" },
  ccBranchPrefix: { key: "codeBranchPrefix" },
  chillingSlothLocation: {
    key: "codeWorktreeLocation",
    read: (value) => value ? { customPath: value } : "default",
  },
  launchEnabled: { key: "codeBrowserTools", write: (value) => z.boolean().parse(value) },
  launchPreviewStorage: {
    key: "browserKeepCookies",
    read: (value) => value === "always" ? "shared" : value === "per-session" ? "session" : "none",
    write: (value) => ({ none: "until-quit", shared: "always", session: "per-session" })[
      z.enum(["none", "shared", "session"]).parse(value)
    ],
  },
  coworkBrowserToolsEnabled: { key: "browserTools" },
  coworkPreferredBrowser: {
    key: "preferredBrowser",
    write: (value) => {
      if (value !== "built_in") throw Error("Only the built-in browser is available on this computer.");
      return value;
    },
  },
  allowAllBrowserActions: { key: "allowAllBrowserActions" },
  legacyQuickEntryEnabled: { key: "legacyQuickEntryEnabled", write: (value) => z.boolean().parse(value) },
  quickEntryShortcut: {
    key: "quickEntryShortcut",
    read: (value: string) => value === "double-tap-option" || value === "off"
      ? value
      : { accelerator: value },
    write: (value: unknown) => {
      const shortcut = quickEntry.parse(value);
      return typeof shortcut === "string" ? shortcut : shortcut.accelerator;
    },
  },
  quickEntryDictationShortcut: {
    key: "quickEntryDictationShortcut",
    read: (value: string) =>
      value === "capslock" || value === "double-tap-capslock" || value === "off"
        ? value
        : { accelerator: value },
    write: (value: unknown) => {
      const shortcut = quickEntryDictation.parse(value);
      return typeof shortcut === "string" ? shortcut : shortcut.accelerator;
    },
  },
  dictationShortcut: {
    key: "dictationShortcut",
    read: (value: DictationShortcutPreference) =>
      typeof value !== "string"
        ? value
        : value === "off" || value === ""
          ? "off"
          : value === defaultDictationShortcut
            ? "default"
            : { accelerator: value },
    write: (value: unknown) => {
      const shortcut = chatDictation.parse(value);
      return shortcut === "default" ? defaultDictationShortcut : shortcut === "off" ? "" : shortcut;
    },
  },
};

export function registerPreferences(
  host: NativeHost,
  features: unknown,
  saveComputerUsePreference?: (key: OfficialComputerUsePreference, value: unknown) => Promise<void>,
) {
  const { ctx } = host;
  const buckets = new Map<
    string,
    {
      scope: ReturnType<typeof newAdapterScope>;
      value: Record<string, unknown>;
    }
  >();
  const load = () => {
    const key = JSON.stringify([
      ctx.account?.()?.id ?? "",
      ctx.stateDirectory?.(),
    ]);
    const existing = buckets.get(key);
    if (existing) return existing;
    const scope = newAdapterScope(
      ctx.account?.()?.id ?? "",
      ctx.stateDirectory?.(),
      ctx.sessionIdentity?.(),
    );
    const loaded = {
      scope,
      value: inAdapterScope(scope, () =>
        readState<Record<string, unknown>>("preferences", {}),
      ),
    };
    // Returning to an account before its debounce fires must not lose pending values.
    buckets.set(key, loaded);
    return loaded;
  };
  let bucket = load();
  const account = sessionAccountScope(ctx, () => {
    bucket = load();
  });
  const settings = () => ctx.settings() as Settings & SettingsPreferences;
  const autoOpenFiles = () => {
    account.sync();
    return bucket.value.launchAutoOpenFiles !== false;
  };
  const all = () => {
    account.sync();
    const current = settings();
    const out: Record<string, unknown> = {
      ...bucket.value,
      launchAutoOpenFiles: autoOpenFiles(),
      launchChromeImportPrompt:
        chromeImportPrompt.safeParse(bucket.value.launchChromeImportPrompt).data ?? "pending",
      chicagoBackgroundIntroSeen: bucket.value.chicagoBackgroundIntroSeen === true,
      wakeSchedulerEnabled: false,
    };
    for (const [officialKey, map] of Object.entries(mapped)) {
      const value = preference(current, map.key as any);
      const converted = map.read ? map.read(value) : value;
      if (converted !== undefined) out[officialKey] = converted;
    }
    out.launchEnabled = (current.codeBrowserTools ?? current.browserTools) !== false;
    const owner = ctx.account()?.id;
    delete out.coworkModelAutoFallbackByAccount;
    if (owner) out.coworkModelAutoFallbackByAccount = { [owner]: preference(current, "modelAutoFallback") };
    delete out.bypassPermissionsOptInByAccount;
    if (owner) out.bypassPermissionsOptInByAccount = { [owner]: out.bypassPermissionsModeEnabled === true };
    const bypassGate = z.record(z.string(), z.boolean())
      .safeParse(bucket.value.bypassPermissionsGateByAccount);
    out.bypassPermissionsGateByAccount =
      owner && bypassGate.success && Object.hasOwn(bypassGate.data, owner)
        ? { [owner]: bypassGate.data[owner] && out.bypassPermissionsModeEnabled === true }
        : {};
    for (const key of Object.keys(out))
      if (key.startsWith("wakeScheduler") && key !== "wakeSchedulerEnabled") delete out[key];
    for (const key of Object.keys(computerUsePreferenceKeys)) delete out[key];
    for (const key of mainOnlyPreferences) delete out[key];
    Object.assign(out, computerUsePreferences(ctx.computerUseSettingsState?.()));
    delete out.claudexRemoteReachabilityPreference;
    if (ctx.remoteReachabilityPreferenceAvailable?.()) out.claudexRemoteReachabilityPreference = true;
    delete out.claudexChromeExtension;
    delete out.claudexChromeExtensionEnabled;
    delete out.claudexChromeExtensionReveal;
    if (ctx.chromeExtension) out.claudexChromeExtension = ctx.chromeExtension.status();
    delete out.claudexBuiltInBrowserSettings;
    if (ctx.builtInBrowserSettingsAvailable?.()) out.claudexBuiltInBrowserSettings = true;
    return out;
  };
  const changed = () =>
    host.emit("AppPreferences", "preferencesChanged", all());
  const write = async (key: string, value: unknown) =>
    account.run(async () => {
      account.sync();
      if (
        typeof key !== "string" ||
        !key ||
        key.length > 256 ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        throw Error("Choose a valid preference key.");
      if (key.startsWith("wakeScheduler") && key !== "wakeSchedulerEnabled")
        throw Error("Scheduled wake is unavailable on this host.");
      if (key === "wakeSchedulerEnabled") {
        if (value === true) throw Error("Scheduled wake is unavailable on this host.");
        z.boolean().parse(value);
        return;
      }
      if (key === "claudexChromeExtension") throw Error("This preference is managed by the application.");
      if (key === "claudexChromeExtensionEnabled") {
        if (!ctx.chromeExtension) throw Error("Chrome extension setup is unavailable here.");
        await account.guard(() => ctx.chromeExtension!.configure(z.boolean().parse(value)));
        changed();
        return;
      }
      if (key === "claudexChromeExtensionReveal") {
        if (!ctx.chromeExtension || value !== true) throw Error("Chrome extension setup is unavailable here.");
        await ctx.chromeExtension.revealBundle();
        return;
      }
      if (key === "claudexBuiltInBrowserSettings" || key === "claudexRemoteReachabilityPreference" || mainOnlyPreferences.has(key)) throw Error("This preference is managed by the application.");
      if (officialComputerUsePreference(key)) {
        if (!saveComputerUsePreference) throw Error("Computer use is unavailable here.");
        await account.guard(() => saveComputerUsePreference(key, value));
        return;
      }
      if (key === "coworkModelAutoFallbackByAccount") {
        const owner = ctx.account()?.id;
        const entries = z.record(z.string(), z.boolean()).parse(value);
        if (!owner || Object.keys(entries).length !== 1 || !Object.hasOwn(entries, owner))
          throw Error("Choose model fallback for the active account.");
        return;
      }
      if (key === "bypassPermissionsOptInByAccount") {
        const owner = ctx.account()?.id;
        const entries = z.record(z.string(), z.boolean()).parse(value);
        if (!owner || Object.keys(entries).length !== 1 || !Object.hasOwn(entries, owner))
          throw Error("Choose bypass permissions for the active account.");
        await account.guard(() => ctx.call("saveSettings", {
          ...settings(), allowBypassPermissions: entries[owner],
        }));
        changed();
        return;
      }
      if (key === "bypassPermissionsGateByAccount") {
        const owner = ctx.account()?.id;
        const entries = z.record(z.string(), z.boolean()).parse(value);
        if (!owner || Object.keys(entries).length !== 1 || !Object.hasOwn(entries, owner))
          throw Error("Choose bypass eligibility for the active account.");
        value = { [owner]: entries[owner] && preference(settings(), "allowBypassPermissions") };
      }
      if (key === "remoteControlStayReachable" && value === true && !ctx.remoteReachabilityPreferenceAvailable?.())
        throw Error("Remote Control is unavailable on this host.");
      const map = Object.hasOwn(mapped, key) ? mapped[key] : undefined;
      if (map) {
        // The original desktop client mirrors its account PATCH to this setter.
        if (map.key === "prAutoArchive" && ctx.officialCodeSettingsCloudLinked?.())
          return;
        const current = settings();
        let nextValue = map.write ? map.write(value) : value;
        if (key === "chillingSlothLocation") {
          const location = z.union([z.literal("default"), z.strictObject({ customPath: z.string().max(4096) })]).parse(value);
          if (location === "default") nextValue = "";
          else {
            const folder = location.customPath;
            const absolute = path.resolve(folder);
            if (!host.caller || !path.isAbsolute(folder) || path.parse(absolute).root === absolute || !host.hasFolderSelection(host.caller, folder, "settings"))
              throw Error("Choose a worktree folder with the folder picker.");
            nextValue = folder;
          }
        }
        const next = {
          ...current,
          ...(key === "coworkBrowserToolsEnabled" && current.codeBrowserTools === undefined
            ? { codeBrowserTools: current.browserTools !== false }
            : {}),
          [map.key]: nextValue,
        };
        await account.guard(() => ctx.call("saveSettings", next));
      } else {
        if (
          (key === "launchAutoOpenFiles" ||
            key === "chicagoBackgroundIntroSeen" ||
            key === scheduledTaskPreferenceKeys.code ||
            key === scheduledTaskPreferenceKeys.cowork) &&
          value !== undefined && value !== null
        )
          z.boolean().parse(value);
        if (key === "launchChromeImportPrompt" && value !== undefined && value !== null)
          chromeImportPrompt.parse(value);
        const captured = bucket;
        captured.value = { ...captured.value, [key]: value };
        if (value === undefined || value === null) delete captured.value[key];
        inAdapterScope(captured.scope, () =>
          writeState("preferences", () => captured.value),
        );
      }
      changed();
    });
  host
    .on("AppPreferences.getPreferences", all)
    .on("AppPreferences.setPreference", (key: string, value: unknown) =>
      write(key, value),
    )
    .on("AppFeatures.getSupportedFeatures", () => ({
      ...Object(features),
      wakeScheduler: { status: "unavailable" },
      ...(ctx.computerUseSettingsState && computerUseFeatures(ctx.computerUseSettingsState())),
      ...(ctx.browserAccountsAvailable && { multiAccount: { status: ctx.browserAccountsAvailable() ? "supported" : "unavailable" } }),
    }))
    .on("Startup.isMenuBarEnabled", () => preference(settings(), "menuBar"))
    .on("Startup.setMenuBarEnabled", (enabled: unknown) =>
      write("menuBarEnabled", enabled),
    )
    .on("Startup.isStartupOnLoginEnabled", () =>
      account.run(async () =>
        startupOnLoginEnabled(await account.guard(() => ctx.call("systemState"))),
      ),
    )
    .on("Startup.setStartupOnLoginEnabled", async (value: unknown) => {
      const enabled = z.boolean().parse(value);
      const state = await ctx.call("setRunOnStartup", enabled);
      if (startupOnLoginEnabled(state) !== enabled)
        throw Error("Startup on login could not be changed. Check your computer's startup settings.");
    })
    .on(
      "GlobalShortcut.getGlobalShortcut",
      () => preference(settings(), "quickAccessShortcut"),
    )
    .on("GlobalShortcut.setGlobalShortcut", (accelerator: unknown) =>
      account.run(() => account.guard(() => ctx.call("saveSettings", {
        ...settings(),
        quickAccessShortcut: z.string().max(100).nullable().parse(accelerator) ?? "",
      }))),
    );
  // A Claudex settings change (this window or another) reaches the page.
  const unsubscribe = ctx.onEvent((event) => {
    if (event.type === "settings" || event.type === "policy" || (event.type === "computer-use" && event.changed)) changed();
    if (event.type === "policy" || event.type === "resync") host.emit("AppFeatures", "supportedFeaturesChanged");
  });
  const unsubscribeChrome = ctx.chromeExtension?.onStatusChanged?.(changed);
  const resetChromeImportPrompt = () => account.run(async () => {
    if (bucket.value.launchChromeImportPrompt === "done")
      await write("launchChromeImportPrompt", "pending");
  });
  return {
    dispose: () => {
      unsubscribe();
      unsubscribeChrome?.();
    },
    autoOpenFiles,
    resetChromeImportPrompt,
  };
}
