/**
 * The Code Browser panel (R8): the state the main process sends the window,
 * the dev server and element pick shapes, and the address bar rules. The
 * main process keeps one Browser session per Code conversation
 * (`electron/browser/browser-host.ts`); the panel draws this state and
 * sends its calls through `PanelsAPI` (`shared/panels-api.ts`).
 */
import type { BrowserEventState } from "./types";

/**
 * The page size the panel shows (the original's Viewport: Responsive, Mobile
 * 375 × 812, Tablet 768 × 1024): the panel's own width ("desktop"), a phone
 * or a tablet.
 */
export type BrowserViewportPreset = "desktop" | "mobile" | "tablet";
export type BrowserViewport =
  BrowserViewportPreset | { width: number; height: number };
export const browserViewports: readonly BrowserViewportPreset[] = [
  "desktop",
  "mobile",
  "tablet",
];

/** The prefers-color-scheme pages see: the app's own ("system"), light or dark. */
export type BrowserColorScheme = "system" | "light" | "dark";
export const browserColorSchemes: readonly BrowserColorScheme[] = [
  "system",
  "light",
  "dark",
];

/**
 * Settings → Claude Code → Browser → Keep cookies. "until-quit" (the
 * default) shares one browser that forgets everything when Claudex quits;
 * "always" shares one saved browser; "per-session" saves a separate browser
 * for each Code session.
 */
export type BrowserKeepCookies = "until-quit" | "always" | "per-session";
export const browserKeepCookiesChoices: readonly BrowserKeepCookies[] = [
  "until-quit",
  "always",
  "per-session",
];
/** A stored Keep cookies value, or the default for anything else. */
export function keepCookiesOf(value: unknown): BrowserKeepCookies {
  return browserKeepCookiesChoices.includes(value as BrowserKeepCookies)
    ? (value as BrowserKeepCookies)
    : "until-quit";
}

/** Why a page is not showing, from Chromium's load error. */
export interface BrowserLoadError {
  /** Chromium's net error code (negative), or 0 for a refusal of ours. */
  code: number;
  /** Chromium's name for it (`ERR_CONNECTION_REFUSED`) or our own reason. */
  description: string;
  url: string;
}

/** A page's JavaScript dialog waiting for an answer (alert is answered at once). */
export interface BrowserPageDialog {
  type: "confirm" | "prompt" | "beforeunload";
  message: string;
  /** The page's origin, for "<origin> says:". */
  origin: string;
  /** A prompt's default text. */
  defaultValue?: string;
}

export interface BrowserTabState {
  canExportFile?: boolean;
  id: string;
  /** "" for a new tab that has not opened a page. */
  url: string;
  /** The page title, "New tab" before a page opens. */
  title: string;
  /** An http(s) or data: icon the page declared. */
  faviconUrl?: string;
  loading: boolean;
  /** The page arrived but has not finished loading after 20 seconds. */
  stalled: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: BrowserLoadError;
  /** The page's renderer process ended. */
  crashed?: boolean;
  dialog?: BrowserPageDialog;
  /** Something the page tried that the built-in browser does not do. */
  notice?: { kind: "download-blocked"; filename: string };
  restored?: { jpegBase64: string; serverName?: string };
}

export interface BrowserSavedPage {
  url: string;
  title: string;
  jpegBase64: string;
  serverName?: string;
}

export type DevServerStatus =
  | "stopped"
  | "awaiting-approval"
  | "starting"
  | "running"
  | "failed"
  | "crashed";

export interface DevServerState {
  name: string;
  /** The command as shown to the person (executable and arguments). */
  command: string;
  port?: number;
  url?: string;
  status: DevServerStatus;
  pid?: number;
  startedAt?: number;
  error?: string;
  /** From the folder's launch.json, or a local address seen in terminal output. */
  source: "launch.json" | "detected-output";
}

/**
 * One configuration of `.claude/launch.json` (the format Claude's desktop
 * app uses). Package R8-B validates it (`shared/launch-config.ts`).
 */
