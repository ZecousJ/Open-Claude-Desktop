import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { defaultSettings } from "../../electron/store/store";
import { DesignSystemStore } from "../../electron/artifacts/design-systems";
import { desktopHost } from "../../shared/host";
import type { DesignSystem } from "../../shared/collections-api";
import {
  FontLicensesContent,
  FontLicensesDialog,
  openDyslexicLicenseNotice,
} from "../../src/settings/FontLicensesDialog";
import { ClaudeCodeTab } from "../../src/settings/tabs/ClaudeCode";
import { SyncSection } from "../../src/settings/tabs/General";
import { DesignSystemsTab } from "../../src/settings/tabs/DesignSystems";
import { codeLabels } from "../../src/settings/tabs/desktop-labels";
import { HostContext } from "../../src/host/HostContext";

const source = (file: string) =>
  fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

test("Sync describes merged chats while retaining the real cloud-sync switch", () => {
  const html = renderToStaticMarkup(
    createElement(SyncSection, {
      settings: { ...defaultSettings, cloudSync: true },
      save() {},
    }),
  );
  assert.match(
    html,
    /Chats and Code sessions that use a GitHub repository run in the cloud/,
  );
  assert.match(
    html,
    /Code sessions that use a folder on this computer stay here/,
  );
  assert.doesNotMatch(html, /Cowork/);
  assert.match(html, /aria-label="Sync with the web" aria-checked="true"/);
});

test("Settings radios use 6px corners independently from the 7px animated thumb", () => {
  // Current live General DOM: transparent radios30×30 r6, track32 r8. Thumb
  // calc(--cds-radius -1px)=7px.
  const css = source("src/settings/settings.css");
  assert.match(css, /\.settings-segmented \{[^}]*--segmented-radius: 7px/);
  assert.match(
    css,
    /\.settings-segmented > button \{[^}]*height: 30px[^}]*border-radius: 6px/,
  );
  assert.match(css, /\.settings-segmented > button\.icon \{[^}]*width: 30px/);
});

test("Code General contains only the captured classifier and fallback while defaults stay functional", () => {
  const html = renderToStaticMarkup(
    createElement(ClaudeCodeTab, {
      settings: defaultSettings,
      save() {},
      platform: "darwin",
      engine: { state: "ready" },
      onError() {},
      goTo() {},
    }),
  );
  const { document } = parseHTML(html);
  const section = (title: string) => {
    const heading = document.querySelector(`h3[data-setting="${title}"]`);
    assert.ok(heading, title);
    return heading.parentElement!;
  };
  assert.deepEqual(
    Array.from(section("General").querySelectorAll(".settings-row"), (row) =>
      row.getAttribute("data-setting"),
    ),
    ["Classify session states", "Switch models when a message is flagged"],
  );
  assert.equal(
    document.querySelectorAll(
      'button[role="switch"][aria-label="Switch models when a message is flagged"]',
    ).length,
    1,
  );
  assert.equal(
    section("Local sessions").querySelector(
      '[data-setting="Switch models when a message is flagged"]',
    ),
    null,
  );
  for (const label of ["Default permissions", "Thinking effort"])
    assert.ok(
      section("Code defaults").querySelector(`button[aria-label="${label}"]`),
    );
  assert.ok(codeLabels.includes("Code defaults"));
  assert.ok(
    section("Code appearance").querySelector(
      'input[aria-label="Code font family"]',
    ),
  );
  const license = section("Appearance").querySelector(
    "button.font-license-link",
  );
  assert.equal(license?.textContent, "Font licenses");
  assert.equal(license?.getAttribute("aria-haspopup"), "dialog");
});

test("font notices quote the shipped OpenDyslexic metadata and distinguish unbundled fonts", () => {
  assert.match(openDyslexicLicenseNotice, /© Bitstream/);
  assert.match(openDyslexicLicenseNotice, /Abelardo Gonzalez/);
  assert.match(
    openDyslexicLicenseNotice,
    /Creative Commons Attribution 3\.0 Unported License/,
  );
  assert.match(
    source("THIRD_PARTY_NOTICES.md"),
    /OpenDyslexic changes and additional glyphs are licensed under the Creative Commons Attribution 3\.0/,
  );
  const web = renderToStaticMarkup(
    createElement(FontLicensesContent, { onError() {} }),
  );
  assert.match(web, /data-no-translate="true"/);
  assert.match(web, /System fonts are supplied by your operating system/);
  assert.match(web, /OpenDyslexic 2\.001/);
  assert.match(web, /href="https:\/\/opendyslexic.org\/legal\/"/);
  assert.match(web, /OpenDyslexic website/);
  assert.doesNotMatch(web, /Reference fonts are loaded/);
});

