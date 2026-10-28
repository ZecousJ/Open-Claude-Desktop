/**
 * The Code Browser panel and dev servers (R8-D) for the preview. There is no
 * native page in a plain browser, so the page area stays empty where the app
 * would show the site; everything the panel draws itself (new tab, errors,
 * bars, menus, dialogs) is real.
 *
 * `browser=` sets the first tab of every Code conversation: empty (default,
 * "New tab") | page (localhost:5173 loaded) | loading | stalled | error
 * (connection refused) | blocked | crashed | dialog (a confirm) | tabs (three
 * tabs) | mobile (phone size) | picking. `browserDev=` the dev servers: on |
 * servers (web running on 5173, docs stopped, api crashed) | off (unavailable:
 * no dev servers control). `browserTools=off` is Browser tools off (the empty
 * state only asks for a URL). `browserPrefs=off` leaves out the Settings
 * switches another package adds (the menu then has no switches).
 * `browserRows=1` adds the Code conversation "Browser tool rows" (Claude's
 * Browser tools in the transcript, R8-G); `browserApproval=` site | site-locked
 * | password | paste | script | dev asks that question in it.
 */
import type {
  BrowserState,
  BrowserTabState,
  DevServerState,
  LaunchConfiguration,
} from "../../../shared/browser";
import { normalizeAddress } from "../../../shared/browser";
import type { FixtureDomain } from "./index";
import { browserApprovalFixture, browserRowsConversation } from "./browser-rows";

const tab = (id: string, extra: Partial<BrowserTabState> = {}): BrowserTabState => ({
  id,
  url: "",
  title: "New tab",
  loading: false,
  stalled: false,
  canGoBack: false,
  canGoForward: false,
  ...extra,
});

const page = (id: string, extra: Partial<BrowserTabState> = {}) =>
  tab(id, {
    url: "http://localhost:5173/",
    title: "Vite + React",
    canGoBack: true,
    ...extra,
  });

function firstTabs(kind: string): BrowserTabState[] {
  switch (kind) {
    case "page":
    case "mobile":
    case "picking":
      return [page("t1")];
    case "loading":
      return [page("t1", { loading: true, title: "" })];
    case "stalled":
      return [page("t1", { loading: true, stalled: true })];
    case "error":
      return [
        tab("t1", {
          url: "http://localhost:3000/",
          title: "localhost:3000",
          error: {
            code: -102,
            description: "ERR_CONNECTION_REFUSED",
            url: "http://localhost:3000/",
          },
        }),
      ];
    case "blocked":
      return [
        tab("t1", {
          url: "https://blocked.example/",
          title: "blocked.example",
          error: {
            code: 0,
            description: "BLOCKED_BY_ADMINISTRATOR",
            url: "https://blocked.example/",
          },
        }),
      ];
    case "crashed":
      return [page("t1", { crashed: true })];
    case "dialog":
      return [
        page("t1", {
          dialog: {
            type: "confirm",
            message: "Discard the draft?",
            origin: "http://localhost:5173",
          },
        }),
      ];
    case "tabs":
      return [
        page("t1"),
        tab("t2", {
          url: "https://vite.dev/guide/",
          title: "Getting Started | Vite",
        }),
        tab("t3"),
      ];
    default:
      return [tab("t1")];
  }
}

function servers(kind: string): DevServerState[] {
  if (kind !== "servers") return [];
  return [
    {
      name: "web",
      command: "npm run dev",
      port: 5173,
      url: "http://localhost:5173",
      status: "running",
      pid: 4242,
      source: "launch.json",
    },
    {
      name: "docs",
      command: "pnpm --filter docs dev",
      port: 4321,
      status: "stopped",
      source: "launch.json",
    },
    {
      name: "api",
      command: "python manage.py runserver 8000",
      port: 8000,
      status: "crashed",
      error: "Exited with code 1",
      source: "launch.json",
    },
  ];
}

