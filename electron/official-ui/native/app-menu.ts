/** Bridge the existing application menu to the authenticated official window.
 * No new menu items, OS/global shortcuts, or renderer-selected destinations. */
import type { BrowserWindow, Input } from "electron";
import { z } from "zod";
import type { AppCommand } from "../../../shared/types";
import { initialMenuState, noSplitMenu, type MenuArea, type MenuState, type SplitMenuState } from "../../../shared/menu-state";
import type { NativeHost } from "./host";
import { navigationState, observeBrowserNavigation } from "./browser-navigation";

interface Binding {
  current(): boolean;
  origin: string;
  log(message: string): void;
  openSettings(): void;
  toggleSidebar?(): void;
  selectArea?(id: z.infer<typeof goAreas>[number]["id"]): void;
  openCommandPalette?(search: boolean): void;
  sessionMenu?(...event: SessionMenuEvent): void;
  splitMenu?(command: string): void;
}
type SessionMenuEvent =
  | [name: "toggleSessionPane", pane: "terminal" | "diff" | "preview" | "files" | "side_chat"]
  | [name: "cycleSession", direction: "prev" | "next"]
  | [name: "closeSessionPane" | "findInFiles" | "closeWindow" | "reopenClosedSession" | "openFolder" | "openFile" | "newWindow" | "newSideChat"];
const windows = new WeakMap<BrowserWindow, Binding>();
// Detached, surviving official windows must never fall through to classic routing.
const knownOfficial = new WeakSet<BrowserWindow>();
const observers = new WeakMap<BrowserWindow, () => void>();
interface SidebarReport {
  enabled: boolean;
  open: boolean;
}
const sidebarReports = new WeakMap<BrowserWindow, SidebarReport>();
const goAreas = z.array(z.object({
  id: z.enum(["chat", "cowork", "code"]),
  label: z.string().max(160),
  selected: z.boolean(),
  items: z.enum(["chats", "tasks", "sessions"]),
  newProject: z.boolean().optional(),
})).max(3).refine(areas =>
  new Set(areas.map(area => area.id)).size === areas.length &&
  areas.filter(area => area.selected).length <= 1,
);
const areaReports = new WeakMap<BrowserWindow, z.infer<typeof goAreas>>();
const pane = z.object({ enabled: z.boolean(), open: z.boolean() });
const panesSchema = z.object({
  terminal: pane,
  diff: pane,
  preview: pane,
  sideChat: pane,
  files: pane.optional(),
  closePane: pane,
  findInFiles: pane.optional(),
  newSideChat: pane.optional(),
});
const closeTargets = { chat: "Chat", task: "Chat", page: "Page" } as const;
interface SessionMenuReport {
  panes?: z.infer<typeof panesSchema>;
  closeTarget?: keyof typeof closeTargets | null;
  split?: SplitMenuState;
  reopen?: { available: boolean; enabled: boolean };
}
const sessionMenuReports = new WeakMap<BrowserWindow, SessionMenuReport>();
const splitSchema = z.object({
  newRight: z.boolean(),
  newBelow: z.boolean(),
  split: z.boolean(),
  moveLeft: z.boolean(),
  moveRight: z.boolean(),
  moveUp: z.boolean(),
  moveDown: z.boolean(),
});
const splitCommands = {
  "split-new-right": ["newRight", "new_right"],
  "split-new-below": ["newBelow", "new_below"],
  "split-focus-next": ["split", "focus_next"],
  "split-focus-previous": ["split", "focus_previous"],
  "split-move-left": ["moveLeft", "move_left"],
  "split-move-right": ["moveRight", "move_right"],
  "split-move-up": ["moveUp", "move_up"],
  "split-move-down": ["moveDown", "move_down"],
  "split-close": ["split", "close"],
} as const;

