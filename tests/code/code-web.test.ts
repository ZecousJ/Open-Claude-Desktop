import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppController } from "../../src/app/AppContext";
(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const { AppContext } = await import("../../src/app/AppContext");
const { HomeCornerActions } = await import("../../src/app/ShellChrome");

test("Code web keeps its draft title when release notes are unseen, without a native version nudge", () => {
  const app = {
    mode: "code",
    notesSeen: false,
    incognitoShown: false,
    policy: { incognito: true },
    openReleaseNotes: () => {
      throw Error("must not open during render");
    },
  } as unknown as AppController;
  const html = renderToStaticMarkup(
    createElement(
      AppContext.Provider,
      { value: app },
      createElement(HomeCornerActions),
    ),
  );
  assert.match(html, /<h1 class="code-draft-title">New session<\/h1>/);
  assert.doesNotMatch(html, /whats-new|What's new|incognito-button/);
});

test("web Code settings keep the captured general rows and omit native-only sections", async () => {
  const { ClaudeCodeTab } = await import("../../src/settings/tabs/ClaudeCode");
  const { defaultSettings } = await import("../../electron/store/store");
  const { parseHTML } = await import("linkedom");
  const html = renderToStaticMarkup(
    createElement(ClaudeCodeTab, {
      settings: defaultSettings,
      save: async () => true,
      platform: "darwin",
      onError: () => {},
    } as never),
  );
  const document = parseHTML(html).document;
  assert.deepEqual(
    [...document.querySelectorAll(".settings-section>h3")].map(
      (e) => e.textContent,
    ),
    ["General", "Code appearance", "Appearance", "Pull requests"],
  );
  const general = document.querySelector(".settings-section")!;
  assert.deepEqual(
    [...general.querySelectorAll('[role="switch"]')].map((e) =>
      e.getAttribute("aria-label"),
    ),
    ["Classify session states", "Switch models when a message is flagged"],
  );
  assert.match(general.textContent!, /Applies to cloud sessions/);
  for (const text of [
    "Code defaults",
    "Local sessions",
    "Remote Control",
    "Auto-archive after PR merge or close",
    "Open pull requests in browser",
  ])
    assert.ok(!document.body.textContent!.includes(text), text);
  assert.ok(document.querySelector('input[aria-label="Code font family"]'));
  assert.ok(document.querySelector(".font-license-link"));
  const autoFix = document.querySelector(
    '[role="switch"][aria-label="Auto-fix pull requests"]',
  )!;
  assert.ok(autoFix);
  assert.equal(autoFix.getAttribute("aria-checked"), "false");
  assert.ok(!autoFix.hasAttribute("disabled"));
  assert.notEqual(autoFix.getAttribute("aria-disabled"), "true");
});

test("real web Auto-fix toggle persists through Store restart and rolls back failed saves", async () => {
  const { act, useEffect, useState } = await import("react");
  const { routineDom } = await import("../support/routine-dom");
  const { ClaudeCodeTab } = await import("../../src/settings/tabs/ClaudeCode");
  const { SettingsPatchQueue } =
    await import("../../src/settings/settings-patch-queue");
  const { Store } = await import("../../electron/store/store");
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-pr-toggle-"),
  );
  const store = new Store(directory),
    errors: unknown[] = [];
  let reject = false;
  const queue = new SettingsPatchQueue(
    store.settings,
    async (value) => {
      if (reject) throw Error("Synthetic save failure");
      store.settings = value;
      store.flush();
      return value;
    },
    () => true,
  );
  const dom = await routineDom({
    accountProfile: async () => ({ kind: "local" }),
    sharingStatus: async () => ({ conversations: false }),
  } as never);
  function View() {
    const [settings, setSettings] = useState(queue.value);
    useEffect(() => queue.subscribe(setSettings), []);
    return createElement(ClaudeCodeTab, {
      settings,
      save: (patch: Partial<import("../../shared/types").Settings>) =>
        queue.update(
          patch,
          () => {},
          (error) => errors.push(error),
        ),
      platform: "darwin",
      onError: (error: unknown) => errors.push(error),
    } as never);
  }
  const toggle = () =>
    dom.document.querySelector(
      '[role="switch"][aria-label="Auto-fix pull requests"]',
    )!;
  try {
    await dom.render(createElement(View));
    await act(
      async () => new Promise<void>((resolve) => setImmediate(resolve)),
    );
    assert.equal(toggle().getAttribute("aria-checked"), "false");
    await dom.event(toggle(), "click");
    assert.equal(toggle().getAttribute("aria-checked"), "true");
    assert.equal(new Store(directory).settings.prAutoFix, true);
    reject = true;
    await dom.event(toggle(), "click");
    assert.equal(toggle().getAttribute("aria-checked"), "true");
    assert.equal(new Store(directory).settings.prAutoFix, true);
    assert.equal(errors.length, 1);
    reject = false;
    await dom.event(toggle(), "click");
    assert.equal(toggle().getAttribute("aria-checked"), "false");
    assert.equal(new Store(directory).settings.prAutoFix, false);
  } finally {
    queue.cancel();
    await dom.clean();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
