import test from "node:test";
import assert from "node:assert/strict";

/** Sends one Chat message with the pointer the screen reports; counts the composer's focus calls. */
async function sendWith(coarse: boolean) {
  const g = globalThis as { window?: unknown; matchMedia?: unknown };
  const before = { window: g.window, matchMedia: g.matchMedia };
  g.window = {
    desktop: { send: async () => ({ id: "c-new", mode: "chat", turns: [] }) },
  };
  g.matchMedia = (query: string) => ({
    matches: coarse && query.includes("coarse"),
  });
  const calls: string[] = [];
  try {
    const { sendDraft } = await import("../../src/app/composer-send");
    const app = {
      accountId: "keyboard-fixture-account",
      draftSession: "keyboard-fixture-draft",
      controllerScope: {},
      text: "Hello",
      attachments: [],
      sending: false,
      running: false,
      active: undefined,
      activeId: undefined,
      model: "gpt-test",
      providerId: "p1",
      mode: "chat",
      projectId: undefined,
      project: undefined,
      policy: { webSearch: false },
      draftWebSearch: false,
      incognitoShown: false,
      selectNext: { current: false },
      follow: { current: false },
      navigation: { replaceNext: () => undefined },
      composer: {
        current: {
          focus: () => calls.push("focus"),
          blur: () => calls.push("blur"),
        },
      },
      setSending: () => undefined,
      setError: () => undefined,
      setText: () => undefined,
      setAttachments: () => undefined,
      upsert: () => undefined,
      setActiveId: () => undefined,
      setPage: () => undefined,
      notify: () => undefined,
      report: (e: unknown) => {
        throw e;
      },
    };
    await sendDraft(app as never);
  } finally {
    g.window = before.window;
    g.matchMedia = before.matchMedia;
  }
  return calls;
}

test("on a touch screen a sent message closes the on-screen keyboard", async () => {
  const calls = await sendWith(true);
  assert.ok(calls.length > 0);
  assert.ok(
    calls.every((call) => call === "blur"),
    calls.join(),
  );
});

test("with a mouse and keyboard the composer keeps the focus", async () => {
  const calls = await sendWith(false);
  assert.deepEqual(calls, ["focus"]);
});