const paneCommands = {
  "toggle-terminal": ["terminal", "terminal"],
  "toggle-changes": ["diff", "diff"],
  "toggle-browser": ["preview", "preview"],
  "toggle-files": ["files", "files"],
  "toggle-side-chat": ["sideChat", "side_chat"],
} as const;
const areaCommands = {
  "area-chat": "chat",
  "area-code": "code",
} satisfies Record<string, MenuArea["id"]>;
const menuListeners = new Set<() => void>();
export function onOfficialMenuState(listener: () => void) {
  menuListeners.add(listener);
  return () => {
    menuListeners.delete(listener);
  };
}
function menuStateChanged() {
  for (const listener of menuListeners) {
    try {
      listener();
    } catch {}
  }
}
/** Undefined leaves the classic renderer's report unchanged. */
export function officialSidebarMenuState(
  window: BrowserWindow | null | undefined,
) {
  if (!window || !knownOfficial.has(window)) return undefined;
  const binding = windows.get(window);
  const report =
    binding && current(window, binding)
      ? sidebarReports.get(window)
      : undefined;
  return {
    sidebarOpen: report?.open ?? false,
    sidebarEnabled: report?.enabled ?? false,
  };
}
/** An official window owns this command even when retired or not ready. */
export function toggleOfficialWindowSidebar(
  window: BrowserWindow | null | undefined,
): boolean {
  if (!window || !knownOfficial.has(window)) return false;
  const binding = windows.get(window);
  if (
    binding &&
    current(window, binding) &&
    sidebarReports.get(window)?.enabled
  ) {
    try {
      binding.toggleSidebar?.();
    } catch {
      try {
        binding.log("[official-ui] Sidebar command could not be delivered.");
      } catch {}
    }
  }
  return true;
}
function current(window: BrowserWindow, binding: Binding) {
  try {
    return (
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      binding.current() &&
      new URL(window.webContents.mainFrame.url).origin === binding.origin
    );
  } catch {
    return false;
  }
}
function report(binding: Binding) {
  try {
    binding.log("[official-ui] Settings navigation could not be confirmed.");
  } catch {}
}
/** True means an official binding owns the command, including a retired one.
 * A stale official window must not fall through into the classic renderer. */
export function openOfficialWindowSettings(
  window: BrowserWindow | null | undefined,
): boolean {
  if (!window) return false;
  const binding = windows.get(window);
  if (!binding) return knownOfficial.has(window);
  if (!current(window, binding)) return true;
  try {
    // The original preload's Navigation event lets its consumer choose the
    // existing modal or router fallback, without replacing the whole document.
    binding.openSettings();
  } catch {
    report(binding);
  }
  return true;
}

export function officialMenuHistory(window: BrowserWindow | null) {
  const binding = window && windows.get(window);
  if (!window || !binding || !current(window, binding)) return undefined;
  return navigationState(window.webContents);
}

export function officialMenuAreas(window: BrowserWindow | null) {
  if (!window || !knownOfficial.has(window)) return undefined;
  const binding = windows.get(window);
  const reported = binding && current(window, binding) ? areaReports.get(window) ?? [] : [];
  const home = reported.find(area => area.id !== "code");
  const areas = [
    ...(home ? [{ ...home, id: "chat" as const, label: "Claudex", selected: reported.some(area => area.id !== "code" && area.selected) }] : []),
    ...reported.filter(area => area.id === "code").map(area => ({ ...area, id: "code" as const })),
  ];
  const items = reported.find(area => area.selected)?.items;
  return {
    areas,
    mode: items === "sessions" ? "code" as const : "chat" as const,
    canCycleSession: items !== undefined,
  };
}

export function officialSessionMenuState(
  window: BrowserWindow | null,
): Pick<MenuState, "panes" | "sideChat" | "canClosePane" | "findInFiles" | "closeTarget" | "canReopenClosed" | "splitView"> & {
  canShowReopenClosed: boolean;
  canStartSideChat: boolean;
} | undefined {
  if (!window || !knownOfficial.has(window)) return undefined;
  const binding = windows.get(window);
  const report = binding && current(window, binding) ? sessionMenuReports.get(window) : undefined;
  const code = officialMenuAreas(window)?.mode === "code";
  const panes = code ? report?.panes : undefined;
  const closeTarget =
    code ? (panes?.diff.enabled ? "Session" : panes?.closePane.enabled ? "Pane" : undefined)
    : report?.closeTarget ? closeTargets[report.closeTarget] : undefined;
  const reopen = code ? report?.reopen : undefined;
  return {
    panes: panes ? {
      terminal: panes.terminal,
      changes: panes.diff,
      browser: panes.preview,
      files: panes.files,
    } : initialMenuState.panes,
    sideChat: panes?.sideChat ?? initialMenuState.sideChat,
    splitView: report?.split ?? noSplitMenu,
    canClosePane: panes?.closePane.enabled ?? false,
    findInFiles: panes?.findInFiles?.enabled ?? false,
    closeTarget,
    canShowReopenClosed: reopen?.available ?? false,
    canStartSideChat: panes?.newSideChat?.enabled ?? false,
    canReopenClosed: !!reopen?.available && reopen.enabled,
  };
}

