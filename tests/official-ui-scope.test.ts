import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bindAdapterScope,
  inAdapterScope,
  newAdapterScope,
  ScopedMap,
  ScopedSet,
} from "../electron/official-ui/api/scope";
import {
  readState,
  setStateDir,
  writeState,
} from "../electron/official-ui/api/state";
import { guardAdapterContext } from "../electron/official-ui/api/scoped-context";

test("concurrent accounts cannot see one another's adapter maps or listeners", async () => {
  const map = new ScopedMap<string, string>("files");
  const listeners = new ScopedSet<string>("listeners");
  const a = newAdapterScope("account-a"),
    b = newAdapterScope("account-b");
  const emitter = new EventEmitter();
  let observed = "";
  await Promise.all([
    inAdapterScope(a, async () => {
      map.set("same-id", "A");
      listeners.add("A");
      emitter.on(
        "update",
        bindAdapterScope(() => {
          observed = map.get("same-id") ?? "";
        }),
      );
      await new Promise((r) => setImmediate(r));
      assert.equal(map.get("same-id"), "A");
      assert.deepEqual([...listeners], ["A"]);
    }),
    inAdapterScope(b, async () => {
      map.set("same-id", "B");
      listeners.add("B");
      emitter.emit("update");
      assert.equal(map.get("same-id"), "B");
      assert.deepEqual([...listeners], ["B"]);
    }),
  ]);
  assert.equal(observed, "A");
  assert.equal(map.has("same-id"), false);
});

test("an in-flight request and its events cannot cross an account switch", async () => {
  let owner = "a";
  let release!: (value: string) => void;
  let listener: ((event: any) => void) | undefined;
  const ctx = guardAdapterContext({
    account: () => ({ id: owner }),
    call: () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    onEvent: (fn: (event: any) => void) => {
      listener = fn;
      return () => {};
    },
  } as never);
  const scope = newAdapterScope("a");
  let delivered = 0;
  const pending = inAdapterScope(scope, () => {
    ctx.onEvent((event) => {
      if (event.type !== "signed-out") delivered++;
    });
    return ctx.call("read");
  });
  owner = "b";
  listener!({ type: "devices-changed" });
  release("account-a-data");
  await assert.rejects(pending, /account changed/);
  assert.equal(delivered, 0);
});

test("signing back into the same account does not revive an old request", async () => {
  let identity = {};
  let release!: (value: string) => void;
  const ctx = guardAdapterContext({
    account: () => ({ id: "a" }),
    sessionIdentity: () => identity,
    call: () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  } as never);
  const old = newAdapterScope("a", undefined, identity);
  const pending = inAdapterScope(old, () => ctx.call("read"));
  identity = {}; // A new activation of the same account.
  release("stale");
  await assert.rejects(pending, /account changed/);
  assert.equal(
    inAdapterScope(newAdapterScope("a", undefined, identity), () =>
      ctx.isCurrent!(),
    ),
    true,
  );
});

test("persisted state for the same key remains isolated across accounts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-state-scope-"));
  try {
    setStateDir(root);
    const a = newAdapterScope("account-a"),
      b = newAdapterScope("account-b");
    inAdapterScope(a, () => writeState("aliases", () => ({ owner: "A" })));
    inAdapterScope(b, () => writeState("aliases", () => ({ owner: "B" })));
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(
      inAdapterScope(a, () => readState("aliases", null)),
      { owner: "A" },
    );
    assert.deepEqual(
      inAdapterScope(b, () => readState("aliases", null)),
      { owner: "B" },
    );
    assert.equal(readState("aliases", null), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
