import type { BaseWindow, MenuItemConstructorOptions } from "electron";
import type { AppCommand } from "../../shared/types";
import { initialMenuState, type MenuState } from "../../shared/menu-state";

export interface AppMenuOptions {
  fullScreen?: boolean;
  translate?: (value: string) => string;
  mac: boolean;
  appName: string;
  /** Runs a command the window handles. */
  run: (command: AppCommand) => void;
  checkForUpdates: () => void;
  /** Brings the main window forward (Window ▸ Show Main Window, R2). */
  showMainWindow: () => void;
  /**
   * What the main window reports about itself (shared/menu-state.ts): the
   * mode, the sidebar and panes, history and what can be reopened. Absent:
   * the state of a window that has not reported yet.
   */
  state?: MenuState;
  /** Code surface and its Open File / Open Folder rollouts (both default on). */
  codeSurface?: {
    enabled: boolean;
    openFileFromAnySurface: boolean;
    openFolder: boolean;
  };
  /**
   * The updates item while Claudex updates itself: "Checking for Updates…",
   * "Downloading Update…" (both disabled), "Restart to Update to 1.2" or "Check
   * for Updates…" with a disabled "Last Update Attempt Failed" line under it.
   * Absent: updates are hidden.
   */
  updateItem?: { label: string; enabled: boolean; failed?: boolean };
  /** Help and Get Support: the administrator's help page, else Claudex's site. */
  openHelp?: () => void;
  /** Help ▸ Troubleshooting ▸ Show Logs; absent: the item is greyed. */
  showLogs?: () => void;
  /** Help ▸ Troubleshooting ▸ Clear Cache and Restart; absent: greyed. */
  clearCacheAndRestart?: () => void;
  /**
   * The rest of Help ▸ Troubleshooting (electron/troubleshooting.ts): Copy
   * Installation ID, Generate Diagnostic Report, Record Net Log (30s),
   * Disable Hardware Acceleration and Reset App Data…. Absent: left out.
   */
  troubleshooting?: {
    copyInstallationId: () => void;
    generateDiagnosticReport: () => void;
    recordNetLog: (window?: BaseWindow) => void;
    hardwareAccelerationDisabled: boolean;
    setHardwareAccelerationDisabled: (disabled: boolean) => void;
    resetAppData: () => void;
  };
  /** Help ▸ Troubleshooting ▸ Enable Developer Mode, when policy allows it. */
  enableDeveloperMode?: () => void;
  developerModeLabel?: string;
  developerTools?: {
    open: () => void;
    openAll: () => void;
    label: string;
    openLabel: string;
    openAllLabel: string;
  };
  /** Help ▸ About (and the macOS app menu's): the About window. */
  about?: () => void;
  /**
   * Edit ▸ Find…, Find Next and Find Previous: the find bar in the focused
   * app window (electron/find-in-page.ts). Absent: the items are greyed.
   */
  find?: {
    open: (window?: BaseWindow) => void;
    step: (window: BaseWindow | undefined, forward: boolean) => void;
  };
  /**
   * View ▸ Zoom In, Zoom Out and Actual Size, applied to every app window
   * (electron/window-zoom.ts). Absent: Electron's own zoom roles.
   */
  zoom?: {
    level: () => number;
    step: (delta: number) => void;
    reset: () => void;
  };
  /**
   * View ▸ Reload: the Browser's page when the Browser has the focus, else
   * the window (app-menu.ts). Absent: Electron's own reload role.
   */
  reload?: (window?: BaseWindow) => void;
  editCommand?: (command: "undo" | "redo") => void;
}

/** How the first File item reads in each mode (the original: New Chat, Task, Session). */
const newItemLabels = {
  chat: "New Chat",
  cowork: "New Chat",
  code: "New Session",
} as const;
/** The Go menu's Previous and Next items follow the mode the same way. */
const cycleNames = { chat: "Chat", cowork: "Chat", code: "Session" } as const;

/**
 * The application menu follows the 2.37337.1 desktop template. Its app-named
 * menu is present on every platform; macOS-only roles are omitted elsewhere.
 * File's Open actions follow the Code surface and rollout gates.
 */
