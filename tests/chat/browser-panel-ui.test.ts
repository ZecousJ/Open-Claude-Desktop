import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { browsingDataConfirmation } from "../../src/browser/session-data";
import type {
  BrowserTabState,
  DevServerState,
  ElementPick,
} from "../../shared/browser";
import {
  appendToDraft,
  browserToggleShown,
  commandLineOf,
  configFromDraft,
  draftOf,
  elementPickText,
  hasPreference,
  openableElsewhere,
  splitCommandLine,
  tabShowsPage,
  tabTitle,
  boxesOverlap,
} from "../../src/browser/browser-model";
import {
  devServerEntries,
  devServerTooltip,
} from "../../src/browser/DevServersMenu";
import {
  browserSettingsEntries,
  keepCookiesEntries,
} from "../../src/browser/BrowserSettingsMenu";
import {
  BrowserToolsOff,
  DevServerFailedCard,
  DevServerNotStarted,
  DevServerStoppedCard,
  lastLogLine,
} from "../../src/browser/PreviewStatus";
import { BlockedSiteStrip } from "../../src/browser/BrowserErrorState";
import { BrowserEmptyState } from "../../src/browser/BrowserEmptyState";
import {
  BrowserErrorState,
  BrowserNotices,
} from "../../src/browser/BrowserErrorState";
import { BrowserTabStrip } from "../../src/browser/BrowserTabStrip";
import { AddressBar, addressParts } from "../../src/browser/AddressBar";
import { ConversationPanelButtons } from "../../src/conversation/ConversationPanelButtons";
import type { MenuEntry } from "../../src/ui/Menu";

const tab = (extra: Partial<BrowserTabState> = {}): BrowserTabState => ({
  id: "t1",
  url: "",
  title: "New tab",
  loading: false,
  stalled: false,
  canGoBack: false,
  canGoForward: false,
  ...extra,
});
const html = (type: unknown, props: object) =>
  renderToStaticMarkup(createElement(type as never, props as never));
const labels = (entries: MenuEntry[]) =>
  entries.map((entry) =>
    "label" in entry
      ? `${entry.label}${entry.disabled ? " (off)" : ""}${entry.checked ? " ✓" : ""}`
      : "heading" in entry
        ? `# ${entry.heading}`
        : "---",
  );

test("browser page tools include annotation, contextual export and reusable cookies", () => {
  const selected: string[] = [];
  const entries = browserSettingsEntries({
    browserName: null,
    hasPage: true,
    canOpenElsewhere: true,
    toolsAvailable: true,
    viewport: { width: 900, height: 700 },
    settings: {},
    actions: {
      ...actions,
      showAnnotationTools: () => selected.push("annotate"),
      hasExportFile: true,
      exportFile: () => selected.push("export"),
      importCookies: () => selected.push("import"),
      useImportedCookies: () => selected.push("reuse"),
    },
  });
  const row = (label: string) => {
    const entry = entries.find(
      (entry) => "label" in entry && entry.label === label,
    );
    assert.ok(entry && "label" in entry);
    return entry;
  };
  assert.deepEqual(labels(row("Viewport").submenu!), [
    "Responsive",
    "Mobile",
    "Tablet",
    "Custom ✓",
  ]);
  assert.equal(row("Viewport").value, "900 × 700");
  assert.deepEqual(labels(row("Export").submenu!), [
    "Export…",
    "Save screenshot",
  ]);
  row("Show annotation tools").onSelect?.();
  row("Export").submenu?.forEach((entry) => {
    if ("label" in entry && entry.label === "Export…") entry.onSelect?.();
  });
  row("Import cookies…").onSelect?.();
  row("Use cookies you already imported").onSelect?.();
  assert.deepEqual(selected, ["annotate", "export", "import", "reuse"]);
  assert.match(
    browsingDataConfirmation(true).body,
    /every Code session and Cowork/,
  );
  assert.match(browsingDataConfirmation(false).body, /this session’s browser/);
  assert.equal(browsingDataConfirmation(true).title, "Clear browsing data?");
});

test("Cowork keeps import and clearing but does not offer Code's cookie lifetime choices", () => {
  const entries = browserSettingsEntries({
    browserName: null,
    hasPage: true,
    canOpenElsewhere: true,
    toolsAvailable: true,
    settings: { browserKeepCookies: "until-quit" },
    actions: { ...actions, cowork: true, importCookies: () => {} },
  });
  assert.ok(labels(entries).includes("Import cookies…"));
  assert.ok(labels(entries).includes("Clear browsing data"));
  assert.ok(!labels(entries).includes("Keep cookies"));
});

