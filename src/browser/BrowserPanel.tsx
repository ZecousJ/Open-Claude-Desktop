import { useContext, useEffect, useRef, useState } from "react";
import {
  type DevServerState,
  type LaunchConfiguration,
} from "../../shared/browser";
import type { BrowserPolicy } from "../../shared/client-policy";
import type { Attachment, Conversation } from "../../shared/types";
import type { Confirmation } from "../dialogs/ConfirmationDialog";
import { type MenuPosition } from "../ui/Menu";
import { devServerActive } from "./browser-model";
import {
  activeTab,
  appendToDraft,
  elementPickText,
  tabShowsPage,
} from "./browser-model";
import {
  errorText,
  useBrowserState,
  windowBridge,
  type BrowserBridge,
} from "./useBrowserState";
import { useBrowserKeys } from "./useBrowserKeys";
import { usePaneExpandToggle } from "../app/pane-expand";
import { useBrowserView } from "./useBrowserView";
import { attachElementPick } from "./ElementPickCard";
import { addFile } from "../composer/attachment-input";
import { lazyPiece } from "../ui/lazy-piece";
import { ShortcutPlatform } from "../ui/Tooltip";
import type { SketchBackdrop, SketchHandle } from "./BrowserSketch";
import { pngSize } from "./browser-sketch-model";
import "./browser-panel.css";
import { useBrowserPanelActions } from "./useBrowserPanelActions";

/** Sketch mode's layer loads when ⇧⌘X is first used. */
export const BrowserSketch = lazyPiece(
  () => import("./BrowserSketch"),
  "BrowserSketch",
);
export const ChromeImportDialog = lazyPiece(
  () => import("./ChromeImportDialog"),
  "ChromeImportDialog",
);

