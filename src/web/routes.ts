/**
 * The web app's addresses (SCRATCH/impl/web/W-UI-design.md §6.1, web plan
 * §3): pure functions between a URL and where the window is, so every
 * route can be tested without a browser. useWebRoute (src/web) wires them
 * to the window; the desktop app never uses them.
 *
 * | Address                       | Window                                   |
 * |-------------------------------|------------------------------------------|
 * | `/`, `/login`, `/register`    | signed in: a new chat (address → `/new`) |
 * | `/forgot-password`            | signed out: the reset link request       |
 * | `/reset-password?email&token` | signed out: a new password (emailed link) |
 * | `/new`                        | new Chat (or Cowork) draft               |
 * | `/new?incognito=1`            | incognito chat                           |
 * | `/new?q=<text>`               | new chat with the composer filled in     |
 * | `/chat/<id>`                  | a Chat or Cowork conversation (gone: a   |
 * |                               | notice and a new chat at `/new`)         |
 * | `/code`                       | Code home (→ `/new` without Code)        |
 * | `/code/<id>`                  | a Code conversation (gone: a notice and  |
 * |                               | Code home at `/code`)                    |
 * | `/projects`, `/project/<id>`  | Projects page, or one project on it      |
 * |                               | (`/cowork/projects`, `/cowork/project/<id>` |
 * |                               | from before the Cowork merge still work) |
 * | `/artifacts[?surface=code]`   | Artifacts page                           |
 * | `/scheduled-task[/:id]`      | Scheduled list or independently loaded detail |
 * | `/customize`                  | Customize page                           |
 * | `/api`                        | API page (service group, API keys)       |
 * | `/shared/<token>`             | A chat shared with the account           |
 * | `/recents`                    | All chats (the `history` page)           |
 * | `/settings`, `/settings/<t>`  | Settings open on page `<t>`              |
 * | anything else                 | "Page not found"                         |
 *
 * The server owns some addresses (API, gateway, share pages, the admin
 * console, its public pages and old console paths). Their layout is
 * `reservedLayout` below, a copy of the service's reserved_paths.json
 * (backend/backend/internal/web/sitepaths); tests/web-routes.test.ts
 * checks the copy and that no app route falls into a server zone.
 */
import type { Mode } from "../../shared/types";
import type { NavEntry, Surface } from "../app/navigation-history";
import {
  customizePath,
  parseCustomizePath,
  type CustomizePlace,
} from "./customize-route";

/** Pages with an address of their own (the NavEntry `page` values). */
export type RoutePage =
  | "projects"
  | "artifacts"
  | "scheduled"
  | "customize"
  | "api"
  | "status"
  | "dispatch"
  | "history";

export type WebRoute =
  /** `/`: the app's front door. */
  | { kind: "root" }
  /** `/login`, `/register`: the sign-in page, or home when signed in. */
  | { kind: "sign-in" }
  | { kind: "new"; incognito?: boolean; prompt?: string }
  | { kind: "chat"; id: string; artifactId?: string }
  | { kind: "code" }
  | { kind: "code-search" }
  | { kind: "code-chat"; id: string }
  | {
      kind: "page";
      page: RoutePage;
      surface?: Surface;
      view?: "templates";
      taskId?: string;
      customize?: CustomizePlace;
    }
  | { kind: "project"; id: string }
  | { kind: "artifact"; id: string }
  /** `/downloads`: the apps page, outside the app (src/downloads). */
  | { kind: "downloads" }
  | { kind: "help"; slug?: string }
  /** `/shared/<token>`: a chat someone shared with the signed-in account. */
  | { kind: "shared"; token: string }
  | {
      kind: "settings";
      tab?: string;
      background?: WebRoute;
      connector?: string;
    }
  /** An address the server answers; the app never takes it over. */
  | { kind: "reserved" }
  | { kind: "not-found" };

/** Pick the visible mode before the first render; routing finishes before paint. */
export function initialWebMode(route: WebRoute): "chat" | "code" {
  if (route.kind === "settings" && route.background)
    return initialWebMode(route.background);
  return route.kind === "code" ||
    route.kind === "code-chat" ||
    route.kind === "code-search" ||
    (route.kind === "page" && route.surface === "code")
    ? "code"
    : "chat";
}

