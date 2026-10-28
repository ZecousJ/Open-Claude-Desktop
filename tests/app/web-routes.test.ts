import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Conversation, Mode } from "../../shared/types";
import type { AppController } from "../../src/app/AppContext";
import {
  formatWebRoute,
  initialWebMode,
  initialWebEntry,
  isAppPath,
  navEntryForRoute,
  parseWebRoute,
  reservedLayout,
  routeForNavEntry,
  siteZone,
  urlForState,
  type RouteState,
  type WebRoute,
} from "../../src/web/routes";
import { documentTitle, newlyUnread } from "../../src/web/document-title";
import { faviconLinks, themeColor } from "../../src/web/favicon";
import { applyRoute, historyStep } from "../../src/web/web-route-apply";
import {
  projectRequest,
  clearProjectRequest,
} from "../../src/collections/open-requests";

test("the first web render selects its mode from the address", () => {
  for (const path of [
    "/new",
    "/login",
    "/chat/abc",
    "/projects",
    "/scheduled-task",
  ])
    assert.equal(initialWebMode(parseWebRoute(path)), "chat", path);
  for (const path of ["/code", "/code/new", "/code/abc", "/code/search"])
    assert.equal(initialWebMode(parseWebRoute(path)), "code", path);
  assert.equal(
    initialWebMode(parseWebRoute("/code", "", "#settings/general")),
    "code",
  );
  assert.equal(
    initialWebMode(parseWebRoute("/chat/abc", "", "#settings/general")),
    "chat",
  );
});

/** The service's layout file, the single source both sides read. */
const layoutFile = new URL(
  "../../backend/backend/internal/web/sitepaths/reserved_paths.json",
  import.meta.url,
);
const layout = JSON.parse(readFileSync(layoutFile, "utf8"));

/** Drops the "$comment" members the Go side ignores. */
function withoutComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutComments);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "$comment")
        .map(([key, item]) => [key, withoutComments(item)]),
    );
  return value;
}

test("the app's copy of the URL layout matches reserved_paths.json", () => {
  assert.deepEqual(withoutComments(reservedLayout), withoutComments(layout));
});

/** A few addresses under each reserved zone of the layout file. */
function reservedSamples(): { path: string; search?: string; zone: string }[] {
  const samples: { path: string; search?: string; zone: string }[] = [];
  for (const path of layout.bypass.exact)
    samples.push({ path, zone: "bypass" });
  for (const prefix of layout.bypass.prefixes) {
    samples.push({ path: `${prefix}x`, zone: "bypass" });
    samples.push({ path: `${prefix}chat/1`, zone: "bypass" });
  }
  const base = layout.console.base;
  for (const path of [base, `${base}/`, `${base}/login`, `${base}/assets/a.js`])
    samples.push({ path, zone: "console" });
  for (const path of layout.console_root_pages.exact)
    samples.push({ path, zone: "console-root" });
  for (const prefix of layout.console_root_pages.prefixes)
    samples.push({ path: `${prefix}terms`, zone: "console-root" });
  for (const path of Object.keys(layout.legacy_redirects.exact))
    samples.push({ path, zone: "legacy" });
  for (const prefix of Object.keys(layout.legacy_redirects.prefixes))
    samples.push({ path: `${prefix}page`, zone: "legacy" });
  const login = layout.admin_login_redirect;
  samples.push({
    path: login.from,
    search: `?${login.redirect_param}=${encodeURIComponent(`${login.redirect_prefix}/users`)}`,
    zone: "legacy",
  });
  return samples;
}

test("reserved prefixes are never taken over by the app", () => {
  const samples = reservedSamples();
  assert.ok(samples.length > 50);
  for (const { path, search, zone } of samples) {
    assert.equal(siteZone(path, search), zone, path);
    assert.equal(isAppPath(path, search), false, path);
    assert.deepEqual(parseWebRoute(path, search), { kind: "reserved" }, path);
  }
});