test("the browser shows in Code with the capability and policy, remaining a Preview when Browser tools are off", () => {
  const base = {
    mode: "code" as const,
    capability: true,
    policyEnabled: true,
    settings: {},
  };
  assert.equal(browserToggleShown(base), true);
  assert.equal(browserToggleShown({ ...base, mode: "chat" }), false);
  assert.equal(browserToggleShown({ ...base, mode: "cowork" }), true);
  assert.equal(browserToggleShown({ ...base, capability: false }), false);
  assert.equal(browserToggleShown({ ...base, policyEnabled: false }), false);
  assert.equal(
    browserToggleShown({ ...base, settings: { browserTools: false } }),
    true,
  );
  assert.equal(
    browserToggleShown({ ...base, settings: { browserTools: true } }),
    true,
  );
});

test("dock cards open side by side in a fixed order and close on their own", async () => {
  const { openInDock, isDockPanel } =
    await import("../../src/app/useToolPanels");
  // Background tasks, Changes and Browser stack; Terminal has its own column.
  let dock = openInDock([], "browser");
  dock = openInDock(dock, "background");
  dock = openInDock(dock, "terminal");
  dock = openInDock(dock, "changes");
  assert.deepEqual(dock, ["background", "changes", "browser", "terminal"]);
  // Opening one already open changes nothing.
  assert.deepEqual(openInDock(dock, "changes"), dock);
  assert.equal(isDockPanel("plan"), true); // Plan sits in the dock with the others
  assert.equal(isDockPanel("terminal"), true);
  assert.equal(isDockPanel(null), false);
});

test("the title bar alone (no window state) keeps Terminal and Changes only", () => {
  const markup = html(ConversationPanelButtons, {
    conversation: { id: "c" },
    mode: "code",
    panel: null,
    onTogglePanel() {},
  });
  assert.match(markup, /aria-label="Changes"/);
  assert.doesNotMatch(markup, /aria-label="Browser"/);
});

test("commands split like shell words and never lose quoting", () => {
  assert.deepEqual(splitCommandLine("npm run dev"), {
    ok: true,
    words: ["npm", "run", "dev"],
  });
  assert.deepEqual(splitCommandLine(`node "my server.js" --x='a b' c\\ d ""`), {
    ok: true,
    words: ["node", "my server.js", "--x=a b", "c d", ""],
  });
  assert.deepEqual(splitCommandLine(`echo "a \\"b\\" \\$HOME"`), {
    ok: true,
    words: ["echo", 'a "b" $HOME'],
  });
  assert.equal(splitCommandLine(`npm "run`).ok, false);
  const config = {
    name: "web",
    runtimeExecutable: "npm",
    runtimeArgs: ["run", "dev", "--", "--host", "my host", "it's"],
  };
  const line = commandLineOf(config);
  const round = splitCommandLine(line);
  assert.ok(round.ok);
  assert.deepEqual(round.words, ["npm", ...config.runtimeArgs]);
});

test("Add server checks the form like launch.json", () => {
  const draft = {
    name: "web",
    command: "pnpm dev --port 5173",
    port: "5173",
    url: "",
    cwd: "apps/web/",
  };
  assert.deepEqual(configFromDraft(draft), {
    ok: true,
    config: {
      name: "web",
      runtimeExecutable: "pnpm",
      runtimeArgs: ["dev", "--port", "5173"],
      port: 5173,
      cwd: "apps/web",
    },
  });
  const bad = (patch: Partial<typeof draft>, names: string[] = []) => {
    const result = configFromDraft({ ...draft, ...patch }, names);
    assert.equal(result.ok, false, JSON.stringify(patch));
    return result.ok ? "" : result.message;
  };
  bad({ name: "" });
  assert.match(bad({}, ["web"]), /already exists/);
  bad({ command: "  " });
  bad({ port: "70000" });
  bad({ port: "", url: "" });
  assert.match(bad({ url: "https://example.com" }), /this computer/);
  bad({ url: "http://user:pw@localhost:3000" });
  bad({ cwd: "../outside" });
  bad({ cwd: "/etc" });
  bad({ cwd: "~/x" });
  const local = configFromDraft({
    ...draft,
    port: "",
    url: "http://app.localhost:8080/admin",
    cwd: ".",
  });
  assert.ok(local.ok);
  assert.equal(local.ok && local.config.cwd, undefined);
  // An existing configuration fills the form back in.
  assert.deepEqual(
    draftOf({
      name: "api",
      runtimeExecutable: "python",
      runtimeArgs: ["manage.py", "runserver"],
      port: 8000,
      cwd: ".",
    }),
    {
      name: "api",
      command: "python manage.py runserver",
      port: "8000",
      url: "",
      cwd: "",
    },
  );
});

