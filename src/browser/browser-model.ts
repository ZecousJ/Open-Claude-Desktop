/**
 * The Browser panel's rules that do not need a window (package R8-D): when
 * the title bar offers the Browser, how the Changes + Browser split opens
 * and closes, the Add server form, what Select element puts in the
 * message, and which settings the panel's menu can show.
 */
import type {
  BrowserState,
  BrowserTabState,
  DevServerState,
  ElementPick,
  LaunchConfiguration,
} from "../../shared/browser";
import { isLocalDevHost } from "../../shared/browser";
import type { Mode } from "../../shared/types";
import { preferenceDefaults } from "../../shared/settings-extras";
import type { SidePanel } from "../conversation/ToolSidePanel";

// ---------------------------------------------------------------------------
// The title bar's Browser toggle

/**
 * Whether the Code title bar shows the Browser (globe) toggle: a desktop build
 * (the web app has no built-in browser), a Code conversation, the administrator
 * has not turned the browser off. With Browser tools off it remains a Preview.
 */
export function browserToggleShown({
  mode,
  capability,
  policyEnabled,
  cloudHosted = false,
}: {
  mode: Mode;
  capability: boolean;
  policyEnabled: boolean;
  settings: Record<string, unknown> | undefined;
  /** A conversation in the cloud has no Browser on this computer. */
  cloudHosted?: boolean;
}) {
  return (
    (mode === "code" || mode === "cowork") &&
    capability &&
    policyEnabled &&
    !cloudHosted
  );
}

// ---------------------------------------------------------------------------
// The panel's state

/** The tab the panel shows. */
export function activeTab(state: BrowserState | undefined) {
  if (!state) return undefined;
  return (
    state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]
  );
}

/** A tab with a web page (not a new tab, not an error or a crash). */
export const tabShowsPage = (tab: BrowserTabState | undefined) =>
  Boolean(
    tab?.url &&
    tab.url !== "about:blank" &&
    !tab.error &&
    !tab.crashed &&
    !tab.restored,
  );

/** A page the system browser can open: http, https or a file. */
export function openableElsewhere(tab: BrowserTabState | undefined) {
  const url = tab?.error?.url || tab?.url || "";
  return /^(https?|file):/i.test(url);
}

/** A tab's title in the tab strip. */
export function tabTitle(tab: BrowserTabState) {
  if (tab.title.trim()) return tab.title.trim();
  if (!tab.url) return "New tab";
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url;
  }
}

/** What a dev server's row says after its name. */
export function devServerStatusLabel(server: DevServerState) {
  switch (server.status) {
    case "running":
      return server.port ? `Running · ${server.port}` : "Running";
    case "starting":
      return "Starting…";
    case "awaiting-approval":
      return "Waiting";
    case "failed":
      return "Failed";
    case "crashed":
      return "Crashed";
    default:
      return server.port ? String(server.port) : "";
  }
}

/** A dev server that is up or on its way (Stop applies). */
export const devServerActive = (server: DevServerState) =>
  server.status === "running" ||
  server.status === "starting" ||
  server.status === "awaiting-approval";

// ---------------------------------------------------------------------------
// The browser settings menu

/**
 * Whether a preference is part of this build's settings. Some of the
 * menu's switches belong to other packages' preferences (Open links in
 * built-in browser, Auto-verify changes, Allowed sites, Keep cookies);
 * each shows once its preference exists, saved or not: the original lists
 * them whatever the person has saved, and the Settings page shows the same
 * switches at their defaults.
 */
export const hasPreference = (key: string) =>
  Object.hasOwn(preferenceDefaults, key);

export const keepCookiesLabels = {
  "until-quit": "Until quit",
  always: "Shared",
  "per-session": "Per session",
} as const;

// ---------------------------------------------------------------------------
// Add server

/** The Add server form as typed. */
export interface ServerDraft {
  name: string;
  command: string;
  port: string;
  url: string;
  cwd: string;
}

export const emptyDraft: ServerDraft = {
  name: "",
  command: "",
  port: "",
  url: "",
  cwd: "",
};

/**
 * Splits a command the way a shell reads words: spaces separate them,
 * single quotes keep everything, double quotes keep spaces (a backslash
 * escapes `"`, `\` and `$`), a backslash outside quotes escapes the next
 * character. Nothing is expanded: the command never runs through a shell.
 */