/** One address of every app route (web plan §3). */
const appAddresses = [
  "/",
  "/new",
  "/new?incognito=1",
  "/new?q=hello",
  "/chat/c-1",
  "/code",
  "/code/c-2",
  "/projects",
  "/project/p-1",
  "/shared/AbCdEfGhIjKlMnOpQrStUv",
  "/artifacts",
  "/artifacts?surface=code",
  "/customize",
  "/scheduled-task/r-review",
  "/api",
  "/recents",
  "/settings",
  "/settings/account",
  "/login",
  "/register",
  "/login?redirect=/new",
  "/assets/index-abc.js",
];

test("every app route is in the app's zone of the site", () => {
  for (const address of appAddresses) {
    const [path, query] = address.split("?");
    const search = query ? `?${query}` : "";
    assert.equal(siteZone(path, search), "app", address);
  }
  // Near misses of reserved prefixes stay with the app.
  for (const path of [
    "/s",
    "/legal",
    "/legal/",
    "/administrator",
    "/v1x",
    "/setupx",
  ])
    assert.equal(siteZone(path), "app", path);
});

test("addresses parse to routes", () => {
  const cases: [string, string, WebRoute][] = [
    ["/", "", { kind: "root" }],
    ["/login", "", { kind: "sign-in" }],
    ["/register", "", { kind: "sign-in" }],
    ["/sign-in/callback", "", { kind: "sign-in" }],
    ["/new", "", { kind: "new" }],
    ["/new", "?incognito=1", { kind: "new", incognito: true }],
    ["/new", "?q=Plan%20a%20trip", { kind: "new", prompt: "Plan a trip" }],
    ["/new", "?incognito=1&q=x", { kind: "new", incognito: true }],
    ["/chat/abc-123", "", { kind: "chat", id: "abc-123" }],
    ["/chat/a%20b", "", { kind: "chat", id: "a b" }],
    ["/code", "", { kind: "code" }],
    ["/code/", "", { kind: "code" }],
    ["/code/xyz", "", { kind: "code-chat", id: "xyz" }],
    ["/projects", "", { kind: "page", page: "projects" }],
    ["/projects/", "", { kind: "page", page: "projects" }],
    ["/project/p1", "", { kind: "project", id: "p1" }],
    [
      "/shared/AbCdEfGhIjKlMnOpQrStUv",
      "",
      { kind: "shared", token: "AbCdEfGhIjKlMnOpQrStUv" },
    ],
    ["/shared/short", "", { kind: "not-found" }],
    ["/artifacts", "", { kind: "page", page: "artifacts" }],
    [
      "/artifacts",
      "?surface=code",
      { kind: "page", page: "artifacts", surface: "code" },
    ],
    ["/customize", "", { kind: "page", page: "customize" }],
    ["/api", "", { kind: "page", page: "api" }],
    ["/recents", "", { kind: "page", page: "history" }],
    ["/settings", "", { kind: "settings" }],
    ["/settings/privacy", "", { kind: "settings", tab: "privacy" }],
    ["/nope", "", { kind: "not-found" }],
    ["/chat", "", { kind: "not-found" }],
    ["/chat/a/b", "", { kind: "not-found" }],
    ["/chat/%E0%A4%A", "", { kind: "not-found" }],
    ["/chat/a%2Fb", "", { kind: "not-found" }],
    ["/history", "", { kind: "not-found" }],
    ["/scheduled", "", { kind: "page", page: "scheduled" }],
    [
      "/scheduled-task",
      "?view=templates",
      { kind: "page", page: "scheduled", view: "templates" },
    ],
    ["/scheduled-task", "?view=unknown", { kind: "page", page: "scheduled" }],
    [
      "/scheduled-task/r-review",
      "",
      { kind: "page", page: "scheduled", taskId: "r-review" },
    ],
    ["/scheduled-task/a%2Fb", "", { kind: "not-found" }],
    ["/project", "", { kind: "not-found" }],
  ];
  for (const [path, search, route] of cases)
    assert.deepEqual(parseWebRoute(path, search), route, path + search);
  const long = "x".repeat(10_000);
  const route = parseWebRoute("/new", `?q=${long}`);
  assert.equal(route.kind === "new" && route.prompt?.length, 4000);
});

