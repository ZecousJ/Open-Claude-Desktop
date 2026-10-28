import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session } from "electron";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NonessentialServices,
  nonessentialService,
} from "../../electron/account/nonessential-services";
import { ArtifactPreviews } from "../../electron/artifacts/artifact-previews";
import { defaultSettings, Store } from "../../electron/store/store";
import {
  publicPreferences,
  withoutPreferences,
} from "../../electron/store/settings-preferences";
import { preference } from "../../shared/settings-extras";
import { preferenceFields } from "../../shared/settings-extras-schema";
import type { Conversation, Item } from "../../shared/types";
import {
  PreferencesSection,
  nonessentialServicesDescription,
  nonessentialServicesWarning,
} from "../../src/settings/tabs/Privacy";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { McpToolView } from "../../src/transcript/tools/McpToolView";
import { WidgetPanel } from "../../src/widgets/WidgetPanel";
import {
  faviconFor,
  requestFavicons,
  useFavicons,
} from "../../src/research/useFavicons";

test("the shared preference defaults off, validates, and persists without restarting the engine", () => {
  assert.equal(
    preference(defaultSettings, "disableNonessentialServices"),
    false,
  );
  for (const value of [true, false, undefined])
    assert.equal(
      preferenceFields.disableNonessentialServices.safeParse(value).success,
      true,
    );
  for (const value of ["true", 1, null])
    assert.equal(
      preferenceFields.disableNonessentialServices.safeParse(value).success,
      false,
    );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-services-"));
  try {
    const store = new Store(root);
    store.settings.disableNonessentialServices = true;
    store.flush();
    const saved = new Store(root).settings;
    assert.equal(publicPreferences(saved).disableNonessentialServices, true);
    assert.equal(
      withoutPreferences(saved).disableNonessentialServices,
      undefined,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Privacy exposes the enabled switch and shows the official warning only when blocked", () => {
  for (const blocked of [false, true]) {
    const html = renderToStaticMarkup(
      createElement(PreferencesSection, {
        status: null,
        settings: { ...defaultSettings, disableNonessentialServices: blocked },
        save() {},
      }),
    );
    assert.ok(html.includes(nonessentialServicesDescription));
    assert.equal(html.includes(nonessentialServicesWarning), blocked);
    assert.match(
      html,
      new RegExp(
        `role="switch" aria-label="Block nonessential services" aria-checked="${blocked}"`,
      ),
    );
    assert.equal(html.includes("nonessential-services-blocked"), blocked);
  }
  let saved: unknown;
  const section = PreferencesSection({
    status: null,
    settings: defaultSettings,
    save: (patch) => {
      saved = patch;
    },
  });
  const row = section.props.children.at(-1)!;
  row.props.children[1].props.onChange(true);
  assert.deepEqual(saved, { disableNonessentialServices: true });
});

function sessionMock(enabled = true) {
  type Request = (
    details: { url: string },
    respond: (response: { cancel?: boolean }) => void,
  ) => void;
  let request: Request | undefined;
  let installs = 0;
  const changes: boolean[] = [];
  const session = {
    webRequest: {
      onBeforeRequest(_filter: unknown, listener: Request) {
        request = listener;
        installs++;
      },
    },
    isSpellCheckerEnabled: () => enabled,
    setSpellCheckerEnabled(value: boolean) {
      enabled = value;
      changes.push(value);
    },
  } as unknown as Session;
  return {
    session,
    changes,
    installs: () => installs,
    blocked(url: string) {
      let cancel = false;
      request!({ url }, (response) => {
        cancel = response.cancel === true;
      });
      return cancel;
    },
  };
}

test("desktop sessions block only the nonessential destinations, never local artifact runtimes", async () => {
  const services = new NonessentialServices("linux");
  const first = sessionMock();
  services.add(first.session);
  services.add(first.session);
  assert.equal(first.installs(), 1);
  assert.deepEqual(first.changes, []);
  const urls = [
    "https://www.google.com/s2/favicons?domain=example.com",
    "https://t0.gstatic.com/faviconV2?url=example.com",
    "https://www.claudeusercontent.com/preview",
    "https://assets.frame.claudeusercontent.com/preview",
    "https://assets.frame.staging.claudeusercontent.com/preview",
    "https://widget.claudemcpcontent.com/",
    "https://redirector.gvt1.com/dictionary",
    "https://download.gvt1.com/dictionary",
  ];
  assert.equal(first.blocked(urls[0]), false);
  services.update(true);
  for (const url of urls) assert.equal(first.blocked(url), true, url);
  for (const url of [
    "https://www.google.com/search?q=test",
    "https://api.example.com/mcp",
    "https://widget.claudemcpcontent.com.evil.test/",
    "https://cdn.jsdelivr.net/npm/react",
    "claudex-preview://document/local",
    "data:text/html,local",
    "not a URL",
  ])
    assert.equal(first.blocked(url), false, url);
  assert.deepEqual(first.changes, [false]);
  const second = sessionMock(false);
  services.add(second.session);
  assert.deepEqual(second.changes, [false]);
  const previews = new ArtifactPreviews();
  const url = previews.create("<h1>Local artifact</h1>");
  assert.equal(first.blocked(url), false);
  assert.equal(await previews.response(url).text(), "<h1>Local artifact</h1>");
  assert.match(
    previews.response(url).headers.get("Content-Security-Policy")!,
    /connect-src 'none'/,
  );
  services.update(false);
  assert.deepEqual(first.changes, [false, true]);
  assert.deepEqual(second.changes, [false, false]);
  assert.equal(first.blocked(urls[0]), false);
});

test("macOS and Windows keep their system spellcheck and dictionary downloads", () => {
  for (const platform of ["darwin", "win32"] as const) {
    const services = new NonessentialServices(platform);
    services.update(true);
    const current = sessionMock();
    services.add(current.session);
    services.update(false);
    assert.deepEqual(current.changes, []);
    assert.equal(
      nonessentialService("https://redirector.gvt1.com/dictionary", platform),
      false,
    );
  }
});

test("blocked MCP Apps hide the widget action and an already-open panel shows text without an iframe", () => {
  const item: Item = {
    id: "tool",
    type: "mcpToolCall",
    server: "docs",
    tool: "lookup",
    result: {
      content: [
        { type: "text", text: "Actual tool text result" },
        {
          type: "resource",
          resource: {
            uri: "ui://app",
            mimeType: "text/html",
            text: "<h1>Widget HTML</h1>",
          },
        },
      ],
    },
  };
  const app = {
    snapshot: { settings: { disableNonessentialServices: false } },
    toolPanels: { widgetId: item.id },
  } as unknown as AppController;
  const render = () =>
    renderToStaticMarkup(
      createElement(
        AppContext.Provider,
        { value: app },
        createElement(McpToolView, { item }),
      ),
    );
  assert.match(render(), /<button>Widget<\/button>/);
  app.snapshot.settings.disableNonessentialServices = true;
  assert.doesNotMatch(render(), /<button>Widget<\/button>/);
  assert.match(render(), /Actual tool text result/);
  const html = renderToStaticMarkup(
    createElement(
      AppContext.Provider,
      { value: app },
      createElement(WidgetPanel, {
        conversation: {
          id: "conversation",
          turns: [{ items: [item] }],
        } as Conversation,
        onClose() {},
      }),
    ),
  );
  assert.match(html, /Actual tool text result/);
  assert.doesNotMatch(html, /<iframe|Widget HTML/);
});

test("blocking hides already-cached connector icons and unblocking restores them", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const icon = "data:image/png;base64,YQ==";
  let fetched!: () => void;
  const ready = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktop: {
        async getFavicons() {
          fetched();
          return { "cached.example": icon };
        },
      },
    },
  });
  try {
    requestFavicons(["cached.example"]);
    await ready;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(faviconFor("cached.example"), icon);
    function Icons() {
      return createElement(
        "span",
        null,
        useFavicons(["cached.example"])["cached.example"],
      );
    }
    const app = {
      snapshot: { settings: { disableNonessentialServices: false } },
    } as unknown as AppController;
    const render = () =>
      renderToStaticMarkup(
        createElement(
          AppContext.Provider,
          { value: app },
          createElement(Icons),
        ),
      );
    assert.ok(render().includes(icon));
    app.snapshot.settings.disableNonessentialServices = true;
    assert.ok(!render().includes(icon));
    app.snapshot.settings.disableNonessentialServices = false;
    assert.ok(render().includes(icon));
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