test("Select element adds the element's place, selector and HTML to the message", () => {
  const pick: ElementPick = {
    selector: "#app > button.primary",
    tag: "button",
    text: "  Sign\n in ",
    outerHTML: '<button class="primary">Sign in</button>',
    styles: { color: "rgb(255, 255, 255)", "font-size": "14px" },
    box: { x: 1, y: 2, width: 3, height: 4 },
    url: "http://localhost:5173/login",
  };
  const text = elementPickText(pick);
  assert.match(text, /^Selected element on http:\/\/localhost:5173\/login:/);
  assert.match(text, /Selector: `#app > button\.primary`/);
  assert.match(text, /Text: "Sign in"/);
  assert.match(text, /font-size: 14px;/);
  assert.match(text, /```html\n<button class="primary">Sign in<\/button>\n```/);
  assert.equal(appendToDraft("", "X"), "X\n");
  assert.equal(appendToDraft("Fix this  \n", "X"), "Fix this\n\nX\n");
});

test("tab helpers: titles, pages, what opens elsewhere", () => {
  assert.equal(tabTitle(tab()), "New tab");
  assert.equal(
    tabTitle(tab({ url: "http://localhost:5173/", title: "" })),
    "localhost:5173",
  );
  assert.equal(tabShowsPage(tab()), false);
  assert.equal(tabShowsPage(tab({ url: "https://a.dev/" })), true);
  assert.equal(
    tabShowsPage(
      tab({
        url: "https://a.dev/",
        error: { code: -1, description: "x", url: "https://a.dev/" },
      }),
    ),
    false,
  );
  assert.equal(openableElsewhere(tab()), false);
  assert.equal(openableElsewhere(tab({ url: "https://a.dev/" })), true);
  assert.equal(openableElsewhere(tab({ url: "about:blank" })), false);
  assert.ok(
    boxesOverlap(
      { left: 0, top: 0, right: 10, bottom: 10 },
      { left: 9, top: 9, right: 20, bottom: 20 },
    ),
  );
  assert.ok(
    !boxesOverlap(
      { left: 0, top: 0, right: 10, bottom: 10 },
      { left: 10, top: 0, right: 20, bottom: 10 },
    ),
  );
});

const actions = {
  openElsewhere() {},
  saveScreenshot() {},
  openHtmlFile() {},
  setPreference() {},
  manageAllowedSites() {},
  chooseKeepCookies() {},
  clearBrowsingData() {},
  copyUrl() {},
  setViewport() {},
  setColorScheme() {},
};

test("the settings menu is the reference's, without Import cookies", () => {
  const settings = {
    browserOpenLinksInApp: false,
    browserAutoVerify: true,
    browserAllowedSites: [],
    browserKeepCookies: "until-quit",
  };
  const entries = browserSettingsEntries({
    browserName: "Google Chrome",
    hasPage: false,
    canOpenElsewhere: false,
    toolsAvailable: true,
    settings,
    actions,
  });
  assert.deepEqual(labels(entries), [
    "Open in Google Chrome (off)",
    "Copy URL (off)",
    "Save screenshot (off)",
    "Open HTML file…",
    "Export (off)",
    "---",
    "Viewport (off)",
    "Color scheme",
    "---",
    "Open links in built-in browser",
    "Auto-verify changes ✓",
    "Manage allowed sites…",
    "---",
    "# Cookies",
    "Keep cookies",
    "Clear browsing data",
  ]);
  const keep = entries.find(
    (entry) => "label" in entry && entry.label === "Keep cookies",
  );
  assert.ok(keep && "label" in keep);
  assert.equal(keep.value, "Until quit");
  const chosen: string[] = [];
  const choices = keepCookiesEntries(
    { browserKeepCookies: "per-session" },
    (value) => chosen.push(value),
  );
  assert.deepEqual(labels(choices), [
    "# Keep cookies",
    "Until quit",
    "Shared",
    "Per session ✓",
  ]);
  const always = choices[2];
  assert.ok("label" in always);
  assert.equal(
    always.description,
    "Cowork and all Code sessions share cookies",
  );
  assert.equal(always.descriptionWraps, true);
  always.onSelect?.();
  assert.deepEqual(chosen, ["always"]);
  assert.ok(
    entries.some(
      (entry) =>
        "label" in entry &&
        entry.label === "Clear browsing data" &&
        entry.danger,
    ),
  );
  assert.ok(!labels(entries).some((label) => /Import cookies/.test(label)));
});