test("routes format to one canonical address that parses back", () => {
  const routes: WebRoute[] = [
    { kind: "new" },
    { kind: "new", incognito: true },
    { kind: "chat", id: "c 1/2" },
    { kind: "code" },
    { kind: "code-chat", id: "k" },
    { kind: "page", page: "projects" },
    { kind: "page", page: "artifacts" },
    { kind: "page", page: "artifacts", surface: "code" },
    { kind: "page", page: "customize" },
    { kind: "page", page: "history" },
    { kind: "page", page: "scheduled", view: "templates" },
    { kind: "page", page: "scheduled", taskId: "r-review" },
    { kind: "project", id: "p" },
    { kind: "shared", token: "AbCdEfGhIjKlMnOpQrStUv" },
    { kind: "settings", tab: "general" },
  ];
  for (const route of routes) {
    const url = formatWebRoute(route)!;
    const parsed = new URL(url, "https://claudex.example");
    const back = parseWebRoute(parsed.pathname, parsed.search, parsed.hash);
    if (route.kind === "chat") assert.equal(url, "/chat/c%201%2F2");
    if (route.kind === "chat")
      assert.deepEqual(back, { kind: "not-found" }, "ids with / are refused");
    else
      assert.deepEqual(
        back,
        route.kind === "settings"
          ? { ...route, background: { kind: "new" } }
          : route,
        url,
      );
  }
  assert.equal(formatWebRoute({ kind: "root" }), "/new");
  assert.equal(formatWebRoute({ kind: "sign-in" }), "/new");
  assert.equal(formatWebRoute({ kind: "not-found" }), undefined);
  assert.equal(formatWebRoute({ kind: "reserved" }), undefined);
  assert.equal(
    formatWebRoute({ kind: "new", prompt: "a b&c" }),
    "/new?q=a+b%26c",
  );
});

test("the window's state has one address", () => {
  const state = (patch: Partial<RouteState>): RouteState => ({
    page: "chat",
    mode: "chat",
    ...patch,
  });
  const cases: [Partial<RouteState>, string | undefined][] = [
    [{}, "/new"],
    [{ mode: "cowork" }, "/new"],
    [{ mode: "code" }, "/code"],
    [{ conversationId: "a" }, "/chat/a"],
    [{ conversationId: "a", mode: "cowork" }, "/chat/a"],
    [{ conversationId: "a", mode: "code" }, "/code/a"],
    // The conversation's own mode wins over the window's.
    [
      { conversationId: "a", mode: "chat", conversationMode: "code" },
      "/code/a",
    ],
    [{ incognitoShown: true }, "/new?incognito"],
    [{ incognitoShown: true, conversationId: "i" }, "/new?incognito"],
    [{ page: "projects" }, "/projects"],
    [{ page: "artifacts" }, "/artifacts"],
    [{ page: "artifacts", mode: "code" }, "/artifacts?surface=code"],
    [{ page: "customize" }, "/customize"],
    [{ page: "api" }, "/api"],
    [{ page: "history" }, "/recents"],
    [{ page: "scheduled" }, "/scheduled-task"],
    [
      { page: "scheduled", scheduledView: "templates" },
      "/scheduled-task?view=templates",
    ],
    [
      { page: "scheduled", scheduledTaskId: "r-review" },
      "/scheduled-task/r-review",
    ],
    [{ page: "not-found" }, undefined],
    [{ settingsOpen: true, settingsTab: "account" }, "/new#settings/account"],
    [{ settingsOpen: true, settingsTab: "" }, "/new#settings/general"],
    [{ settingsOpen: true, page: "projects" }, "/projects#settings/general"],
  ];
  for (const [patch, url] of cases)
    assert.equal(urlForState(state(patch)), url, JSON.stringify(patch));
});

test("routes and history entries map both ways", () => {
  assert.deepEqual(navEntryForRoute({ kind: "new" }), {
    page: "chat",
    surface: "chat",
  });
  assert.deepEqual(navEntryForRoute({ kind: "code-chat", id: "x" }), {
    page: "chat",
    surface: "code",
    conversationId: "x",
  });
  assert.deepEqual(navEntryForRoute({ kind: "project", id: "p" }), {
    page: "projects",
    surface: "chat",
  });
  assert.equal(navEntryForRoute({ kind: "settings" }), undefined);
  assert.equal(navEntryForRoute({ kind: "not-found" }), undefined);
  for (const route of [
    { kind: "new" },
    { kind: "chat", id: "c" },
    { kind: "code" },
    { kind: "code-chat", id: "k" },
    { kind: "page", page: "projects" },
    { kind: "page", page: "artifacts", surface: "code" },
    { kind: "page", page: "history" },
  ] as WebRoute[])
    assert.deepEqual(routeForNavEntry(navEntryForRoute(route)!), route);
});

