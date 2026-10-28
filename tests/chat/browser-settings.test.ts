/**
 * Settings → Claude Code → Browser (package R8-E): the preference fields
 * and their validation, the section's rows, and which links open in the
 * built-in browser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import type { Settings } from "../../shared/types";

registerHooks({
  load(url, context, next) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  },
});

const extras = await import("../../shared/settings-extras");
const { preferenceFields } =
  await import("../../shared/settings-extras-schema");
const { keepCookiesOf } = await import("../../shared/browser");
const { AllowedSitesContent, AllowedSitesDialog } =
  await import("../../src/settings/tabs/ClaudeCode");
const { BrowserSection, browserSectionState } =
  await import("../../src/settings/tabs/ClaudeCodeSections");
const { builtInBrowserConversation, linkRoute } =
  await import("../../src/ui/ExternalLinks");
const { HostContext } = await import("../../src/host/HostContext");
const { desktopHost, hostFor } = await import("../../shared/host");

const base = {} as Settings;
const schema = z.object(preferenceFields);

test("Browser preferences default as the design says", () => {
  assert.equal(extras.preference(base, "browserTools"), true);
  assert.equal(extras.preference(base, "browserOpenLinksInApp"), true);
  assert.equal(extras.preference(base, "browserKeepCookies"), "until-quit");
  assert.deepEqual(extras.preference(base, "browserAllowedSites"), []);
  assert.equal(extras.preference(base, "browserAutoVerify"), false);
  // The same values the main process's partitions read (shared/browser.ts).
  for (const option of extras.browserKeepCookiesOptions)
    assert.equal(keepCookiesOf(option.value), option.value);
});

test("the settings schema checks the Browser preferences", () => {
  assert.equal(
    schema.safeParse({
      browserTools: false,
      browserOpenLinksInApp: true,
      browserKeepCookies: "per-session",
      browserAllowedSites: [
        "https://example.com",
        "http://localhost:*",
        "http://127.0.0.1:5173",
        "http://[::1]:8080",
      ],
      browserAutoVerify: true,
    }).success,
    true,
  );
  assert.equal(
    schema.safeParse({ browserKeepCookies: "forever" }).success,
    false,
  );
  for (const site of [
    "example.com",
    "https://example.com/path",
    "https://user:pw@example.com",
    "file:///etc",
    "javascript:alert(1)",
    "https://example.com?x=1",
  ])
    assert.equal(
      schema.safeParse({ browserAllowedSites: [site] }).success,
      false,
      site,
    );
  assert.equal(
    schema.safeParse({
      browserAllowedSites: Array.from(
        { length: extras.browserAllowedSitesLimit + 1 },
        (_, i) => `https://s${i}.example.com`,
      ),
    }).success,
    false,
  );
});

const render = (settings: Settings, host = desktopHost) =>
  renderToStaticMarkup(
    createElement(
      HostContext.Provider,
      { value: host },
      createElement(BrowserSection, { settings, save: () => {} }),
    ),
  );

test("the Browser section shows the original's rows", () => {
  const html = render(base);
  for (const label of [
    "Browser tools",
    "Open links in built-in browser",
    "Keep cookies",
    "Allowed sites",
  ])
    assert.match(html, new RegExp(`data-setting="${label}"`));
  assert.match(html, /aria-label="Browser tools" aria-checked="true"/);
  assert.match(
    html,
    /aria-label="Open links in built-in browser" aria-checked="true"/,
  );
  assert.match(html, /Until quit/);
  assert.match(html, />Manage</);
});

test("Allowed sites is hidden while Browser tools are off", () => {
  const html = render({ ...base, browserTools: false } as Settings);
  assert.match(html, /aria-label="Browser tools" aria-checked="false"/);
  assert.doesNotMatch(html, /data-setting="Allowed sites"/);
  // Keep cookies and links still apply to browsing by hand.
  assert.match(html, /data-setting="Keep cookies"/);
  assert.match(html, /data-setting="Open links in built-in browser"/);
});

test("the section is not shown where there is no Browser panel (web)", () => {
  assert.equal(render(base, hostFor("web")), "");
});

test("the administrator's policy turns Browser tools off", () => {
  assert.deepEqual(browserSectionState(base, {}), {
    blocked: false,
    tools: true,
  });
  assert.deepEqual(
    browserSectionState(base, {
      browser: {
        enabled: false,
        externalSites: true,
        allowScript: true,
        devServers: true,
        blockedDomains: [],
      },
    }),
    { blocked: true, tools: false },
  );
});
test("Allowed sites lists the sites with a remove button, Clear all and the built-in address", () => {
  const props = {
    sites: ["https://example.com", "http://localhost:*"],
    externalSites: true,
    onAdd: () => {},
    onRemove: () => {},
    onClear: () => {},
    onClose: () => {},
  };
  const html = renderToStaticMarkup(createElement(AllowedSitesContent, props));
  assert.match(html, /aria-label="Remove example\.com"/);
  assert.match(html, /aria-label="Remove http:\/\/localhost:\*"/);
  assert.match(html, /placeholder="example\.com"/);
  assert.doesNotMatch(html, /<small>Built-in<\/small>/);
  assert.doesNotMatch(html, /Your administrator/);
  assert.doesNotMatch(html, /No allowed sites yet/);
  assert.doesNotMatch(html, /Clear all<\/button>[^]*disabled=""[^]*Done/);
  const empty = renderToStaticMarkup(
    createElement(AllowedSitesContent, {
      ...props,
      sites: [],
      externalSites: false,
    }),
  );
  assert.match(empty, /No allowed sites yet\./);
  assert.match(empty, /disabled=""[^>]*>Clear all/);
  assert.match(empty, /Your administrator doesn’t allow Claudex/);
  assert.equal(typeof AllowedSitesDialog, "function");
});

test("a typed address becomes an Allowed sites entry or says why not", () => {
  const { parseAllowedSite } = extras;
  assert.deepEqual(parseAllowedSite(" Example.com/docs?x=1 ", []), {
    site: "https://example.com",
  });
  assert.deepEqual(parseAllowedSite("http://dev.example.com:8080", []), {
    site: "http://dev.example.com:8080",
  });
  for (const text of ["", "not a site", "ftp://example.com", "a b.com"])
    assert.deepEqual(parseAllowedSite(text, []), { refusal: "invalid" }, text);
  for (const text of ["localhost:3000", "http://127.0.0.1:5173", "[::1]"])
    assert.deepEqual(parseAllowedSite(text, []), { refusal: "loopback" }, text);
  assert.deepEqual(parseAllowedSite("example.com", ["https://example.com"]), {
    refusal: "exists",
  });
  assert.deepEqual(
    parseAllowedSite("https://example.com:9000", ["https://example.com:*"]),
    { refusal: "exists" },
  );
  assert.deepEqual(
    parseAllowedSite(
      "new.example.com",
      Array.from(
        { length: extras.browserAllowedSitesLimit },
        (_, i) => `https://s${i}.example.com`,
      ),
    ),
    { refusal: "full" },
  );
});

test("links open in the built-in browser only in a Code conversation with the setting on", () => {
  const on = { ...base, browserOpenLinksInApp: true } as Settings;
  const code = { id: "c1", mode: "code" as const };
  const args = {
    browserPanel: true,
    settings: on,
    active: code,
    policy: {},
  };
  assert.equal(builtInBrowserConversation(args), "c1");
  // On by default, as in the original; turned off, links leave the app.
  assert.equal(builtInBrowserConversation({ ...args, settings: base }), "c1");
  assert.equal(
    builtInBrowserConversation({
      ...args,
      settings: { ...base, browserOpenLinksInApp: false } as Settings,
    }),
    undefined,
  );
  assert.equal(
    builtInBrowserConversation({
      ...args,
      active: { id: "c2", mode: "chat" },
    }),
    undefined,
  );
  assert.equal(
    builtInBrowserConversation({
      ...args,
      active: { id: "c3", mode: "cowork" },
    }),
    "c3",
  );
  assert.equal(
    builtInBrowserConversation({ ...args, active: undefined }),
    undefined,
  );
  assert.equal(
    builtInBrowserConversation({ ...args, browserPanel: false }),
    undefined,
  );
  assert.equal(
    builtInBrowserConversation({
      ...args,
      policy: {
        browser: {
          enabled: false,
          externalSites: true,
          allowScript: true,
          devServers: true,
          blockedDomains: [],
        },
      },
    }),
    undefined,
  );
});

test("links a page starts still ask before the built-in browser opens them", () => {
  // A reply link the user clicked opens straight in the Browser panel.
  assert.equal(linkRoute("c1", false), "browser");
  // Artifact previews and new windows can navigate without a click.
  assert.equal(linkRoute("c1", true), "confirm-browser");
  // Without a built-in browser target, the usual external-link confirmation.
  assert.equal(linkRoute(undefined, false), "confirm");
  assert.equal(linkRoute(undefined, true), "confirm");
});
