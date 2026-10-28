import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectorHistory } from "../../electron/connectors/connector-history";
import type { McpServerState } from "../../shared/settings-desktop-api";
import type { ApprovedDirectoryEntry } from "../../shared/directory-submissions";
import { directorySubmissionInput } from "../../shared/directory-submissions-input";
import { DirectorySubmissions } from "../../electron/connectors/directory-submissions";
import { mcpServerStates } from "../../electron/connectors/mcp-config-file";
import {
  connectors,
  directoryConnectors,
  connectorServer,
  findConnectors,
  defaultConnectorFilter,
} from "../../shared/connectors-catalogue";
import {
  ConnectorCards,
  ConnectorDiscover,
  connectorShelves,
  connectorFilterTitle,
  NothingMatches,
} from "../../src/settings/tabs/ConnectorDirectory";
import {
  DirectoryReviewBadge,
  CommunityExplainer,
  reviewTooltips,
  communityExplainers,
} from "../../src/settings/directory/DirectoryReview";
import ConnectorFeatured from "../../src/settings/directory/ConnectorFeatured";
import ConnectorAttention from "../../src/settings/directory/ConnectorAttention";
import { popularDirectoryPlugins } from "../../src/settings/directory/ConnectorPlugins";
import type { PluginEntry } from "../../shared/collections-api";
import {
  nextReconnect,
  readReconnectQueue,
  type ReconnectQueue,
} from "../../src/settings/directory/connector-reconnect";

const entry: ApprovedDirectoryEntry = {
  id: "12345678-1234-4234-8234-123456789012",
  kind: "mcp",
  name: "Example",
  description: "Example service",
  url: "https://example.com/mcp",
  added: "2026-10-14",
  curation: {
    topic: "Code",
    isNew: true,
    isTrending: true,
    inChatUi: true,
    featured: {
      title: "Example",
      subtitle: "Example service",
      curator: "Claudex",
    },
  },
};
const server: McpServerState = {
  name: "Example",
  url: entry.url,
  tools: 0,
  state: "ready",
  authStatus: "notLoggedIn",
};

test("service curation flows through the existing directory API without allowing submitters to curate", async () => {
  const service = new DirectorySubmissions(async () => [entry]);
  const approved = await service.directory();
  const catalogue = directoryConnectors(approved);
  const found = catalogue.find((candidate) => candidate.id === entry.id)!;
  assert.equal(found.type, "community");
  assert.equal(found.byline, "");
  assert.equal(found.isTrending, true);
  assert.equal(found.inChatUi, true);
  assert.equal(found.featured?.title, "Example");
  assert.equal(
    findConnectors({ ...defaultConnectorFilter, type: "trending" }, catalogue)
      .length,
    1,
  );
  assert.equal(
    findConnectors({ ...defaultConnectorFilter, type: "inChatUi" }, catalogue)
      .length,
    1,
  );
  assert.equal(
    findConnectors(
      { ...defaultConnectorFilter, type: "desktopExtension" },
      catalogue,
    ).length,
    0,
  );
  const parsed = directorySubmissionInput.parse({
    ...entry,
    slug: "example",
    examples: "",
    email: "",
    license: "",
    termsAcknowledged: false,
    toolsVerified: false,
    tools: [],
  });
  assert.equal("curation" in parsed, false);
  const sameName = directoryConnectors([{ ...entry, name: "Linear" }]);
  const published = sameName.find((candidate) => candidate.id === entry.id)!;
  assert.equal(published.type, "community");
  assert.equal(published.byline, "");
  assert.equal(
    sameName.find((candidate) => candidate.id === "linear")?.type,
    "verified",
  );
});

test("directory shelves use real flags, omit empty shelves, and keep Trending ahead of New", () => {
  const catalogue = directoryConnectors([entry]);
  const shelves = connectorShelves(catalogue);
  assert.deepEqual(
    shelves.map((shelf) => shelf.title),
    ["Top connectors", "Trending connectors", "New connectors"],
  );
  assert.deepEqual(
    shelves[1].entries.map((candidate) => candidate.id),
    [entry.id],
  );
  assert.ok(!shelves[2].entries.some((candidate) => candidate.id === entry.id));
  assert.deepEqual(connectorShelves([]), []);
  const html = renderToStaticMarkup(
    createElement(ConnectorDiscover, {
      entries: catalogue,
      filter: defaultConnectorFilter,
      onShowAll() {},
      onReset() {},
    }),
  );
  assert.match(html, /Trending connectors/);
  assert.match(html, /New connectors/);
  assert.match(html, /Categories/);
  assert.equal(connectorFilterTitle("verified"), "Verified connectors");
  assert.equal(connectorFilterTitle("community"), "Community connectors");
  assert.equal(connectorFilterTitle("inChatUi"), "Connectors with in-chat UI");
});