export const browserFixture: FixtureDomain = {
  params: {
    browser:
      "empty|page|loading|stalled|error|blocked|crashed|dialog|tabs|mobile|picking: the first tab",
    browserDev: "on|servers|off: the dev servers",
    browserTools: "off: Browser tools off",
    browserPrefs: "off: without the browser preferences of Settings",
    browserRows: "1: the conversation with Browser tool rows",
    browserApproval:
      "site|site-locked|password|paste|script|dev: a question from the Browser tools",
  },
  bridge: ({ params, state, emit, origin }) => {
    const kind = params.get("browser") ?? "empty";
    const dev = params.get("browserDev") ?? "on";
    // The Settings preferences (package R8-E), as the app will have them.
    if (params.get("browserPrefs") !== "off")
      Object.assign(state.settings as unknown as Record<string, unknown>, {
        browserTools: params.get("browserTools") !== "off",
        browserOpenLinksInApp: false,
        browserAutoVerify: false,
        browserKeepCookies: "until-quit",
        browserAllowedSites: ["https://github.com", "https://vite.dev"],
      });
    if (
      (params.get("browserRows") === "1" || params.get("browserApproval")) &&
      !state.conversations.some((c) => c.id === "c-browser-rows")
    )
      state.conversations.unshift(browserRowsConversation(origin));
    const asked = params.get("browserApproval");
    if (asked && !state.approvals.some((a) => a.id === "approval-browser"))
      state.approvals.push(browserApprovalFixture(asked));
    const sessions = new Map<string, BrowserState>();
    const configs: LaunchConfiguration[] = [];
    let version = 0;
    const session = (conversationId: string): BrowserState => {
      const found = sessions.get(conversationId);
      if (found) return found;
      const tabs = firstTabs(kind);
      const created: BrowserState = {
        conversationId,
        tabs,
        activeTabId: tabs[0].id,
        viewport: kind === "mobile" ? "mobile" : "desktop",
        colorScheme: "system",
        devServers: servers(dev),
        devServersAvailable: dev !== "off",
        toolsAvailable: params.get("browserTools") !== "off",
        picking: kind === "picking",
        version: ++version,
      };
      sessions.set(conversationId, created);
      return created;
    };
    const change = (
      conversationId: string,
      edit: (current: BrowserState) => Partial<BrowserState>,
    ) => {
      const current = session(conversationId);
      const next = { ...current, ...edit(current), version: ++version };
      sessions.set(conversationId, next);
      emit({ type: "browser", state: structuredClone(next) });
      return next;
    };
    const editTab = (
      conversationId: string,
      edit: (tab: BrowserTabState) => BrowserTabState,
      tabId?: string,
    ) =>
      change(conversationId, (current) => ({
        tabs: current.tabs.map((item) =>
          item.id === (tabId ?? current.activeTabId) ? edit(item) : item,
        ),
      }));
    const open = (url: string) => (item: BrowserTabState) => ({
      ...item,
      url,
      title: new URL(url).host,
      error: undefined,
      crashed: false,
      dialog: undefined,
      canGoBack: Boolean(item.url),
    });
    let tabs = 10;
    return {
      browserState: async (id) => structuredClone(session(id)),
      browserOpen: async (id) => structuredClone(session(id)),
      browserHide: async () => {},
      browserSetBounds: async () => {},
      browserOcclude: async () => ({}),
      browserNavigate: async (id, input, tabId) => {
        const result = normalizeAddress(input);
        if (result.ok) editTab(id, open(result.url), tabId);
        return result;
      },
      browserBack: async () => {},
      browserForward: async () => {},
      browserReload: async (id) =>
        void editTab(id, (item) => ({
          ...item,
          error: undefined,
          crashed: false,
        })),
      browserStop: async (id) =>
        void editTab(id, (item) => ({
          ...item,
          loading: false,
          stalled: false,
        })),
      browserNewTab: async (id, url) => {
        const created = tab(`t${++tabs}`);
        change(id, (current) => ({
          tabs: [...current.tabs, url ? open(url)(created) : created],
          activeTabId: created.id,
        }));
        return created.id;
      },
      browserSelectTab: async (id, tabId) =>
        void change(id, () => ({ activeTabId: tabId })),
      browserCloseTab: async (id, tabId) =>
        void change(id, (current) => {
          const left = current.tabs.filter((item) => item.id !== tabId);
          const rest = left.length ? left : [tab(`t${++tabs}`)];
          return {
            tabs: rest,
            activeTabId:
              current.activeTabId === tabId ? rest[0].id : current.activeTabId,
          };
        }),
      browserCloseOtherTabs: async (id, tabId) =>
        void change(id, (current) => ({
          tabs: current.tabs.filter((item) => item.id === tabId),
          activeTabId: tabId,
        })),
      browserSetViewport: async (id, viewport) =>
        void change(id, () => ({ viewport })),
      browserSetColorScheme: async (id, colorScheme) => {
        if (session(id).colorScheme === colorScheme) return;
        change(id, () => ({ colorScheme }));
      },
      browserPickElement: async (id) => {
        change(id, () => ({ picking: true }));
        return null;
      },
      browserCancelPick: async (id) => void change(id, () => ({ picking: false })),
      browserCapture: async () => null,
      browserSaveScreenshot: async () => false,
      browserOpenHtmlFile: async () => false,
      browserOpenExternally: async () => {},
      browserAnswerDialog: async (id, tabId) =>
        void editTab(id, (item) => ({ ...item, dialog: undefined }), tabId),
      browserClearData: async () => {},
      browserDefaultBrowserName: async () => "Google Chrome",
      devServersDetect: async () => [
        {
          name: "web",
          runtimeExecutable: "npm",
          runtimeArgs: ["run", "dev"],
          port: 5173,
        },
      ],
      devServersSave: async (id, config) => {
        configs.push(config);
        change(id, (current) => ({
          devServers: [
            ...current.devServers.filter((s) => s.name !== config.name),
            {
              name: config.name,
              command: [config.runtimeExecutable, ...(config.runtimeArgs ?? [])].join(" "),
              port: config.port,
              url: config.url ?? (config.port ? `http://localhost:${config.port}` : undefined),
              status: "stopped",
              source: "launch.json",
            },
          ],
        }));
      },
      devServersStart: async (id, name) => {
        const next = change(id, (current) => ({
          devServers: current.devServers.map((s) =>
            s.name === name ? { ...s, status: "running" as const } : s,
          ),
        }));
        return structuredClone(next.devServers.find((s) => s.name === name)!);
      },
      devServersStop: async (id, name) =>
        void change(id, (current) => ({
          devServers: current.devServers.map((s) =>
            s.name === name ? { ...s, status: "stopped" as const } : s,
          ),
        })),
      devServersLogs: async (_id, name) => [
        `> ${name}@0.0.0 dev`,
        "> vite",
        "",
        "  VITE v7.1.0  ready in 312 ms",
        "",
        "  ➜  Local:   http://localhost:5173/",
      ],
    };
  },
};
