import type { MenuEntry } from "../ui/Menu";
import type { DevServerActions } from "./DevServersMenu";
import {
  devServerActive,
  tabShowsPage,
  openableElsewhere,
} from "./browser-model";
import {
  sessionDataConfirmation,
  browsingDataConfirmation,
} from "./session-data";
import { t } from "../i18n";
import { devServerEntries } from "./DevServersMenu";
import { keepCookiesOf } from "../../shared/browser";
import {
  keepCookiesEntries,
  browserSettingsEntries,
} from "./BrowserSettingsMenu";
import { originOf } from "./BrowserPanel";
import { browserPanelView } from "./BrowserPanelView";
import type { BrowserBridge } from "./useBrowserState";
import type { Conversation } from "../../shared/types";
import type {
  OpenDialog,
  BrowserPanelEnv,
  OpenMenu,
  PreviewProblem,
} from "./BrowserPanel";
import type {
  DevServerState,
  BrowserState,
  BrowserTabState,
} from "../../shared/browser";
import type { SketchBackdrop, SketchHandle } from "./BrowserSketch";

/** What useBrowserPanelActions needs from BrowserPanel.tsx. */
export interface UseBrowserPanelActionsKit {
  address: React.RefObject<HTMLInputElement | null>;
  attachSketch: (
    png: Uint8Array<ArrayBufferLike>,
    name: string,
  ) => Promise<void>;
  below: (
    button: HTMLElement | null,
    alignTo?: HTMLElement | null | undefined,
  ) => { right: number; top: number };
  bridge: BrowserBridge | undefined;
  browserName: string | null;
  canImport: boolean;
  canUseImported: boolean;
  closeAction: React.RefObject<(() => Promise<unknown>) | undefined>;
  closeTabs: (
    tabIds: string[],
    others: boolean,
    keepId?: string | undefined,
  ) => void;
  conversation: Conversation;
  cover: { on: boolean; snapshot?: string | undefined };
  detect: () => void;
  detecting: boolean;
  devButton: React.RefObject<HTMLButtonElement | null>;
  dialog: OpenDialog | undefined;
  drawerServer: DevServerState | undefined;
  env: BrowserPanelEnv;
  expanded: boolean;
  failure: string | undefined;
  id: string;
  logsFor: string | undefined;
  logsServer: DevServerState | undefined;
  menu: OpenMenu | undefined;
  message: string;
  moreButton: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onError: (error: unknown) => void;
  openAddress: (url: string) => Promise<void>;
  openWhenRunning: string | undefined;
  pick: () => void;
  place: React.RefObject<HTMLDivElement | null>;
  platform: string;
  problem: PreviewProblem | undefined;
  retrying: string | undefined;
  run: (work: () => Promise<unknown> | undefined) => void;
  setDialog: React.Dispatch<React.SetStateAction<OpenDialog | undefined>>;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setLogsFor: React.Dispatch<React.SetStateAction<string | undefined>>;
  setMenu: React.Dispatch<React.SetStateAction<OpenMenu | undefined>>;
  setMessage: React.Dispatch<React.SetStateAction<string>>;
  setProblem: React.Dispatch<React.SetStateAction<PreviewProblem | undefined>>;
  setRetrying: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSketch: React.Dispatch<React.SetStateAction<SketchBackdrop | undefined>>;
  settings: Record<string, unknown>;
  sketch: SketchBackdrop | undefined;
  sketchHandle: React.RefObject<SketchHandle | null>;
  startApproved: React.RefObject<boolean>;
  startServer: (name: string) => Promise<void>;
  state: BrowserState | undefined;
  tab: BrowserTabState | undefined;
  toggleSketch: () => void;
  touchId: boolean;
}

