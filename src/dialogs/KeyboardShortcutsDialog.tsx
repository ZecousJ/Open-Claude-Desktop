import type { HostSurface } from "../../shared/host";
import type { AppCommand } from "../../shared/types";
import { isMacPlatform, keyTable, shortcutKeys } from "../host/keys";
import { catalogHasFastTier } from "../composer/code/code-fast-mode";
import { useModelCatalog } from "../composer/useComposerServices";
import { Sheet } from "../ui/Sheet";

type Keys = string[];
type Shortcut = { action: string; keys: Keys[] };
type Section = { title: string; shortcuts: Shortcut[] };

/**
 * Which list the dialog shows: the reference design shows one for chats and
 * another on Code's routes.
 */
export type ShortcutContext = "chat" | "code";

/** What else decides the rows (Code: whether any model has a fast tier). */
export interface ShortcutOptions {
  fastMode?: boolean;
}

const general: Section = {
  title: "General",
  shortcuts: [
    // ⌘K opens the palette with Search and Compose; ⇧⌘K opens it on Search.
    { action: "Quick chat or search", keys: [["mod", "K"]] },
    { action: "Search", keys: [["shift", "mod", "K"]] },
    { action: "Incognito chat", keys: [["shift", "mod", "I"]] },
    { action: "Toggle sidebar", keys: [["mod", "B"]] },
    { action: "New chat", keys: [["mod", "N"]] },
    { action: "Keyboard shortcuts", keys: [["mod", "/"]] },
    { action: "Settings", keys: [["mod", ","]] },
  ],
};

/**
 * Chat rows and order. Side chat belongs to Code's Panes section; pinning also
 * appears in chats.
 */
const chatSection: Section = {
  title: "In chats",
  shortcuts: [
    { action: "Send message", keys: [["enter"]] },
    { action: "New line in message", keys: [["shift", "enter"]] },
    {
      action: "Queue for later",
      keys: [["mod", "enter"]],
    },
    { action: "Toggle thinking", keys: [["shift", "mod", "E"]] },
    { action: "Toggle browser", keys: [["shift", "mod", "B"]] },
    { action: "Jump to Browser tab", keys: [["mod", "1…9"]] },
    { action: "Open model menu", keys: [["shift", "mod", "."]] },
    { action: "Add files or photos", keys: [["mod", "U"]] },
    { action: "Stop Claudex’s response", keys: [["Esc"]] },
    { action: "Edit your last message", keys: [["Esc", "Esc"]] },
    // The open chat, whether or not its sidebar row has the focus.
    { action: "Pin / unpin chat", keys: [["mod", "alt", "P"]] },
  ],
};

/**
 * The desktop's chat-switching keys after New chat. Close chat (⌘W) is listed
 * only with the desktop's chat tabs, which Claudex does not have.
 */
/**
 * The sidebar's mode tabs, after Jump to chat and Jump to session on the
 * desktop.
 */
const sidebarTabRows: Shortcut[] = [
  { action: "Next sidebar tab", keys: [["mod", "alt", "right"]] },
  { action: "Previous sidebar tab", keys: [["mod", "alt", "left"]] },
];

const chatSwitchRows: Shortcut[] = [
  {
    action: "Next chat",
    keys: [
      ["shift", "mod", "]"],
      ["ctrl", "tab"],
    ],
  },
  {
    action: "Previous chat",
    keys: [
      ["shift", "mod", "["],
      ["ctrl", "shift", "tab"],
    ],
  },
  { action: "Jump to chat", keys: [["mod", "1…9"]] },
  ...sidebarTabRows,
];

/** The chats' list on the desktop: General ends with Reopen closed session. */
function chatSections(desktop: boolean): Section[] {
  if (!desktop) return [general, chatSection];
  const newChat = general.shortcuts.findIndex((s) => s.action === "New chat");
  return [
    {
      ...general,
      shortcuts: [
        ...general.shortcuts.slice(0, newChat + 1),
        ...chatSwitchRows,
        ...general.shortcuts.slice(newChat + 1),
        { action: "Reopen closed session", keys: [["mod", "shift", "T"]] },
        // A Cowork task's Activity panel.
        { action: "Toggle activity sidebar", keys: [["mod", "shift", "S"]] },
      ],
    },
    chatSection,
  ];
}