test("switches show at their defaults when nothing is saved; without Browser tools the tool ones stay out", () => {
  const bare = browserSettingsEntries({
    browserName: null,
    hasPage: true,
    canOpenElsewhere: true,
    toolsAvailable: true,
    settings: {},
    actions,
  });
  assert.deepEqual(labels(bare), [
    "Open in browser",
    "Copy URL",
    "Save screenshot",
    "Open HTML file…",
    "Export",
    "---",
    "Viewport",
    "Color scheme",
    "---",
    "Open links in built-in browser ✓",
    "Auto-verify changes",
    "Manage allowed sites…",
    "---",
    "# Cookies",
    "Keep cookies",
    "Clear browsing data",
  ]);
  const noTools = browserSettingsEntries({
    browserName: null,
    hasPage: true,
    canOpenElsewhere: true,
    toolsAvailable: false,
    settings: {
      browserOpenLinksInApp: true,
      browserAutoVerify: false,
      browserAllowedSites: [],
    },
    actions,
  });
  assert.ok(labels(noTools).includes("Open links in built-in browser ✓"));
  assert.ok(!labels(noTools).some((l) => /Auto-verify|allowed sites/.test(l)));
  assert.equal(hasPreference("browserAutoVerify"), true);
  const viewport = bare.find((e) => "label" in e && e.label === "Viewport");
  assert.ok(viewport && "label" in viewport);
  assert.equal(viewport.value, "Responsive");
  assert.deepEqual(
    viewport.submenu!.map(
      (e) => "label" in e && [e.label, e.value, Boolean(e.checked)],
    ),
    [
      ["Responsive", undefined, true],
      ["Mobile", "375 × 812", false],
      ["Tablet", "768 × 1024", false],
    ],
  );
  const project = browserSettingsEntries({
    browserName: null,
    hasPage: true,
    canOpenElsewhere: true,
    toolsAvailable: true,
    viewport: "tablet",
    colorScheme: "dark",
    autoVerify: false,
    settings: { browserAutoVerify: true },
    actions: { ...actions, toggleAutoVerify() {} },
  });
  assert.ok(labels(project).includes("Enable auto verify"));
  assert.ok(!labels(project).some((l) => /Auto-verify changes/.test(l)));
  const color = project.find((e) => "label" in e && e.label === "Color scheme");
  assert.ok(color && "label" in color && color.value === "Dark");
  assert.deepEqual(labels(color.submenu!), ["Light", "Dark ✓", "System"]);
  assert.equal(hasPreference("noSuchPreference"), false);
});

test("dev servers menu: rows with Run or Stop at their ends, Stop all, the empty line", () => {
  const calls: string[] = [];
  const act = {
    start: (s: DevServerState) => calls.push(`start ${s.name}`),
    stop: (s: DevServerState) => calls.push(`stop ${s.name}`),
    open: (s: DevServerState) => calls.push(`open ${s.name}`),
    stopAll: () => calls.push("stop all"),
    add: () => calls.push("add"),
  };
  assert.deepEqual(labels(devServerEntries([], act)), [
    "# Servers",
    "No dev server configured (off)",
    "---",
    "Add server",
  ]);
  const server = (extra: Partial<DevServerState>): DevServerState => ({
    name: "web",
    command: "npm run dev",
    port: 5173,
    url: "http://localhost:5173",
    status: "stopped",
    source: "launch.json",
    ...extra,
  });
  const entries = devServerEntries(
    [
      server({ status: "running" }),
      server({ name: "docs", status: "stopped", port: undefined }),
      server({ name: "api", status: "starting", port: 8080 }),
      server({
        name: "seen",
        status: "running",
        source: "detected-output",
        url: "http://localhost:3000",
      }),
    ],
    { ...act, toggleLogs: () => calls.push("logs") },
    { showingUrl: "http://localhost:5173/about", logsOpen: true },
  );
  assert.deepEqual(labels(entries), [
    "# Servers",
    "web ✓",
    "docs",
    "api",
    "seen",
    "Stop all servers",
    "---",
    "Add server",
    "Hide dev server logs",
  ]);
  const row = (index: number) =>
    entries[index] as Extract<MenuEntry, { label: string }>;
  assert.equal(row(1).tooltip, ":5173");
  assert.equal(row(2).tooltip, "Not running");
  assert.equal(row(3).tooltip, "Starting…");
  assert.deepEqual(
    [1, 2, 3, 4].map(
      (i) =>
        row(i).trailing && [
          row(i).trailing!.text,
          row(i).trailing!.label,
          Boolean(row(i).trailing!.danger),
        ],
    ),
    [
      ["Stop", "Stop web", true],
      ["Run", "Run docs", false],
      ["Stop", "Stop api", true],
      undefined,
    ],
  );
  assert.equal(row(1).trailing!.hint, "press right arrow to stop");
  assert.equal(row(5).danger, true);
  row(1).onSelect?.();
  row(2).onSelect?.();
  row(1).trailing!.onAction();
  row(2).trailing!.onAction();
  row(4).onSelect?.();
  row(5).onSelect?.();
  assert.equal(row(3).onSelect, undefined);
  assert.deepEqual(calls, [
    "open web",
    "start docs",
    "stop web",
    "start docs",
    "open seen",
    "stop all",
  ]);
  assert.equal(
    devServerTooltip(server({ status: "failed" })),
    "Failed to start",
  );
});

