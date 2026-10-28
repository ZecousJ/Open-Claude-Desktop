/**
 * The Code Browser panels of the signed-in account (R8): builds the
 * BrowserHost on Electron, keeps it in step with Settings and the policy,
 * closes it at sign-out, and publishes it as `ctx.services.browser` for the
 * other R8 parts (dev servers R8-B, the Browser MCP tools R8-C, links in
 * the built-in browser R8-E).
 *
 * `electron/ipc/panels.ts` loads this file on demand, so the IPC domain can
 * be tested without Electron.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { previewLinkRouter } from "../artifacts/preview-link-routing";
import { hostBlocked } from "../../shared/browser";
import type { ChromeImport } from "./chrome-import";
import { PreviewPages } from "./preview-pages";
import {
  app,
  BaseWindow,
  BrowserWindow,
  dialog,
  session as electronSession,
  shell,
  systemPreferences,
  WebContentsView,
} from "electron";
import type { AppContext } from "../app/app-context";
import type { BrowserPanelDeps } from "../ipc/panels";
import {
  type BrowserKeepCookies,
  type BrowserNavigateResult,
  type DevServerState,
  type LaunchConfiguration,
  keepCookiesOf,
} from "../../shared/browser";
import type { Settings } from "../../shared/types";
import { preference } from "../../shared/settings-extras";
import { nativeTranslator } from "../app/native-i18n";
import { previewOriginUnsafe } from "../../shared/preview-origin";
import { paneKeyCommand, pageReloadKey } from "../../shared/pane-keys";
import {
  BrowserHost,
  type BrowserPlatform,
  type HostView,
  type ParkingWindow,
} from "./browser-host";
import { DevServers, type DevServerStartOptions } from "./dev-servers";
import {
  BrowserPartitions,
  partitionName,
  perSessionPrefix,
  previewPartitionName,
} from "./partitions";

/**
 * Dev servers of a conversation's folder (`DevServers`, R8-B), handed to
 * `attachDevServers` when the Browser service starts. Without it the panel
 * shows no dev server controls (`devServersAvailable` is false).
 */
export interface DevServersPort {
  list(conversationId: string): DevServerState[];
  launchConfig(conversationId: string): { path?: string; error?: string };
  detect(conversationId: string): Promise<LaunchConfiguration[]>;
  save(conversationId: string, config: LaunchConfiguration): Promise<void>;
  /** The project's Auto-verify choice in launch.json, if it has one. */
  autoVerify?(conversationId: string): boolean | undefined;
  setAutoVerify?(conversationId: string, on: boolean): Promise<void>;
  /**
   * Starts a configuration. The panel's calls come from a person who
   * confirmed; Claude's Browser tools (R8-C) pass `{ by: "claude", approve }`.
   */
  start(
    conversationId: string,
    name: string,
    options?: DevServerStartOptions,
  ): Promise<DevServerState>;
  /** Whether Claude starting `name` now would ask the person first. */
  needsApproval?(conversationId: string, name: string): boolean;
  stop(conversationId: string, name: string): Promise<void>;
  logs(conversationId: string, name: string, lines?: number): Promise<string[]>;
  /** Runs `cb` with the conversation whose servers changed; returns the unsubscribe. */
  onChange(cb: (conversationId: string) => void): () => void;
  /** Stops every server (sign-out). */
  dispose(): void | Promise<void>;
}

/** The administrator's Browser settings; missing means allowed. */
export interface BrowserPolicy {
  enabled?: boolean;
  externalSites?: boolean;
  allowScript?: boolean;
  blockedDomains?: string[];
  devServers?: boolean;
}

export interface BrowserService {
  readonly host: BrowserHost;
  /** Browser tools are on in Settings and allowed by the administrator. */
  toolsAvailable(): boolean;
  /** The administrator's Browser settings now. */
  policy(): BrowserPolicy;
  blockedDomains(): readonly string[];
  keepCookies(): BrowserKeepCookies;
  /** Opens `url` in a new foreground tab of a Code conversation's panel (links, R8-E). */
  openUrl(conversationId: string, url: string): BrowserNavigateResult;
  /** Connects the dev servers (R8-B); returns the disconnect. */
  attachDevServers(port: DevServersPort): () => void;
  devServers(): DevServersPort | undefined;
  /** Clear browsing data for the Keep cookies choice in use; open pages reload. */
  clearBrowsingData(conversationId?: string): Promise<void>;
  clearPreviewData(): Promise<void>;
  clearCoworkBrowserData?(): Promise<boolean>;
  chromeImport?(): Promise<ChromeImport>;
  /** The system's default browser ("Google Chrome"), or null. */
  defaultBrowserName(): string | null;
}