test("badges expose review identity and use the exact connector, extension and plugin explanations", () => {
  assert.equal(
    reviewTooltips.verified,
    "Verified in the source directory. This is not a new Claudex security audit.",
  );
  assert.equal(
    reviewTooltips.custom,
    "You added this connector. Claudex has not reviewed it.",
  );
  for (const review of [
    "verified",
    "community",
    "custom",
    "organization",
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(DirectoryReviewBadge, { review }),
    );
    assert.match(html, /tabindex="0"/);
    assert.match(html, /aria-label=/);
    assert.doesNotMatch(html, /title=/);
  }
  for (const kind of ["connector", "desktop_extension", "plugin"] as const) {
    const html = renderToStaticMarkup(
      createElement(CommunityExplainer, { kind }),
    );
    assert.ok(html.includes(communityExplainers[kind]));
    assert.match(html, /\/help\/connector-review/);
    assert.match(html, /Learn more<\/a>\./);
  }
});

test("directory cards use icon actions, connected checkmarks and re-authorization, not credential split menus", () => {
  const connector = { ...connectors[0], name: server.name, url: entry.url };
  const render = (servers: McpServerState[]) =>
    renderToStaticMarkup(
      createElement(ConnectorCards, {
        entries: [connector],
        servers,
        onConnect() {},
      }),
    );
  assert.match(render([]), /aria-label="Connect Example to Claudex"/);
  assert.doesNotMatch(render([]), /disabled|Connect API credential/);
  assert.match(render([server]), /aria-label="Re-authorize Example"/);
  const connected = render([{ ...server, authStatus: "oAuth" }]);
  assert.match(connected, /aria-label="Example is connected"/);
  assert.doesNotMatch(connected, /aria-label="Connect Example/);
  const community = renderToStaticMarkup(
    createElement(ConnectorCards, {
      entries: [{ ...connector, type: "community" }],
    }),
  );
  assert.doesNotMatch(community, /customize-card-add/);
  assert.equal(
    connectorServer(connector, [{ ...server, name: "renamed" }])?.name,
    "renamed",
  );
  assert.equal(
    connectorServer(connector, [
      { ...server, url: "https://unrelated.example/mcp" },
    ]),
    undefined,
  );
});

test("the Featured carousel has labelled controls, inert inactive slides, and no controls for a single slide", () => {
  const catalogue = directoryConnectors([entry]);
  const featured = catalogue.find((candidate) => candidate.id === entry.id)!;
  const single = renderToStaticMarkup(
    createElement(ConnectorFeatured, { entries: [featured] }),
  );
  assert.doesNotMatch(
    single,
    /Previous slide|Next slide|aria-roledescription="carousel"/,
  );
  assert.match(single, /Explore/);
  const html = renderToStaticMarkup(
    createElement(ConnectorFeatured, {
      entries: [
        featured,
        {
          ...featured,
          id: "second",
          featured: { title: "Second", subtitle: "Second service" },
        },
      ],
    }),
  );
  assert.match(html, /aria-label="Featured" aria-roledescription="carousel"/);
  assert.match(html, /aria-label="Previous slide"/);
  assert.match(html, /aria-label="Next slide"/);
  assert.match(html, /aria-label="Show Second"/);
  assert.match(html, /aria-hidden="true" inert=""/);
  assert.match(html, /animation-play-state:running/);
  assert.equal(
    renderToStaticMarkup(createElement(ConnectorFeatured, { entries: [] })),
    "",
  );
});

test("attention and no-match copy use singular/plural strings rather than ICU syntax", () => {
  const render = (servers: McpServerState[]) =>
    renderToStaticMarkup(
      createElement(ConnectorAttention, {
        servers,
        editable: true,
        busy: false,
        onReconnect() {},
      }),
    );
  assert.match(render([server]), /1 of your connectors needs attention/);
  assert.match(
    render([server]),
    /Reconnect all 1 connector whose sign-in expired/,
  );
  assert.match(
    render([server, { ...server, name: "two" }]),
    /2 of your connectors need attention/,
  );
  assert.match(
    render([server, { ...server, name: "two" }]),
    /Reconnect all 2 connectors whose sign-in expired/,
  );
  assert.equal(render([{ ...server, state: "disabled" }]), "");
  assert.doesNotMatch(
    render([{ ...server, state: "failed", authStatus: "unsupported" }]),
    /Reconnect all/,
  );
  const html = renderToStaticMarkup(
    createElement(NothingMatches, { onReset() {} }),
  );
  assert.match(html, /No connectors match your filters/);
  assert.match(html, /Try a different search or clear your filters\./);
  assert.match(html, /Clear filters/);
  assert.doesNotMatch(html, /plural,/);
});

test("the attention banner is the warning Banner: icon, View, Reconnect all and a dismiss that stays until the broken set changes", async () => {
  const { JSDOM } = await import("jsdom");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const dom = new JSDOM("<html><body><main></main></body></html>", {
    url: "https://app.test/",
  });
  const { window } = dom;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    localStorage: window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const viewed: string[] = [];
  const root = createRoot(window.document.querySelector("main")!);
  const show = (servers: McpServerState[]) =>
    act(async () =>
      root.render(
        createElement(ConnectorAttention, {
          servers,
          editable: true,
          busy: false,
          onReconnect() {},
          onView: (item) => viewed.push(item.name),
        }),
      ),
    );
  try {
    await show([server]);
    const banner = window.document.querySelector(".auth-issue-banner")!;
    assert.equal(banner.getAttribute("data-variant"), "warning");
    assert.ok(banner.querySelector(".auth-issue-icon"));
    const buttons = [...banner.querySelectorAll("button")].map(
      (item) => item.textContent || item.getAttribute("aria-label"),
    );
    assert.equal(buttons.join("|"), "View|Reconnect all|Dismiss");
    await act(async () => banner.querySelector("button")!.click());
    assert.equal(viewed.join(), server.name);
    await act(async () =>
      banner.querySelector<HTMLButtonElement>(".auth-issue-dismiss")!.click(),
    );
    assert.equal(window.document.querySelector(".auth-issue-banner"), null);
    // The same broken set stays hidden; another broken connector shows it again.
    await show([server]);
    assert.equal(window.document.querySelector(".auth-issue-banner"), null);
    await show([server, { ...server, name: "two" }]);
    assert.ok(window.document.querySelector(".auth-issue-banner"));
  } finally {
    await act(async () => root.unmount());
    window.close();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("reconnect queues survive OAuth navigation and starting states but never cross accounts, ages or server URLs", () => {
  const queue: ReconnectQueue = {
    account: "one",
    startedAt: 10,
    connectors: [{ name: server.name, url: server.url! }],
    waiting: server.name,
  };
  assert.deepEqual(readReconnectQueue(JSON.stringify(queue), "one", 20), queue);
  assert.equal(readReconnectQueue(JSON.stringify(queue), "two", 20), undefined);
  assert.equal(
    readReconnectQueue(JSON.stringify(queue), "one", 30 * 60_000 + 11),
    undefined,
  );
  assert.equal(
    readReconnectQueue(
      JSON.stringify({ ...queue, connectors: [null] }),
      "one",
      20,
    ),
    undefined,
  );
  assert.equal(
    nextReconnect(queue, [
      { ...server, state: "starting", authStatus: undefined },
    ]).waiting,
    server.name,
  );
  assert.deepEqual(
    nextReconnect(queue, [{ ...server, authStatus: "oAuth" }]).connectors,
    [],
  );
  assert.deepEqual(
    nextReconnect(queue, [{ ...server, url: "https://changed.example/mcp" }])
      .connectors,
    [],
  );
});

test("sign-in history stores successful transitions, not startup, polling or refresh times, and persists privately", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-history-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 100;
  const history = new ConnectorHistory(root, () => now);
  assert.equal(
    history.states([{ ...server, authStatus: "oAuth" }])[0].lastConnectedAt,
    undefined,
  );
  history.states([server]);
  now = 200;
  assert.equal(
    history.states([{ ...server, authStatus: "oAuth" }])[0].lastConnectedAt,
    200,
  );
  now = 300;
  assert.equal(
    history.states([{ ...server, authStatus: "oAuth" }])[0].lastConnectedAt,
    200,
  );
  assert.equal(history.states([server])[0].lastConnectedAt, 200);
  assert.equal(
    new ConnectorHistory(root).states([server])[0].lastConnectedAt,
    200,
  );
  assert.equal(
    fs.statSync(path.join(root, "connector-history.json")).mode & 0o777,
    0o600,
  );
  history.complete(server.name, server.url!);
  assert.equal(history.states([server])[0].lastConnectedAt, 300);
  assert.equal(
    history.states([{ ...server, url: "https://changed.example/mcp" }])[0]
      .lastConnectedAt,
    undefined,
  );
  history.states([]);
  assert.equal(history.states([server])[0].lastConnectedAt, undefined);
});

test("popular plugins follow trusted curation order without duplicates or fabricated rankings", () => {
  const plugin = (name: string): PluginEntry => ({
    id: `${name}@marketplace`,
    name,
    title: name,
    marketplace: "marketplace",
    marketplacePath: "/plugins",
    installed: false,
    enabled: false,
    installable: true,
    source: "git",
  });
  const first = plugin("First");
  const second = plugin("Second");
  const curated = (name: string): ApprovedDirectoryEntry => ({
    ...entry,
    id: name,
    name,
    kind: "plugin",
    curation: { popular: true },
  });
  assert.deepEqual(
    popularDirectoryPlugins(
      [
        curated("Second"),
        curated("Missing"),
        curated("First"),
        curated("Second"),
      ],
      [first, second],
    ),
    [second, first],
  );
  assert.deepEqual(
    popularDirectoryPlugins(
      [{ ...curated("First"), curation: undefined }],
      [first],
    ),
    [],
  );
});

test("desktop extension provenance survives the main-process MCP state projection", () => {
  const states = mcpServerStates(
    {
      local: {
        command: "node",
        claudex_extension: "/profile/desktop-extensions/example",
      },
    },
    true,
    new Map(),
    [{ name: "local" }],
  );
  assert.equal(states[0].desktopExtension, true);
  assert.equal(
    findConnectors({ ...defaultConnectorFilter, type: "desktopExtension" }, [
      { ...connectors[0], desktopExtension: true },
    ]).length,
    1,
  );
});