/*
 * General (the palette, the window, the sessions, the transcript), Panes and
 * Composer. Only keys Claudex implements are listed; the desktop app adds the
 * keys the web leaves to the browser.
 */

/** Code's General: the window's keys come from the surface's key table. */
const codeGeneralCommands: { command: AppCommand; action: string }[] = [
  { command: "search", action: "Search or start a session" },
  { command: "search-palette", action: "Search" },
  { command: "toggle-sidebar", action: "Toggle sidebar" },
  { command: "shortcuts", action: "Keyboard shortcuts" },
  { command: "settings", action: "Settings" },
  { command: "new-chat", action: "New session" },
];

/** The session keys after the window's. */
function codeSessionRows(mac: boolean, desktop: boolean): Shortcut[] {
  return [
    ...(desktop
      ? [
          { action: "Reopen closed session", keys: [["mod", "shift", "T"]] },
          {
            action: "Next session",
            keys: [
              ["shift", "mod", "]"],
              ["ctrl", "tab"],
            ],
          },
          {
            action: "Previous session",
            keys: [
              ["shift", "mod", "["],
              ["ctrl", "shift", "tab"],
            ],
          },
          { action: "Jump to session", keys: [["mod", "1…9"]] },
          ...sidebarTabRows,
          // Split view.
          { action: "Open session in split view", keys: [["alt", "click"]] },
          {
            action: "New session on the right",
            keys: [mac ? ["ctrl", "mod", "\\"] : ["ctrl", "alt", "\\"]],
          },
          {
            action: "New session below",
            keys: [mac ? ["ctrl", "mod", "-"] : ["ctrl", "alt", "-"]],
          },
          { action: "Focus next split view", keys: [["ctrl", "]"]] },
          { action: "Focus previous split view", keys: [["ctrl", "["]] },
          {
            action: "Close split view",
            keys: [mac ? ["ctrl", "mod", "W"] : ["ctrl", "alt", "W"]],
          },
        ]
      : []),
    // The open session, whether or not its sidebar row has the focus.
    { action: "Pin / unpin session", keys: [["mod", "alt", "P"]] },
    // open_code_session_pr: ⌥⌘G, Ctrl+Alt+G elsewhere.
    { action: "Open session PR", keys: [["mod", "alt", "G"]] },
    // jumpPrevPrompt / jumpNextPrompt: ⌥⌘↑ / ⌥⌘↓, Alt+↑ / Alt+↓ elsewhere.
    {
      action: "Jump to previous prompt",
      keys: [mac ? ["alt", "mod", "up"] : ["alt", "up"]],
    },
    {
      action: "Jump to next prompt",
      keys: [mac ? ["alt", "mod", "down"] : ["alt", "down"]],
    },
    // cycleTranscriptMode: Control+O on every platform.
    { action: "Transcript view", keys: [["ctrl", "O"]] },
    { action: "Stop Claudex’s response", keys: [["Esc"]] },
  ];
}

/**
 * Panes: the desktop's Code panes; the web has the side chat only. The
 * Changes rows, Annotate page and Reload page follow the live claude.ai
 * bundle, 2026-10-12 (toggleDiffFileList, next/prevDiffChange with ⌥F5
 * except on Linux, goToDiffFile, toggleSketchMode; Reload page is ⌘R on
 * macOS and F5 or Ctrl+R elsewhere).
 */