const conversation = (
  id: string,
  mode: Mode,
  patch: Partial<Conversation> = {},
) => ({ id, mode, title: `Chat ${id}`, ...patch }) as Conversation;

/** An AppController that records what the route asked it to do. */
function fakeApp(patch: Partial<AppController> = {}) {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      void calls.push([name, ...args]);
  const app = {
    page: "chat",
    mode: "chat",
    activeId: undefined,
    active: undefined,
    incognitoShown: false,
    settingsOpen: false,
    settingsTab: "general",
    search: null,
    policy: { incognito: true },
    snapshot: {
      conversations: [
        conversation("c1", "chat"),
        conversation("k1", "code"),
        conversation("i1", "chat", { incognito: true }),
      ],
      projects: [{ id: "p1" }],
    },
    newChat: record("newChat"),
    openConversation: (c: Conversation) =>
      calls.push(["openConversation", c.id]),
    setPage: record("setPage"),
    report: (error: Error) => calls.push(["report", error.message]),
    setMode: record("setMode"),
    setText: record("setText"),
    setSearch: record("setSearch"),
    openSettingsTab: record("openSettingsTab"),
    setSettingsOpen: record("setSettingsOpen"),
    ...patch,
  } as unknown as AppController;
  return { app, calls };
}

const load = { codeAvailable: false, initial: true };
const pop = { codeAvailable: false, initial: false };

test("cold conversation places skip the home and still initialize the session exactly once", () => {
  const route = parseWebRoute("/code/k1");
  assert.deepEqual(initialWebEntry(route), {
    page: "chat",
    surface: "code",
    conversationId: "k1",
  });
  const { app, calls } = fakeApp({
    mode: "code",
    activeId: "k1",
    active: conversation("k1", "code"),
  });
  applyRoute(app, route, { codeAvailable: true, initial: true });
  assert.deepEqual(calls, [["openConversation", "k1"]]);
  calls.length = 0;
  applyRoute(app, route, { codeAvailable: true, initial: false });
  assert.deepEqual(calls, []);
  assert.deepEqual(initialWebEntry(parseWebRoute("/customize/skills")), {
    page: "customize",
    surface: "chat",
  });
});

test("live aliases do not mistake Code entry points for stored conversation ids", () => {
  assert.deepEqual(parseWebRoute("/code/new"), { kind: "code" });
  assert.deepEqual(parseWebRoute("/code/search"), { kind: "code-search" });
  assert.deepEqual(parseWebRoute("/projects"), {
    kind: "page",
    page: "projects",
  });
  assert.deepEqual(parseWebRoute("/scheduled-task"), {
    kind: "page",
    page: "scheduled",
  });
  assert.equal(
    formatWebRoute(parseWebRoute("/scheduled", "?view=templates")),
    "/scheduled-task?view=templates",
  );
  assert.deepEqual(parseWebRoute("/project/p1"), parseWebRoute("/project/p1"));
  assert.deepEqual(parseWebRoute("/new", "?incognito"), {
    kind: "new",
    incognito: true,
  });
});

test("scheduled Templates survives route application and a Settings background", () => {
  const route: WebRoute = {
    kind: "page",
    page: "scheduled",
    view: "templates",
  };
  const { app, calls } = fakeApp();
  assert.equal(applyRoute(app, route, load), "/scheduled-task?view=templates");
  assert.deepEqual(calls, [["setPage", "scheduled"]]);
  const settings: WebRoute = {
    kind: "settings",
    tab: "general",
    background: route,
  };
  const url = formatWebRoute(settings)!;
  assert.equal(url, "/scheduled-task?view=templates#settings/general");
  const address = new URL(url, "https://claudex.example");
  assert.deepEqual(
    parseWebRoute(address.pathname, address.search, address.hash),
    settings,
  );
});

