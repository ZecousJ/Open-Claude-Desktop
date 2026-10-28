import type { ITheme } from "@xterm/xterm";

/**
 * The terminal's colours: the original's claude-dark and claude-light code
 * themes as its terminal reads them: surface-2 behind, text-primary text, the
 * blue cursor, pink for magenta and purple for cyan, the bright greens and
 * yellows as the plain ones.
 */
const palettes = {
  dark: {
    bg: "#1a1a19",
    fg: "#f0efec",
    selection: "#0099ff4d",
    black: "#262626",
    brightBlack: "#525252",
    white: "#a6a6a6",
    brightWhite: "#ededed",
    red: "#ff3a30",
    brightRed: "#ff5047",
    green: "#32d74b",
    yellow: "#ffd014",
    blue: "#0099ff",
    brightBlue: "#0087ee",
    pink: "#ff2c56",
    purple: "#b796ff",
  },
  light: {
    bg: "#ffffff",
    fg: "#1a1a1a",
    selection: "#0073e640",
    black: "#1a1a1a",
    brightBlack: "#666666",
    white: "#999999",
    brightWhite: "#d6d6d6",
    red: "#ff3a30",
    brightRed: "#ff5047",
    green: "#1e9e3c",
    yellow: "#98801f",
    blue: "#0073e6",
    brightBlue: "#0078f0",
    pink: "#cd2054",
    purple: "#8e6bd9",
  },
};

export function terminalTheme(mode: "dark" | "light"): ITheme {
  const p = palettes[mode];
  return {
    background: p.bg,
    foreground: p.fg,
    cursor: p.blue,
    cursorAccent: p.bg,
    selectionBackground: p.selection,
    black: p.black,
    red: p.red,
    green: p.green,
    yellow: p.yellow,
    blue: p.blue,
    magenta: p.pink,
    cyan: p.purple,
    white: p.white,
    brightBlack: p.brightBlack,
    brightRed: p.brightRed,
    brightGreen: p.green,
    brightYellow: p.yellow,
    brightBlue: p.brightBlue,
    brightMagenta: p.pink,
    brightCyan: p.purple,
    brightWhite: p.brightWhite,
  };
}

/** Whether the window shows its light theme now. */
export function windowMode(): "dark" | "light" {
  const theme = document.documentElement.dataset.theme;
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}
