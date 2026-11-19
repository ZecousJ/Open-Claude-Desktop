/** Temp-only actual state service; no accounts, sockets, or engine. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  newAdapterScope,
  inAdapterScope,
  currentAdapterScope,
} from "../electron/official-ui/api/scope";
import { readState, writeState } from "../electron/official-ui/api/state";
import {
  conversationAliases,
  loadConversationState,
} from "../electron/official-ui/api/conversations";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-pending-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, scope: (owner = "a") => newAdapterScope(owner, root, {}) };
}
test("actual aliases survive A1 to B to A2 before the 500 ms save, without crossing accounts", async (t) => {
  const f = fixture(t),
    a1 = f.scope(),
    a2 = f.scope(),
    b = f.scope("b");
  inAdapterScope(a1, () => conversationAliases.set("old-a", "old-real"));
  inAdapterScope(b, () => conversationAliases.set("b-only", "b-real"));
  inAdapterScope(a2, () => {
    loadConversationState();
    assert.equal(conversationAliases.get("old-a"), "old-real");
    conversationAliases.set("new-a", "new-real");
  });
  await sleep(650);
  assert.deepEqual(
    inAdapterScope(a2, () => readState("aliases", [])),
    [
      ["old-a", "old-real"],
      ["new-a", "new-real"],
    ],
  );
  assert.deepEqual(
    inAdapterScope(b, () => readState("aliases", [])),
    [["b-only", "b-real"]],
  );
});
test("suppliers use captured scope and independent full destinations, even when flushed from another scope", (t) => {
  const f = fixture(t),
    a = f.scope(),
    b = f.scope("b"),
    a2 = f.scope();
  for (const scope of [a, b])
    inAdapterScope(scope, () => {
      writeState("one", () => currentAdapterScope().owner);
      writeState("two", () => `${currentAdapterScope().owner}-two`);
    });
  assert.equal(
    inAdapterScope(a2, () => readState("one", "")),
    "a",
  );
  assert.equal(
    inAdapterScope(a2, () => readState("two", "")),
    "a-two",
  );
  assert.equal(
    inAdapterScope(b, () => readState("one", "")),
    "b",
  );
  assert.equal(
    inAdapterScope(b, () => readState("two", "")),
    "b-two",
  );
});
test("obsolete timer cannot overwrite a newer same-file pending job", (t) => {
  const f = fixture(t),
    a = f.scope(),
    a2 = f.scope();
  const callbacks: (() => void)[] = [];
  t.mock.method(globalThis, "setTimeout", (cb: () => void) => {
    callbacks.push(cb);
    return { ref() {}, unref() {} };
  });
  t.mock.method(globalThis, "clearTimeout", () => {});
  inAdapterScope(a, () => writeState("value", () => "old"));
  inAdapterScope(a2, () => writeState("value", () => "new"));
  callbacks[0]();
  assert.equal(
    inAdapterScope(a2, () => readState("value", "")),
    "new",
  );
  callbacks[0]();
  callbacks[1]();
  assert.equal(
    inAdapterScope(a2, () => readState("value", "")),
    "new",
  );
});
test("failed flush preserves old disk file and pending supplier; new write cannot silently replace it", (t) => {
  const f = fixture(t),
    a = f.scope(),
    a2 = f.scope();
  inAdapterScope(a, () => {
    writeState("value", () => "disk-old");
    readState("value", "");
  });
  const folder = path.join(
    f.root,
    "official-ui",
    "accounts",
    fs.readdirSync(path.join(f.root, "official-ui", "accounts"))[0],
  );
  inAdapterScope(a, () => writeState("value", () => "pending-old"));
  const spy = t.mock.method(fs, "renameSync", () => {
    throw Error("sensitive path not exposed");
  });
  assert.throws(
    () => inAdapterScope(a2, () => readState("value", "fallback")),
    /^Error: Official UI state could not be saved\.$/,
  );
  assert.throws(
    () => inAdapterScope(a2, () => writeState("value", () => "replacement")),
    /could not be saved/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(folder, "value.json"), "utf8")),
    "disk-old",
  );
  assert.deepEqual(fs.readdirSync(folder), ["value.json"]);
  spy.mock.restore();
  assert.equal(
    inAdapterScope(a2, () => readState("value", "")),
    "pending-old",
  );
  inAdapterScope(a2, () => writeState("value", () => "new"));
  assert.equal(
    inAdapterScope(a2, () => readState("value", "")),
    "new",
  );
});
test("timer failure is sanitized and retained until explicit retry; absent disk still uses fallback", (t) => {
  const f = fixture(t),
    a = f.scope();
  let callback: () => void = () => {
    throw Error("not scheduled");
  };
  t.mock.method(globalThis, "setTimeout", (cb: () => void) => {
    callback = cb;
    return {};
  });
  t.mock.method(globalThis, "clearTimeout", () => {});
  const log = t.mock.method(console, "error", () => {});
  let fail = true;
  inAdapterScope(a, () =>
    writeState("value", () => {
      if (fail) throw Error("private");
      return "saved";
    }),
  );
  callback();
  assert.equal(log.mock.callCount(), 1);
  assert.equal(
    log.mock.calls[0].arguments.join(" ").includes("private"),
    false,
  );
  assert.throws(
    () => inAdapterScope(a, () => readState("value", "fallback")),
    /could not be saved/,
  );
  fail = false;
  assert.equal(
    inAdapterScope(a, () => readState("value", "")),
    "saved",
  );
  assert.equal(
    inAdapterScope(a, () => readState("missing", "fallback")),
    "fallback",
  );
});
