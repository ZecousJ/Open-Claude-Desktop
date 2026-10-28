import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultSettings } from "../../electron/store/store";
import { Sub2ApiClient } from "../../electron/sub2api/client";
import { preference } from "../../shared/settings-extras";
import { preferenceFields } from "../../shared/settings-extras-schema";
import { hostFor } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { settingsSearchIndex } from "../../src/settings/search/pages";
import { TranscriptAppearance } from "../../src/settings/tabs/TranscriptAppearance";
import { TasksSection } from "../../src/settings/tabs/Tasks";
import { Row, Section } from "../../src/settings/controls";
import { ThemeGlyph } from "../../src/settings/theme-glyphs";
import {
  deleteAccountWarning,
  deleteAccountQuestion,
} from "../../src/settings/tabs/DeleteAccountDialog";

const source = (file: string) =>
  fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

test("settings groups expose the live heading and named-row semantics", () => {
  const markup = renderToStaticMarkup(
    createElement(
      Section,
      { title: "Appearance" },
      createElement(Row, {
        label: "Motion",
        description: "Reduce animation.",
      }),
    ),
  );
  assert.match(markup, /<h3 data-setting="Appearance">Appearance<\/h3>/);
  const labelId = markup.match(/role="group" aria-labelledby="([^"]+)"/);
  assert.ok(labelId);
  assert.ok(markup.includes(`id="${labelId[1]}">Motion</div>`));
  assert.match(
    renderToStaticMarkup(
      createElement(Section, { title: "Privacy", headingLevel: 2 }),
    ),
    /<h2 data-setting="Privacy">Privacy<\/h2>/,
  );
});

test("General uses the measured comfortable-density frame and controls", () => {
  // Official-settings-general.txt:2–6,12–23; current read-only DOM measurements
  // additionally resolve py-md/gap-lg and the 390×844 modal/header. Source rem
  // values use the official 16px scale.
  const css = source("src/settings/settings.css");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]+)\\}`));
    assert.ok(match, selector);
    return match[1];
  };
  const frame = rule(".settings-dialog");
  assert.match(frame, /grid-template-columns: 192px minmax\(0, 1fr\)/);
  assert.match(frame, /width: min\(1024px, 100%\)/);
  assert.match(frame, /height: min\(800px, 100%\)/);
  assert.match(frame, /border-radius: 12px/);
  assert.match(rule(".settings-page"), /padding: 8px 24px 16px/);
  assert.match(rule(".settings-page"), /margin-top: 52px/);
  for (const declaration of [
    "font-size: 15px",
    "line-height: 20px",
    "font-weight: 580",
    "margin: 0 0 16px",
  ]) {
    assert.ok(rule(".settings-section > :is(h2, h3)").includes(declaration));
  }
  assert.match(rule(".settings-row"), /gap: 28px/);
  assert.match(rule(".settings-row"), /padding: 12px 0/);
  assert.match(rule(".settings-row-label"), /font-size: 14px/);
  assert.match(rule(".settings-row-label"), /line-height: 20px/);
  assert.match(rule(".settings-segmented"), /gap: 0/);
  assert.match(rule(".settings-segmented"), /border: 0/);
  assert.match(rule(".settings-segmented > button"), /font-size: 14px/);
  assert.match(rule(".settings-segmented > button.icon"), /width: 30px/);
  assert.match(css, /@media \(max-width: 767\.98px\)/);
  assert.doesNotMatch(css, /\.settings-row\s*\{[^}]*flex-wrap: wrap/);
  assert.match(
    renderToStaticMarkup(createElement(ThemeGlyph, { name: "Computer" })),
    /width="20" height="20"/,
  );
});

test("transcript controls belong to General and reflect the persisted width", () => {
  const markup = renderToStaticMarkup(
    createElement(TranscriptAppearance, {
      settings: {
        ...defaultSettings,
        transcriptTextSize: "l",
        transcriptWidth: "l",
      },
      save: () => {},
    }),
  );

  assert.match(markup, /aria-checked="true"[^>]*>Wide</);
  assert.match(markup, /aria-checked="true"[^>]*>Large</);
  for (const label of ["Transcript text size", "Transcript width"]) {
    assert.ok(settingsSearchIndex.general?.includes(label));
    assert.ok(!settingsSearchIndex.code?.includes(label));
    assert.ok(
      !source("src/settings/tabs/ClaudeCode.tsx").includes(`label="${label}"`),
    );
  }
});

test("remote deletion sends DELETE for the current bearer session without password or account ID", async () => {
  const client = new Sub2ApiClient(
    "https://service.example",
    async (input, init) => {
      assert.equal(
        String(input),
        "https://service.example/api/v1/claudex/account",
      );
      assert.equal(init?.method, "DELETE");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer session-token",
      );
      assert.equal(init?.body, undefined);
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
      });
    },
  );
  await client.deleteAccount("session-token");
});

test("Tasks offers the working built-in browser, not the unsupported Chrome connector", () => {
  const markup = renderToStaticMarkup(
    createElement(
      HostContext.Provider,
      {
        value: hostFor("desktop"),
      },
      createElement(TasksSection, {
        settings: defaultSettings,
        save: () => {},
        onError: () => {},
      }),
    ),
  );
  assert.match(markup, />Tasks</);
  assert.match(markup, /Preferred browser/);
  assert.match(markup, /Built-in browser/);
  assert.doesNotMatch(markup, /disabled|Chrome/);
  assert.equal(preference(defaultSettings, "preferredBrowser"), "built_in");
  assert.equal(
    preferenceFields.preferredBrowser.safeParse("chrome").success,
    false,
  );
  for (const label of ["Trusted Cowork folders", "Preferred browser"]) {
    assert.ok(settingsSearchIndex.general?.includes(label));
    assert.ok(!settingsSearchIndex.cowork?.includes(label));
  }
  const web = renderToStaticMarkup(
    createElement(
      HostContext.Provider,
      {
        value: hostFor("web"),
      },
      createElement(TasksSection, {
        settings: defaultSettings,
        save: () => {},
        onError: () => {},
      }),
    ),
  );
  assert.equal(web, "");
});

test("account confirmation follows the two steps without password or reload", () => {
  assert.equal(
    deleteAccountWarning,
    "Deleting your account is permanent. You will have no way of recovering your account or conversation data.",
  );
  assert.equal(
    deleteAccountQuestion,
    "Are you sure you want to delete your account?",
  );
  const dialog = source("src/settings/tabs/DeleteAccountDialog.tsx");
  assert.doesNotMatch(dialog, /type="password"|location.reload/);
  assert.match(dialog, /confirmFocus="cancel"/);
  assert.match(dialog, /performance.now\(\) - openedAt.current >= 500/);
  assert.match(dialog, /showToast\(t\("Account deleted"\)\)/);
  assert.match(source("src/settings/tabs/Account.tsx"), /lazyPiece\(/);
  assert.match(source("src/app/AuthGate.tsx"), /<Toaster \/>/);
});
