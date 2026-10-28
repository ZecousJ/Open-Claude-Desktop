import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { defaultSettings } from "../../electron/store/store";
import { avatarUploadLimit } from "../../shared/avatar";
import { hostFor } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import type { TabProps } from "../../src/settings/context";
import { AccountTab } from "../../src/settings/tabs/Account";
import { CapabilitiesTab } from "../../src/settings/tabs/Capabilities";
import { PrivacyTab } from "../../src/settings/tabs/Privacy";
import { MemoryPage } from "../../src/settings/tabs/Memory";

const props: TabProps = {
  settings: defaultSettings,
  save: () => {},
  platform: "darwin",
  engine: { state: "ready" },
  onError: () => {},
  goTo: () => {},
};
const source = (file: string) =>
  fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

test("Account uses Display name, merged-chat instructions and its actual 10MB photo flow", () => {
  const page = (enabled: boolean) =>
    renderToStaticMarkup(
      createElement(AccountTab, {
        ...props,
        settings: { ...defaultSettings, profilePhotoEnabled: enabled },
      }),
    );
  for (const enabled of [false, true]) {
    const { document } = parseHTML(page(enabled));
    assert.ok(document.querySelector('input[aria-label="Display name"]'));
    assert.ok(
      document.querySelector('[data-setting="What should Claudex call you?"]'),
    );
    const photo = document.querySelector('button[aria-label="Profile photo"]');
    assert.equal(photo?.getAttribute("aria-haspopup"), "menu");
    assert.ok(document.querySelector('input[type="file"]'));
    const text = document.documentElement.textContent ?? "";
    assert.ok(text.includes("PNG, JPEG, or WebP, up to 10MB."));
    assert.ok(text.includes("across chats within"));
    assert.equal(text.includes("across chats and Cowork"), false);
  }
  assert.equal(
    avatarUploadLimit,
    50 * 1024 * 1024,
    "the shared upload envelope is unchanged",
  );
});

test("Capabilities keeps the live standalone groups and location stays in Privacy", () => {
  const html = renderToStaticMarkup(createElement(CapabilitiesTab, props));
  assert.doesNotMatch(html, /data-setting="Location metadata"/);
  const groups = [
    "General",
    "Visuals",
    "Code execution and file creation",
    "Skills",
  ];
  let previous = -1;
  for (const group of groups) {
    const at = html.indexOf(`<h3 data-setting="${group}">`);
    assert.ok(at > previous, group);
    previous = at;
  }
  const privacy = renderToStaticMarkup(createElement(PrivacyTab, props));
  assert.match(privacy, /data-setting="Location metadata"/);
});

test("network controls retain the service ceiling and the real allowlist state", () => {
  const render = (ceiling: "none" | "trusted" | "full", enabled = true) =>
    renderToStaticMarkup(
      createElement(
        HostContext.Provider,
        { value: { ...hostFor("web"), sandboxNetwork: ceiling } },
        createElement(CapabilitiesTab, {
          ...props,
          settings: {
            ...defaultSettings,
            networkEgress: enabled,
            egressAllowlist: "packages",
          },
        }),
      ),
    );
  const open = render("full");
  assert.match(open, /class="capabilities-network"/);
  assert.match(open, /class="capabilities-allowlist"/);
  assert.match(open, /aria-label="Domain allowlist"/);
  assert.doesNotMatch(open, /width:192px/);
  assert.match(open, /class="capabilities-allowlist-note" role="status"/);
  assert.match(open, /width="20" height="20"[^>]*data-icon="Info"/);
  assert.match(open, /class="settings-button primary regular" disabled="">Add/);
  assert.doesNotMatch(render("full", false), /class="capabilities-allowlist"/);
  const closed = render("none");
  assert.match(
    closed,
    /aria-label="Allow network egress" aria-checked="false"[^>]*disabled=""/,
  );
  assert.doesNotMatch(closed, /class="capabilities-allowlist"/);
});

test("the network card matches the measured outer frame, banner and large field geometry", () => {
  // Outer card 782×282, 24px padding+1px rim, inner banner 732×64, Info20,
  // Add61×40 r10. The card keeps 24px padding at390px; 183px is an inner
  // trigger only.
  const css = source("src/settings/original-rows.css");
  const rule = (selector: string) => {
    const escaped = selector
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll(" ", "\\s+");
    const match = css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]+)\\}`));
    assert.ok(match, selector);
    return match[1];
  };
  assert.match(rule(".capabilities-network"), /padding: 12px 0/);
  const card = rule(".capabilities-allowlist");
  assert.match(card, /margin: 16px 0 0/);
  assert.match(card, /padding: 24px/);
  assert.match(card, /background: var\(--settings-alpha-1\)/);
  assert.match(card, /border: 1px solid var\(--settings-alpha-2\)/);
  const combobox = rule(
    ".settings-dialog .capabilities-allowlist .settings-select",
  );
  assert.match(combobox, /width: max-content/);
  assert.match(combobox, /min-width: 180px/);
  assert.match(combobox, /max-width: 300px/);
  const banner = rule(".capabilities-allowlist-note");
  assert.match(banner, /padding: 12px 16px/);
  assert.match(banner, /border: 0/);
  assert.match(banner, /background: var\(--settings-rail\)/);
  for (const selector of [
    ".settings-dialog .capabilities-allowlist .capabilities-allowlist-add > .settings-input",
    ".capabilities-allowlist-add > .settings-button",
  ]) {
    const field = rule(selector);
    assert.match(field, /height: 40px/);
    assert.match(field, /border-radius: 10px/);
    assert.match(field, /font-size: 15px/);
    assert.match(field, /line-height: 22px/);
  }
  assert.doesNotMatch(css, /\.capabilities-allowlist\s*\{\s*padding: 16px/);
});

test("Privacy memory navigation uses the measured 20px ArrowOutSquare and actual Memory destination", () => {
  const html = renderToStaticMarkup(createElement(PrivacyTab, props));
  const memoryRow = html.slice(
    html.indexOf('data-setting="Memory preferences"'),
  );
  assert.match(
    memoryRow,
    /width="20" height="20"[^>]*data-icon="ArrowOutSquare"/,
  );
  assert.doesNotMatch(memoryRow, /data-icon="CaretRight"/);
  assert.doesNotMatch(memoryRow, /data-icon="ArrowUpRight"/);
  const leaf = source("src/settings/tabs/Privacy.tsx");
  assert.match(leaf, /onClick=\{\(\) => goTo\("memory"\)\}/);
  const css = source("src/settings/original-rows.css");
  assert.match(
    css,
    /\[data-setting="Memory preferences"\] \.settings-button \{\s*gap: 4px/,
  );
  assert.match(
    css,
    /\[data-setting="Memory preferences"\] \.settings-button > svg \{\s*margin-inline-end: -4px/,
  );
});

test("Memory off state keeps the real switches and describes merged chats", () => {
  const html = renderToStaticMarkup(
    createElement(MemoryPage, {
      status: {
        available: true,
        allowed: { searchChats: true, generate: true },
        prefs: { searchChats: false, generate: false },
        synthesizing: false,
      },
      onPrefs: () => {},
      onDialog: () => {},
    }),
  );
  assert.match(html, /<h2 data-setting="Memory">Memory<\/h2>/);
  assert.match(html, /Allow Claudex to generate memory from your chats\./);
  assert.doesNotMatch(html, /chats and Cowork/);
  assert.equal((html.match(/role="switch"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-checked="false"/g) ?? []).length, 2);
});