function codePaneRows(
  mac: boolean,
  desktop: boolean,
  linux = false,
): Shortcut[] {
  if (!desktop) return [{ action: "Toggle side chat", keys: [["mod", ";"]] }];
  return [
    { action: "Toggle changes", keys: [["mod", "shift", "D"]] },
    {
      action: "Toggle file list in changes or files",
      keys: [["mod", "shift", "Y"]],
    },
    {
      action: "Next change in changes",
      keys: linux ? [["F7"]] : [["alt", "F5"], ["F7"]],
    },
    {
      action: "Previous change in changes",
      keys: linux
        ? [["shift", "F7"]]
        : [
            ["shift", "alt", "F5"],
            ["shift", "F7"],
          ],
    },
    { action: "Go to file in changes or files", keys: [["mod", "P"]] },
    { action: "Toggle Files", keys: [["mod", "shift", "F"]] },
    { action: "Toggle Browser", keys: [["mod", "shift", "B"]] },
    { action: "Select element in Browser", keys: [["mod", "shift", "S"]] },
    { action: "Annotate page in Browser", keys: [["mod", "shift", "X"]] },
    { action: "New Browser tab", keys: [["mod", "T"]] },
    { action: "Reopen closed Browser tab", keys: [["mod", "shift", "T"]] },
    { action: "Next Browser tab", keys: [["ctrl", "tab"]] },
    { action: "Previous Browser tab", keys: [["ctrl", "shift", "tab"]] },
    { action: "Jump to Browser tab", keys: [["mod", "1…9"]] },
    { action: "Focus address bar in Browser", keys: [["mod", "L"]] },
    {
      action: "Reload page in Browser",
      keys: mac ? [["mod", "R"]] : [["F5"], ["ctrl", "R"]],
    },
    // The terminal's selection into the message (terminal-menu.ts).
    {
      action: "Attach selection as context",
      keys: [["mod", "shift", "L"]],
    },
    // The Terminal key is ⌘J and Ctrl+` on macOS, Ctrl+` elsewhere.
    {
      action: "Toggle terminal",
      keys: mac
        ? [
            ["mod", "J"],
            ["ctrl", "`"],
          ]
        : [["mod", "`"]],
    },
    { action: "Close pane", keys: [["mod", "\\"]] },
    { action: "Expand or collapse pane", keys: [["mod", "shift", "\\"]] },
    // View ▸ Side Chat.
    { action: "Toggle side chat", keys: [["mod", ";"]] },
  ];
}

/**
 * Composer: the menus (⇧⌘M in the app, ⌥⌘M on the web; ⇧⌘I, which the web
 * leaves to the developer tools outside macOS; ⇧⌘E), Fast mode where a
 * model has it, then Add files and Queue.
 */
function codeComposerRows(
  mac: boolean,
  desktop: boolean,
  { fastMode = false }: ShortcutOptions,
): Shortcut[] {
  return [
    {
      action: "Open mode menu",
      keys: [desktop ? ["shift", "mod", "M"] : ["alt", "mod", "M"]],
    },
    ...(desktop || mac
      ? [{ action: "Open model menu", keys: [["shift", "mod", "I"]] }]
      : []),
    { action: "Open effort selector", keys: [["shift", "mod", "E"]] },
    ...(fastMode
      ? [{ action: "Toggle fast mode", keys: [["alt", "mod", "F"]] }]
      : []),
    // An open mode or model menu picks its rows by number.
    { action: "Select menu item", keys: [["1…9"]] },
    { action: "Add files or photos", keys: [["mod", "U"]] },
    {
      action: "Queue for later (while Claudex is working)",
      keys: [["mod", "enter"]],
    },
    // ⌥⌘↵ sends the draft in a forked session (cmd+alt+enter).
    {
      action: desktop
        ? "Send in a forked session (local sessions)"
        : "Fork with this prompt",
      keys: [["alt", "mod", "enter"]],
    },
  ];
}

/** Modifiers in the order a key table's are written for display. */
function tableKeys(
  command: AppCommand,
  surface: HostSurface,
  platform: string,
) {
  const keys = shortcutKeys(command, keyTable(surface, platform));
  if (!keys) return undefined;
  const mac = isMacPlatform(platform);
  return mac && keys.includes("shift")
    ? ["shift", ...keys.filter((key) => key !== "shift")]
    : keys;
}

/** Code's sections on a surface and platform. */
export function codeShortcutSections(
  platform: string,
  surface: HostSurface = "desktop",
  options: ShortcutOptions = {},
): Section[] {
  const mac = isMacPlatform(platform);
  const desktop = surface === "desktop";
  const windowRows = codeGeneralCommands.flatMap(({ command, action }) => {
    const keys = tableKeys(command, surface, platform);
    return keys ? [{ action, keys: [keys] }] : [];
  });
  return [
    {
      title: "General",
      shortcuts: [...windowRows, ...codeSessionRows(mac, desktop)],
    },
    {
      title: "Panes",
      shortcuts: codePaneRows(mac, desktop, /linux/i.test(platform)),
    },
    {
      title: "Composer",
      shortcuts: codeComposerRows(mac, desktop, options),
    },
  ];
}