test("a new tab says what the browser is for, with Detect dev server when it can run", () => {
  const on = html(BrowserEmptyState, { toolsAvailable: true, onDetect() {} });
  assert.match(on, /Browse with Claudex/);
  assert.match(
    on,
    /Type a URL or ask Claudex to open a site\. Claudex can read, click, and type\./,
  );
  assert.match(
    on,
    /<span>Preview your app instead\?<\/span><button[^>]*class="preview-button ghost xxs"[^>]*>Detect dev server/,
  );
  const manual = html(BrowserEmptyState, { toolsAvailable: false });
  assert.match(manual, /Type a URL to open a site\./);
  assert.doesNotMatch(manual, /Detect dev server|Claudex can read/);
});

test("dev server cards: failed with its last log line, stopped with Restart, not started, tools off", () => {
  const failed = html(DevServerFailedCard, {
    message: "> vite\n\nError: listen EADDRINUSE :::5173\n",
    busy: false,
    onRetry() {},
  });
  assert.match(failed, /Dev server failed to start/);
  assert.match(failed, /<span>Error: listen EADDRINUSE :::5173<\/span>/);
  assert.match(failed, /aria-label="Copy error log"/);
  assert.match(failed, />Try again</);
  assert.doesNotMatch(failed, /sent to Claude/);
  assert.equal(lastLogLine("a\n  b  \n\n"), "b");
  const stopped = html(DevServerStoppedCard, {
    name: "web",
    busy: true,
    onRestart() {},
  });
  assert.match(
    stopped,
    /<span class="preview-stopped-name">web<\/span><span class="preview-stopped-state">Stopped/,
  );
  assert.match(stopped, /aria-label="Restart web" aria-busy="true" disabled/);
  assert.match(
    stopped,
    /The dev server stopped\. Restart it, or close the preview\./,
  );
  const declined = html(DevServerNotStarted, { busy: false, onRetry() {} });
  assert.match(
    declined,
    /Dev server wasn’t started.*It needs your approval to start\..*Try again/,
  );
  const off = html(BrowserToolsOff, { onTurnOn() {} });
  assert.match(off, /Browser tools are turned off/);
  assert.match(off, /Turn on Browser tools/);
});