/** The bytes of a base64 string. */
function bytesOf(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** What the panel needs from the window around it (ToolPanelHost supplies it). */
export interface BrowserPanelEnv {
  /** The window's settings, for the menu's switches (`browser*` preferences). */
  settings: Record<string, unknown>;
  policy: BrowserPolicy;
  /** The card sits under the Changes card. */
  split: boolean;
  onPreference: (patch: Record<string, unknown>) => Promise<void>;
  onConfirm: (confirmation: Confirmation) => void;
  /** Changes the message being written (Select element writes into it when it can't attach). */
  onDraft: (change: (draft: string) => string) => void;
  /** Adds attachments to the message being written (Select element). */
  onAttach: (attachments: Attachment[]) => void;
  onNotify: (message: string) => void;
}

export type OpenMenu = {
  kind: "dev" | "settings" | "cookies" | "tab";
  position: MenuPosition;
  tabId?: string;
  /** The dev server whose actions show. */
  name?: string;
};
export const menuLabels: Record<OpenMenu["kind"], string> = {
  dev: "Dev servers",
  settings: "Browser settings",
  cookies: "Keep cookies",
  tab: "Tab",
};
/** Why the empty tab shows a dev server card instead of the start page. */
export type PreviewProblem =
  | { kind: "start-failed"; name: string; message: string }
  | { kind: "not-started"; name: string };

/** The origin of an address, or "" when it has none. */
export function originOf(url: string | undefined) {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

export type OpenDialog =
  | { kind: "add"; initial?: LaunchConfiguration; note?: string }
  | { kind: "start"; server: DevServerState }
  | {
      kind: "close";
      tabIds: string[];
      others: boolean;
      servers: DevServerState[];
    }
  | { kind: "sites" }
  | { kind: "import"; useImported?: boolean };

/**
 * The Code Browser panel: a card with the tab strip and the dev servers,
 * settings, expand and close buttons, the address row, and the page. The page
 * itself is the main process's native view laid over `.browser-viewport`; the
 * card draws what is not a page (a new tab, a load error, a crash) and stands
 * in a still while an app menu or dialog covers the page.
 */
export function BrowserPanel({
  conversation,
  env,
  onClose,
  onError,
  bridge: given,
}: {
  conversation: Conversation;
  env: BrowserPanelEnv;
  onClose: () => void;
  onError: (error: unknown) => void;
  bridge?: BrowserBridge;
}) {
  const [bridge] = useState(() => given ?? windowBridge());
  const id = conversation.id;
  const { state, failure } = useBrowserState(id, bridge);
  const place = useRef<HTMLDivElement>(null);
  const cover = useBrowserView(id, bridge, place);
  const devButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState<OpenMenu>();
  const [dialog, setDialog] = useState<OpenDialog>();
  const [message, setMessage] = useState("");
  const [browserName, setBrowserName] = useState<string | null>(null);
  const [canImport, setCanImport] = useState(false);
  const [canUseImported, setCanUseImported] = useState(false);
  const [touchId, setTouchId] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [openWhenRunning, setOpenWhenRunning] = useState<string>();
  const [problem, setProblem] = useState<PreviewProblem>();
  // The server a card's Try again or Restart is starting.
  const [retrying, setRetrying] = useState<string>();
  const startApproved = useRef(false);
  // The dev server whose output shows in the drawer under the page.
  const [logsFor, setLogsFor] = useState<string>();
  // Sketch mode (⇧⌘X): the page's still while it is on, and the layer's handle.
  const [sketch, setSketch] = useState<SketchBackdrop>();
  const sketchStarting = useRef(false);
  const sketchHandle = useRef<SketchHandle | null>(null);
  const platform = useContext(ShortcutPlatform);

  useEffect(() => {
    void bridge
      ?.browserDefaultBrowserName()
      .then((name) => setBrowserName(name ?? null))
      .catch(() => {});
  }, [bridge]);
  useEffect(() => {
    let active = true;
    void (
      conversation.mode === "cowork"
        ? bridge?.getCoworkChromeImportAvailability?.()
        : bridge?.getChromeImportAvailability?.()
    )
      ?.then((result) => {
        if (!active) return;
        setCanImport(result.available);
        setTouchId(Boolean(result.touchId));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [bridge, conversation.mode]);

  const tab = activeTab(state);
  useEffect(() => {
    let active = true;
    void bridge
      ?.getChromeImportSharedOffer(id)
      .then((offer) => {
        if (active) setCanUseImported(offer.offer);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [bridge, id, menu, dialog, env.settings.browserKeepCookies, tab?.url]);
  // A refused address belongs to the tab it was typed in; a sketch belongs to
  // the page it was drawn on.
  useEffect(() => {
    setMessage("");
    setSketch(undefined);
    setProblem(undefined);
  }, [tab?.id]);
  const run = (work: () => Promise<unknown> | undefined) => {
    void Promise.resolve()
      .then(work)
      .catch((error) => onError(new Error(errorText(error))));
  };
  // ⇧⌘S starts Select element where the button could (a page on screen),
  // or stops it; ⇧⌘\ expands or restores the card.
  useBrowserKeys({
    conversationId: id,
    state,
    bridge,
    address,
    run,
    onSelectElement: () => {
      if (sketch) return;
      if (state?.picking || tabShowsPage(activeTab(state))) pick();
    },
    onSketch: () => toggleSketch(),
  });
  usePaneExpandToggle("browser", () => setExpanded((value) => !value));

  /** Opens a local address: in the open tab when it is empty, else in a new one. */
  const openAddress = async (url: string) => {
    if (!bridge) return;
    // An empty tab, or one showing that server's page failing to load.
    const failedHere =
      (tab?.error || tab?.restored) &&
      originOf(tab.url) &&
      originOf(tab.url) === originOf(url);
    if (tab && ((!tab.url && !tab.error) || failedHere)) {
      const result = await bridge.browserNavigate(id, url, tab.id);
      if (!result.ok) throw new Error(result.message);
    } else await bridge.browserNewTab(id, url);
  };

  // A server started from the panel opens once it is running.
  useEffect(() => {
    if (!openWhenRunning || !state) return;
    const server = state.devServers.find((s) => s.name === openWhenRunning);
    if (!server) return setOpenWhenRunning(undefined);
    if (server.status === "failed" || server.status === "crashed") {
      setOpenWhenRunning(undefined);
      setProblem({
        kind: "start-failed",
        name: server.name,
        message: server.error ?? "",
      });
      return;
    }
    if (server.status === "running") {
      setOpenWhenRunning(undefined);
      if (server.url) run(() => openAddress(server.url!));
    }
  }, [state, openWhenRunning]);

  const startServer = async (name: string) => {
    if (!bridge) return;
    setProblem(undefined);
    let started: DevServerState;
    try {
      started = await bridge.devServersStart(id, name);
    } catch (error) {
      setProblem({ kind: "start-failed", name, message: errorText(error) });
      throw error;
    }
    if (started.status === "running" && started.url)
      await openAddress(started.url);
    else setOpenWhenRunning(name);
  };

  const below = (button: HTMLElement | null, alignTo?: HTMLElement | null) => {
    const box = button?.getBoundingClientRect();
    const edge = (alignTo ?? button)?.getBoundingClientRect();
    return box && edge
      ? { right: innerWidth - edge.right, top: box.bottom + 5 }
      : { right: 16, top: 48 };
  };

  const detect = () => {
    if (!bridge || !state) return;
    if (state.devServers.some((server) => server.source === "launch.json"))
      return setMenu({ kind: "dev", position: below(devButton.current) });
    setDetecting(true);
    void bridge
      .devServersDetect(id)
      .then((drafts) =>
        setDialog(
          drafts.length
            ? { kind: "add", initial: drafts[0] }
            : { kind: "add", note: "No dev server found in this folder." },
        ),
      )
      .catch((error) => onError(new Error(errorText(error))))
      .finally(() => setDetecting(false));
  };

  const pick = () => {
    if (!bridge || !state) return;
    if (state.picking) return run(() => bridge.browserCancelPick(id));
    run(async () => {
      const element = await bridge.browserPickElement(id);
      if (!element) return;
      try {
        env.onAttach(await attachElementPick(element));
      } catch {
        // Attachments are off or full: the element's details go into the text.
        const text = elementPickText(element);
        env.onDraft((draft) => appendToDraft(draft, text));
      }
      env.onNotify("Element added to your message");
    });
  };

  /**
   * ⇧⌘X: starts sketch mode on a page that is on screen, ending Select element
   * first, with a still of the page to draw on; while it is on, asks to end it.
   */
  const toggleSketch = () => {
    if (sketch) {
      if (sketchHandle.current) sketchHandle.current.requestClose();
      else setSketch(undefined);
      return;
    }
    if (!bridge || !state || sketchStarting.current) return;
    if (!tabShowsPage(activeTab(state))) return;
    sketchStarting.current = true;
    const picking = state.picking;
    const failed = () =>
      env.onNotify("Couldn’t capture a screenshot to annotate. Try again.");
    void Promise.resolve()
      .then(async () => {
        if (picking) await bridge.browserCancelPick(id);
        const shot = await bridge.browserCapture(id);
        const size = shot ? pngSize(bytesOf(shot.pngBase64)) : undefined;
        if (!shot || !size) return failed();
        setSketch({
          dataUrl: `data:image/png;base64,${shot.pngBase64}`,
          ...size,
          scale: window.devicePixelRatio || 1,
        });
      })
      .catch(failed)
      .finally(() => {
        sketchStarting.current = false;
      });
  };

  /** Add to chat: the sketched page goes into the message being written. */
  const attachSketch = async (png: Uint8Array, name: string) => {
    try {
      env.onAttach([
        await addFile(new File([png as BlobPart], name, { type: "image/png" })),
      ]);
    } catch (error) {
      onError(new Error(errorText(error)));
      throw error;
    }
  };

  /** The configured servers running behind these tabs' pages. */
  const serversBehind = (tabIds: string[]) => {
    if (!state) return [];
    const origins = new Set(
      state.tabs
        .filter((each) => tabIds.includes(each.id))
        .map((each) => originOf(each.url))
        .filter(Boolean),
    );
    return state.devServers.filter(
      (server) =>
        server.source === "launch.json" &&
        devServerActive(server) &&
        origins.has(originOf(server.url)),
    );
  };
  /**
   * Closes tabs; a tab whose dev server runs asks first whether to stop it
   * (the original's "Close {host}?").
   */
  const closeTabs = (tabIds: string[], others: boolean, keepId?: string) => {
    if (!bridge) return;
    const servers = serversBehind(tabIds);
    const close = () =>
      others && keepId
        ? bridge.browserCloseOtherTabs(id, keepId)
        : bridge.browserCloseTab(id, tabIds[0]);
    if (!servers.length) return run(close);
    setDialog({ kind: "close", tabIds, others, servers });
    closeAction.current = close;
  };
  const closeAction = useRef<() => Promise<unknown>>(undefined);

  // The drawer's server: the one the page shows, else the first one running.
  const logsServer =
    state?.devServers.find(
      (server) =>
        server.source === "launch.json" &&
        server.url &&
        originOf(server.url) === originOf(tab?.url),
    ) ??
    state?.devServers.find(
      (server) => server.source === "launch.json" && devServerActive(server),
    );
  const drawerServer = logsFor
    ? state?.devServers.find((server) => server.name === logsFor)
    : undefined;

  const settings = env.settings;
  const { browserPanelViewView } = useBrowserPanelActions({
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
  });
  return browserPanelViewView;
}