test("the license link opens its real author-provided destination", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const opened: string[] = [];
  window.desktop = {
    openExternal: async (url: string) => {
      opened.push(url);
    },
  } as never;
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
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
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  try {
    await act(async () =>
      root.render(
        createElement(FontLicensesContent, {
          onError(error) {
            throw error;
          },
        }),
      ),
    );
    await act(async () => document.querySelector("a")!.click());
    assert.deepEqual(opened, ["https://opendyslexic.org/legal/"]);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("Design systems show real counts, standalone provenance and written dates without invented sharing", () => {
  const at = Date.UTC(2026, 5, 23, 12);
  const record = (id: string, guidelines: string): DesignSystem => ({
    id,
    name: id,
    blurb: "",
    notes: "",
    sources: [],
    guidelines,
    createdAt: at,
    updatedAt: at,
    ...(guidelines ? { generatedAt: at } : {}),
  });
  const html = renderToStaticMarkup(
    createElement(DesignSystemsTab, {
      settings: { ...defaultSettings, designSystem: "Example" },
      systems: [record("Example", "# Rules"), record("Draft", "")],
    }),
  );
  const { document } = parseHTML(html);
  assert.equal(
    document.querySelector(".design-systems-count")?.textContent,
    "Showing 1–2 of 2",
  );
  assert.equal(document.querySelectorAll(".design-system-kind").length, 2);
  assert.ok(
    Array.from(document.querySelectorAll(".design-system-kind")).every(
      (badge) => badge.textContent === "Standalone",
    ),
  );
  assert.equal(
    document.querySelectorAll(".design-system-name [data-no-translate]").length,
    2,
  );
  assert.equal(
    document.querySelectorAll(".design-system-name .design-system-kind").length,
    2,
  );
  assert.equal(
    document.querySelector("th:nth-child(3)")?.textContent,
    "Content written",
  );
  assert.equal(
    document.querySelector("tbody tr:nth-child(1) td:nth-child(2)")
      ?.textContent,
    "—",
  );
  assert.match(
    document.querySelector("tbody tr:nth-child(1) td:nth-child(3)")!
      .textContent!,
    /Jun 23, 2026/,
  );
  assert.equal(
    document.querySelector("tbody tr:nth-child(2) td:nth-child(3)")
      ?.textContent,
    "Draft",
  );
  assert.ok(document.querySelector('button[aria-label="Actions for Example"]'));
  assert.ok(
    document.querySelector(
      'summary[aria-label="About who can use a design system"]',
    ),
  );
  assert.match(
    document.querySelector(".design-systems-availability-info p")!.textContent!,
    /Available only in your account/,
  );
  assert.doesNotMatch(html, /choose Share|Organization/);
  const css = source("src/settings/directory/directory.css");
  assert.match(css, /\.design-system-name \{[^}]*gap: 8px/);
  assert.match(
    css,
    /\.design-systems-page \.design-systems-table \.design-system-kind \{[^}]*height: 22px[^}]*border-radius: 5\.5px/,
  );
  assert.match(
    css,
    /@media \(max-width: 639\.98px\) \{[^]*?\.design-systems-page \.design-systems-table \{\s*table-layout: auto/,
  );
  const empty = renderToStaticMarkup(
    createElement(DesignSystemsTab, { systems: [] }),
  );
  assert.match(empty, /Showing 0–0 of 0/);
});

test("Content-written dates describe stored hand-written and imported guidelines without claiming model generation or a latest edit", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-r3-design-"));
  const at = Date.UTC(2026, 5, 23, 12);
  let clock = at;
  try {
    const store = new DesignSystemStore(folder, () => clock);
    const handWritten = store.save({
      name: "Hand written",
      guidelines: "# Manual rules",
    });
    // Import uses the same bridge save input, not the model-generation path.
    const imported = store.save({
      name: "Imported",
      guidelines: "# Imported rules",
    });
    assert.equal(handWritten.generatedAt, at);
    assert.equal(imported.generatedAt, at);
    clock = Date.UTC(2026, 6, 1, 12);
    const edited = store.save({
      id: handWritten.id,
      name: handWritten.name,
      guidelines: "# Changed by hand",
    });
    assert.equal(edited.updatedAt, clock);
    assert.equal(
      edited.generatedAt,
      at,
      "the existing first-written date stays",
    );
    const html = renderToStaticMarkup(
      createElement(DesignSystemsTab, { systems: [edited, imported] }),
    );
    const { document } = parseHTML(html);
    assert.equal(
      document.querySelector("th:nth-child(3)")?.textContent,
      "Content written",
    );
    assert.doesNotMatch(
      html,
      /<th>(Generated|Published|Content updated)<\/th>/,
    );
    assert.deepEqual(
      Array.from(
        document.querySelectorAll("tbody td:nth-child(3)"),
        (cell) => cell.textContent,
      ),
      ["Jun 23, 2026", "Jun 23, 2026"],
    );
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