test("a settings hash restores its conversation without converting a legacy task record", () => {
  const task = conversation("task", "cowork");
  const { app, calls } = fakeApp({
    mode: "cowork",
    active: task,
    activeId: task.id,
  });
  const route = parseWebRoute(
    "/chat/task",
    "",
    "#settings/data-privacy-controls",
  );
  assert.equal(
    applyRoute(app, route, load),
    "/chat/task#settings/data-privacy-controls",
  );
  assert.deepEqual(calls, [["openSettingsTab", "privacy"]]);
  assert.equal(app.active?.mode, "cowork");
  assert.equal(app.active?.id, "task");
});

test("Code search opens the palette instead of trying to load a conversation named search", () => {
  const { app, calls } = fakeApp();
  assert.equal(
    applyRoute(
      app,
      { kind: "code-search" },
      { codeAvailable: true, initial: true },
    ),
    "/code/search",
  );
  assert.deepEqual(calls, [
    ["newChat", "code"],
    ["setSearch", ""],
  ]);
});

test("a route on load shows its place and names its canonical address", () => {
  let { app, calls } = fakeApp({ mode: "code" });
  assert.equal(applyRoute(app, { kind: "root" }, load), "/new");
  assert.deepEqual(calls, [["newChat", "chat"]]);

  ({ app, calls } = fakeApp());
  assert.equal(applyRoute(app, { kind: "new" }, load), "/new");
  assert.deepEqual(
    calls,
    [["newChat", "chat"]],
    "the initial home resolves its execution mode",
  );
  calls.length = 0;
  assert.equal(applyRoute(app, { kind: "new" }, pop), "/new");
  assert.deepEqual(calls, [], "later navigation to the same draft keeps it");

  ({ app, calls } = fakeApp({ mode: "cowork", page: "projects" }));
  assert.equal(applyRoute(app, { kind: "sign-in" }, load), "/new");
  assert.deepEqual(calls, [["newChat", "cowork"]]);

  ({ app, calls } = fakeApp());
  assert.equal(
    applyRoute(app, { kind: "new", incognito: true }, load),
    "/new?incognito",
  );
  assert.deepEqual(calls, [["newChat", "chat", undefined, true]]);

  // The administrator turned incognito off: a plain new chat.
  ({ app, calls } = fakeApp({
    page: "projects",
    policy: { incognito: false } as AppController["policy"],
  }));
  assert.equal(applyRoute(app, { kind: "new", incognito: true }, load), "/new");
  assert.deepEqual(calls, [["newChat", "chat"]]);

  ({ app, calls } = fakeApp());
  assert.equal(applyRoute(app, { kind: "new", prompt: "Hi" }, load), "/new");
  assert.deepEqual(calls, [
    ["newChat", "chat"],
    ["setText", "Hi"],
  ]);
});

test("conversation routes open the conversation or say it is not found", () => {
  let { app, calls } = fakeApp();
  assert.equal(applyRoute(app, { kind: "chat", id: "c1" }, pop), "/chat/c1");
  assert.deepEqual(calls, [["openConversation", "c1"]]);

  // A Code conversation's address is /code/<id>.
  ({ app, calls } = fakeApp());
  assert.equal(applyRoute(app, { kind: "chat", id: "k1" }, pop), "/code/k1");
  assert.deepEqual(calls, [["openConversation", "k1"]]);

  ({ app, calls } = fakeApp());
  assert.equal(
    applyRoute(app, { kind: "code-chat", id: "c1" }, pop),
    "/chat/c1",
  );

  // Gone: a notice, and a new chat in its place, not "Page not found".
  for (const id of ["missing", "i1"]) {
    ({ app, calls } = fakeApp({ page: "projects" }));
    assert.equal(applyRoute(app, { kind: "chat", id }, pop), "/new");
    assert.deepEqual(
      calls,
      [
        ["report", "That chat is no longer available. Starting a new one."],
        ["newChat", "chat"],
      ],
      id,
    );
  }
  ({ app, calls } = fakeApp({ page: "projects" }));
  assert.equal(
    applyRoute(
      app,
      { kind: "code-chat", id: "missing" },
      { codeAvailable: true, initial: false },
    ),
    "/code",
  );
  assert.deepEqual(calls, [
    ["report", "That session is no longer available."],
    ["newChat", "code"],
  ]);
});

