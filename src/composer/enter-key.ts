/**
 * Whether a plain Enter sends the draft. It does in the desktop app, on
 * Windows, and wherever the screen is not a touch screen; on a phone or a
 * tablet Enter starts a new line, and Send (or ⌘/Ctrl+Enter on a keyboard)
 * sends.
 */
export function plainEnterSends(
  desktopApp: boolean,
  env: {
    navigator?: { userAgent?: string; maxTouchPoints?: number };
    matchMedia?: (query: string) => { matches: boolean };
  } = typeof window === "undefined" ? {} : window,
) {
  if (desktopApp) return true;
  const agent = env.navigator?.userAgent ?? "";
  if (agent.includes(" Electron/")) return true;
  if (/win32|win64|windows|wince/i.test(agent)) return true;
  const coarse =
    typeof env.matchMedia === "function" &&
    env.matchMedia("(pointer: coarse)").matches;
  return !(coarse && (env.navigator?.maxTouchPoints ?? 0) > 0);
}

/**
 * What Enter does in the composer: "send", "newline" (left to the text
 * box), or nothing of its own. Shift+Enter and Alt+Enter always start a new
 * line; ⌘/Ctrl+Enter always sends.
 */
export function enterAction(
  event: {
    key: string;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    isComposing?: boolean;
  },
  plainSends: boolean,
): "send" | "newline" | undefined {
  if (event.key !== "Enter" || event.isComposing) return undefined;
  if (event.shiftKey || event.altKey) return "newline";
  if (event.metaKey || event.ctrlKey || plainSends) return "send";
  return "newline";
}