export function useBrowserPanelActions(kit: UseBrowserPanelActionsKit) {
  const {
    address,
    attachSketch,
    below,
    bridge,
    browserName,
    canImport,
    canUseImported,
    closeAction,
    closeTabs,
    conversation,
    cover,
    detect,
    detecting,
    devButton,
    dialog,
    drawerServer,
    env,
    expanded,
    failure,
    id,
    logsFor,
    logsServer,
    menu,
    message,
    moreButton,
    onClose,
    onError,
    openAddress,
    openWhenRunning,
    pick,
    place,
    platform,
    problem,
    retrying,
    run,
    setDialog,
    setExpanded,
    setLogsFor,
    setMenu,
    setMessage,
    setProblem,
    setRetrying,
    setSketch,
    settings,
    sketch,
    sketchHandle,
    startApproved,
    startServer,
    state,
    tab,
    toggleSketch,
    touchId,
  } = kit;
  const menuEntries = (): MenuEntry[] => {
    if (!menu || !state || !bridge) return [];
    if (menu.kind === "tab") {
      const tabId = menu.tabId!;
      return [
        {
          label: "Close tab",
          onSelect: () => closeTabs([tabId], false),
        },
        {
          label: "Close other tabs",
          disabled: state.tabs.length < 2,
          onSelect: () =>
            closeTabs(
              state.tabs
                .filter((other) => other.id !== tabId)
                .map((other) => other.id),
              true,
              tabId,
            ),
        },
      ];
    }
    const serverActions: DevServerActions = {
      start: (server) => {
        setMenu(undefined);
        setDialog({ kind: "start", server });
      },
      stop: (server) => run(() => bridge.devServersStop(id, server.name)),
      open: (server) => server.url && run(() => openAddress(server.url!)),
      stopAll: () =>
        run(() =>
          Promise.all(
            state.devServers
              .filter(
                (server) =>
                  server.source === "launch.json" && devServerActive(server),
              )
              .map((server) => bridge.devServersStop(id, server.name)),
          ),
        ),
      toggleLogs: logsServer
        ? () => setLogsFor(logsFor ? undefined : logsServer.name)
        : undefined,
      add: () => setDialog({ kind: "add" }),
    };
    const confirmSessionData = (
      clear: boolean,
      next = clear ? "until-quit" : "always",
    ) => {
      const copy = sessionDataConfirmation(clear);
      env.onConfirm({
        ...copy,
        title: t(copy.title),
        body: t(copy.body),
        confirm: t(copy.confirm),
        action: async () => {
          if (clear) await bridge.browserClearPreviewData();
          await env.onPreference({ browserKeepCookies: next });
        },
      });
    };
    if (menu.kind === "dev")
      return [
        ...devServerEntries(state.devServers, serverActions, {
          showingUrl: tab?.url,
          logsOpen: Boolean(logsFor),
          rtl: document.dir === "rtl",
        }),
        ...(!state.toolsAvailable
          ? [
              { separator: true as const },
              {
                label:
                  keepCookiesOf(settings.browserKeepCookies) !== "until-quit"
                    ? "Clear session data"
                    : "Keep cookies",
                onSelect: () =>
                  confirmSessionData(
                    keepCookiesOf(settings.browserKeepCookies) !== "until-quit",
                  ),
              },
            ]
          : []),
      ];
    if (menu.kind === "cookies")
      return keepCookiesEntries(settings, (value) =>
        run(() => env.onPreference({ browserKeepCookies: value })),
      );
    return browserSettingsEntries({
      browserName,
      hasPage: tabShowsPage(tab),
      canOpenElsewhere: openableElsewhere(tab),
      toolsAvailable: state.toolsAvailable,
      viewport: state.viewport,
      colorScheme: state.colorScheme,
      autoVerify: state.devServersAvailable
        ? (state.autoVerify ?? settings.browserAutoVerify === true)
        : undefined,
      settings,
      actions: {
        openElsewhere: () => run(() => bridge.browserOpenExternally(id)),
        copyUrl: () => {
          const url = tab?.url;
          if (!url) return;
          void navigator.clipboard.writeText(url).then(
            () => env.onNotify(t("URL copied to clipboard.")),
            () => env.onNotify(t("Couldn’t copy the URL. Try again.")),
          );
        },
        setViewport: (next) => run(() => bridge.browserSetViewport(id, next)),
        setColorScheme: (scheme) =>
          run(() => bridge.browserSetColorScheme(id, scheme)),
        toggleAutoVerify: () => {
          const on = state.autoVerify ?? settings.browserAutoVerify === true;
          env.onConfirm({
            title: t(on ? "Disable auto verify" : "Enable auto verify"),
            body: t(
              on
                ? "Claudex will no longer automatically verify code changes using the preview. You can still ask Claudex to verify manually. This setting is saved in .claude/launch.json for this project."
                : "After editing code, Claudex will automatically start the preview server, verify changes, and share proof before completing its response. This setting is saved in .claude/launch.json for this project.",
            ),
            confirm: t(on ? "Disable" : "Enable"),
            danger: false,
            action: () => bridge.devServersSetAutoVerify(id, !on),
          });
        },
        saveScreenshot: () =>
          run(async () => {
            if (await bridge.browserSaveScreenshot(id))
              env.onNotify("Screenshot saved");
          }),
        showAnnotationTools: toggleSketch,
        hasExportFile: tab?.canExportFile,
        exportFile: () => run(() => bridge.browserExportFile(id)),
        openHtmlFile: () => run(() => bridge.browserOpenHtmlFile(id)),
        setPreference: (key, value) =>
          run(() => env.onPreference({ [key]: value })),
        manageAllowedSites: () => setDialog({ kind: "sites" }),
        importCookies: canImport
          ? () => setDialog({ kind: "import" })
          : undefined,
        useImportedCookies: canUseImported
          ? () => setDialog({ kind: "import", useImported: true })
          : undefined,
        chooseKeepCookies: () => setMenu({ ...menu, kind: "cookies" }),
        clearBrowsingData: () =>
          env.onConfirm({
            ...browsingDataConfirmation(
              conversation.mode === "cowork" ||
                keepCookiesOf(settings.browserKeepCookies) === "always",
            ),
            title: t("Clear browsing data?"),
            body: t(
              browsingDataConfirmation(
                conversation.mode === "cowork" ||
                  keepCookiesOf(settings.browserKeepCookies) === "always",
              ).body,
            ),
            confirm: t("Clear data"),
            action: async () => {
              if (conversation.mode === "cowork") {
                if (!(await bridge.clearCoworkBrowserData()))
                  throw new Error(t("Couldn’t clear browsing data."));
              } else await bridge.browserClearData(id);
              env.onNotify("Browsing data cleared");
            },
          }),
        cowork: conversation.mode === "cowork",
      },
    });
  };

  /** Try again or Restart from a card: starts the server, the button busy meanwhile. */
  const retry = (name: string) => {
    if (retrying) return;
    setRetrying(name);
    void startServer(name)
      .catch(() => {})
      .finally(() => setRetrying(undefined));
  };

  const showsError = Boolean(tab?.error || tab?.crashed);
  const emptyTab = Boolean(state && tab && !tab.url && !showsError);
  // The page's own dev server stopped: the load error gives way to Restart.
  const stoppedServer =
    tab?.error && !tab.crashed
      ? state?.devServers.find(
          (server) =>
            server.source === "launch.json" &&
            server.url &&
            originOf(server.url) === originOf(tab.url) &&
            ["stopped", "crashed", "failed"].includes(server.status),
        )
      : undefined;
  const policyAllowsTools = env.policy.enabled !== false;
  const viewport = state?.viewport ?? "desktop";
  const allowedSites = Array.isArray(settings.browserAllowedSites)
    ? (settings.browserAllowedSites as string[])
    : [];
  const browserPanelViewView = browserPanelView({
    address,
    allowedSites,
    attachSketch,
    below,
    bridge,
    browserName,
    closeAction,
    closeTabs,
    conversation,
    cover,
    detect,
    detecting,
    devButton,
    dialog,
    drawerServer,
    emptyTab,
    env,
    expanded,
    failure,
    id,
    menu,
    menuEntries,
    message,
    moreButton,
    onClose,
    onError,
    openWhenRunning,
    pick,
    place,
    platform,
    policyAllowsTools,
    problem,
    retry,
    retrying,
    run,
    setDialog,
    setExpanded,
    setLogsFor,
    setMenu,
    setMessage,
    setProblem,
    setSketch,
    settings,
    showsError,
    sketch,
    sketchHandle,
    startApproved,
    startServer,
    state,
    stoppedServer,
    tab,
    toggleSketch,
    touchId,
    viewport,
  });
  return { browserPanelViewView } as const;
}