test("Code routes fall back to a new chat without Code", () => {
  let { app, calls } = fakeApp({ page: "projects" });
  assert.equal(applyRoute(app, { kind: "code" }, load), "/new");
  assert.deepEqual(calls, [["newChat", "chat"]]);

  ({ app, calls } = fakeApp());
  assert.equal(
    applyRoute(app, { kind: "code" }, { codeAvailable: true, initial: true }),
    "/code",
  );
  assert.deepEqual(calls, [["newChat", "code"]]);

  ({ app, calls } = fakeApp());
  assert.equal(
    applyRoute(app, { kind: "page", page: "artifacts", surface: "code" }, load),
    "/artifacts",
  );
  assert.deepEqual(calls, [["setPage", "artifacts"]]);

  ({ app, calls } = fakeApp());
  assert.equal(
    applyRoute(
      app,
      { kind: "page", page: "artifacts", surface: "code" },
      { codeAvailable: true, initial: false },
    ),
    "/artifacts?surface=code",
  );
  assert.deepEqual(calls, [
    ["setMode", "code"],
    ["setPage", "artifacts"],
  ]);

  ({ app, calls } = fakeApp({ mode: "code" }));
  assert.equal(
    applyRoute(app, { kind: "page", page: "history" }, load),
    "/recents",
  );
  assert.deepEqual(calls, [
    ["setMode", "chat"],
    ["setPage", "history"],
  ]);
});

test("project routes open the project on the Projects page", () => {
  clearProjectRequest();
  let { app, calls } = fakeApp();
  assert.equal(
    applyRoute(app, { kind: "project", id: "p1" }, load),
    "/project/p1",
  );
  assert.deepEqual(calls, [["setPage", "projects"]]);
  assert.equal(projectRequest(), "p1");
  clearProjectRequest();

  ({ app, calls } = fakeApp());
  assert.equal(
    applyRoute(app, { kind: "project", id: "gone" }, load),
    "/project/gone",
  );
  assert.deepEqual(calls, [["setPage", "projects"]]);
  assert.equal(projectRequest(), "gone");
  clearProjectRequest();
});

test("settings routes open Settings over the page", () => {
  // Straight from the address: a new chat under it.
  let { app, calls } = fakeApp({ page: "projects" });
  assert.equal(
    applyRoute(app, { kind: "settings", tab: "account" }, load),
    "/new#settings/account",
  );
  assert.deepEqual(calls, [
    ["newChat", "chat"],
    ["openSettingsTab", "account"],
  ]);

  // Forward into Settings keeps the page it was opened over.
  ({ app, calls } = fakeApp({ page: "projects" }));
  assert.equal(
    applyRoute(app, { kind: "settings" }, pop),
    "/projects#settings/general",
  );
  assert.deepEqual(calls, [["openSettingsTab", "general"]]);

  // Back or forward between Settings pages switches the page.
  ({ app, calls } = fakeApp({ settingsOpen: true, settingsTab: "privacy" }));
  applyRoute(app, { kind: "settings", tab: "account" }, pop);
  assert.deepEqual(calls, [["openSettingsTab", "account"]]);

  ({ app, calls } = fakeApp({ settingsOpen: true, settingsTab: "account" }));
  applyRoute(app, { kind: "settings", tab: "account" }, pop);
  assert.deepEqual(calls, []);

  // Back out of Settings closes it.
  ({ app, calls } = fakeApp({ settingsOpen: true }));
  assert.equal(applyRoute(app, { kind: "new" }, pop), "/new");
  assert.deepEqual(calls, [["setSettingsOpen", false]]);
});

test("unknown and reserved addresses show Page not found", () => {
  for (const route of [
    { kind: "not-found" },
    { kind: "reserved" },
  ] as WebRoute[]) {
    const { app, calls } = fakeApp();
    assert.equal(applyRoute(app, route, load), undefined);
    assert.deepEqual(calls, [["setPage", "not-found"]]);
  }
});