/** Resolve the initial place before any home/composer effects can mount. */
export function initialWebEntry(route: WebRoute): NavEntry | undefined {
  return route.kind === "settings" && route.background
    ? initialWebEntry(route.background)
    : navEntryForRoute(route);
}

/** Page addresses, both ways. */
const pagePaths: Record<RoutePage, string> = {
  projects: "/projects",
  artifacts: "/artifacts",
  scheduled: "/scheduled-task",
  customize: "/customize",
  api: "/api",
  status: "/status",
  dispatch: "/dispatch",
  history: "/recents",
};
const pathPages = new Map(
  Object.entries(pagePaths).map(([page, path]) => [path, page as RoutePage]),
);
// Keep bookmarks from earlier releases working (before the Cowork merge).
pathPages.set("/cowork/projects", "projects");
pathPages.set("/scheduled", "scheduled");

/** Longest prompt `/new?q=` fills in. */
export const maxPromptLength = 4000;

/** A connector destination is an identifier, never an OAuth credential. */
export function settingsConnectorFromSearch(search: string) {
  const value = new URLSearchParams(search).get("connector");
  return value && value.length <= 2048 && !/[\u0000-\u001f]/.test(value)
    ? value
    : undefined;
}

/** Opening Settings must not leave its destination on the background entry. */
export function withoutSettingsConnector(address: string) {
  const url = new URL(address, "https://claudex.invalid");
  url.searchParams.delete("connector");
  return url.pathname + url.search + url.hash;
}

/**
 * The names the original's addresses give these Settings pages; Claudex's own
 * names still open them.
 */
const settingsAddresses: Record<string, string> = {
  privacy: "data-privacy-controls",
  design: "design-systems",
  time: "time-limits",
  code: "claude-code",
  chrome: "browser-extension",
};
const settingsPages = Object.fromEntries(
  Object.entries(settingsAddresses).map(([page, address]) => [address, page]),
);
function settingsAddress(tab: string) {
  return settingsAddresses[tab] ?? tab;
}

/**
 * Where an address leads. `pathname` is `location.pathname` (still
 * percent-encoded), `search` is `location.search`.
 */
export function parseWebRoute(
  pathname: string,
  search = "",
  hash = "",
): WebRoute {
  if (!isAppPath(pathname, search)) return { kind: "reserved" };
  const settings = /^#settings(?:\/([^/]+))?$/.exec(hash);
  if (settings) {
    const named = settings[1] ? segment(settings[1]) : "general";
    const tab = named && (settingsPages[named] ?? named);
    const background = parseWebRoute(pathname, search);
    if (
      tab &&
      background.kind !== "not-found" &&
      background.kind !== "settings"
    )
      return {
        kind: "settings",
        tab,
        background,
        ...(tab === "connectors" && settingsConnectorFromSearch(search)
          ? { connector: settingsConnectorFromSearch(search) }
          : {}),
      };
    return { kind: "not-found" };
  }
  const query = new URLSearchParams(search);
  // One trailing slash is the same address ("/projects/").
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  if (path === "/") return { kind: "root" };
  // The sign-in page's own addresses: the emailed reset link lands on
  // /reset-password (Sub2API's link, its page now the web app's).
  if (
    path === "/login" ||
    path === "/register" ||
    path === "/forgot-password" ||
    path === "/reset-password" ||
    path === "/sign-in/callback"
  )
    return { kind: "sign-in" };
  if (path === "/new") {
    const route: WebRoute = { kind: "new" };
    if (query.has("incognito") && ["", "1"].includes(query.get("incognito")!))
      route.incognito = true;
    const prompt = query.get("q");
    if (prompt && !route.incognito)
      route.prompt = prompt.slice(0, maxPromptLength);
    return route;
  }
  if (path === "/code" || path === "/code/new") return { kind: "code" };
  if (path === "/code/search") return { kind: "code-search" };
  if (path === "/downloads") return { kind: "downloads" };
  if (path === "/help") return { kind: "help" };
  const help = /^\/help\/([a-z0-9-]+)$/.exec(path);
  if (help) return { kind: "help", slug: help[1] };
  if (path === "/settings")
    return settingsConnectorFromSearch(search)
      ? {
          kind: "settings",
          tab: "connectors",
          connector: settingsConnectorFromSearch(search),
        }
      : { kind: "settings" };
  const page = pathPages.get(path);
  if (page) {
    if (page === "artifacts" && query.get("surface") === "code")
      return { kind: "page", page, surface: "code" };
    if (page === "scheduled" && query.get("view") === "templates")
      return { kind: "page", page, view: "templates" };
    return { kind: "page", page };
  }
  const scheduled = /^\/scheduled-task\/([^/]+)$/.exec(path);
  if (scheduled) {
    const taskId = segment(scheduled[1]);
    return taskId
      ? { kind: "page", page: "scheduled", taskId }
      : { kind: "not-found" };
  }
  const customize = parseCustomizePath(path);
  if (customize) return { kind: "page", page: "customize", customize };
  const match =
    /^\/(chat|code|(?:cowork\/)?project|artifact|settings|shared)\/([^/]+)$/.exec(
      path,
    );
  const id = match ? segment(match[2]) : undefined;
  if (match && id) {
    if (match[1] === "artifact")
      return /^[A-Za-z0-9_-]{1,128}$/.test(id)
        ? { kind: "artifact", id }
        : { kind: "not-found" };
    if (match[1] === "chat") {
      const artifactId = query.get("artifact");
      return {
        kind: "chat",
        id,
        ...(artifactId && /^[A-Za-z0-9_-]{1,128}$/.test(artifactId)
          ? { artifactId }
          : {}),
      };
    }
    if (match[1] === "code") return { kind: "code-chat", id };
    if (match[1] === "project" || match[1] === "cowork/project")
      return { kind: "project", id };
    if (match[1] === "shared" && /^[A-Za-z0-9_-]{20,64}$/.test(id))
      return { kind: "shared", token: id };
    if (match[1] === "shared") return { kind: "not-found" };
    return {
      kind: "settings",
      tab: id,
      ...(id === "connectors" && settingsConnectorFromSearch(search)
        ? { connector: settingsConnectorFromSearch(search) }
        : {}),
    };
  }
  return { kind: "not-found" };
}