export function splitCommandLine(
  text: string,
): { ok: true; words: string[] } | { ok: false; message: string } {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\" && /["\\$`]/.test(text[i + 1] ?? "")) {
        word += text[++i];
      } else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < text.length) {
      word += text[++i];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return { ok: false, message: "The command has an open quote." };
  if (started) words.push(word);
  return { ok: true, words };
}

/** One word as a shell would need it written. */
function quoteWord(word: string) {
  if (word && /^[\w@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** A configuration's command as one line (executable and arguments). */
export function commandLineOf(config: LaunchConfiguration) {
  return [config.runtimeExecutable, ...(config.runtimeArgs ?? [])]
    .map(quoteWord)
    .join(" ");
}

/** The form for an existing or detected configuration. */
export function draftOf(config?: LaunchConfiguration): ServerDraft {
  if (!config) return { ...emptyDraft };
  return {
    name: config.name,
    command: commandLineOf(config),
    port: config.port ? String(config.port) : "",
    url: config.url ?? "",
    cwd: config.cwd && config.cwd !== "." ? config.cwd : "",
  };
}

/** Whether a URL is a local development address the preview may open. */
function localPreviewUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      isLocalDevHost(url.host)
    );
  } catch {
    return false;
  }
}

/**
 * The configuration the form describes, or why it cannot be saved. The
 * rules follow `.claude/launch.json` (package R8-B checks them again): a
 * name up to 64 characters, a command, a port 1–65535, a URL on this
 * computer (localhost, 127.0.0.1, [::1], *.localhost) and a working
 * folder inside the session's folder.
 */
export function configFromDraft(
  draft: ServerDraft,
  existing: readonly string[] = [],
  editing?: string,
): { ok: true; config: LaunchConfiguration } | { ok: false; message: string } {
  const name = draft.name.trim();
  if (!name) return { ok: false, message: "Enter a name." };
  if (name.length > 64)
    return { ok: false, message: "Use a name of 64 characters or fewer." };
  if (name !== editing && existing.includes(name))
    return { ok: false, message: "A server with this name already exists." };
  const split = splitCommandLine(draft.command);
  if (!split.ok) return split;
  const [runtimeExecutable, ...runtimeArgs] = split.words;
  if (!runtimeExecutable)
    return { ok: false, message: "Enter the command that starts the server." };
  if (runtimeExecutable.length > 256 || runtimeArgs.length > 64)
    return { ok: false, message: "The command is too long." };
  let port: number | undefined;
  if (draft.port.trim()) {
    port = Number(draft.port.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return { ok: false, message: "Enter a port from 1 to 65535." };
  }
  const url = draft.url.trim() || undefined;
  if (url && !localPreviewUrl(url))
    return {
      ok: false,
      message: "Use an address on this computer, like http://localhost:5173.",
    };
  if (!port && !url)
    return { ok: false, message: "Enter the port the server listens on." };
  const cwd = draft.cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (
    cwd &&
    (cwd.startsWith("/") ||
      /^[a-z]:/i.test(cwd) ||
      cwd.startsWith("~") ||
      cwd.split("/").includes(".."))
  )
    return {
      ok: false,
      message: "Use a folder inside this session's folder, like apps/web.",
    };
  return {
    ok: true,
    config: {
      name,
      runtimeExecutable,
      ...(runtimeArgs.length ? { runtimeArgs } : {}),
      ...(port ? { port } : {}),
      ...(url ? { url } : {}),
      ...(cwd && cwd !== "." ? { cwd } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Select element

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/**
 * What Select element adds to the message: where the element is, its
 * selector and its HTML, so Claude can find it in the code.
 */
export function elementPickText(pick: ElementPick) {
  const lines = [
    `Selected element on ${pick.url}:`,
    `Selector: \`${pick.selector}\``,
  ];
  const text = pick.text.replace(/\s+/g, " ").trim();
  if (text) lines.push(`Text: "${clip(text, 200)}"`);
  const styles = Object.entries(pick.styles)
    .slice(0, 12)
    .map(([key, value]) => `${key}: ${value};`)
    .join(" ");
  if (styles) lines.push(`Styles: ${styles}`);
  const fence = pick.outerHTML.includes("```") ? "````" : "```";
  lines.push(`${fence}html`, clip(pick.outerHTML, 2000), fence);
  return lines.join("\n");
}

/** The message text with an element appended after what is typed. */
export const appendToDraft = (draft: string, addition: string) =>
  draft.trim()
    ? `${draft.replace(/\s+$/, "")}\n\n${addition}\n`
    : `${addition}\n`;

// ---------------------------------------------------------------------------
// Menus and dialogs over the page

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Whether two boxes share any area. */
export const boxesOverlap = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
