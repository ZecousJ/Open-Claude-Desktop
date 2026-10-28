/**
 * Desktop-only entry points are hidden in the web app (Settings navigation,
 * Developer/Extensions/Chrome/Connectors, Billing's payment wording, Settings
 * via /settings/<tab>, the project folder field and Customize), and the desktop
 * stays exactly as it was.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { desktopHost, webHost, type HostInfo } from "../../shared/host";

// Components import their stylesheets; SettingsModal and the checkout page
// portal into document.body, which the server renderer cannot do: render in
// place.
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === "react-dom" &&
      (context.parentURL?.endsWith("/src/settings/controls.tsx") ||
        context.parentURL?.endsWith("/src/settings/billing/CheckoutPage.tsx"))
    )
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent("export const createPortal = (node) => node;"),
        shortCircuit: true,
      };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  },
});

// The build defines the app version; the System page shows it.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = "0.0.0-test";

const { HostContext } = await import("../../src/host/HostContext");
const { navGroups, tabAvailable, availableNavGroups, openableTab, tabId } =
  await import("../../src/settings/nav");
const { Settings } = await import("../../src/settings/SettingsDialog");
const { ConnectorsTab, serviceNote } =
  await import("../../src/settings/tabs/Connectors");
const { ChromeTab } = await import("../../src/settings/tabs/Chrome");
const { ExtensionsTab } = await import("../../src/settings/tabs/Extensions");
const { DeveloperTab, mcpRefreshMs, serviceMcpRefreshMs } =
  await import("../../src/settings/tabs/Developer");
const { SkillsTab } = await import("../../src/settings/tabs/Skills");
const { CheckoutDialog } =
  await import("../../src/settings/billing/CheckoutDialog");
const { ProjectEditorDialog } =
  await import("../../src/dialogs/ProjectEditorDialog");
const { customizeOffers } =
  await import("../../src/collections/customize/customize-list");
const { SkillDetail } =
  await import("../../src/collections/customize/SkillDetail");
const { CustomizePage } =
  await import("../../src/collections/customize/CustomizePage");
const { defaultSettings } = await import("../../electron/store/store");

const withCapabilities = (
  host: HostInfo,
  capabilities: Partial<HostInfo["capabilities"]>,
): HostInfo => ({
  kind: host.kind,
  capabilities: { ...host.capabilities, ...capabilities },
});

const render = (host: HostInfo, node: ReactNode) =>
  renderToStaticMarkup(
    createElement(HostContext.Provider, { value: host }, node),
  );

const engine = { state: "ready" } as never;
const tabProps = {
  settings: defaultSettings,
  save: () => {},
  platform: "darwin" as NodeJS.Platform,
  engine,
  onError: () => {},
  goTo: () => {},
};

const ids = (groups: { tabs: { id: string }[] }[]) =>
  groups.flatMap((group) => group.tabs.map((tab) => tab.id));

test("the desktop navigation keeps local Code Usage without a service plan", () => {
  assert.deepEqual(
    availableNavGroups(desktopHost, true).map((g) => g.label),
    ["Settings", "Customize", "This computer"],
  );
  assert.deepEqual(ids(availableNavGroups(desktopHost, true)), ids(navGroups));
  // Design systems under Customize; Claude Code, Cowork and Claude in Chrome
  // under Products.
  assert.deepEqual(ids(navGroups.slice(1, 2)), [
    "skills",
    "connectors",
    "plugins",
  ]);
  assert.deepEqual(ids(availableNavGroups(desktopHost, false)), ids(navGroups));
  assert.equal(
    tabAvailable(
      "usage",
      {
        ...desktopHost,
        capabilities: { ...desktopHost.capabilities, localCode: false },
      },
      false,
    ),
    false,
  );
});

test("the web navigation has no This computer group, Chrome, Code or Cowork", () => {
  const groups = availableNavGroups(webHost, true);
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Settings", "Customize"],
  );
  assert.deepEqual(ids(groups), [
    "general",
    "account",
    "privacy",
    "billing",
    "usage",
    "capabilities",
    "memory",
    "design",
    "reflect",
    "time",
    "code",
    "skills",
    "connectors",
    "plugins",
  ]);
  for (const id of [
    "system",
    "extensions",
    "developer",
    "chrome",
    "cowork",
  ] as const)
    assert.equal(tabAvailable(id, webHost, true), false, id);
});

test("cloud Code and cloud Cowork bring their pages back on the web", () => {
  const cloud = withCapabilities(webHost, {
    cloudCode: true,
    cloudCowork: true,
  });
  assert.equal(tabAvailable("code", cloud, true), true);
  assert.equal(tabAvailable("cowork", cloud, true), false);
  assert.equal(openableTab("cowork", cloud, true), "capabilities");
  assert.equal(tabAvailable("developer", cloud, true), false);
  assert.equal(tabAvailable("system", cloud, true), false);
});

test("a page name the host has no page for opens General", () => {
  assert.equal(openableTab("system", desktopHost, true), "system");
  assert.equal(openableTab("desktop", desktopHost, true), "system");
  assert.equal(openableTab("system", webHost, true), "general");
  assert.equal(openableTab("desktop", webHost, true), "general");
  assert.equal(openableTab("connections", webHost, true), "general");
  assert.equal(openableTab("browser", webHost, true), "general");
  assert.equal(openableTab("billing", webHost, true), "billing");
  assert.equal(openableTab("tools", webHost, true), "capabilities");
  assert.equal(openableTab("claude-code", webHost, true), "code");
  assert.equal(openableTab("claudex-code", webHost, true), "code");
  assert.equal(openableTab("usage", webHost, false), "general");
  assert.equal(openableTab("nonsense", webHost, true), "general");
  // tabId itself is unchanged.
  assert.equal(tabId("desktop"), "system");
});

test("Settings… opens Claudex Code's page from Code, System's elsewhere", async () => {
  const { menuSettingsTab } = await import("../../src/settings/menu-tab");
  assert.equal(openableTab(menuSettingsTab(true), desktopHost, true), "code");
  assert.equal(
    openableTab(menuSettingsTab(false), desktopHost, true),
    "system",
  );
  // The web app has no System page: General.
  assert.equal(openableTab(menuSettingsTab(false), webHost, true), "general");
});

const settingsDialog = (host: HostInfo, initialTab: string) =>
  render(
    host,
    createElement(Settings, {
      settings: defaultSettings,
      platform: "darwin",
      engine,
      planUsage: true,
      initialTab,
      onSave: () => {},
      onClose: () => {},
      onError: () => {},
    }),
  );

const navButtons = (html: string) =>
  [
    ...html
      .split('aria-label="Settings pages"')[1]
      .split("</nav>")[0]
      .matchAll(
        /<button[^>]*>(?:<(?:svg|span)[^>]*>[\s\S]*?<\/(?:svg|span)>)?([^<]+)<\/button>/g,
      ),
  ].map((match) => match[1]);

test("the Settings dialog lists only the web's pages on the web", () => {
  const web = settingsDialog(webHost, "general");
  const shown = navButtons(web);
  assert.ok(shown.includes("General"));
  assert.ok(shown.includes("Billing"));
  assert.ok(shown.includes("Connectors"));
  assert.ok(shown.includes("Claudex Code"));
  for (const label of [
    "System",
    "Extensions",
    "Developer",
    "Claudex in Chrome",
    "Cowork",
  ])
    assert.ok(!shown.includes(label), label);
  assert.doesNotMatch(web, /This computer/);

  const desktop = navButtons(settingsDialog(desktopHost, "general"));
  for (const label of ["System", "Extensions", "Developer", "Claudex Code"])
    assert.ok(desktop.includes(label), label);
});

test("/settings/<a desktop page> opens General on the web, the page on the desktop", () => {
  const current = (html: string) =>
    /<button aria-current="page">(?:<(?:svg|span)[^>]*>[\s\S]*?<\/(?:svg|span)>)?([^<]+)<\/button>/.exec(
      html,
    )?.[1];
  assert.equal(current(settingsDialog(webHost, "developer")), "General");
  assert.equal(current(settingsDialog(webHost, "system")), "General");
  assert.equal(current(settingsDialog(webHost, "billing")), "Billing");
  assert.equal(current(settingsDialog(desktopHost, "developer")), "Developer");
  assert.equal(current(settingsDialog(desktopHost, "system")), "System");
});

test("Connectors on the web changes nothing: no Edit config or Add custom connector", () => {
  const web = render(webHost, createElement(ConnectorsTab, tabProps));
  assert.match(web, /Connectors/);
  assert.doesNotMatch(web, /Edit config/);
  assert.doesNotMatch(web, /Add custom connector/);
  // The Add connector menu stays for Browse connectors; custom connectors say
  // they aren't here.
  assert.match(web, /Custom connectors aren’t available for this account\./);
  // On the desktop both are in the Add ⌄ menu.
  const desktop = render(desktopHost, createElement(ConnectorsTab, tabProps));
  assert.match(desktop, /aria-haspopup="menu"[^>]*>.*Add/);
  assert.match(serviceNote, /service provides these connectors/);
});

test("Chrome and Extensions point to Developer only where it exists", () => {
  // The glyph sprite's file URL sits in the markup; it can hold any folder name.
  const chromeWeb = render(webHost, createElement(ChromeTab, tabProps)).replace(
    /href="[^"]*"/g,
    "",
  );
  assert.doesNotMatch(chromeWeb, /Developer/);
  assert.match(
    render(desktopHost, createElement(ChromeTab, tabProps)),
    // The disabled Enable switch names the way there (UI first).
    /browser MCP server added under Developer/,
  );
  const extensionsWeb = render(webHost, createElement(ExtensionsTab, tabProps));
  assert.doesNotMatch(extensionsWeb, /Advanced settings/);
  assert.match(
    render(desktopHost, createElement(ExtensionsTab, tabProps)),
    /Advanced settings/,
  );
});

test("Developer asks the service for connectors less often than the local file", () => {
  assert.equal(mcpRefreshMs, 3000);
  assert.ok(serviceMcpRefreshMs > mcpRefreshMs);
  // The desktop page is unchanged.
  const html = render(desktopHost, createElement(DeveloperTab, tabProps));
  assert.match(html, /Local MCP servers/);
  assert.match(html, /Edit config/);
});

test("Skills settings render on both hosts", () => {
  assert.match(
    render(webHost, createElement(SkillsTab, tabProps)),
    /Search skills/,
  );
  assert.match(
    render(desktopHost, createElement(SkillsTab, tabProps)),
    /Search skills/,
  );
});

const checkout = {
  methods: [
    {
      id: "stripe",
      label: "Card",
      route: "browser",
      currency: "USD",
      min: 0,
      max: 0,
    },
  ],
  plans: [],
  balance: { multiplier: 1, min: 0, max: 0 },
  feeRate: 0,
  usdToCny: 0,
} as never;

const checkoutDialog = (host: HostInfo, inTab: boolean) => {
  // SettingsModal names document.body as the portal's target.
  const scope = globalThis as { document?: unknown };
  scope.document = { body: {} };
  try {
    return render(
      host,
      createElement(CheckoutDialog, {
        checkout,
        purchase: { funds: true },
        inTab,
        onClose: () => {},
        onSettled: () => {},
      }),
    );
  } finally {
    delete scope.document;
  }
};

test("Billing's payment page opens in the web app's own tab", () => {
  const web = checkoutDialog(webHost, true);
  assert.match(web, /Continue to payment/);
  assert.match(web, /Opens a payment page/);
  assert.doesNotMatch(web, /browser/);
  const desktop = checkoutDialog(desktopHost, false);
  assert.match(desktop, /Continue in browser/);
  assert.match(desktop, /Opens in your browser/);
});

const project = {
  id: "p",
  name: "Launch",
  description: "",
  instructions: "",
} as never;

const projectEditor = (host: HostInfo, isExisting: boolean) =>
  render(
    host,
    createElement(ProjectEditorDialog, {
      onArchive() {},
      onDelete() {},
      project,
      isExisting,
      onChange: () => {},
      onClose: () => {},
      onSave: async () => {},
      onChooseFolder: async () => null,
      onError: () => {},
    }),
  );

test("the project editor has no folder field on the web", () => {
  assert.doesNotMatch(projectEditor(webHost, false), /Use a folder/);
  assert.doesNotMatch(projectEditor(webHost, true), /Working folder/);
  assert.doesNotMatch(
    projectEditor(desktopHost, false),
    /Use an existing folder/,
  );
  assert.match(projectEditor(desktopHost, false), /Create a project/);
  assert.doesNotMatch(projectEditor(desktopHost, true), /Working folder/);
  assert.match(projectEditor(desktopHost, true), /Project settings/);
});

test("Customize offers only what the host can do", () => {
  assert.deepEqual(customizeOffers(desktopHost.capabilities), {
    upload: true,
    reveal: true,
    createWithCode: true,
    addConnectors: true,
    programLabel: "Local",
  });
  assert.deepEqual(customizeOffers(webHost.capabilities), {
    // The Upload page sends the files' bytes, so the web has it too.
    upload: true,
    reveal: false,
    createWithCode: false,
    addConnectors: false,
    programLabel: "Service",
  });
  const page = (host: HostInfo) =>
    render(
      host,
      createElement(CustomizePage, {
        settings: defaultSettings,
        onUseSkill: () => {},
        onOpenSettings: () => {},
        onConfirmRemove: () => {},
        onError: () => {},
      }),
    );
  // Creating a skill still works on the web, so Add stays on Skills.
  assert.match(page(webHost), /class="customize-add[ "]/);
  assert.match(page(desktopHost), /class="customize-add[ "]/);
});

test("a skill's details offer Show in folder only with a folder to show", () => {
  const skill = {
    name: "weekly-report",
    description: "Reports",
    path: "/skills/weekly-report",
    scope: "user",
    own: true,
    enabled: true,
  } as never;
  const detail = (host: HostInfo, onReveal?: () => void) =>
    render(
      host,
      createElement(SkillDetail, {
        skill,
        added: true,
        busy: false,
        onClose: () => {},
        onAdd: async () => {},
        onTry: () => {},
        onToggle: async () => {},
        onReveal,
        onRemove: () => {},
      }),
    );
  assert.doesNotMatch(detail(webHost), /Show in folder/);
  assert.match(
    detail(desktopHost, () => {}),
    /Show in folder/,
  );
});
