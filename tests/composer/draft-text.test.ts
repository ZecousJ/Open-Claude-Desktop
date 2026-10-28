import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, useContext, useRef } from "react";
import { AppContext, type AppController } from "../../src/app/AppContext";
import {
  DraftTextStore,
  useAppDraft,
  useDraftText,
} from "../../src/composer/draft-text";
import { routineDom } from "../support/routine-dom";

test("the draft store publishes only real changes and keeps skill tokens with the text", () => {
  const store = new DraftTextStore("Hi");
  let calls = 0;
  const stop = store.subscribe(() => calls++);
  const first = store.snapshot();
  store.setText("Hi");
  assert.equal(calls, 0);
  assert.equal(store.snapshot(), first);
  store.setText((text) => `${text} there`);
  assert.equal(store.text, "Hi there");
  assert.equal(calls, 1);
  assert.notEqual(store.snapshot(), first);
  stop();
  store.setText("gone");
  assert.equal(calls, 1);
});

test("typing re-renders the draft's subscribers, not the rest of the window", async () => {
  const env = await routineDom({}, { jsdom: true });
  try {
    const draft = new DraftTextStore();
    const app = {
      draft,
      get text() {
        return draft.text;
      },
    } as unknown as AppController;
    const renders = { window: 0, composer: 0 };
    function Transcript() {
      useContext(AppContext);
      renders.window++;
      return h("main", null, "transcript");
    }
    function Composer() {
      const value = useAppDraft(useContext(AppContext)!);
      renders.composer++;
      return h("p", { id: "draft" }, value.text);
    }
    function Window() {
      const self = useRef(0);
      self.current++;
      return h(AppContext.Provider, { value: app }, h(Transcript), h(Composer));
    }
    await env.render(h(Window));
    const before = { ...renders };
    for (const letter of "hello")
      await act(async () => draft.setText((text) => text + letter));
    assert.equal(env.document.getElementById("draft")?.textContent, "hello");
    assert.equal(renders.window, before.window);
    assert.equal(renders.composer, before.composer + 5);
    assert.equal(app.text, "hello");
  } finally {
    await env.clean();
  }
});

test("a controller without a store still reads its plain draft", async () => {
  const env = await routineDom({}, { jsdom: true });
  try {
    function Reader() {
      const value = useAppDraft({ text: "plain", skillTokens: [] });
      return h("p", { id: "plain" }, value.text);
    }
    await env.render(h(Reader));
    assert.equal(env.document.getElementById("plain")?.textContent, "plain");
    const store = new DraftTextStore("live");
    function Live() {
      return h("p", { id: "live" }, useDraftText(store).text);
    }
    await env.render(h(Live));
    await act(async () => store.setText("changed"));
    assert.equal(env.document.getElementById("live")?.textContent, "changed");
  } finally {
    await env.clean();
  }
});
