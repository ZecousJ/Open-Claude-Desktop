import assert from "node:assert/strict";
import test from "node:test";
import { createCodeDraftRecovery } from "../../src-web/official/code-draft-recovery";

const session = "session_" + "d".repeat(32);
const draft = "epitaxy-" + session;
const key = "composer-draft:" + draft;
const uuid = "13518619-a16b-4b50-8a53-a159944257d3";
const path = "/v1/code/sessions/" + session + "/events";
const body = new TextEncoder().encode(
  JSON.stringify({
    events: [
      {
        payload: {
          uuid,
          type: "user",
          message: { content: "same prompt" },
        },
      },
    ],
  }),
);
const snapshot = (textChangedAt: number) =>
  JSON.stringify({
    text: "same prompt",
    textChangedAt,
    files: [],
    snippets: [],
    readyImageCount: 0,
  });

function area() {
  const entries = new Map<string, string>();
  return {
    setItem: (key: string, value: string) => entries.set(key, value),
    getItem: (key: string) => entries.get(key) ?? null,
    removeItem: (key: string) => entries.delete(key),
  };
}

test("reopening retires only the original unchanged draft backed by an owned receipt", async () => {
  const storage = { sessionStorage: area(), localStorage: area() };
  const sent = createCodeDraftRecovery(storage);
  storage.localStorage.setItem(key, snapshot(1));
  sent.remember(path, body);
  const verify = async (request: { path: string }) => {
    assert.equal(request.path, path + "/" + uuid + "/receipt");
    return {
      status: 204,
      contentType: "application/json",
      body: new Uint8Array(),
    };
  };
  const unknown = createCodeDraftRecovery(storage);
  await unknown.reconcile(
    async () => ({
      status: 404,
      contentType: "application/json",
      body: new Uint8Array(),
    }),
    () => true,
  );
  assert.equal(unknown.takeConfirmed(draft), false);

  const retired = createCodeDraftRecovery(storage);
  await retired.reconcile(verify, () => false);
  assert.equal(retired.takeConfirmed(draft), false);

  const reopened = createCodeDraftRecovery(storage);
  await reopened.reconcile(verify, () => true);
  assert.equal(reopened.takeConfirmed("epitaxy-session_other"), false);
  storage.localStorage.setItem(key, snapshot(2));
  assert.equal(reopened.takeConfirmed(draft), false);
  assert.equal(storage.localStorage.getItem(key), snapshot(2));

  sent.remember(path, body);
  const matched = createCodeDraftRecovery(storage);
  await matched.reconcile(verify, () => true);
  assert.equal(matched.takeConfirmed(draft), true);
  assert.equal(matched.takeConfirmed(draft), false);
});

test("reload reconciliation recognizes the original unload write and preserves later typing", async () => {
  const storage = { sessionStorage: area(), localStorage: area() };
  const proof = async () => ({
    status: 204,
    contentType: "application/json",
    body: new Uint8Array(),
  });
  const restored = snapshot(Date.now() + 100);
  const live = createCodeDraftRecovery(storage);
  live.remember(path, body);
  live.leave();
  storage.localStorage.setItem(key, restored);
  live.trackWrite(key, restored);
  const reopened = createCodeDraftRecovery(storage);
  await reopened.reconcile(proof, () => true);
  assert.equal(reopened.takeConfirmed(draft), true);

  storage.localStorage.removeItem(key);
  const edited = createCodeDraftRecovery(storage);
  edited.remember(path, body);
  edited.edited();
  edited.leave();
  storage.localStorage.setItem(key, restored);
  edited.trackWrite(key, restored);
  const later = createCodeDraftRecovery(storage);
  await later.reconcile(proof, () => true);
  assert.equal(later.takeConfirmed(draft), false);
});
