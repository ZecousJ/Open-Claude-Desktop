import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { openPolicy, researchPolicyOf } from "../../shared/client-policy";
import { ResearchChip } from "../../src/research/ResearchChip";
import { toggleResearch } from "../../src/research/toggle-research";
import {
  researchUnavailable,
  researchUnavailableMessages,
} from "../../shared/research";
import type { Conversation } from "../../shared/types";
import {
  getDraftResearch,
  resetResearchStores,
  setDraftResearch,
} from "../../src/research/useResearchDraft";

// The menu asks for skills on mount; server rendering never runs effects,
// but the bridge must exist for the module to load.
(globalThis as { window?: unknown }).window ??= {
  desktop: {},
  innerWidth: 1280,
  innerHeight: 800,
};

// The menu's stylesheet is an empty module here.
registerHooks({
  load(url, context, next) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  },
});
const { ComposerAddMenu } = await import("../../src/composer/ComposerAddMenu");

const noop = () => {};
const menu = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(ComposerAddMenu, {
      platform: "darwin",
      projects: [],
      webSearch: false,
      webSearchAvailable: true,
      onWebSearch: noop,
      onClose: noop,
      onFiles: noop,
      onGitHub: noop,
      onProject: noop,
      onCreateProject: noop,
      onSettings: noop,
      onUnavailable: noop,
      ...props,
    }),
  );

test("the + menu offers Research above Web search", () => {
  const html = menu({ onResearch: noop, researchAvailable: true });
  assert.match(html, /class="composer-add-research"/);
  assert.match(html, /role="menuitemcheckbox" aria-checked="false"/);
  assert.ok(html.indexOf(">Research<") < html.indexOf(">Web search<"));
  assert.doesNotMatch(
    html.slice(html.indexOf("composer-add-research")).split("</button>")[0],
    /disabled=""/,
  );
});

test("the + menu uses Add image only for image-only policies, and enables GitHub linking", () => {
  const original = openPolicy.attachments;
  try {
    openPolicy.attachments = { ...original, types: ["png", "jpeg", "webp"] };
    assert.match(menu(), />Add image</);
    assert.doesNotMatch(menu(), />Upload or add files</);
    openPolicy.attachments = { ...original, types: [] };
    assert.doesNotMatch(menu(), />Add image<|>Upload or add files</);
  } finally {
    openPolicy.attachments = original;
  }
  const html = menu();
  assert.match(html, />Upload or add files</);
  const row = html.split("Add content from GitHub")[0].split("<button").at(-1)!;
  assert.doesNotMatch(row, /disabled|not available/);
});

test("Research's row shows its state and when it can't be turned on", () => {
  const on = menu({
    onResearch: noop,
    research: true,
    researchAvailable: true,
  });
  assert.match(on, /class="composer-add-research"[^>]*aria-checked="true"/);
  assert.match(on, /composer-add-check/);
  const off = menu({ onResearch: noop, researchAvailable: false });
  // Disabled, with the reason as its hover text.
  assert.match(off, /class="composer-add-research"[^>]*disabled=""/);
  assert.match(off, /Enable a search integration to use research/);
});

test("a unified Chat session reports its actual Research limit without implying another Chat mode enables it", async () => {
  const reason = "Research isn't available for this session.";
  assert.equal(researchUnavailableMessages.mode, reason);
  for (const mode of ["cowork", "code"] as const) {
    assert.equal(
      researchUnavailable({
        policy: openPolicy,
        mode,
        provider: { protocol: "responses" },
      }),
      "mode",
    );
  }
  assert.equal(
    researchUnavailable({
      policy: openPolicy,
      mode: "chat",
      provider: { protocol: "responses" },
    }),
    undefined,
  );
  const document = parseHTML(
    menu({
      presentation: "native-chat",
      onResearch: noop,
      researchAvailable: false,
      researchUnavailableReason: researchUnavailableMessages.mode,
    }),
  ).document;
  const row = document.querySelector<HTMLButtonElement>(
    ".composer-add-research",
  )!;
  assert.equal(row.disabled, true);
  assert.equal(row.title, reason);
  assert.equal(row.getAttribute("aria-checked"), "false");
  assert.doesNotMatch(row.title, /available in Chat/);
  const notices: string[] = [];
  await toggleResearch(
    {
      active: undefined,
      draftWebSearch: false,
      setDraftWebSearch() {
        assert.fail("copy correction must not enable search");
      },
      upsert() {
        assert.fail("copy correction must not enable Research");
      },
      notify(message) {
        notices.push(message);
      },
    },
    false,
    reason,
  );
  assert.deepEqual(notices, [reason]);
});