declare module "../app/app-context" {
  interface BrowserSlot extends BrowserService {}
}

let partitions: BrowserPartitions | undefined;
let host: BrowserHost | undefined;
let parked: BaseWindow | undefined;

/**
 * The hidden window pages wait in while they are not on screen. It is a
 * BaseWindow, so `BrowserWindow.getAllWindows()` never lists it, and it
 * closes with the main window so the app still quits when its last window
 * closes.
 */
function parkingWindow(ctx: AppContext): BaseWindow {
  if (parked && !parked.isDestroyed()) return parked;
  const window = new BaseWindow({
    show: false,
    width: 1024,
    height: 768,
    skipTaskbar: true,
    focusable: false,
    title: "Claudex browser",
  });
  parked = window;
  window.on("closed", () => {
    if (parked === window) parked = undefined;
  });
  const main = ctx.appWindows.main();
  if (main) main.once("closed", () => closeParking());
  else closeParking();
  return window;
}

function closeParking() {
  const window = parked;
  parked = undefined;
  if (window && !window.isDestroyed()) window.destroy();
}

function sharedPartitions(ctx: AppContext) {
  partitions ??= new BrowserPartitions({
    fromPartition: (name) => electronSession.fromPartition(name),
    partitionsDir: BrowserPartitions.folder(app.getPath("userData")),
    blockedDomains: () => browserPolicy(ctx).blockedDomains ?? [],
    downloadRefused: (contents, filename) =>
      host?.noteDownloadRefused(contents, filename),
  });
  return partitions;
}

export function browserPolicy(ctx: Pick<AppContext, "policy">): BrowserPolicy {
  const policy = ctx.policy() as { browser?: BrowserPolicy };
  return policy.browser ?? {};
}