export function appMenuTemplate({
  editCommand,
  mac,
  appName,
  run,
  checkForUpdates,
  showMainWindow,
  state = initialMenuState,
  codeSurface = {
    enabled: true,
    openFileFromAnySurface: true,
    openFolder: true,
  },
  updateItem,
  openHelp,
  showLogs,
  clearCacheAndRestart,
  troubleshooting,
  enableDeveloperMode,
  developerModeLabel = "Enable Developer Mode…",
  developerTools,
  about,
  find,
  zoom,
  reload,
  fullScreen = false,
  translate = (value) => value,
}: AppMenuOptions): MenuItemConstructorOptions[] {
  const page = (
    label: string,
    command: AppCommand,
    accelerator: string,
    enabled = true,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    enabled,
    click: () => run(command),
  });
  // After a failed attempt the item stays and says so beneath itself.
  const updateItems: MenuItemConstructorOptions[] = [
    ...(updateItem
      ? [
          {
            label: translate(updateItem.label),
            enabled: updateItem.enabled,
            click: checkForUpdates,
          },
        ]
      : []),
    ...(updateItem?.failed
      ? [{ label: translate("Last Update Attempt Failed"), enabled: false }]
      : []),
  ];
  const showMain: MenuItemConstructorOptions = {
    label: "Show Main Window",
    click: showMainWindow,
  };
  /** An entry Claudex cannot act on yet: greyed, without a shortcut. */
  const off = (label: string): MenuItemConstructorOptions => ({
    label,
    enabled: false,
  });
  const fileManager = mac ? "Finder" : "File Explorer";
  /** Shared shortcuts on every platform. */
  const findItem = (
    label: string,
    accelerator: string,
    click?: (window?: BaseWindow) => void,
  ): MenuItemConstructorOptions =>
    find && click
      ? { label, accelerator, click: (_item, window) => click(window) }
      : { label, accelerator, enabled: false, registerAccelerator: false };
  const findItems: MenuItemConstructorOptions[] = [
    findItem("Find…", "CmdOrCtrl+F", find?.open),
    findItem(
      "Find Next",
      "CmdOrCtrl+G",
      find && ((window) => find.step(window, true)),
    ),
    findItem(
      "Find Previous",
      "CmdOrCtrl+Shift+G",
      find && ((window) => find.step(window, false)),
    ),
    { type: "separator" },
    {
      label: translate("Find in Files…"),
      enabled: codeSurface.enabled && Boolean(state.findInFiles),
      click: () => run("find-in-files"),
    },
  ];
  /**
   * A switch the View menu shows: macOS says Show or Hide, Windows keeps the
   * name with a check (the original's checkbox variant).
   */
  const toggle = (
    names: { show: string; hide: string; name: string },
    open: boolean,
    command: AppCommand,
    accelerator: string,
    enabled: boolean,
  ): MenuItemConstructorOptions =>
    mac
      ? {
          label: open ? names.hide : names.show,
          accelerator,
          registerAccelerator: false,
          enabled,
          click: () => run(command),
        }
      : {
          label: names.name,
          type: "checkbox",
          checked: open,
          accelerator,
          registerAccelerator: false,
          enabled,
          click: () => run(command),
        };
  const { panes, splitView: split } = state;
  /** Split View ▸ Move: no shortcut of its own. */
  const splitMove = (
    label: string,
    command: AppCommand,
    enabled: boolean,
  ): MenuItemConstructorOptions => ({
    label,
    enabled,
    click: () => run(command),
  });
  const zoomItems: MenuItemConstructorOptions[] = zoom
    ? [
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          enabled: zoom.level() !== 0,
          click: zoom.reset,
        },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+Plus",
          click: () => zoom.step(0.5),
        },
        {
          label: "Zoom In (alternate)",
          accelerator: "CmdOrCtrl+=",
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: () => zoom.step(0.5),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: () => zoom.step(-0.5),
        },
      ]
    : [
        { role: "resetZoom", label: "Actual Size" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ];
  const cycle = cycleNames[state.mode];
  const openItems = [
    ...((
      codeSurface.openFileFromAnySurface
        ? codeSurface.enabled
        : state.mode === "code"
    )
      ? [page("Open File…", "open-file", "CmdOrCtrl+O")]
      : []),
    ...(codeSurface.enabled && codeSurface.openFolder
      ? [page("Open Folder…", "open-folder", "CmdOrCtrl+Shift+O")]
      : []),
  ];
  return [
    {
      label: appName,
      submenu: [
        about
          ? ({ label: `About ${appName}`, click: about } as const)
          : ({ role: "about" } as const),
        { type: "separator" },
        page("Settings…", "settings", "CmdOrCtrl+,"),
        ...updateItems,
        ...(mac
          ? [
              { type: "separator" } as const,
              { role: "services" } as const,
              { type: "separator" } as const,
              { role: "hide" } as const,
              { role: "hideOthers" } as const,
              { role: "unhide" } as const,
            ]
          : []),
        { type: "separator" },
        {
          role: "quit",
          label: `Quit ${appName}`,
          accelerator: "CmdOrCtrl+Q",
        },
      ],
    } satisfies MenuItemConstructorOptions,
    {
      label: "File",
      submenu: [
        // New Chat, New Task or New Session follows the window's mode.
        page(newItemLabels[state.mode], "new-chat", "CmdOrCtrl+N"),
        ...(mac || state.mode !== "code"
          ? []
          : [off("New Session in New Window")]),
        // Code only, as the original; the shortcut is View ▸ Side Chat's.
        ...(state.mode === "code"
          ? [
              {
                label: "New Side Chat",
                enabled: state.sideChat.enabled && !state.sideChat.open,
                click: () => run("toggle-side-chat"),
              },
            ]
          : []),
        ...(openItems.length
          ? [{ type: "separator" } as const, ...openItems]
          : []),
        { type: "separator" },
        ...(state.closeTarget
          ? [
              {
                label: translate(`Close ${state.closeTarget}`),
                accelerator: "CmdOrCtrl+W",
                click: () => run("close-context"),
              },
            ]
          : [
              {
                role: "close" as const,
                label: translate("Close Window"),
                accelerator: "CmdOrCtrl+W",
              },
            ]),
        {
          role: "close",
          label: translate("Close Window"),
          accelerator: "CmdOrCtrl+Shift+W",
          visible: Boolean(state.closeTarget),
          acceleratorWorksWhenHidden: true,
        },
        page(
          "Reopen Closed Session",
          "reopen-closed-session",
          "CmdOrCtrl+Shift+T",
          state.canReopenClosed,
        ),
      ],
    },
    mac
      ? {
          // The standard Edit menu, then Find ▸ as in the original's macOS
          // menu (Find…, Find Next, Find Previous, Find in Files…).
          label: "Edit",
          submenu: [
            ...(editCommand
              ? [
                  {
                    label: "Undo",
                    accelerator: "CmdOrCtrl+Z",
                    click: () => editCommand("undo"),
                  },
                  {
                    label: "Redo",
                    accelerator: "CmdOrCtrl+Shift+Z",
                    click: () => editCommand("redo"),
                  },
                ]
              : [{ role: "undo" as const }, { role: "redo" as const }]),
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "pasteAndMatchStyle" },
            { role: "delete" },
            { role: "selectAll" },
            { type: "separator" },
            { label: "Find", submenu: findItems },
          ],
        }
      : {
          label: "Edit",
          submenu: [
            ...(editCommand
              ? [
                  {
                    label: "Undo",
                    accelerator: "CmdOrCtrl+Z",
                    click: () => editCommand("undo"),
                  },
                  {
                    label: "Redo",
                    accelerator: "CmdOrCtrl+Y",
                    click: () => editCommand("redo"),
                  },
                ]
              : [{ role: "undo" as const }, { role: "redo" as const }]),
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "delete" },
            { role: "selectAll" },
            { type: "separator" },
            { label: "Find", submenu: findItems },
          ],
        },
    {
      label: "View",
      submenu: [
        // R-0129 (Windows crop, macOS tree). Command Palette is the Search
        // panel. Terminal, Changes and Browser toggle the Code panes of the
        // open session (greyed outside Code, and where the pane is
        // unavailable); Side Chat toggles the open conversation's side chat
        // (Chat and Code, after its first reply). Split View is the window's
        // sessions side by side (src/split-view): its items follow what the
        // window reports. Files has no pane yet and stays greyed, as the
        // original greys it outside a session too.
        page("Command Palette…", "search", "CmdOrCtrl+K"),
        toggle(
          { show: "Show Sidebar", hide: "Hide Sidebar", name: "Sidebar" },
          state.sidebarOpen,
          "toggle-sidebar",
          "CmdOrCtrl+B",
          state.sidebarEnabled,
        ),
        { type: "separator" },
        toggle(
          { show: "Show Terminal", hide: "Hide Terminal", name: "Terminal" },
          panes.terminal.open,
          "toggle-terminal",
          "Command+J",
          panes.terminal.enabled,
        ),
        toggle(
          { show: "Show Changes", hide: "Hide Changes", name: "Changes" },
          panes.changes.open,
          "toggle-changes",
          "CmdOrCtrl+Shift+D",
          panes.changes.enabled,
        ),
        toggle(
          { show: "Show Browser", hide: "Hide Browser", name: "Browser" },
          panes.browser.open,
          "toggle-browser",
          "CmdOrCtrl+Shift+B",
          panes.browser.enabled,
        ),
        state.panes.files
          ? toggle(
              { show: "Show Files", hide: "Hide Files", name: "Files" },
              state.panes.files.open,
              "toggle-files",
              "CmdOrCtrl+Shift+F",
              state.panes.files.enabled,
            )
          : off(mac ? "Show Files" : "Files"),
        toggle(
          {
            show: "Show Side Chat",
            hide: "Hide Side Chat",
            name: "Side Chat",
          },
          state.sideChat.open,
          "toggle-side-chat",
          "CmdOrCtrl+;",
          state.sideChat.enabled,
        ),
        page("Close Pane", "close-pane", "CmdOrCtrl+\\", state.canClosePane),
        { type: "separator" },
        {
          label: "Split View",
          submenu: [
            page(
              "New Session on the Right",
              "split-new-right",
              mac ? "Control+Command+\\" : "Ctrl+Alt+\\",
              split.newRight,
            ),
            page(
              "New Session Below",
              "split-new-below",
              mac ? "Control+Command+-" : "Ctrl+Alt+-",
              split.newBelow,
            ),
            { type: "separator" },
            page(
              "Focus Next Split View",
              "split-focus-next",
              "Control+]",
              split.split,
            ),
            page(
              "Focus Previous Split View",
              "split-focus-previous",
              "Control+[",
              split.split,
            ),
            { type: "separator" },
            splitMove(
              "Move Split View Left",
              "split-move-left",
              split.moveLeft,
            ),
            splitMove(
              "Move Split View Right",
              "split-move-right",
              split.moveRight,
            ),
            splitMove("Move Split View Up", "split-move-up", split.moveUp),
            splitMove(
              "Move Split View Down",
              "split-move-down",
              split.moveDown,
            ),
            { type: "separator" },
            page(
              "Close Split View",
              "split-close",
              mac ? "Control+Command+W" : "Ctrl+Alt+W",
              split.split,
            ),
          ],
        },
        { type: "separator" },
        ...zoomItems,
        { type: "separator" },
        {
          role: "togglefullscreen",
          label: translate(
            fullScreen ? "Exit Full Screen" : "Enter Full Screen",
          ),
          accelerator: "Control+Command+F",
        },
        { type: "separator" },
        // Reload.
        reload
          ? {
              label: "Reload",
              accelerator: "CmdOrCtrl+R",
              click: (_item, window) => reload(window),
            }
          : { role: "reload" },
      ],
    },
    {
      // Go (both platforms; the original puts it after View): the area
      // list when the window reports two or more, Back and Forward
      // following the window's history, Previous and Next cycling through
      // the sidebar's chats, tasks or sessions (src/app/session-cycle.ts),
      // and Search…, with the 2.37337.1 template's Command keys on every
      // platform (the renderer keeps Ctrl+Tab and Ctrl+K of its own).
      label: "Go",
      submenu: [
        ...(state.areas && state.areas.length >= 2
          ? [
              ...state.areas
                .slice(0, 8)
                .map((area): MenuItemConstructorOptions => ({
                  label: area.label,
                  type: "checkbox",
                  checked: area.selected,
                  click: () =>
                    run(area.id === "code" ? "area-code" : "area-chat"),
                })),
              { type: "separator" } as const,
            ]
          : []),
        page("Back", "back", "CmdOrCtrl+[", state.canGoBack),
        page("Forward", "forward", "CmdOrCtrl+]", state.canGoForward),
        { type: "separator" },
        page(
          `Previous ${cycle}`,
          "previous-session",
          "Command+Shift+[",
          state.canCycleSession,
        ),
        page(
          `Next ${cycle}`,
          "next-session",
          "Command+Shift+]",
          state.canCycleSession,
        ),
        { type: "separator" },
        page("Search…", "search-palette", "Command+Shift+K"),
      ],
    },
    {
      // The 2.37337.1 Window menu on every platform: Minimize, Zoom, Show
      // Main Window and Bring All to Front between separators; macOS still
      // appends the window list, which names each conversation window by
      // its title.
      role: "window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        showMain,
        { type: "separator" },
        { role: "front" },
      ],
    },
    ...(developerTools
      ? [
          {
            label: developerTools.label,
            submenu: [
              {
                label: developerTools.openLabel,
                accelerator: "CommandOrControl+Alt+I",
                click: developerTools.open,
              },
              {
                label: developerTools.openAllLabel,
                click: developerTools.openAll,
              },
            ],
          },
        ]
      : []),
    {
      // Help, Keyboard Shortcuts, Troubleshooting ▸ and Get Support, never
      // greyed (2.37337.1 zEi): Help and Get Support open the
      // administrator's help page, else Claudex's site. Updates and About
      // live in the app-named menu on every platform.
      role: "help",
      submenu: [
        { label: `${appName} Help`, click: openHelp },
        page("Keyboard Shortcuts", "shortcuts", "CmdOrCtrl+/"),
        { type: "separator" },
        {
          label: "Troubleshooting",
          submenu: [
            showLogs
              ? { label: `Show Logs in ${fileManager}`, click: showLogs }
              : off(`Show Logs in ${fileManager}`),
            ...(troubleshooting
              ? [
                  {
                    label: "Copy Installation ID",
                    click: troubleshooting.copyInstallationId,
                  },
                  {
                    label: "Generate Diagnostic Report",
                    click: troubleshooting.generateDiagnosticReport,
                  },
                  {
                    label: "Record Net Log (30s)",
                    click: (_item: unknown, window?: BaseWindow) =>
                      troubleshooting.recordNetLog(window),
                  },
                  { type: "separator" } as const,
                  {
                    label: "Disable Hardware Acceleration",
                    type: "checkbox" as const,
                    checked: troubleshooting.hardwareAccelerationDisabled,
                    click: (item: { checked: boolean }) =>
                      troubleshooting.setHardwareAccelerationDisabled(
                        item.checked,
                      ),
                  },
                  { type: "separator" } as const,
                ]
              : []),
            clearCacheAndRestart
              ? {
                  label: "Clear Cache and Restart",
                  click: clearCacheAndRestart,
                }
              : off("Clear Cache and Restart"),
            ...(troubleshooting
              ? [
                  {
                    label: "Reset App Data…",
                    click: troubleshooting.resetAppData,
                  },
                ]
              : []),
            ...(enableDeveloperMode
              ? [{ label: developerModeLabel, click: enableDeveloperMode }]
              : []),
          ],
        },
        { type: "separator" },
        { label: "Get Support", click: openHelp },
      ],
    },
  ];
}