test("load errors say why and offer Try again and the system browser", () => {
  const refused = html(BrowserErrorState, {
    tab: tab({
      url: "http://localhost:3000/",
      error: {
        code: -102,
        description: "ERR_CONNECTION_REFUSED",
        url: "http://localhost:3000/",
      },
    }),
    browserName: "Google Chrome",
    onRetry() {},
    onOpenElsewhere() {},
  });
  assert.match(refused, /This site can(&#x27;|')t be reached/);
  assert.match(refused, /localhost:3000 refused to connect\./);
  assert.match(refused, /Try again/);
  assert.match(refused, /Open in Google Chrome/);
  const blocked = html(BrowserErrorState, {
    tab: tab({
      url: "https://x.example/",
      error: {
        code: 0,
        description: "BLOCKED_BY_ADMINISTRATOR",
        url: "https://x.example/",
      },
    }),
    browserName: null,
    onRetry() {},
  });
  assert.equal(blocked, "");
  const strip = html(BlockedSiteStrip, {});
  assert.match(strip, /class="browser-blocked" role="status"/);
  assert.match(strip, /This site is blocked by your organization’s policy\./);
  const crashed = html(BrowserErrorState, {
    tab: tab({ url: "https://a.dev/", crashed: true }),
    browserName: null,
    onRetry() {},
  });
  assert.match(crashed, /This page crashed/);
  assert.match(crashed, /Reload/);
});

test("bars: picking, a slow page, the page's question, a refused download", () => {
  const markup = html(BrowserNotices, {
    tab: tab({
      url: "http://localhost:5173/",
      loading: true,
      stalled: true,
      dialog: {
        type: "prompt",
        message: "Your name?",
        origin: "http://localhost:5173",
        defaultValue: "Ada",
      },
      notice: { kind: "download-blocked", filename: "report.pdf" },
    }),
    picking: true,
    onCancelPick() {},
    onStop() {},
    onAnswer() {},
  });
  assert.match(markup, /Click an element on the page/);
  assert.match(markup, /taking a long time to finish loading/);
  assert.match(markup, /http:\/\/localhost:5173 says:/);
  assert.match(markup, /Your name\?/);
  assert.match(markup, /value="Ada"/);
  assert.match(markup, /Downloads aren(&#x27;|')t supported.*report\.pdf/);
});

test("tab strip and address row as in the reference", () => {
  const single = html(BrowserTabStrip, {
    tabs: [tab()],
    activeTabId: "t1",
    onSelect() {},
    onClose() {},
    onNewTab() {},
    onContextMenu() {},
  });
  assert.match(single, /<span>New tab<\/span>/);
  assert.match(single, /aria-label="New tab"/);
  assert.doesNotMatch(single, /Close New tab/);
  const several = html(BrowserTabStrip, {
    tabs: [tab(), tab({ id: "t2", url: "https://vite.dev/", title: "Vite" })],
    activeTabId: "t2",
    onSelect() {},
    onClose() {},
    onNewTab() {},
    onContextMenu() {},
  });
  assert.match(several, /aria-label="Close Vite"/);
  assert.match(several, /aria-selected="true"[^>]*><span>Vite/);
  const row = html(AddressBar, {
    tab: tab({ url: "https://example.com/docs/", canGoBack: true }),
    picking: false,
    canPick: true,
    onNavigate: async () => true,
    onBack() {},
    onForward() {},
    onReload() {},
    onStop() {},
    onPick() {},
    onOpenExternal() {},
  });
  assert.match(row, /placeholder="Type a URL"/);
  assert.match(row, /aria-label="Page URL"/);
  assert.match(row, /aria-label="Open in default browser"/);
  assert.match(row, /value="example.com\/docs\/"/);
  assert.match(row, /aria-label="Back"(?![^>]*disabled)/);
  assert.match(row, /aria-label="Forward"[^>]*disabled/);
  assert.doesNotMatch(row, /Phone size/);
  const loading = html(AddressBar, {
    tab: tab({ url: "https://a.dev/", loading: true }),
    picking: false,
    canPick: false,
    onNavigate: async () => true,
    onBack() {},
    onForward() {},
    onReload() {},
    onStop() {},
    onPick() {},
  });
  assert.match(loading, /role="status" aria-label="Loading page"/);
  assert.match(loading, /aria-label="Page URL"/);
  assert.doesNotMatch(loading, /aria-label="Stop"/);
  assert.match(loading, /aria-label="Select element"[^>]*disabled/);
  // Loading, Reload is a status spinner; at rest the field shows
  // the host and the muted path over the clear input.
  assert.match(loading, /data-cds="Spinner"/);
  assert.match(
    row,
    /browser-address-overlay[^]*<span>example.com<\/span><span class="browser-address-path">\/docs\/<\/span>/,
  );
});

test("the resting address splits into host and muted rest", () => {
  assert.deepEqual(addressParts("https://example.com/a?b=1#c"), {
    host: "example.com",
    suffix: "/a?b=1#c",
  });
  assert.deepEqual(addressParts("http://localhost:5173/"), {
    host: "http://localhost:5173",
    suffix: "",
  });
  assert.equal(addressParts("file:///tmp/a.html"), undefined);
  assert.equal(addressParts(""), undefined);
});