export function runOfficialMenuNavigation(
  window: BrowserWindow | null,
  command: AppCommand,
) {
  if (!window || !knownOfficial.has(window)) return false;
  const binding = windows.get(window);
  const active = binding && current(window, binding) ? binding : undefined;
  switch (command) {
    case "new-chat":
      // The original File > New handler selects its destination in the renderer.
      if (active) window.webContents.send("cmdK", { keyPress: false });
      return true;
    case "new-code-window":
      if (active && officialMenuAreas(window)?.mode === "code") active.sessionMenu?.("newWindow");
      return true;
    case "new-side-chat":
      if (active && officialSessionMenuState(window)?.canStartSideChat) active.sessionMenu?.("newSideChat");
      return true;
    case "back":
      if (active) window.webContents.navigationHistory.goBack();
      return true;
    case "forward":
      if (active) window.webContents.navigationHistory.goForward();
      return true;
    case "search":
    case "search-palette":
      active?.openCommandPalette?.(command === "search-palette");
      return true;
    case "open-folder":
    case "open-file":
      active?.sessionMenu?.(command === "open-folder" ? "openFolder" : "openFile");
      return true;
    case "previous-session":
    case "next-session":
      if (active && officialMenuAreas(window)?.canCycleSession)
        active.sessionMenu?.("cycleSession", command === "previous-session" ? "prev" : "next");
      return true;
    case "area-chat":
    case "area-code": {
      const id = areaCommands[command];
      const area = areaReports.get(window)?.find(area => id === "chat" ? area.id !== "code" : area.id === id);
      if (area) active?.selectArea?.(area.id);
      return true;
    }
    case "toggle-terminal":
    case "toggle-changes":
    case "toggle-browser":
    case "toggle-files":
    case "toggle-side-chat": {
      const [field, name] = paneCommands[command];
      if (active && officialMenuAreas(window)?.mode === "code" &&
          sessionMenuReports.get(window)?.panes?.[field]?.enabled)
        active.sessionMenu?.("toggleSessionPane", name);
      return true;
    }
    case "close-pane":
      if (active && officialSessionMenuState(window)?.canClosePane)
        active.sessionMenu?.("closeSessionPane");
      return true;
    case "find-in-files":
      if (active && officialSessionMenuState(window)?.findInFiles)
        active.sessionMenu?.("findInFiles");
      return true;
    case "close-context":
      if (active && officialSessionMenuState(window)?.closeTarget)
        active.sessionMenu?.("closeWindow");
      return true;
    case "split-new-right":
    case "split-new-below":
    case "split-focus-next":
    case "split-focus-previous":
    case "split-move-left":
    case "split-move-right":
    case "split-move-up":
    case "split-move-down":
    case "split-close": {
      const [allowed, target] = splitCommands[command];
      if (active && sessionMenuReports.get(window)?.split?.[allowed])
        active.splitMenu?.(target);
      return true;
    }
    case "reopen-closed-session":
      if (active && officialSessionMenuState(window)?.canReopenClosed)
        active.sessionMenu?.("reopenClosedSession");
      return true;
    default:
      return false;
  }
}