test("moves of the window push, replace or step back in the history", () => {
  const place = (url?: string, settingsOpen = false) => ({ url, settingsOpen });
  const step = (
    previous: ReturnType<typeof place>,
    next: ReturnType<typeof place>,
    extra: Partial<Parameters<typeof historyStep>[0]> = {},
  ) =>
    historyStep({
      previous,
      next,
      address: previous.url ?? "/somewhere",
      openedSettings: false,
      draftKnown: null,
      ...extra,
    });
  assert.equal(step(place("/new"), place("/projects")), "push");
  assert.equal(
    step(place("/chat/a"), place("/chat/b"), { activeId: "b" }),
    "push",
  );
  assert.equal(step(place("/new"), place("/new")), "none");
  assert.equal(step(place("/new"), place(undefined)), "none");
  assert.equal(
    step(place("/new"), place("/chat/a"), { address: "/chat/a" }),
    "none",
    "back or forward already moved the address",
  );
  // The draft becomes the conversation it started.
  assert.equal(
    step(place("/new"), place("/chat/n"), {
      activeId: "n",
      draftKnown: new Set(["a"]),
    }),
    "replace",
  );
  assert.equal(
    step(place("/code"), place("/code/n"), {
      activeId: "n",
      draftKnown: new Set(),
    }),
    "replace",
  );
  // Opening an existing conversation from the draft is a move.
  assert.equal(
    step(place("/new"), place("/chat/a"), {
      activeId: "a",
      draftKnown: new Set(["a"]),
    }),
    "push",
  );
  // Settings.
  assert.equal(
    step(place("/chat/a"), place("/settings/general", true)),
    "push",
  );
  assert.equal(
    step(place("/settings/general", true), place("/settings/account", true)),
    "replace",
  );
  assert.equal(
    step(place("/settings/general", true), place("/chat/a"), {
      openedSettings: true,
    }),
    "back",
  );
  assert.equal(
    step(place("/settings/general", true), place("/new")),
    "replace",
    "opened from the address: nothing to step back to",
  );
  // One project open keeps its address while the page stays Projects.
  assert.equal(
    step(place("/new"), place("/projects"), { address: "/project/p1" }),
    "none",
  );
});

test("tab titles name the place with the product", () => {
  const t = (patch: Partial<Parameters<typeof documentTitle>[0]>) =>
    documentTitle({ page: "chat", mode: "chat", ...patch });
  assert.equal(t({}), "Claudex");
  assert.equal(t({ mode: "cowork" }), "Claudex");
  assert.equal(t({ mode: "code" }), "Claudex Code");
  assert.equal(
    t({ conversation: { title: "Trip plan", mode: "chat" } }),
    "Trip plan - Claudex",
  );
  assert.equal(
    t({ conversation: { title: "  ", mode: "cowork" } }),
    "New chat - Claudex",
  );
  assert.equal(
    t({ conversation: { title: "Fix CI", mode: "code" } }),
    "Fix CI - Claudex Code",
  );
  assert.equal(
    t({
      incognitoShown: true,
      conversation: { title: "Secret", mode: "chat" },
    }),
    "Incognito chat - Claudex",
  );
  assert.equal(t({ page: "projects" }), "Projects - Claudex");
  assert.equal(t({ page: "artifacts" }), "Artifacts - Claudex");
  assert.equal(t({ page: "customize" }), "Customize - Claudex");
  assert.equal(t({ page: "history" }), "Recents - Claudex");
  assert.equal(t({ page: "not-found" }), "Page not found - Claudex");
  assert.equal(t({ page: "other" }), "Claudex");
  assert.equal(
    t({ settingsOpen: true, page: "projects" }),
    "Settings - Claudex",
  );
  assert.equal(t({ unseen: 2 }), "(2) Claudex");
  assert.equal(t({ unseen: 0 }), "Claudex");
});

test("the unseen count is chats that became unread in the background", () => {
  const list = [
    conversation("a", "chat", { unread: true }),
    conversation("b", "chat", { unread: true }),
    conversation("c", "chat"),
    conversation("d", "chat", { unread: true, archived: true }),
    conversation("e", "chat", { unread: true, incognito: true }),
  ];
  assert.equal(newlyUnread(list, new Set(["a"])), 1);
  assert.equal(newlyUnread(list, new Set(["a", "b"])), 0);
  assert.equal(newlyUnread(list, new Set()), 2);
});