/** The window-wide commands, in the General section's order. */
const generalCommands: { command: AppCommand; action: string }[] = [
  { command: "search", action: "Quick chat or search" },
  { command: "search-palette", action: "Search" },
  { command: "incognito", action: "Incognito chat" },
  { command: "toggle-sidebar", action: "Toggle sidebar" },
  { command: "new-chat", action: "New chat" },
  { command: "shortcuts", action: "Keyboard shortcuts" },
  { command: "settings", action: "Settings" },
];

/**
 * The web app's list: General comes from the key table the window uses
 * (src/host/keys.ts), so it lists what the browser leaves to the page (New
 * chat is ⇧⌘O; no Settings or back/forward keys; no incognito key where
 * Ctrl+Shift+I opens the developer tools). Modifiers read in each
 * platform's order: ⇧⌘O on macOS, Ctrl Shift O elsewhere.
 */
export function webShortcutSections(
  platform: string,
  context: ShortcutContext = "chat",
  options: ShortcutOptions = {},
): Section[] {
  if (context === "code") return codeShortcutSections(platform, "web", options);
  const general = generalCommands.flatMap(({ command, action }) => {
    const keys = tableKeys(command, "web", platform);
    return keys ? [{ action, keys: [keys] }] : [];
  });
  return [{ title: "General", shortcuts: general }, chatSection];
}

/** The desktop app's list. */
export function desktopShortcutSections(
  platform: string,
  context: ShortcutContext = "chat",
  options: ShortcutOptions = {},
): Section[] {
  return context === "code"
    ? codeShortcutSections(platform, "desktop", options)
    : chatSections(true);
}

const macKeys: Record<string, string> = {
  ctrl: "⌃",
  tab: "⇥",
  mod: "⌘",
  shift: "⇧",
  alt: "⌥",
  enter: "↩",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};
const otherKeys: Record<string, string> = {
  ctrl: "Ctrl",
  tab: "Tab",
  mod: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  enter: "Enter",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

/**
 * Modifiers in each platform's reading order: ⇧⌥⌘ on macOS, Ctrl Alt Shift
 * elsewhere ("Ctrl Shift K", "Ctrl Alt P").
 */
function platformOrder(combo: Keys, mac: boolean): Keys {
  const order = mac
    ? ["ctrl", "shift", "alt", "mod"]
    : ["ctrl", "mod", "alt", "shift"];
  const modifiers = order.filter((key) => combo.includes(key));
  return [...modifiers, ...combo.filter((key) => !order.includes(key))];
}

export function KeyboardShortcutsDialog({
  platform,
  surface = "desktop",
  context = "chat",
  onClose,
}: {
  platform: string;
  /** The web lists the browser-safe keys (W-UI-design §6.4). */
  surface?: HostSurface;
  /** Code's list or the chats' (the live dialog follows the route). */
  context?: ShortcutContext;
  onClose: () => void;
}) {
  const mac = isMacPlatform(platform);
  const names = mac ? macKeys : otherKeys;
  const catalog = useModelCatalog();
  const options = { fastMode: catalogHasFastTier(catalog) };
  const shown =
    surface === "web"
      ? webShortcutSections(platform, context, options)
      : desktopShortcutSections(platform, context, options);
  return (
    <Sheet title="Keyboard shortcuts" onClose={onClose}>
      {shown.map((section) => (
        <section className="shortcuts-section" key={section.title}>
          <h3>{section.title}</h3>
          {section.shortcuts.map((shortcut) => (
            <div className="shortcuts-row" key={shortcut.action}>
              <span>{shortcut.action}</span>
              <span className="shortcuts-keys">
                {shortcut.keys.map((combo, index) => [
                  index > 0 && (
                    <small key={`or-${index}`} aria-hidden="true">
                      or
                    </small>
                  ),
                  <span className="shortcuts-combination" key={`keys-${index}`}>
                    {platformOrder(combo, mac).map((key, keyIndex) => (
                      <kbd key={`${index}-${keyIndex}-${key}`}>
                        {names[key] ?? key}
                      </kbd>
                    ))}
                  </span>,
                ])}
              </span>
            </div>
          ))}
        </section>
      ))}
    </Sheet>
  );
}
