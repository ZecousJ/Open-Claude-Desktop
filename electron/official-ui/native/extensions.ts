import { createExtensionInstaller } from "./extension-install-request";
/**
 * Extensions (desktop extensions, .mcpb/.dxt), MCP (local MCP servers: the
 * "Local MCP servers" page), AppConfig and FilePickers, on Claudex's desktop
 * extensions ("desktopExtensions", "desktopExtension", "saveDesktopExtension",
 * "uninstallDesktopExtension", "installExtension") and its MCP configuration
 * (settings.mcpServers, saved through "saveSettings", which writes the
 * configuration file too). Official shapes: work/official-native/schema.json
 * (tyt installed extension, eyt settings, s_/iyt server configs).
 */
import { app, dialog, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DesktopExtensionDetails, ExtensionValue } from "../../../shared/desktop-extensions-api";
import type { McpServers } from "../../../shared/settings-desktop-api";
import type { McpLogSnapshot } from "../../../shared/settings-mcp-api";
import type { Settings } from "../../../shared/types";
import type { ClientPolicy } from "../../../shared/client-policy";
import { NativeRefusal, type NativeHost } from "./host";
import {
  createExtensionReads,
  officialExtensionSettings,
  officialLocalMcpServersConfig,
} from "./extensions-read";
import { detectedExtensionRuntimes, extensionCompatibility } from "./extension-compatibility";
import { nativeTranslator } from "../../app/native-i18n";
import { preference } from "../../../shared/settings-extras";

type ServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
};