export interface LaunchConfiguration {
  name: string;
  runtimeExecutable: string;
  runtimeArgs?: string[];
  port?: number;
  url?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** A Code conversation's Browser panel, as the main process sees it. */
export interface BrowserState extends BrowserEventState {
  conversationId: string;
  tabs: BrowserTabState[];
  activeTabId?: string;
  viewport: BrowserViewport;
  colorScheme: BrowserColorScheme;
  devServers: DevServerState[];
  /** Whether dev servers can be listed and started here (R8-B, and the administrator). */
  devServersAvailable: boolean;
  launchConfigPath?: string;
  launchConfigError?: string;
  /** The project's Auto-verify choice in launch.json, when it has one. */
  autoVerify?: boolean;
  /** Browser tools are on in Settings and allowed by the administrator: Claude can drive the panel. */
  toolsAvailable: boolean;
  /** The person is choosing an element with Select element. */
  picking: boolean;
  version: number;
}

/** A place on the window, in CSS pixels of the app page. */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What Select element returns about the element the person chose. */
export interface ElementPick {
  selector: string;
  tag: string;
  text: string;
  outerHTML: string;
  styles: Record<string, string>;
  box: { x: number; y: number; width: number; height: number };
  screenshotPngBase64?: string;
  url: string;
}

export type BrowserNavigateResult =
  { ok: true; url: string } | { ok: false; message: string };

/** The phone the Mobile viewport shows. */
export const mobileViewport = { width: 375, height: 812, scale: 3 } as const;
export const tabletViewport = { width: 768, height: 1024, scale: 2 } as const;
/** A device viewport's size, or undefined for the panel's own width. */
export function viewportFrame(viewport: BrowserViewport) {
  return typeof viewport === "object"
    ? { ...viewport, scale: 1 }
    : viewport === "mobile"
      ? mobileViewport
      : viewport === "tablet"
        ? tabletViewport
        : undefined;
}

/** The title of a tab that has not opened a page. */
export const newTabTitle = "New tab";

// ---------------------------------------------------------------------------
// Address bar rules

/** Hosts that are this computer: always opened over http when no scheme is typed. */
export function isLocalDevHost(host: string): boolean {
  const name = hostName(host);
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "[::1]" ||
    name === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(name)
  );
}

/** Private network addresses (10/8, 172.16/12, 192.168/16, 169.254/16) and `.test`/`.local` names. */
export function isPrivateNetworkHost(host: string): boolean {
  const name = hostName(host);
  if (name.endsWith(".test") || name.endsWith(".local")) return true;
  const parts = name.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p)))
    return false;
  if (parts.some((p) => p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** A host without its port, lower-cased; IPv6 keeps its brackets. */
function hostName(host: string) {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.lastIndexOf(":");
  return colon === -1 || value.indexOf(":") !== colon
    ? value
    : value.slice(0, colon);
}

/**
 * Whether a host is one the administrator blocked: the domain itself or any
 * name under it (`example.com` blocks `www.example.com`).
 */
export function hostBlocked(host: string, blockedDomains: readonly string[]) {
  const name = hostName(host).replace(/\.$/, "");
  return blockedDomains.some((raw) => {
    const domain = raw.trim().toLowerCase().replace(/^\*\./, "");
    return !!domain && (name === domain || name.endsWith(`.${domain}`));
  });
}

export interface AddressOptions {
  /** Folders whose files the person opened with Open HTML file… (file: pages allowed there). */
  fileRoots?: readonly string[];
}

/**
 * What the address bar opens for what the person typed. http and https
 * pages; about:blank; file pages only inside a folder the person chose with
 * Open HTML file…. Without a scheme, local and private network addresses
 * open over http and anything that looks like a domain over https. Words
 * that are not an address are refused: the built-in browser does not search.
 */
export function normalizeAddress(
  input: string,
  options: AddressOptions = {},
): BrowserNavigateResult {
  const text = input.trim();
  if (!text) return { ok: false, message: "Enter a URL." };
  if (text.length > 8192)
    return { ok: false, message: "That URL is too long." };
  if (/\s/.test(text) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text))
    return { ok: false, message: "Enter a URL, like example.com." };
  if (/^about:blank$/i.test(text)) return { ok: true, url: "about:blank" };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  // "localhost:3000" and "example.com:8080/x" parse as a scheme; they are hosts.
  const hostLike =
    scheme !== undefined && /^[a-z0-9.-]+:\d{1,5}(?:[/?#]|$)/i.test(text);
  if (scheme !== undefined && !hostLike) {
    if (scheme === "http" || scheme === "https") return webUrl(text);
    if (scheme === "file") return fileUrl(text, options.fileRoots ?? []);
    return {
      ok: false,
      message: `The built-in browser can't open ${scheme}: addresses.`,
    };
  }
  const host = /^(\[[^\]]*\]|[^/?#]*)/.exec(text)?.[1] ?? "";
  const bare = hostName(host);
  const looksLocal = isLocalDevHost(bare) || isPrivateNetworkHost(bare);
  const looksLikeDomain =
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$/i.test(bare) ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare);
  if (looksLocal) return webUrl(`http://${text}`);
  if (looksLikeDomain) return webUrl(`https://${text}`);
  return { ok: false, message: "Enter a URL, like example.com." };
}

function webUrl(text: string): BrowserNavigateResult {
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return { ok: false, message: "Enter a URL, like example.com." };
    if (!url.hostname)
      return { ok: false, message: "Enter a URL, like example.com." };
    if (url.username || url.password)
      return {
        ok: false,
        message: "URLs with a user name or password can't be opened.",
      };
    return { ok: true, url: url.href };
  } catch {
    return { ok: false, message: "Enter a URL, like example.com." };
  }
}

function fileUrl(
  text: string,
  roots: readonly string[],
): BrowserNavigateResult {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: "That file address isn't valid." };
  }
  if (url.host)
    return { ok: false, message: "Only files on this computer can be opened." };
  if (!fileAllowed(url, roots))
    return {
      ok: false,
      message: "Use Open HTML file… to choose a file to open.",
    };
  return { ok: true, url: url.href };
}