/** A decoded path segment; undefined when it is malformed or empty. */
function segment(raw: string): string | undefined {
  try {
    const value = decodeURIComponent(raw);
    return value && !/[/\\\u0000-\u001f]/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The address of a route, in its one canonical spelling (`/` and the
 * sign-in pages become `/new`: they only show while signed out). Undefined
 * for routes without an address of their own.
 */
export function formatWebRoute(route: WebRoute): string | undefined {
  const id = (value: string) => encodeURIComponent(value);
  switch (route.kind) {
    case "root":
    case "sign-in":
      return "/new";
    case "new":
      if (route.incognito) return "/new?incognito";
      return route.prompt
        ? `/new?${new URLSearchParams({ q: route.prompt })}`
        : "/new";
    case "chat":
      return `/chat/${id(route.id)}${route.artifactId ? `?artifact=${id(route.artifactId)}` : ""}`;
    case "code":
      return "/code";
    case "code-search":
      return "/code/search";
    case "code-chat":
      return `/code/${id(route.id)}`;
    case "artifact":
      return `/artifact/${id(route.id)}`;
    case "page":
      if (route.page === "customize" && route.customize)
        return customizePath(route.customize);
      if (route.page === "scheduled" && route.taskId)
        return `/scheduled-task/${id(route.taskId)}`;
      if (route.page === "scheduled" && route.view === "templates")
        return "/scheduled-task?view=templates";
      return route.page === "artifacts" && route.surface === "code"
        ? "/artifacts?surface=code"
        : pagePaths[route.page];
    case "project":
      return `/project/${id(route.id)}`;
    case "shared":
      return `/shared/${id(route.token)}`;
    case "settings": {
      const background =
        formatWebRoute(route.background ?? { kind: "new" }) ?? "/new";
      if (route.tab !== "connectors" || !route.connector)
        return `${background}#settings/${id(settingsAddress(route.tab || "general"))}`;
      const url = new URL(background, "https://claudex.invalid");
      url.searchParams.set("connector", route.connector);
      return `${url.pathname}${url.search}#settings/connectors`;
    }
    case "downloads":
      return "/downloads";
    case "help":
      return route.slug ? `/help/${id(route.slug)}` : "/help";
    default:
      return undefined;
  }
}

/** What decides the address: the parts of the window's state it shows. */
export interface RouteState {
  /** `AppController.page`. */
  page: string;
  /** `AppController.mode`. */
  mode: Mode;
  /** The open conversation (`activeId`). */
  conversationId?: string;
  /** Its mode, once the conversation is known (else `mode` is used). */
  conversationMode?: Mode;
  incognitoShown?: boolean;
  settingsOpen?: boolean;
  settingsTab?: string;
  settingsConnector?: string;
  searchOpen?: boolean;
  projectId?: string;
  scheduledView?: "templates";
  scheduledTaskId?: string;
  customizePlace?: CustomizePlace;
  artifactId?: string;
  pairedArtifactId?: string;
}

/** The route that shows the window's state; undefined keeps the address. */
export function routeForState(state: RouteState): WebRoute | undefined {
  if (state.settingsOpen)
    return {
      kind: "settings",
      tab: state.settingsTab || "general",
      ...(state.settingsTab === "connectors" && state.settingsConnector
        ? { connector: state.settingsConnector }
        : {}),
      background: routeForState({ ...state, settingsOpen: false }),
    };
  if (state.searchOpen && state.mode === "code") return { kind: "code-search" };
  if (state.page === "artifact" && state.artifactId)
    return { kind: "artifact", id: state.artifactId };
  if (state.page === "projects" && state.projectId)
    return { kind: "project", id: state.projectId };
  if (state.page === "chat") {
    if (state.incognitoShown) return { kind: "new", incognito: true };
    const mode = state.conversationMode ?? state.mode;
    if (state.conversationId)
      return mode === "code"
        ? { kind: "code-chat", id: state.conversationId }
        : {
            kind: "chat",
            id: state.conversationId,
            ...(state.pairedArtifactId
              ? { artifactId: state.pairedArtifactId }
              : {}),
          };
    return state.mode === "code" ? { kind: "code" } : { kind: "new" };
  }
  if (Object.hasOwn(pagePaths, state.page)) {
    const page = state.page as RoutePage;
    if (page === "customize" && state.customizePlace)
      return { kind: "page", page, customize: state.customizePlace };
    if (page === "scheduled" && state.scheduledTaskId)
      return { kind: "page", page, taskId: state.scheduledTaskId };
    if (page === "scheduled" && state.scheduledView === "templates")
      return { kind: "page", page, view: "templates" };
    return page === "artifacts" && state.mode === "code"
      ? { kind: "page", page, surface: "code" }
      : { kind: "page", page };
  }
  // "not-found" keeps the address that was not found; Routines has no
  // address until the web app runs them (web plan Q8).
  return undefined;
}

/** The address of the window's state; undefined keeps the address. */
export function urlForState(state: RouteState): string | undefined {
  const route = routeForState(state);
  return route && formatWebRoute(route);
}

/** An address that shows a new-chat draft (Chat, Cowork or Code). */
export const isDraftUrl = (url: string | undefined) =>
  url === "/new" || url === "/code";

/**
 * The history entry a route shows (src/navigation-history.ts); undefined
 * for routes that are not a place in the window (settings, sign-in,
 * not found). `/new` keeps a Cowork draft on the Chat surface.
 */
export function navEntryForRoute(route: WebRoute): NavEntry | undefined {
  switch (route.kind) {
    case "root":
    case "new":
      return { page: "chat", surface: "chat" };
    case "chat":
      return {
        page: "chat",
        surface: "chat",
        conversationId: route.id,
        ...(route.artifactId ? { artifactId: route.artifactId } : {}),
      };
    case "code":
    case "code-search":
      return { page: "chat", surface: "code" };
    case "code-chat":
      return { page: "chat", surface: "code", conversationId: route.id };
    case "page":
      return { page: route.page, surface: route.surface ?? "chat" };
    case "project":
      return { page: "projects", surface: "chat" };
    case "shared":
      return { page: "shared", surface: "chat" };
    case "artifact":
      return { page: "artifact", surface: "chat", artifactId: route.id };
    default:
      return undefined;
  }
}

/** The route of a history entry (the reverse of navEntryForRoute). */
export function routeForNavEntry(entry: NavEntry): WebRoute | undefined {
  return routeForState({
    page: entry.page,
    mode: entry.surface === "code" ? "code" : "chat",
    conversationId: entry.page === "chat" ? entry.conversationId : undefined,
    artifactId: entry.page === "artifact" ? entry.artifactId : undefined,
    pairedArtifactId: entry.page === "chat" ? entry.artifactId : undefined,
  });
}

/**
 * The service's URL layout: a copy of reserved_paths.json (web plan §3,
 * package W-SITE) without its comments. Paths match exactly, or by prefix
 * in the prefix lists.
 */
export const reservedLayout = {
  version: 1,
  bypass: {
    exact: ["/health", "/models", "/responses", "/alpha/search"],
    prefixes: [
      "/api/",
      "/v1/",
      "/v1beta/",
      "/backend-api/",
      "/antigravity/",
      "/setup/",
      "/responses/",
      "/images/",
      "/videos/",
      "/s/",
    ],
  },
  console: { base: "/admin" },
  console_root_pages: {
    exact: [
      "/desktop-pay",
      "/desktop-only",
      "/payment/result",
      "/auth/callback",
      "/auth/oauth/callback",
      "/auth/linuxdo/callback",
      "/auth/wechat/callback",
      "/auth/dingtalk/callback",
      "/auth/oidc/callback",
      "/auth/wechat/payment/callback",
      "/auth/dingtalk/email-completion",
    ],
    prefixes: ["/legal/"],
  },
  legacy_redirects: {
    exact: {
      "/setup": "/admin/setup",
      "/home": "/admin/home",
      "/model-plaza": "/admin/model-plaza",
      "/key-usage": "/admin/key-usage",
      "/email-verify": "/admin/email-verify",
      "/payment/qrcode": "/admin/payment/qrcode",
      "/payment/stripe": "/admin/payment/stripe",
      "/payment/stripe-popup": "/admin/payment/stripe-popup",
      "/payment/airwallex": "/admin/payment/airwallex",
      "/dashboard": "/admin/my/dashboard",
      "/keys": "/admin/my/keys",
      "/usage": "/admin/my/usage",
      "/redeem": "/admin/my/redeem",
      "/affiliate": "/admin/my/affiliate",
      "/available-channels": "/admin/my/available-channels",
      "/profile": "/admin/my/profile",
      "/subscriptions": "/admin/my/subscriptions",
      "/purchase": "/admin/my/purchase",
      "/orders": "/admin/my/orders",
      "/batch-image": "/admin/my/batch-image",
      "/monitor": "/admin/my/monitor",
    } as Record<string, string>,
    prefixes: { "/custom/": "/admin/my/custom/" } as Record<string, string>,
  },
  admin_login_redirect: {
    from: "/login",
    to: "/admin/login",
    redirect_param: "redirect",
    redirect_prefix: "/admin",
  },
};

/** Who answers a path; the same zones as sitepaths.Classify in Go. */
export type SiteZone = "app" | "bypass" | "console" | "console-root" | "legacy";

/**
 * The zone of a request path, as the service decides it (sitepaths.go
 * `Classify`). `search` only matters for `/login?redirect=/admin…`.
 */
export function siteZone(pathname: string, search = ""): SiteZone {
  const layout = reservedLayout;
  const { bypass, console_root_pages: rootPages } = layout;
  if (
    bypass.exact.includes(pathname) ||
    bypass.prefixes.some((prefix) => pathname.startsWith(prefix))
  )
    return "bypass";
  const base = layout.console.base;
  if (pathname === base || pathname.startsWith(`${base}/`)) return "console";
  if (
    rootPages.exact.includes(pathname) ||
    rootPages.prefixes.some(
      (prefix) =>
        pathname.startsWith(prefix) && pathname.length > prefix.length,
    )
  )
    return "console-root";
  const legacy = layout.legacy_redirects;
  if (Object.hasOwn(legacy.exact, pathname)) return "legacy";
  if (
    Object.keys(legacy.prefixes).some(
      (prefix) =>
        pathname.startsWith(prefix) && pathname.length > prefix.length,
    )
  )
    return "legacy";
  const login = layout.admin_login_redirect;
  if (pathname === login.from && search) {
    const redirect = new URLSearchParams(search).get(login.redirect_param);
    const prefix = login.redirect_prefix;
    if (
      redirect !== null &&
      (redirect === prefix ||
        redirect.startsWith(`${prefix}/`) ||
        redirect.startsWith(`${prefix}?`))
    )
      return "legacy";
  }
  return "app";
}

/** Whether the web app answers this address (else a full page load). */
export const isAppPath = (pathname: string, search = "") =>
  siteZone(pathname, search) === "app";