export function registerExtensions(host: NativeHost) {
  const { ctx } = host;
  const settings = () => ctx.settings();
  const changed = () => host.emit("Extensions", "extensionsChanged");
  const policy = () => ctx.call("clientPolicy") as Promise<ClientPolicy>;

  const reads = createExtensionReads(ctx);
  const directoryUnavailable = () => {
    throw new NativeRefusal(
      "directory_unavailable",
      "The extension directory has been disabled on your computer.",
    );
  };
  const selectedFolders = new WeakMap<object, { identity: unknown; version: number; paths: Set<string> }>();
  const install = createExtensionInstaller(host, async (window) => {
    const current = await policy();
    if (!current.localMcpEditing || current.desktopExtensionsEnabled === false)
      throw Error("Desktop extensions are unavailable.");
    const translate = await nativeTranslator(preference(ctx.settings(), "locale"));
    const result = await dialog.showOpenDialog(window, {
      title: translate("Select extension"),
      buttonLabel: translate("Preview"),
      properties: ["openFile"],
      filters: [{ name: translate("Extensions"), extensions: ["dxt", "mcpb"] }],
    });
    return result.canceled ? undefined : result.filePaths[0];
  }, (window, folder) => {
    const selection = selectedFolders.get(window);
    if (typeof folder !== "string" || !selection || selection.identity !== ctx.sessionIdentity?.() || selection.version !== host.selectionVersion(window) || !selection.paths.delete(folder))
      throw Error("Choose the extension folder again.");
    return folder;
  });
  const withInstallFeedback = async <T,>(kind: "preview" | "install", operation: () => Promise<T>) => {
    const window = host.caller;
    const identity = ctx.sessionIdentity?.();
    try { return await operation(); }
    catch (error) {
      if (!window || window.isDestroyed() || identity !== ctx.sessionIdentity?.() || ctx.isCurrent?.() === false) throw error;
      const translate = await nativeTranslator(preference(ctx.settings(), "locale"));
      const preview = kind === "preview";
      const detail = preview
        ? "The extension couldn't be previewed due to the following error. Please ensure the DXT file is valid and try again. {errorMessage}"
        : "The extension couldn't be installed due to the following error: {errorMessage}";
      await dialog.showMessageBox(window, {
        type: "error",
        title: translate(preview ? "Extension preview failed" : "Extension installation failed"),
        message: translate(preview ? "Couldn't preview extension" : "Couldn't install extension"),
        detail: translate(detail).replace("{errorMessage}", `\n\n${error instanceof Error ? error.message : String(error)}`),
        buttons: [translate("OK")], defaultId: 0,
      });
      return null;
    }
  };

  host
    .on("Extensions.isExtensionsEnabled", async () => (await policy()).desktopExtensionsEnabled !== false)
    .on("Extensions.isLocalExtensionInstallAllowed", async () => {
      const current = await policy();
      return current.desktopExtensionsEnabled !== false && current.localMcpEditing;
    })
    // There is no extension directory to browse, and Claudex does not require signatures.
    .answer(
      false,
      "Extensions.isDirectoryEnabled",
      "Extensions.isDesktopExtensionSignatureRequired",
      "Extensions.isDesktopExtensionDirectoryEnabled",
    )
    .on("Extensions.getDirectoryUrl", directoryUnavailable)
    .on("Extensions.getAvailableExtensionRuntimes", async () =>
      detectedExtensionRuntimes(await ctx.call("extensionTools")),
    )
    .answer(null, "Extensions.getIsUpdateAvailable")
    .on("Extensions.getManifestCompatibilityResult", async (manifest: unknown) => {
      const tools = await ctx.call("extensionTools");
      if (ctx.isCurrent?.() === false) throw Error("This account has changed.");
      return extensionCompatibility(manifest, tools, {
        platform: process.platform,
        appVersion: app.getVersion(),
        builtInNode: (ctx.settings() as Settings).extensionBuiltInNode ?? true,
      });
    })
    .on("Extensions.getInstalledExtensionsWithState", reads.installed)
    .on("Extensions.getExtensionSettings", reads.settings)
    .on(
      "Extensions.setExtensionSettings",
      async (
        id: string,
        next: {
          isEnabled: boolean;
          userConfig?: Record<string, ExtensionValue>;
        },
      ) => {
        const identity = ctx.sessionIdentity?.();
        const serverId = reads.resolve(id);
        const details = (await ctx.call(
          "desktopExtension",
          serverId,
        )) as DesktopExtensionDetails;
        const saved = await ctx.call("saveDesktopExtension", {
          id: serverId,
          revision: details.revision,
          enabled: next.isEnabled,
          values: next.userConfig ?? details.values,
        });
        if (identity !== ctx.sessionIdentity?.() || ctx.isCurrent?.() === false) return;
        host.emit("Extensions", "extensionSettingsChanged", id, officialExtensionSettings(saved));
        changed();
      },
    )
    .on("Extensions.deleteExtension", async (id: string) => {
      const serverId = reads.resolve(id);
      const details = (await ctx.call(
        "desktopExtension",
        serverId,
      )) as DesktopExtensionDetails;
      await ctx.call("uninstallDesktopExtension", {
        id: serverId,
        revision: details.revision,
      });
      changed();
    })
    .on("Extensions.installDxt", (_id: string, file: string) =>
      withInstallFeedback("install", () => install("archive", file)),
    )
    .on("Extensions.installDxtUnpacked", (folder: string) =>
      withInstallFeedback("install", () => install("folder", folder)),
    )
    .on("Extensions.installExtensionFromPreview", (id: string, file: string) =>
      withInstallFeedback("install", () => install.installPreview(id, file)),
    )
    .on("Extensions.handleDxtFile", async (file: string) => {
      const caller = host.caller;
      await withInstallFeedback("preview", async () => {
        const current = await policy();
        if (!current.localMcpEditing || current.desktopExtensionsEnabled === false)
          throw Error("Desktop extensions are unavailable.");
        return install.preview(file, caller);
      });
    })
    .on("Extensions.showInstallDxtDialog", async () => {
      await withInstallFeedback("preview", () => install.preview());
    })
    .on("Extensions.installDxtFromDirectory", directoryUnavailable)
    .on("Extensions.getExtension", directoryUnavailable)
    .on("Extensions.getExtensionVersions", directoryUnavailable)
    .on("Extensions.openExtensionsFolder", () =>
      ctx.call("openExtensionsFolder"),
    )
    .on("Extensions.openExtensionSettingsFolder", () =>
      ctx.call("openExtensionSettingsFolder"),
    )
    .on("Extensions.refreshAllowlistCheck", () => undefined);

  // Local MCP servers (programs on this computer).
  const configs = () => officialLocalMcpServersConfig(settings().mcpServers);
  const withStatus = async () => {
    const states = new Map(
      (
        (await ctx.call(
          "mcpServers",
          Object.keys(configs()).length > 0,
        )) as McpServers
      ).servers.map((s) => [s.name, s]),
    );
    const failures = new Set(
      (
        await Promise.all(
          Object.keys(configs()).map(async (name) => {
            const log = (await ctx
              .call("readMcpLogs", name)
              .catch(() => undefined)) as McpLogSnapshot | undefined;
            return log?.serverOutput?.failed ? name : undefined;
          }),
        )
      ).filter((name): name is string => name !== undefined),
    );
    return Object.fromEntries(
      Object.entries(configs()).map(([name, config]) => {
        const state = states.get(name);
        const status = failures.has(name)
          ? "failed"
          : state?.state === "ready"
            ? "running"
            : state?.state === "starting" ||
                state?.state === "stopped" ||
                state?.state === "disabled"
              ? "initializing"
              : "failed";
        return [
          name,
          {
            ...config,
            status,
            ...(state?.error ? { error: state.error } : {}),
          },
        ];
      }),
    );
  };
  const logs = async (name?: string) => {
    const names = name === undefined ? Object.keys(configs()) : [name];
    const snapshots = await Promise.all(
      names.map(
        async (server) =>
          (await ctx.call("readMcpLogs", server)) as McpLogSnapshot,
      ),
    );
    if (ctx.isCurrent?.() === false) throw Error("This account has changed.");
    const root = ctx.stateDirectory?.();
    if (!root) throw Error("MCP logs are unavailable.");
    const directory = path.join(root, "mcp-log-exports");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const snapshot of snapshots) {
      const output = snapshot.serverOutput;
      const lines = [
        ...snapshot.lines,
        ...(output?.lines ?? []),
        ...(output && output.availability !== "available"
          ? [`Server output: ${output.availability}.`]
          : []),
        ...(snapshot.truncated || output?.truncated
          ? ["Log output truncated."]
          : []),
      ];
      fs.writeFileSync(
        path.join(directory, `${snapshot.name}.log`),
        lines.length ? `${lines.join("\n")}\n` : "No logs available.\n",
        { mode: 0o600 },
      );
    }
    const target =
      name === undefined
        ? directory
        : path.join(directory, `${snapshots[0].name}.log`);
    const error = await shell.openPath(target);
    if (error) throw Error(error);
  };
  host
    .answer(true, "MCP.isLocalDevMcpEnabled")
    .on("MCP.getMcpServersConfig", () => configs())
    .on("MCP.getMcpServersConfigWithStatus", withStatus)
    .on(
      "MCP.setMcpServerConfigs",
      async (next: Record<string, ServerConfig>) => {
        const current = settings();
        const visible = configs();
        const removed = Object.keys(visible).filter(
          (name) => !Object.hasOwn(next, name),
        );
        const unchanged = Object.entries(next).every(([name, value]) => {
          const config = {
            command: value.command,
            args: value.args ?? [],
            ...(value.env ? { env: value.env } : {}),
          };
          return (
            Object.hasOwn(visible, name) &&
            isDeepStrictEqual(config, visible[name])
          );
        });
        if (removed.length && unchanged) {
          for (const name of removed)
            await (ctx.localCall ?? ctx.call)("removeConnector", name);
          host.emit("MCP", "mcpConfigChange", await withStatus());
          return;
        }
        const kept = Object.fromEntries(
          Object.entries(current.mcpServers ?? {}).filter(
            ([name]) => !(name in visible),
          ),
        );
        await ctx.call("saveSettings", {
          ...current,
          mcpServers: { ...kept, ...next },
        });
        host.emit("MCP", "mcpConfigChange", await withStatus());
      },
    )
    .on("MCP.revealConfig", () => ctx.call("openMcpConfig"))
    .on("MCP.revealLogs", () => logs())
    .on("MCP.revealServerLog", (name: string) => logs(name));

  host
    .on("AppConfig.getAppConfig", () => ({
      mcpServers: configs(),
      isUsingBuiltInNodeForMcp:
        (settings() as { extensionBuiltInNode?: boolean })
          .extensionBuiltInNode ?? true,
      isDxtAutoUpdatesEnabled:
        (settings() as { extensionAutoUpdates?: boolean })
          .extensionAutoUpdates ?? true,
    }))
    .on("AppConfig.setIsUsingBuiltInNodeForMcp", (enabled: boolean) =>
      ctx.call("saveSettings", {
        ...settings(),
        extensionBuiltInNode: !!enabled,
      }),
    )
    .on("AppConfig.setIsDxtAutoUpdatesEnabled", (enabled: boolean) =>
      ctx.call("saveSettings", {
        ...settings(),
        extensionAutoUpdates: !!enabled,
      }),
    );

  // The system pickers the settings pages ask for.
  host
    .on("FilePickers.getDirectoryPath", async (multiple?: boolean) => {
      const caller = host.caller;
      const identity = ctx.sessionIdentity?.();
      const version = caller ? host.selectionVersion(caller) : 0;
      const result = await dialog.showOpenDialog(caller ?? host.window!, {
        properties: [
          "openDirectory",
          ...(multiple ? (["multiSelections"] as const) : []),
        ],
      });
      const paths = result.canceled ? [] : result.filePaths;
      if (caller && identity === ctx.sessionIdentity?.() && ctx.isCurrent?.() !== false && host.selectionVersion(caller) === version) {
        selectedFolders.set(caller, { identity, version, paths: new Set(paths) });
        host.recordFolderSelection(caller, paths, "settings");
      }
      return paths;
    })
    .on("FilePickers.getFilePath", async (multiple?: boolean) => {
      const result = await dialog.showOpenDialog(host.caller ?? host.window!, {
        properties: [
          "openFile",
          ...(multiple ? (["multiSelections"] as const) : []),
        ],
      });
      return result.canceled ? [] : result.filePaths;
    });
}