test("the tab icon and theme colour", () => {
  const links = faviconLinks({ svg: "/s.svg", png: "/p.png", touch: "/t.png" });
  assert.deepEqual(
    links.map((link) => [link.rel, link.href, link.sizes]),
    [
      ["icon", "/s.svg", "any"],
      ["icon", "/p.png", "32x32"],
      ["apple-touch-icon", "/t.png", "180x180"],
    ],
  );
  assert.equal(themeColor("dark"), "#141414");
  assert.equal(themeColor("light"), "#fcfcfb");
  assert.equal(themeColor(undefined), "#141414");
  // The tab icon is the Claudex app icon's mark alone, in its orange and
  // without the plate, not Claude's mark.
  const svg = readFileSync(
    new URL("../../public-web/favicon.svg", import.meta.url),
    "utf8",
  );
  const appIcon = readFileSync(
    new URL("../../build/icon.svg", import.meta.url),
    "utf8",
  );
  const marks = (text: string) => text.match(/<path d="[^"]+"/g) ?? [];
  assert.equal(marks(svg).length, 6);
  assert.deepEqual(marks(svg), marks(appIcon), "the app icon's strokes");
  assert.ok(!svg.includes("<rect"), "no plate");
  assert.ok(svg.includes("#D97757"));
  assert.ok(!svg.includes("m4.7144"));
  for (const name of ["favicon-32.png", "apple-touch-icon.png"]) {
    const png = readFileSync(
      new URL(`../../public-web/${name}`, import.meta.url),
    );
    assert.equal(png.subarray(1, 4).toString(), "PNG", name);
  }
});

test("connector Settings destinations survive canonicalization and refresh while their background stays clean", async () => {
  const { withoutSettingsConnector, settingsConnectorFromSearch } =
    await import("../../src/web/routes");
  const target = "/code?connector=integration-github#settings/connectors";
  const route = parseWebRoute(
    "/code",
    "?connector=integration-github",
    "#settings/connectors",
  );
  assert.deepEqual(route, {
    kind: "settings",
    tab: "connectors",
    connector: "integration-github",
    background: { kind: "code" },
  });
  assert.equal(formatWebRoute(route), target);
  assert.equal(
    urlForState({
      page: "chat",
      mode: "code",
      settingsOpen: true,
      settingsTab: "connectors",
      settingsConnector: "integration-github",
    }),
    target,
  );
  assert.equal(
    formatWebRoute(
      parseWebRoute("/settings/connectors", "?connector=integration-github"),
    ),
    "/new?connector=integration-github#settings/connectors",
  );
  assert.equal(
    withoutSettingsConnector("/code?github=repos&connector=integration-github"),
    "/code?github=repos",
  );
  assert.equal(
    withoutSettingsConnector("/customize/skills?connector=x#settings/general"),
    "/customize/skills#settings/general",
  );
  assert.equal(
    formatWebRoute(parseWebRoute("/code", "?connector=x", "#settings/general")),
    "/code#settings/general",
  );
  assert.equal(settingsConnectorFromSearch("?connector=%00bad"), undefined);
  assert.equal(
    settingsConnectorFromSearch("?connector=" + "a".repeat(2049)),
    undefined,
  );
});

test("projects live at /projects and /project/<id>; the pre-merge /cowork addresses still open them", () => {
  assert.deepEqual(parseWebRoute("/cowork/projects", ""), {
    kind: "page",
    page: "projects",
  });
  assert.deepEqual(parseWebRoute("/cowork/project/abc", ""), {
    kind: "project",
    id: "abc",
  });
  assert.equal(formatWebRoute({ kind: "page", page: "projects" }), "/projects");
  assert.equal(formatWebRoute({ kind: "project", id: "abc" }), "/project/abc");
});

test("the original's settings addresses open the same Claudex pages", async () => {
  const { tabId } = await import("../../src/settings/nav");
  assert.deepEqual(
    [
      "data-privacy-controls",
      "design-systems",
      "time-limits",
      "browser-extension",
    ].map(tabId),
    ["privacy", "design", "time", "chrome"],
  );
});