test("Research does not lock the Web search checkbox", () => {
  const html = menu({ onResearch: noop, research: true, webSearch: true });
  const row = html.split(">Web search<")[0].split("<button").at(-1)!;
  assert.doesNotMatch(row, /disabled|Research uses web search/);
  assert.match(row, /aria-checked="true"/);
});

test("without a Research switch the row is left out", () => {
  assert.doesNotMatch(menu(), /composer-add-research/);
});

test("the policy that turns web search off turns Research off", () => {
  assert.equal(researchPolicyOf(openPolicy).enabled, true);
  assert.equal(
    researchPolicyOf({ ...openPolicy, webSearch: false }).enabled,
    false,
  );
});

test("the composer's Research chip is a pressed button", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchChip, { onClick: noop }),
  );
  assert.match(html, /class="research-chip"/);
  assert.match(html, /aria-label="Research"/);
  assert.match(html, /aria-pressed="true"/);
  const busy = renderToStaticMarkup(
    createElement(ResearchChip, { onClick: noop, disabled: true }),
  );
  assert.match(busy, /disabled=""/);
});

test("the new chat's Research switch is kept until it is sent", () => {
  resetResearchStores();
  assert.equal(getDraftResearch(), false);
  setDraftResearch(true);
  assert.equal(getDraftResearch(), true);
  resetResearchStores();
  assert.equal(getDraftResearch(), false);
});

test("Research announces auto-enabled search only after a successful change", async () => {
  resetResearchStores();
  const notices: string[] = [];
  const app: Parameters<typeof toggleResearch>[0] = {
    active: undefined,
    draftWebSearch: false,
    setDraftWebSearch(value) {
      app.draftWebSearch =
        typeof value === "function" ? value(app.draftWebSearch) : value;
    },
    notify(message) {
      notices.push(message);
    },
    upsert(conversation) {
      app.active = conversation;
    },
  };
  await toggleResearch(app, false, undefined);
  assert.equal(getDraftResearch(), true);
  assert.equal(app.draftWebSearch, true);
  assert.deepEqual(notices, ["Web search enabled automatically for Research"]);
  notices.length = 0;
  await toggleResearch(app, true, undefined);
  assert.equal(getDraftResearch(), false);
  assert.equal(app.draftWebSearch, true);
  await toggleResearch(app, false, undefined);
  assert.deepEqual(notices, []);
  const original = window.desktop;
  try {
    app.active = { id: "chat", webSearch: false } as Conversation;
    window.desktop = {
      async setConversationResearch() {
        throw new Error("Search failed");
      },
    } as never;
    await assert.rejects(
      toggleResearch(app, false, undefined),
      /Search failed/,
    );
    assert.deepEqual(notices, []);
    window.desktop = {
      async setConversationResearch(id: string, research: boolean) {
        return { id, research, webSearch: true };
      },
    } as never;
    await toggleResearch(app, false, undefined);
    assert.equal(app.active.research, true);
    assert.deepEqual(notices, [
      "Web search enabled automatically for Research",
    ]);
  } finally {
    window.desktop = original;
    resetResearchStores();
  }
});

test("a draft researching through a connector does not force web search or announce it", async () => {
  resetResearchStores();
  const app = {
    active: undefined,
    draftWebSearch: false,
    setDraftWebSearch() {
      assert.fail("Web search must not be changed");
    },
    notify() {
      assert.fail("No auto-enable notice is due");
    },
    upsert() {},
  };
  try {
    await toggleResearch(app, false, undefined, false);
    assert.equal(getDraftResearch(), true);
  } finally {
    resetResearchStores();
  }
});