/** Whether a file: URL is inside one of the folders the person chose. */
export function fileAllowed(url: URL | string, roots: readonly string[]) {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return false;
  }
  if (parsed.protocol !== "file:" || parsed.host) return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  if (pathname.split("/").includes("..")) return false;
  const normal = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  // Windows file URLs are /C:/…; roots are C:\….
  const target = normal(pathname.replace(/^\/([a-z]:)/i, "$1"));
  return roots.some((root) => {
    const folder = normal(root);
    if (!folder || !target.startsWith(`${folder}/`)) return false;
    // Hidden files and folders (.ssh, .env, .git) stay closed even inside
    // a chosen folder: choosing ~/page.html must not open ~/.ssh.
    return !target
      .slice(folder.length + 1)
      .split("/")
      .some((segment) => segment.startsWith("."));
  });
}

/**
 * The address bar text while it is not being edited: the host and path
 * without `https://`, `www.` stays, and without a lone trailing slash.
 */
export function displayAddress(url: string) {
  if (!url || url === "about:blank") return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      const scheme = parsed.protocol === "http:" ? "http://" : "";
      const rest = `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
      return `${scheme}${rest}`;
    }
    if (parsed.protocol === "file:") return decodeURIComponent(parsed.pathname);
  } catch {
    // Shown as it is.
  }
  return url;
}

/** The origin a page belongs to, "" when it has none (about:blank, file:). */
export function pageOrigin(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : "";
  } catch {
    return "";
  }
}

/**
 * What a load error page says: a title and a line, from Chromium's error
 * name (`ERR_CONNECTION_REFUSED`) or one of ours.
 */
export function describeLoadError(error: BrowserLoadError): {
  title: string;
  detail: string;
} {
  let host = "";
  try {
    host = new URL(error.url).host;
  } catch {
    // No host to name.
  }
  const where = host || "This site";
  const name = error.description.replace(/^net::/, "");
  switch (name) {
    case "BLOCKED_BY_ADMINISTRATOR":
      return {
        title: "This site is blocked",
        detail: "Your administrator doesn't allow this site in Claudex.",
      };
    case "ERR_CONNECTION_REFUSED":
      return {
        title: "This site can't be reached",
        detail: `${where} refused to connect.`,
      };
    case "ERR_NAME_NOT_RESOLVED":
      return {
        title: "This site can't be reached",
        detail: `${where}'s server address could not be found.`,
      };
    case "ERR_INTERNET_DISCONNECTED":
      return {
        title: "No internet",
        detail: "Check your connection and try again.",
      };
    case "ERR_CONNECTION_TIMED_OUT":
    case "ERR_TIMED_OUT":
      return {
        title: "This site can't be reached",
        detail: `${where} took too long to respond.`,
      };
    case "ERR_CONNECTION_RESET":
    case "ERR_CONNECTION_CLOSED":
    case "ERR_EMPTY_RESPONSE":
      return {
        title: "This site can't be reached",
        detail: `The connection to ${where} was interrupted.`,
      };
    case "ERR_TOO_MANY_REDIRECTS":
      return {
        title: "This page isn't working",
        detail: `${where} redirected you too many times.`,
      };
    case "ERR_BLOCKED_BY_RESPONSE":
    case "ERR_BLOCKED_BY_CLIENT":
      return {
        title: "This page can't be shown",
        detail: `${where} doesn't allow itself to be shown here.`,
      };
    default:
      if (name.startsWith("ERR_CERT_") || name === "ERR_SSL_PROTOCOL_ERROR")
        return {
          title: "Your connection isn't private",
          detail: `The certificate of ${where} isn't trusted, so the page wasn't opened.`,
        };
      if (name === "ERR_HTTP_RESPONSE_CODE_FAILURE")
        return {
          title: "This page isn't working",
          detail: `${where} returned an error.`,
        };
      return {
        title: "This site can't be reached",
        detail: name ? `${where} couldn't be opened (${name}).` : where,
      };
  }
}
