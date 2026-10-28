import { captureConnectorContext } from "../connectors/connector-owner";
import { discardSessionWorktree } from "../git/code-worktree";
import { app, dialog, Menu, session, shell } from "electron";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import { deviceName } from "../remote-control/device-identity";
import { shortcutChoices } from "../store/settings-preferences";
import { storageUsage } from "../workspace/storage-usage";
import {
  removeConversation,
  StorageCleanup,
} from "../workspace/storage-cleanup";
import { clearWebCaches } from "../support/clear-cache";
import { coworkFolderGrants } from "../workspace/cowork-folders";
import { mcpServerStates } from "../connectors/mcp-config-file";
import { mcpEditingRefusal } from "../../shared/client-policy";
import { quickEntryDictationSupported } from "../app/quick-access";
import {
  installUnpackedExtension,
  unpackedExtensionEntry,
  developerModeFolderBlocked,
} from "../connectors/desktop-extension";
import { developerModeAllowed } from "../store/developer-settings";
import { nativeTranslator } from "../app/native-i18n";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  extensionOpenFailed,
  unpackExtensionArchive,
} from "../connectors/desktop-extension";
import { extensionPolicyNotice } from "../../shared/extension-policy";
import { preference } from "../../shared/settings-extras";
import { ConnectorHistory } from "../connectors/connector-history";
import type { McpServers } from "../../shared/settings-desktop-api";
import {
  notificationAuthorizationStatus,
  requestNotificationAuthorization,
} from "../notification-authorization";
import { desktopNotificationInput } from "../../shared/desktop-notifications-input";
import { registerSettingsConnectorHandlers } from "./settings-desktop-connectors";

/** The words of Clear cache and restart…'s question, from the window. */
const clearCacheQuestion = z
  .object({
    message: z.string().min(1).max(300),
    detail: z.string().max(1000),
    cancel: z.string().min(1).max(60),
    confirm: z.string().min(1).max(60),
  })
  .strict();

