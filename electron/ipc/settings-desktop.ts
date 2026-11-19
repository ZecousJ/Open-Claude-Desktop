import { ConnectorClients } from "../connectors/connector-clients";
import { connectorAuthRejected } from "../connectors/connector-auth-rejection";
import { desktopConnectorAuthStatus } from "../connectors/connector-auth";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { takePickedExtensionFolder } from "../connectors/extension-picked-folder";
import { readPickedExtensionArchive } from "../connectors/extension-picked-archive";
import { captureExtensionInstallLease } from "../connectors/extension-install-lease";
import { captureConnectorContext } from "../connectors/connector-owner";
import { discardSessionWorktree } from "../git/code-worktree";
import { app, dialog, Menu, session, shell } from "electron";
import * as electron from "electron";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
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
  openNotificationSettings,
  requestNotificationAuthorization,
} from "../notification-authorization";
import { desktopNotificationInput } from "../../shared/desktop-notifications-input";
import { registerSettingsConnectorHandlers } from "./settings-desktop-connectors";
import { officialExtensionId, type ExtensionSource } from "../connectors/extension-identity";
import { ensureExtensionUv } from "../connectors/extension-uv-runtime";

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
  prepareUpgrade?: Parameters<typeof installUnpackedExtension>[0]["prepareUpgrade"],
  publishExtensionServers?: (servers: Record<string, unknown>) => void,
  prepareExtensionMaintenance?: () => Promise<() => void>,
) {
  const isExtensionUpgrade = (manifest: { name: string; author?: { name?: string } }, source: ExtensionSource, fallback: string) => {
    const id = officialExtensionId(manifest, source);
    if (Object.values(ctx.store.settings.mcpServers).some(value =>
        !!value && typeof value === "object" && (value as Record<string, unknown>).claudex_extension_id === id,
      )) return true;
    const legacy = ctx.store.settings.mcpServers[fallback] as Record<string, unknown> | undefined;
    if (!legacy || legacy.claudex_extension_id || typeof legacy.claudex_extension !== "string") return false;
    try {
      const old = JSON.parse(fs.readFileSync(path.join(legacy.claudex_extension, "manifest.json"), "utf8"));
      return old.name === manifest.name && (old.author?.name ?? "") === (manifest.author?.name ?? "");
    } catch { return false; }
  };
  const canRetireExtension = (_name: string, previous: string) => {
    try {
      if (!ctx.mcpConfig) return false;
      const disk = JSON.parse(fs.readFileSync(ctx.mcpConfig.path, "utf8"));
      if (!disk?.mcpServers || typeof disk.mcpServers !== "object") return false;
      const oldDirectory = fs.realpathSync(previous);
      return [ctx.store.settings.mcpServers, disk.mcpServers].every(servers =>
        Object.values(servers).every(value => {
          const location = (value as { claudex_extension?: unknown })?.claudex_extension;
          if (typeof location !== "string") return true;
          try { return fs.realpathSync(location) !== oldDirectory; } catch { return path.resolve(location) !== path.resolve(previous); }
        }),
      );
    } catch { return false; }
  };
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
  // Settings → System → Storage (live claude.ai bundle, 2026-10-12).
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
      // The system's question over the window that asked, Cancel first and
      // the default (desktop bundle in the live claude.ai crawl, 2026-10-12).
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
  const loginItem = { path: process.execPath, args: [] };
  const runOnStartup = () => {
    if (process.platform === "linux") return null;
    const login = app.getLoginItemSettings(loginItem);
    return process.platform === "win32"
      ? login.executableWillLaunchAtLogin
      : login.openAtLogin;
  };
  const system = () => ({
    quickEntryDictation: quickEntryDictationSupported(),
    customQuickEntryDictationShortcut: quickEntryDictationSupported(),
    runOnStartup: runOnStartup(),
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
  handle("openNotificationSettings", openNotificationSettings);
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
    const enabled = z.boolean().parse(raw);
    // Electron's default Windows AppUserModelID also identifies existing Claudex login items.
    app.setLoginItemSettings({ ...loginItem, openAtLogin: enabled, enabled });
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
  const pendingExtensionInstalls = new Set<NonNullable<AppContext["window"]>>();
  const withExtensionInstall = async <T>(
    run: (
      lease: ReturnType<typeof captureExtensionInstallLease>,
      parent: NonNullable<AppContext["window"]>,
    ) => Promise<T>,
  ): Promise<T> => {
    const parent = ctx.callerWindow?.() ?? ctx.window;
    if (!parent)
      throw Error("Open extension settings again before installing.");
    if (pendingExtensionInstalls.has(parent))
      throw Error("An extension installation is already open in this window.");
    const lease = captureExtensionInstallLease(() => ({
      accountId: ctx.activeAccount?.id,
      store: ctx.store,
      generation: connectorGeneration,
      window: ctx.callerWindow?.() ?? ctx.window,
    }));
    pendingExtensionInstalls.add(parent);
    try {
      return await run(lease, parent);
    } finally {
      lease.dispose();
      pendingExtensionInstalls.delete(parent);
    }
  };
  handle("installUnpackedExtension", (selection: unknown) =>
    withExtensionInstall(async (lease, parent) => {
      ctx.noActive();
      const root = ctx.store.root;
      const translate = await lease.wait(
        nativeTranslator(preference(ctx.store.settings, "locale")),
      );
      if (ctx.policy().desktopExtensionsEnabled === false)
        throw new Error(translate(extensionPolicyNotice(ctx.policy())!));
      if (!developerModeAllowed(ctx.policy()))
        throw new Error(translate(developerModeFolderBlocked));
      if (!ctx.policy().localMcpEditing)
        throw new Error(mcpEditingRefusal(ctx.policy()));
      const selected = selection === undefined ? undefined : takePickedExtensionFolder(selection);
      if (selection !== undefined && !selected) throw Error("Choose the extension folder again.");
      const picked = selected ? { canceled: false, filePaths: [selected] } : await lease.wait(
        dialog.showOpenDialog(parent, {
          title: translate("Choose the extension folder to install"),
          properties: ["openDirectory"],
        }),
      );
      if (picked.canceled || !picked.filePaths[0]) return null;
      if (!lease.current() || root !== ctx.store.root)
        throw new Error("Couldn’t install the extension. Try again.");
      const extension = unpackedExtensionEntry(picked.filePaths[0]);
      const manifest = JSON.parse(fs.readFileSync(path.join(picked.filePaths[0], "manifest.json"), "utf8"));
      const confirmation = await lease.wait(
        dialog.showMessageBox(parent, {
          type: "question",
          title: translate("Install Extension?"),
          message: translate("Do you want to install {extensionName}?").replace(
            "{extensionName}",
            manifest.display_name || manifest.name,
          ),
          detail: manifest.server?.type === "uv"
            ? "This desktop extension will be installed on your computer. In order to install this extension we need to fetch a few dependencies. This may take a few minutes."
            : translate("This desktop extension will be installed on your computer and made available to Claudex."),
          buttons: [translate("Install"), translate("Cancel")],
          defaultId: 1,
          cancelId: 1,
        }),
      );
      if (confirmation.response !== 0) return null;
      if (!lease.current() || root !== ctx.store.root)
        throw new Error("Couldn’t install the extension. Try again.");
      const uvExecutable = manifest.server?.type === "uv" ? await lease.wait(ensureExtensionUv(app.getPath("userData"), (url, init) => electron.net.fetch(url, init))) : undefined;
      const upgrade = isExtensionUpgrade(manifest, "local.unpacked", extension.name);
      const release = upgrade ? await prepareExtensionMaintenance?.() : undefined;
      try {
        if (upgrade && !release)
          throw new Error("Extension maintenance is unavailable.");
        lease.assertCurrent();
        const config = ctx.mcpConfig;
        if (!config) throw new Error("Sign in to edit MCP servers.");
        return installUnpackedExtension({
          source: picked.filePaths[0],
          root: ctx.store.root,
          allowed: () =>
            lease.current() &&
            developerModeAllowed(ctx.policy()) &&
            ctx.policy().localMcpEditing &&
            ctx.policy().desktopExtensionsEnabled !== false,
          current: ctx.store.settings.mcpServers,
          prepareUpgrade,
          retirePrevious: canRetireExtension,
          sourceKind: "local.unpacked",
          uvExecutable,
          update: (servers) => publishExtensionServers ? publishExtensionServers(servers) : config.update(servers),
        });
      } catch (error) {
        throw new Error(
          translate(error instanceof Error ? error.message : String(error)),
        );
      } finally {
        release?.();
      }
    }),
  );
  handle("installExtension", (raw: unknown) =>
    withExtensionInstall(async (lease, parent) => {
      ctx.noActive();
      const root = ctx.store.root;
      const translate = await lease.wait(
        nativeTranslator(preference(ctx.store.settings, "locale")),
      );
      const allowed = () =>
        lease.current() &&
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
          const picked = await lease.wait(
            dialog.showOpenDialog(parent, {
              title: translate("Choose the extension package to install"),
              properties: ["openFile"],
              filters: [
                { name: translate("Extensions"), extensions: ["mcpb", "dxt"] },
              ],
            }),
          );
          if (picked.canceled || !picked.filePaths[0]) return null;
          file = readPickedExtensionArchive(picked.filePaths[0]);
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
        const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
        const sourceKind = file.name.toLowerCase().endsWith(".dxt") ? "local.dxt" : "local.mcpb";
        const confirmation = await lease.wait(
          dialog.showMessageBox(parent, {
            type: "question",
            title: translate("Install Extension?"),
            message: translate(
              "Do you want to install {extensionName}?",
            ).replace("{extensionName}", manifest.display_name || manifest.name),
          detail: manifest.server?.type === "uv"
            ? "This desktop extension will be installed on your computer. In order to install this extension we need to fetch a few dependencies. This may take a few minutes."
            : translate("This desktop extension will be installed on your computer and made available to Claudex."),
            buttons: [translate("Install"), translate("Cancel")],
            defaultId: 1,
            cancelId: 1,
          }),
        );
        if (confirmation.response !== 0) return null;
        if (!allowed() || !ctx.mcpConfig) throw new Error(extensionOpenFailed);
        const uvExecutable = manifest.server?.type === "uv" ? await lease.wait(ensureExtensionUv(app.getPath("userData"), (url, init) => electron.net.fetch(url, init))) : undefined;
        const upgrade = isExtensionUpgrade(manifest, sourceKind, extension.name);
        const release = upgrade ? await prepareExtensionMaintenance?.() : undefined;
        try {
          if (upgrade && !release) throw new Error("Extension maintenance is unavailable.");
          lease.assertCurrent();
          return installUnpackedExtension({
            source,
            root,
            allowed,
            current: ctx.store.settings.mcpServers,
            prepareUpgrade,
            retirePrevious: canRetireExtension,
            sourceKind,
            uvExecutable,
            update: (servers) => publishExtensionServers ? publishExtensionServers(servers) : ctx.mcpConfig!.update(servers),
          });
        } finally {
          release?.();
        }
      } catch {
        throw new Error(translate(extensionOpenFailed));
      } finally {
        if (source) fs.rmSync(source, { recursive: true, force: true });
      }
    }),
  );
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
  const mcpServers = async (startLocal = false, refreshName?: string): Promise<McpServers> => {
    if (startLocal && ctx.engine.state.state === "stopped") {
      const provider = ctx.store.settings.providers.find(
        (entry) => entry.id === ctx.store.settings.activeProviderId,
      );
      if (!provider) throw Error("No active provider is available.");
      await ctx.engine.ensure(provider);
    }
    if (refreshName && ctx.engine.state.state === "starting") await ctx.engine.starting;
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
      serverInfo?: unknown;
    }[] = [];
    const connecting = () => {
      const signingIn = Object.entries(store.settings.mcpServers).flatMap(([name, configured]) => {
        const server = configured as { url?: string; enabled?: boolean } | undefined;
        return server?.url && server.enabled !== false && connectorAllowed(ctx.policy(), name, server) &&
          desktopConnectorAuthStatus(ctx, name, server.url) === "connected" ? [name] : [];
      });
      if (!signingIn.length || engine.state.state === "error") return false;
      if (engine.state.state !== "ready") return true;
      const started = JSON.parse(engine.startedMcpServers || "{}");
      const expected = JSON.parse(engine.mcpConfig());
      return signingIn.some(name => Object.hasOwn(expected, name) &&
        !isDeepStrictEqual(started[name], expected[name]));
    };
    try {
      if (file?.readCatalog) {
        const result = await file.readCatalog(refreshName);
        lease.assertCurrent();
        if (ctx.mcpConfig !== file) throw Error("The connector configuration changed.");
        return { ...result, servers: connectorHistory().states(result.servers) };
      }
      if (connecting()) throw Error("The connector runtime is starting.");
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
        if (refreshName) {
          const refreshed = live.find((entry) => entry.name === refreshName);
          if (!refreshed?.serverInfo) throw Error("Connector tools are unavailable.");
        }
      } else if (refreshName) {
        throw Error("The connector runtime is unavailable.");
      }
      lease.assertCurrent();
      if (ctx.mcpConfig !== file || engine.rpc !== rpc)
        throw Error(
          "This connector operation belongs to a retired account or connector. Open it again.",
        );
      if (connecting()) throw Error("The connector runtime is starting.");
      const startup = new Map(engine.mcpStartup);
      for (const server of live)
        if (server.serverInfo) startup.delete(server.name);
      const servers = mcpServerStates(
        store.settings.mcpServers,
        engine.state.state === "ready",
        startup,
        live,
      );
      const credentials = new ConnectorClients(store.root);
      for (const server of servers) {
        if (!server.url || server.state === "disabled") continue;
        const client = credentials.get(server.name, server.url);
        const oauthStatus = client?.staticAuth
          ? undefined
          : desktopConnectorAuthStatus(ctx, server.name, server.url);
        if (oauthStatus) server.oauthStatus = oauthStatus;
        if (client?.staticAuth && server.authStatus === "notLoggedIn") {
          server.state = "failed";
          delete server.authStatus;
        } else if (client?.staticAuth && server.state === "ready" && live.some((item) => item.name === server.name)) {
          server.authStatus = "staticHeaders";
        } else if (server.oauthStatus === "reconnect" || server.oauthStatus === "disconnected" ||
          (client?.oauth?.posture === "auth_required" && !engine.connectorHeaders?.(server.name)?.Authorization)) {
          server.authStatus = "notLoggedIn";
          server.state = "stopped";
          server.tools = 0;
          server.toolList = [];
        } else if (client?.oauth?.posture === "defer_auth") {
          const authenticated = Boolean(engine.connectorHeaders?.(server.name)?.Authorization) ||
            server.authStatus === "oAuth" || server.authStatus === "bearerToken";
          if (connectorAuthRejected(store, server.name, server.url, authenticated))
            server.authStatus = "notLoggedIn";
          else if (!authenticated && server.state === "ready" && server.tools > 0)
            server.authStatus = "unsupported";
        }
      }
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