function settingsOf(
  ctx: AppContext,
): Partial<Settings> & Record<string, unknown> {
  try {
    return ctx.store.settings as Partial<Settings> & Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Settings → Claude Code → Browser → Browser tools (R8-E); on unless turned off. */
export function browserToolsSetting(settings: Record<string, unknown>) {
  return settings.browserTools !== false;
}

/**
 * Starts the Browser service of the signed-in account and sets
 * `ctx.services.browser`. It closes itself (pages, dev servers) when the
 * account signs out.
 */
export function createBrowserFeature(ctx: AppContext): BrowserService {
  const existing = ctx.services.browser;
  if (existing) return existing;
  const account = ctx.activeAccount;
  if (!account) throw new Error("Sign in to use the browser.");
  const profileRoot = ctx.store.root;
  const jars = sharedPartitions(ctx);
  const keepCookies = () => keepCookiesOf(settingsOf(ctx).browserKeepCookies);
  const pages = new PreviewPages(app.getPath("userData"), account.id);
  let devServers: DevServersPort | undefined;
  let importer: Promise<ChromeImport> | undefined;
  let disposed = false;
  const platform: BrowserPlatform = {
    platform: process.platform,
    parking: () => parkingWindow(ctx) as unknown as ParkingWindow,
    createView(partition) {
      jars.session(partition);
      const view = new WebContentsView({
        webPreferences: {
          partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          backgroundThrottling: false,
          spellcheck: false,
          navigateOnDragDrop: false,
          safeDialogs: true,
          autoplayPolicy: "document-user-activation-required",
        },
      });
      view.setBackgroundColor("#ffffff");
      // A page that has the focus keeps the pane keys from the window (new
      // tab, the address bar, Terminal, Close Pane …): they go to the app
      // window instead of the page.
      view.webContents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") return;
        // F5 reloads the page outside macOS; ⌘R and Ctrl+R are View ▸ Reload,
        // which reloads the focused page (app-menu.ts).
        const reloading =
          process.platform !== "darwin" && pageReloadKey(input)
            ? host?.focusedConversation()
            : undefined;
        if (reloading) {
          event.preventDefault();
          if (!input.isAutoRepeat) host?.reload(reloading);
          return;
        }
        const command = paneKeyCommand(input, process.platform === "darwin");
        const target = ctx.appWindows.focused() ?? ctx.appWindows.main();
        if (!command || !target) return;
        event.preventDefault();
        ctx.appWindows.send(target, { type: "command", command });
      });
      return view as unknown as HostView;
    },
  };
  const toolsAvailable = () =>
    browserToolsSetting(settingsOf(ctx)) &&
    browserPolicy(ctx).enabled !== false;
  const workspaceFor = (id: string) => {
    const conversation = ctx.store.conversations.find(
      (conversation) => conversation.id === id,
    );
    const cwd =
      conversation?.cwd ??
      ctx.store.projects.find(
        (project) => project.id === conversation?.projectId,
      )?.cwd;
    return conversation?.environment?.kind === "ssh"
      ? `${conversation.environment.hostId}\0${cwd ?? id}`
      : cwd
        ? path.resolve(cwd)
        : id;
  };
  const browserHost = new BrowserHost({
    routedLink: (url) => {
      void previewLinkRouter(ctx)
        .request(url)
        .catch((error) =>
          console.warn("Preview link confirmation failed", error),
        );
    },
    platform,
    partition: (conversationId) => {
      if (
        ctx.store.conversations.find(
          (conversation) => conversation.id === conversationId,
        )?.mode === "cowork"
      )
        return partitionName("always", account.id, "");
      return previewPartitionName(
        keepCookies(),
        account.id,
        workspaceFor(conversationId),
        "",
        conversationId,
      );
    },
    savedPage: (id) =>
      ctx.store.conversations.find((conversation) => conversation.id === id)
        ?.incognito
        ? undefined
        : pages.get(id),
    savePage: (id, page) => {
      const conversation = ctx.store.conversations.find(
        (conversation) => conversation.id === id,
      );
      if (conversation && !conversation.incognito) pages.set(id, page);
    },
    blockedDomains: () => browserPolicy(ctx).blockedDomains ?? [],
    toolsAvailable,
    devServers: (conversationId) => {
      if (
        ctx.store.conversations.find(
          (conversation) => conversation.id === conversationId,
        )?.mode === "cowork"
      )
        return { available: false, servers: [] };
      if (!devServers) return { available: false, servers: [] };
      const config = devServers.launchConfig(conversationId);
      return {
        available: browserPolicy(ctx).devServers !== false,
        servers: devServers.list(conversationId),
        ...(config.path ? { launchConfigPath: config.path } : {}),
        ...(config.error ? { launchConfigError: config.error } : {}),
        autoVerify: devServers.autoVerify?.(conversationId),
      };
    },
    push: (state) => ctx.push({ type: "browser", state }),
  });
  host = browserHost;

  // A deleted conversation's pages close and its own saved browser is cleared.
  const sweep = () => {
    let known: Set<string>;
    try {
      known = new Set(ctx.store.conversations.map((c) => c.id));
    } catch {
      return;
    }
    pages.prune(known);
    for (const id of browserHost.conversations())
      if (!known.has(id)) {
        browserHost.close(id);
        void jars.forgetConversation(account.id, id).catch(() => {});
      }
    return known;
  };
  // Per-session browsers saved by an earlier run for conversations deleted since.
  const known = sweep();
  if (known)
    void (async () => {
      await jars.forgetMissingPreviewConversations(account.id, [...known]);
      const kept = new Set(
        [...known].map((id) =>
          partitionName("per-session", account.id, id).slice("persist:".length),
        ),
      );
      const fs = await import("node:fs");
      let folders: string[] = [];
      try {
        folders = fs
          .readdirSync(BrowserPartitions.folder(app.getPath("userData")))
          .filter((name) => name.startsWith(perSessionPrefix(account.id)));
      } catch {
        return;
      }
      for (const folder of folders)
        if (!kept.has(folder))
          await jars.clear(`persist:${folder}`).catch(() => {});
    })();
  const sweeper = setInterval(sweep, 30_000);
  sweeper.unref?.();

  let lastKeep = keepCookies();
  let lastTools = toolsAvailable();
  const offSettings = ctx.onSettingsChanged(() => {
    const keep = keepCookies();
    if (keep !== lastKeep) {
      lastKeep = keep;
      browserHost.repartition();
    }
    const tools = toolsAvailable();
    if (tools !== lastTools) {
      lastTools = tools;
      browserHost.refresh();
    }
  });
  const offEvents = ctx.onEvent((event) => {
    if (event.type === "policy") {
      lastTools = toolsAvailable();
      // The administrator turned the browser off: its pages close.
      if (browserPolicy(ctx).enabled === false)
        for (const id of browserHost.conversations()) browserHost.close(id);
      browserHost.refresh();
    }
  });
  let offDevServers: (() => void) | undefined;

  const service: BrowserService = {
    host: browserHost,
    toolsAvailable,
    policy: () => browserPolicy(ctx),
    blockedDomains: () => browserPolicy(ctx).blockedDomains ?? [],
    keepCookies,
    openUrl(conversationId, url) {
      if (browserPolicy(ctx).enabled === false)
        return {
          ok: false,
          message: "Your administrator has turned off the browser.",
        };
      try {
        browserHost.newTab(conversationId, url, true);
        return { ok: true, url: browserHost.activeUrl(conversationId) };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    attachDevServers(port) {
      offDevServers?.();
      devServers = port;
      const off = port.onChange((conversationId) =>
        browserHost.refresh(conversationId),
      );
      offDevServers = () => {
        off();
        if (devServers === port) devServers = undefined;
        offDevServers = undefined;
        browserHost.refresh();
      };
      browserHost.refresh();
      return offDevServers;
    },
    devServers: () => devServers,
    chromeImport() {
      importer ??= import("./chrome-import").then(({ ChromeImport }) => {
        const instance = new ChromeImport({
          ...ChromeImport.defaults,
          seedStorage: async (jar, storage, allowed) => {
            const { seedChromeStorage } = await import("./chrome-storage-seed");
            return seedChromeStorage(jar as Electron.Session, storage, allowed);
          },
          readJarStorage: async (jar, origins, allowed) => {
            const { readChromeJarStorage } =
              await import("./chrome-storage-seed");
            return readChromeJarStorage(
              jar as Electron.Session,
              origins,
              allowed,
            );
          },
          shared: () => {
            const partition = partitionName("always", account.id, "");
            return {
              partition,
              jar: jars.session(partition) as Electron.Session,
            };
          },
          clearStorage: async (jar, origins) => {
            await (jar as Electron.Session).clearData({
              dataTypes: ["localStorage"],
              origins,
            });
          },
          indexFile: path.join(profileRoot, "imported-browser-cookies.json"),
          touchId: () =>
            process.platform === "darwin" &&
            systemPreferences.canPromptTouchID(),
          authorize: async (profile) => {
            if (disposed) return false;
            const translate = await nativeTranslator(
              preference(ctx.store.settings, "locale"),
            );
            if (disposed) return false;
            const reason = translate(
              "list the sites you’re signed into in {browser}",
            ).replace("{browser}", profile.browserName);
            if (
              process.platform === "darwin" &&
              systemPreferences.canPromptTouchID()
            ) {
              // Two minutes to answer.
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                const answer = await Promise.race([
                  systemPreferences.promptTouchID(reason).then(() => true),
                  new Promise<"timeout">((resolve) => {
                    timer = setTimeout(() => resolve("timeout"), 120_000);
                  }),
                ]);
                return answer === "timeout" ? answer : !disposed;
              } catch {
                return false;
              } finally {
                clearTimeout(timer);
              }
            }
            const options = {
              type: "question" as const,
              message: translate(
                "Let Claudex read your {browser} logins?",
              ).replace("{browser}", profile.browserName),
              detail: translate(
                profile.browser === "firefox"
                  ? "Claudex will {reason}."
                  : "Claudex will {reason}. macOS may also ask for your login password to unlock that browser’s saved data.",
              ).replace("{reason}", reason),
              buttons: [translate("Continue"), translate("Cancel")],
              defaultId: 1,
              cancelId: 1,
            };
            const parent = ctx.callerWindow();
            const answer =
              parent && !parent.isDestroyed()
                ? await dialog.showMessageBox(parent, options)
                : await dialog.showMessageBox(options);
            return answer.response === 0 && !disposed;
          },
          target: async (id, keep) => {
            if (
              disposed ||
              ctx.activeAccount?.id !== account.id ||
              browserPolicy(ctx).enabled === false
            )
              throw new Error("expired");
            if (
              keep &&
              keepCookies() === "until-quit" &&
              ctx.store.conversations.find(
                (conversation) => conversation.id === id,
              )?.mode !== "cowork"
            ) {
              ctx.store.settings = {
                ...ctx.store.settings,
                browserKeepCookies: "always",
              };
              ctx.store.flush();
              ctx.settingsChanged();
            }
            const partition = browserHost.activePartition(id);
            return {
              partition,
              jar: jars.session(partition) as Electron.Session,
              persistent: partition.startsWith("persist:"),
            };
          },
          blocked: (host) =>
            disposed ||
            browserPolicy(ctx).externalSites === false ||
            previewOriginUnsafe(`https://${host}`) ||
            hostBlocked(host, browserPolicy(ctx).blockedDomains ?? []),
          reload: (id) => {
            if (!disposed) browserHost.reload(id);
          },
        });
        if (disposed) instance.dispose();
        return instance;
      });
      return importer;
    },
    async clearPreviewData() {
      await jars.clearPreviews(account.id);
      browserHost.reloadAll();
    },
    async clearCoworkBrowserData() {
      if (
        disposed ||
        ctx.activeAccount?.id !== account.id ||
        browserPolicy(ctx).enabled === false
      )
        return false;
      const partition = partitionName("always", account.id, "");
      await (await service.chromeImport!()).clearPartition(partition);
      await jars.clear(partition);
      browserHost.reloadAll();
      return true;
    },
    async clearBrowsingData(conversationId) {
      if (conversationId) {
        const partition = browserHost.activePartition(conversationId);
        await (await importer)?.clearPartition(partition);
        await jars.clear(partition);
        browserHost.reloadAll();
        return;
      }
      await (await importer)?.clear();
      const conversations = (() => {
        try {
          return ctx.store.conversations.map((c) => c.id);
        } catch {
          return [];
        }
      })();
      await jars.clearFor(keepCookies(), account.id, conversations);
      for (const mode of ["until-quit", "always", "per-session"] as const)
        if (mode !== keepCookies())
          await jars.clearFor(mode, account.id, conversations);
      await jars.clearPreviews(account.id);
      browserHost.reloadAll();
    },
    defaultBrowserName() {
      const name = app.getApplicationNameForProtocol("https://");
      return name ? name.replace(/\.app$/i, "") : null;
    },
  };
  ctx.services.browser = service;

  // Dev servers of the account's Code sessions (R8-B).
  service.attachDevServers(
    new DevServers({
      beforeStart: async (conversationId, name) => {
        if (keepCookies() !== "until-quit") return;
        await jars.clear(
          previewPartitionName(
            "until-quit",
            account.id,
            workspaceFor(conversationId),
            name,
            conversationId,
          ),
        );
      },
      conversation(conversationId) {
        let conversation;
        try {
          conversation = ctx.store.conversations.find(
            (c) => c.id === conversationId,
          );
        } catch {
          return undefined;
        }
        if (!conversation) return undefined;
        const cwd =
          conversation.cwd ??
          ctx.store.projects.find((p) => p.id === conversation.projectId)?.cwd;
        return {
          cwd,
          remote: conversation.environment?.kind === "ssh",
        };
      },
      unattended: (conversationId) =>
        ctx.scheduler?.isUnattended(conversationId) ?? false,
      allowed: () => browserPolicy(ctx).devServers !== false,
      onEvent: (cb) => ctx.onEvent(cb),
    }),
  );

  const offDeactivating = ctx.onAccountDeactivating(async () => {
    disposed = true;
    void importer?.then((instance) => instance.dispose());
    offDeactivating();
    offSettings();
    offEvents();
    clearInterval(sweeper);
    const port = devServers;
    offDevServers?.();
    browserHost.dispose();
    closeParking();
    if (host === browserHost) host = undefined;
    if (ctx.services.browser === service) ctx.services.browser = undefined;
    await port?.dispose();
  });
  return service;
}

/** The Browser calls' Electron side (`electron/ipc/panels.ts`). */
export const electronPanelDeps: BrowserPanelDeps = {
  service: (ctx) => createBrowserFeature(ctx),
  async saveFile(window, bytes, name) {
    const parent = window instanceof BrowserWindow ? window : undefined;
    const options = {
      defaultPath: name,
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    };
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    await fs.writeFile(result.filePath, bytes);
    return true;
  },
  async saveImage(window, png, suggestedName) {
    const parent = window instanceof BrowserWindow ? window : undefined;
    const options = {
      defaultPath: suggestedName,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    };
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    await fs.writeFile(result.filePath, png);
    return true;
  },
  async chooseHtmlFile(window) {
    const parent = window instanceof BrowserWindow ? window : undefined;
    const options = {
      properties: ["openFile" as const],
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  },
  openExternal: (url) => shell.openExternal(url),
};