/** Handlers behind the desktop and developer Settings pages (System, Cowork files, Developer, Skills). */
export function registerSettingsDesktopHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  let connectorGeneration = 0;
  const connectorTickets = new Map<string, number>();
  let connectorSequence = 0;
  const retireConnectors = () => {
    connectorGeneration++;
    connectorTickets.clear();
  };
  ctx.onAccountDeactivating?.(retireConnectors);
  ctx.onAccountActivated?.(retireConnectors);
  const connectorLease = (key: string, resource: string) => {
    const operation = ++connectorSequence;
    connectorTickets.set(key, operation);
    while (connectorTickets.size > 1024)
      connectorTickets.delete(connectorTickets.keys().next().value!);
    const configuration = ctx.store.settings.mcpServers;
    const scope = captureConnectorContext(() => ({
      accountId: ctx.activeAccount?.id,
      store: ctx.store,
      engine: ctx.engine,
      remote: ctx.remote,
      generation: connectorGeneration,
      operation: connectorTickets.get(key) ?? -1,
      // Configuration changes made by this operation are accepted after its commit.
      // Writers separately assert the original map before any mutation below.
      configuration,
      origin: ctx.remote?.accounts.baseUrl ?? "local",
      resource,
    }));
    scope.assertCurrent();
    return {
      ...scope,
      configuration,
      async wait<T>(promise: Promise<T>): Promise<T> {
        try {
          const value = await promise;
          scope.assertCurrent();
          return value;
        } catch (error) {
          scope.assertCurrent();
          throw error;
        }
      },
    };
  };
  // Settings → System → Storage.
  handle("storageUsage", () =>
    storageUsage({
      root: ctx.store.root,
      dataRoot: ctx.dataRoot,
      conversations: ctx.store.conversations,
      logFolders: ["logs", "crashDumps"].flatMap((name) => {
        try {
          return [app.getPath(name as "logs" | "crashDumps")];
        } catch {
          return [];
        }
      }),
    }),
  );
  let clearing: Promise<boolean> | undefined;
  handle("clearCacheAndRestart", (raw: unknown) => {
    const question = clearCacheQuestion.parse(raw);
    clearing ??= (async () => {
      // The system's question over the window that asked, Cancel first and the
      // default.
      const window = ctx.callerWindow();
      const options = {
        type: "question" as const,
        message: question.message,
        detail: question.detail,
        buttons: [question.cancel, question.confirm],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const { response } = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      if (response !== 1) return false;
      await clearWebCaches(session.defaultSession);
      app.relaunch();
      app.quit();
      return true;
    })().finally(() => {
      clearing = undefined;
    });
    return clearing;
  });
  const cleanup = new StorageCleanup({
    get root() {
      return ctx.store.root;
    },
    conversations: () => ctx.store.conversations,
    removeWorktree: (conversation) =>
      conversation.worktree
        ? discardSessionWorktree(conversation.worktree)
        : Promise.resolve(),
    remove: (conversation, rollouts) =>
      removeConversation(
        {
          root: ctx.store.root,
          store: ctx.store,
          rpc:
            ctx.engine.rpc && ctx.engine.state.state === "ready"
              ? ctx.engine.rpc
              : undefined,
          closeTerminals: async (id) => {
            await ctx.terminals?.closeConversation(id);
          },
          attachmentsInUse: () =>
            [...ctx.selectedAttachments.values()].map((file) => file.path),
          forget: async (id) => {
            ctx.replyFeedback.deleteConversation(id);
            coworkFolderGrants(ctx.store.root).forgetConversation(id);
            await ctx.services.computerUse
              ?.deleteConversation(id)
              .catch(() => {});
          },
        },
        conversation,
        rollouts,
      ),
    finished: () => {
      // Generated-file snapshots only the deleted conversations showed.
      try {
        ctx.artifactLibrary.tidy();
      } catch {
        // Collected the next time the account opens.
      }
      ctx.push({ type: "resync" });
    },
  });
  handle("previewStorageCleanup", (rawKind: unknown, rawDays: unknown) =>
    cleanup.preview(
      z.enum(["cowork", "code"]).parse(rawKind),
      z.union([z.literal(30), z.literal(60), z.literal(90)]).parse(rawDays),
    ),
  );
  handle("runStorageCleanup", (rawToken: unknown, rawOptions: unknown) => {
    const token = z.string().uuid().parse(rawToken);
    const options = z
      .object({ deleteSessions: z.boolean().optional() })
      .strict()
      .optional()
      .parse(rawOptions);
    return cleanup.run(token, options ?? {}, (done, total) =>
      ctx.push({ type: "storage-cleanup-progress", done, total }),
    );
  });
  handle("cancelStorageCleanup", () => cleanup.cancel());
  const system = () => ({
    quickEntryDictation: quickEntryDictationSupported(),
    customQuickEntryDictationShortcut: quickEntryDictationSupported(),
    runOnStartup:
      process.platform === "linux"
        ? null
        : app.getLoginItemSettings().openAtLogin,
    shortcutChoices: shortcutChoices(process.platform),
    nativeQuickEntry: {
      status: process.platform === "darwin" ? "supported" : "unsupported",
    },
    trayIcon: ctx.integration?.trayIconStatus?.() ?? "supported",
    dataFolder: ctx.store.root,
    deviceName: deviceName(),
  });
  handle("systemState", system);
  handle("getNotificationAuthorizationStatus", notificationAuthorizationStatus);
  handle("requestNotificationAuthorization", requestNotificationAuthorization);
  handle("openNotificationSettings", async () => {
    if (process.platform === "darwin")
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
      );
    else if (process.platform === "win32")
      await shell.openExternal("ms-settings:notifications");
  });
  handle("supportsNotificationActions", () =>
    ctx.integration.supportsNotificationActions(),
  );
  handle("showDesktopNotification", (raw: unknown) => {
    const input = desktopNotificationInput.parse(raw);
    const window = ctx.callerWindow();
    ctx.integration.showNotification(input, (event) => {
      if (window && !window.isDestroyed()) ctx.appWindows.send(window, event);
    });
  });
  handle("setProjectPromptsWaiting", (raw: unknown) => {
    const window = ctx.callerWindow();
    if (window)
      ctx.integration.setProjectPromptsWaiting(
        window.webContents,
        z.number().parse(raw),
      );
  });
  handle("openQuickEntry", () => ctx.integration.openQuickEntry());
  handle("showAppMenu", (x: unknown, y: unknown) => {
    const point = z.number().finite().min(0).max(100_000);
    const window = ctx.callerWindow() ?? ctx.window;
    Menu.getApplicationMenu()?.popup({
      window,
      x: Math.round(point.parse(x)),
      y: Math.round(point.parse(y)),
    });
  });
  handle("setRunOnStartup", (raw: unknown) => {
    if (process.platform === "linux")
      throw Error("Run on startup isn't available on Linux.");
    app.setLoginItemSettings({ openAtLogin: z.boolean().parse(raw) });
    return system();
  });
  handle("revealDataFolder", async () => {
    const failure = await shell.openPath(ctx.store.root);
    if (failure) throw Error(failure);
  });
  handle("openMcpConfig", async () => {
    const config = ctx.mcpConfig;
    if (!config) throw Error("Sign in to edit MCP servers.");
    // The file would only record edits the policy then refuses to apply.
    if (!ctx.policy().localMcpEditing)
      throw Error(mcpEditingRefusal(ctx.policy()));
    config.ensure();
    const failure = await shell.openPath(config.path);
    // Without a default editor for .json, show the file instead.
    if (failure) shell.showItemInFolder(config.path);
  });
  handle("installUnpackedExtension", async () => {
    ctx.noActive();
    const root = ctx.store.root;
    const translate = await nativeTranslator(
      preference(ctx.store.settings, "locale"),
    );
    if (ctx.policy().desktopExtensionsEnabled === false)
      throw new Error(translate(extensionPolicyNotice(ctx.policy())!));
    if (!developerModeAllowed(ctx.policy()))
      throw new Error(translate(developerModeFolderBlocked));
    if (!ctx.policy().localMcpEditing)
      throw new Error(mcpEditingRefusal(ctx.policy()));
    const picked = await dialog.showOpenDialog(ctx.window!, {
      properties: ["openDirectory"],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    if (root !== ctx.store.root)
      throw new Error("Couldn’t install the extension. Try again.");
    const extension = unpackedExtensionEntry(picked.filePaths[0]);
    const confirmation = await dialog.showMessageBox(ctx.window!, {
      type: "question",
      title: translate("Install Extension?"),
      message: translate("Do you want to install {extensionName}?").replace(
        "{extensionName}",
        extension.name,
      ),
      detail: translate(
        "This desktop extension will be installed on your computer and made available to Claudex.",
      ),
      buttons: [translate("Install"), translate("Cancel")],
      defaultId: 1,
      cancelId: 1,
    });
    if (confirmation.response !== 0) return null;
    if (root !== ctx.store.root)
      throw new Error("Couldn’t install the extension. Try again.");
    const config = ctx.mcpConfig;
    if (!config) throw new Error("Sign in to edit MCP servers.");
    try {
      return installUnpackedExtension({
        source: picked.filePaths[0],
        root: ctx.store.root,
        allowed: () =>
          developerModeAllowed(ctx.policy()) &&
          ctx.policy().localMcpEditing &&
          ctx.policy().desktopExtensionsEnabled !== false,
        current: ctx.store.settings.mcpServers,
        update: (servers) => config.update(servers),
      });
    } catch (error) {
      throw new Error(
        translate(error instanceof Error ? error.message : String(error)),
      );
    }
  });
  handle("installExtension", async (raw: unknown) => {
    ctx.noActive();
    const root = ctx.store.root;
    const translate = await nativeTranslator(
      preference(ctx.store.settings, "locale"),
    );
    const allowed = () =>
      root === ctx.store.root &&
      ctx.policy().localMcpEditing &&
      ctx.policy().desktopExtensionsEnabled !== false;
    if (!allowed())
      throw new Error(
        translate(
          extensionPolicyNotice(ctx.policy()) ??
            mcpEditingRefusal(ctx.policy()),
        ),
      );
    let source: string | undefined;
    try {
      let file: { name: string; data: Buffer };
      if (raw === undefined) {
        const picked = await dialog.showOpenDialog(ctx.window!, {
          properties: ["openFile"],
          filters: [
            { name: translate("Extensions"), extensions: ["mcpb", "dxt"] },
          ],
        });
        if (picked.canceled || !picked.filePaths[0]) return null;
        const filePath = picked.filePaths[0];
        if (fs.statSync(filePath).size > 100 * 1024 * 1024)
          throw new Error(extensionOpenFailed);
        file = {
          name: path.basename(filePath),
          data: fs.readFileSync(filePath),
        };
      } else {
        const input = z
          .object({
            name: z.string().max(255),
            data: z
              .instanceof(Uint8Array)
              .refine((value) => value.byteLength <= 100 * 1024 * 1024),
          })
          .strict()
          .parse(raw);
        file = { name: input.name, data: Buffer.from(input.data) };
      }
      if (!/\.(mcpb|dxt)$/i.test(file.name) || !allowed())
        throw new Error(extensionOpenFailed);
      source = unpackExtensionArchive(file.data, os.tmpdir());
      const extension = unpackedExtensionEntry(source);
      const confirmation = await dialog.showMessageBox(ctx.window!, {
        type: "question",
        title: translate("Install Extension?"),
        message: translate("Do you want to install {extensionName}?").replace(
          "{extensionName}",
          extension.name,
        ),
        detail: translate(
          "This desktop extension will be installed on your computer and made available to Claudex.",
        ),
        buttons: [translate("Install"), translate("Cancel")],
        defaultId: 1,
        cancelId: 1,
      });
      if (confirmation.response !== 0) return null;
      if (!allowed() || !ctx.mcpConfig) throw new Error(extensionOpenFailed);
      return installUnpackedExtension({
        source,
        root,
        allowed,
        current: ctx.store.settings.mcpServers,
        update: (servers) => ctx.mcpConfig!.update(servers),
      });
    } catch {
      throw new Error(translate(extensionOpenFailed));
    } finally {
      if (source) fs.rmSync(source, { recursive: true, force: true });
    }
  });
  const openExtensionFolder = async (folder: string) => {
    const target = path.join(ctx.store.root, folder);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const failure = await shell.openPath(target);
    if (failure) throw new Error(failure);
  };
  handle("openExtensionsFolder", () =>
    openExtensionFolder("desktop-extensions"),
  );
  handle("openExtensionSettingsFolder", () =>
    openExtensionFolder("desktop-extension-settings"),
  );
  handle("extensionTools", async () => {
    const detect = async (command: string) => {
      try {
        const { stdout, stderr } = await promisify(execFile)(
          command,
          ["--version"],
          { timeout: 5000 },
        );
        return [(stdout || stderr).trim()];
      } catch {
        return [];
      }
    };
    const [node, python] = await Promise.all([
      detect("node"),
      detect(process.platform === "win32" ? "python" : "python3"),
    ]);
    return [
      {
        name: "Node.js",
        versions: node,
        builtInVersion: process.versions.node,
      },
      { name: "Python", versions: python, builtInVersion: null },
    ];
  });
  let history: ConnectorHistory | undefined;
  let historyRoot: string | undefined;
  const connectorHistory = () => {
    if (!history || historyRoot !== ctx.store.root) {
      historyRoot = ctx.store.root;
      history = new ConnectorHistory(historyRoot);
    }
    return history;
  };
  const mcpServers = async (): Promise<McpServers> => {
    const store = ctx.store,
      engine = ctx.engine,
      rpc = engine.rpc,
      file = ctx.mcpConfig;
    const lease = captureConnectorContext(() => ({
      accountId: ctx.activeAccount?.id,
      store: ctx.store,
      engine: ctx.engine,
      remote: ctx.remote,
      generation: connectorGeneration,
      operation: 0,
      configuration: ctx.store.settings.mcpServers,
      origin: ctx.remote?.accounts.baseUrl ?? "local",
      resource: "mcp-status",
    }));
    lease.assertCurrent();
    let live: {
      name: string;
      tools?: Record<string, unknown>;
      authStatus?: string;
    }[] = [];
    try {
      if (rpc && engine.state.state === "ready") {
        const result = await rpc.call("mcpServerStatus/list", {});
        lease.assertCurrent();
        if (
          !Array.isArray(result?.data) ||
          !result.data.every(
            (item: unknown) =>
              item &&
              typeof item === "object" &&
              typeof (item as { name?: unknown }).name === "string",
          )
        )
          throw Error("The connector returned an invalid server list.");
        live = result.data;
      }
      lease.assertCurrent();
      if (ctx.mcpConfig !== file || engine.rpc !== rpc)
        throw Error(
          "This connector operation belongs to a retired account or connector. Open it again.",
        );
      const servers = mcpServerStates(
        store.settings.mcpServers,
        engine.state.state === "ready",
        engine.mcpStartup,
        live,
      );
      return {
        servers: connectorHistory().states(servers),
        configError: file?.error,
        configPath: file?.path ?? "",
      };
    } catch (error) {
      lease.assertCurrent();
      throw error;
    }
  };
  registerSettingsConnectorHandlers({
    connectorHistory,
    connectorLease,
    ctx,
    handle,
    mcpServers,
  });
}
