import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { HomeStarters as StarterSettings } from "../../shared/home-starters";
import type { Mode } from "../../shared/types";
import { AppContext, type AppController } from "../../src/app/AppContext";
import HomeStarters from "../../src/starter-prompts/HomeStarters";
import {
  legacyHomeStartersAllowed,
  starterPromptsVisible,
} from "../../src/starter-prompts/visibility";

test("the shaped Chat home suppresses only the old chips surface", () => {
  for (const homeShaped of [false, true])
    for (const targetKind of ["chat", "cowork", "code"] as const)
      assert.equal(
        legacyHomeStartersAllowed(homeShaped, targetKind),
        !(homeShaped && targetKind === "chat"),
        `${homeShaped} ${targetKind}`,
      );
  assert.equal(legacyHomeStartersAllowed(), true);
});

test("shape selection takes priority over overrides and a low count", () => {
  for (const override of [undefined, "show", "hide"] as const)
    assert.equal(
      starterPromptsVisible({
        hideStarterChips: !legacyHomeStartersAllowed(true, "chat"),
        conversationCount: 0,
        override,
      }),
      false,
    );
  assert.equal(starterPromptsVisible({ conversationCount: 24 }), true);
  assert.equal(starterPromptsVisible({ conversationCount: 25 }), false);
});

function render(
  homeShaped: boolean,
  config: StarterSettings,
  targetKind: Mode = "chat",
) {
  const app = {
    accountId: "compact-home-fixture",
    snapshot: {
      settings: { homeStarters: config, providers: [], mcpServers: {} },
    },
    latest: { current: undefined },
    policy: { research: false },
    composerDraft: { draftConnectors: {} },
  } as unknown as AppController;
  return renderToStaticMarkup(
    createElement(
      AppContext.Provider,
      { value: app },
      createElement(HomeStarters, {
        onPick: () => {},
        conversationCount: 0,
        homeShaped,
        targetKind,
      }),
    ),
  );
}

test("the compact home retains its independent checklist without generic chips", () => {
  const html = render(true, {
    chipsOverride: "show",
    prosumer_checklist_v2: { setup_project: true, explore_skills: true },
  });
  assert.match(html, /class="home-checklist"/);
  assert.match(html, /Set up a project with files and context/);
  assert.match(html, /Teach Claudex your workflows with skills/);
  assert.doesNotMatch(html, /class="starter-prompts"/);
  assert.equal(render(true, { chipsOverride: "show" }), "");
});

test("classic Chat retains eligible generic chips and its own hide preference", () => {
  for (const targetKind of ["chat"] as const) {
    assert.match(
      render(false, { chipsOverride: "show" }, targetKind),
      /class="starter-prompts"/,
    );
    assert.doesNotMatch(
      render(false, { chipsOverride: "hide" }, targetKind),
      /class="starter-prompts"/,
    );
  }
  for (const targetKind of ["cowork", "code"] as const)
    assert.equal(render(false, { chipsOverride: "show" }, targetKind), "");
});

test("the visible web Chat home passes its shape explicitly and scopes the dark color", () => {
  const source = readFileSync("src/home/ChatHome.tsx", "utf8");
  assert.match(
    source,
    /<StarterPrompts\s+homeShaped=\{web\}\s+targetKind="chat"/,
  );
  const starters = readFileSync("src/starter-prompts/HomeStarters.tsx", "utf8");
  assert.match(starters, /hideStarterChips: !chipsAllowed/);
  const css = readFileSync("src/home/chat-home.css", "utf8");
  assert.match(
    css,
    /:root:not\(\[data-theme="light"\]\)\s+\.app\.web\s+\.chat-home\s*> h1 \{\s*color: #f0efec;/,
  );
});