export function observeOfficialAppMenu(
  window: BrowserWindow,
  binding: Binding,
  platform = process.platform,
) {
  observers.get(window)?.();
  knownOfficial.add(window);
  windows.set(window, binding);
  sidebarReports.delete(window);
  areaReports.delete(window);
  const navigation = (
    _event: unknown,
    _url: string,
    inPlace: boolean,
    mainFrame: boolean,
  ) => {
    if (!mainFrame || inPlace) return;
    const hadSidebar = sidebarReports.delete(window);
    const hadAreas = areaReports.delete(window);
    const hadSession = sessionMenuReports.delete(window);
    if (hadSidebar || hadAreas || hadSession) menuStateChanged();
  };
  window.webContents.on("did-start-navigation", navigation);
  const disposeHistory = observeBrowserNavigation(window.webContents, binding.origin, menuStateChanged);
  const input = (event: { preventDefault(): void }, key: Input) => {
    if (
      key.type !== "keyDown" ||
      key.isAutoRepeat ||
      key.key !== "," ||
      key.shift ||
      key.alt ||
      (platform === "darwin"
        ? !key.meta || key.control
        : !key.control || key.meta)
    )
      return;
    if (!current(window, binding)) return;
    event.preventDefault();
    openOfficialWindowSettings(window);
  };
  window.webContents.on("before-input-event", input);
  const dispose = () => {
    if (observers.get(window) === dispose) {
      observers.delete(window);
      if (windows.get(window) === binding) windows.delete(window);
      const hadSidebar = sidebarReports.delete(window);
      const hadAreas = areaReports.delete(window);
      const hadSession = sessionMenuReports.delete(window);
      if (hadSidebar || hadAreas || hadSession) menuStateChanged();
    }
    window.webContents.removeListener("before-input-event", input);
    window.webContents.removeListener("did-start-navigation", navigation);
    disposeHistory();
  };
  observers.set(window, dispose);
  return dispose;
}
export function registerOfficialAppMenu(
  host: NativeHost,
  getMenu: () => { popup(options: { window: BrowserWindow }): void } | null,
) {
  function reportSession<K extends keyof SessionMenuReport>(
    field: K,
    schema: z.ZodType<SessionMenuReport[K]>,
  ) {
    return (raw: unknown) => {
      const window = host.caller;
      const binding = window && windows.get(window);
      if (!window || !binding || !current(window, binding)) throw Error("This account window has retired.");
      const value = schema.parse(raw);
      const currentReport = sessionMenuReports.get(window) ?? {};
      if (JSON.stringify(currentReport[field]) === JSON.stringify(value)) return;
      sessionMenuReports.set(window, { ...currentReport, [field]: value });
      menuStateChanged();
    };
  }
  host.on("LocalSessions.setSessionPaneMenuState", reportSession("panes", panesSchema));
  host.on("WindowControl.reportSplitViewMenuState", reportSession("split", splitSchema));
  host.on("WindowControl.reportCloseMenuTarget", reportSession("closeTarget", z.enum(["chat", "task", "page"]).nullable()));
  host.on("WindowControl.reportReopenClosedSessionMenuState", reportSession("reopen", z.object({
    available: z.boolean(),
    enabled: z.boolean(),
  })));
  host.on("WindowControl.reportGoMenuAreas", (raw: unknown) => {
    const window = host.caller;
    const binding = window && windows.get(window);
    if (!window || !binding || !current(window, binding))
      throw Error("This account window has retired.");
    const areas = goAreas.parse(raw);
    if (JSON.stringify(areaReports.get(window)) === JSON.stringify(areas)) return;
    areaReports.set(window, areas);
    menuStateChanged();
  });
  host.on("WindowControl.reportSidebarMenuState", (...args: unknown[]) => {
    const raw = args[0];
    if (
      args.length !== 1 ||
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 2 ||
      !Object.hasOwn(raw, "enabled") ||
      !Object.hasOwn(raw, "open") ||
      typeof (raw as SidebarReport).enabled !== "boolean" ||
      typeof (raw as SidebarReport).open !== "boolean"
    )
      throw Error("Invalid sidebar menu state.");
    const window = host.caller,
      binding = window && windows.get(window);
    if (!window || !binding || !current(window, binding))
      throw Error("This account window has retired.");
    const next = {
      enabled: (raw as SidebarReport).enabled,
      open: (raw as SidebarReport).open,
    };
    const old = sidebarReports.get(window);
    if (old?.enabled === next.enabled && old.open === next.open) return;
    sidebarReports.set(window, next);
    menuStateChanged();
  });
  host.on("BrowserNavigation.requestMainMenuPopup", (...args: unknown[]) => {
    if (args.length) throw Error("The application menu takes no arguments.");
    const window = host.caller;
    const binding = window && windows.get(window);
    if (!window || !binding || !current(window, binding))
      throw Error("This account window has retired.");
    const menu = getMenu();
    if (!menu) throw Error("The application menu is unavailable.");
    menu.popup({ window });
  });
}
