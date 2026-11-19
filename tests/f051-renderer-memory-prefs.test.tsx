/** Real hook/React DOM with synthetic bridge replies, not original UI acceptance. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import React, { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { build } from "esbuild";
import type { MemoryStatus } from "../shared/memory-api";
function deferred() {
  let resolve!: (value: MemoryStatus) => void, reject!: (error: Error) => void;
  const promise = new Promise<MemoryStatus>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const status = (generate = true, searchChats = true): MemoryStatus => ({
  available: true,
  allowed: { generate: true, searchChats: true },
  prefs: { generate, searchChats },
  synthesizing: false,
});
async function fixture(t: test.TestContext, strict = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "f051-renderer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await symlink(await realpath("node_modules"), path.join(dir, "node_modules"));
  const output = path.join(dir, "hook.mjs");
  await build({
    entryPoints: ["src/memory/useMemory.ts"],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["react"],
  });
  const { useMemory } = await import(pathToFileURL(output).href);
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  const old = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const reads: ReturnType<typeof deferred>[] = [],
    writes: (ReturnType<typeof deferred> & { change: any })[] = [];
  const errors: unknown[] = [],
    listeners = new Set<(e: any) => void>();
  let automaticRead = true,
    memory: any;
  (window as any).desktop = {
    memoryStatus() {
      if (automaticRead) return Promise.resolve(status());
      const read = deferred();
      reads.push(read);
      return read.promise;
    },
    setMemoryPrefs(change: any) {
      const write = { ...deferred(), change };
      writes.push(write);
      return write.promise;
    },
    onEvent(fn: (e: any) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  function Harness() {
    memory = useMemory((e: unknown) => errors.push(e));
    return <pre>{JSON.stringify(memory.status?.prefs)}</pre>;
  }
  const root = createRoot(document.getElementById("root")!);
  let mounted = true;
  const unmount = async () => {
    if (mounted) {
      await act(async () => root.unmount());
      mounted = false;
    }
  };
  t.after(async () => {
    await unmount();
    Object.assign(globalThis, old);
  });
  await act(async () =>
    root.render(
      strict ? (
        <StrictMode>
          <Harness />
        </StrictMode>
      ) : (
        <Harness />
      ),
    ),
  );
  return {
    reads,
    writes,
    errors,
    listeners,
    unmount,
    memory: () => memory,
    prefs: () => memory.status?.prefs,
    change: async (...changes: any[]) =>
      act(async () => {
        for (const change of changes) memory.setPrefs(change);
      }),
    event: async () =>
      act(async () => {
        for (const fn of listeners) fn({ type: "memory-changed" });
      }),
    deferReads: () => {
      automaticRead = false;
    },
    settle: async (
      pending: ReturnType<typeof deferred>,
      next: MemoryStatus | Error,
    ) =>
      act(async () => {
        if (next instanceof Error) pending.reject(next);
        else pending.resolve(next);
      }),
  };
}
test("rapid independent changes serialize and all optimistic choices stay visible", async (t) => {
  const f = await fixture(t);
  await f.change({ searchChats: false }, { generate: false });
  assert.deepEqual(f.prefs(), { generate: false, searchChats: false });
  assert.equal(f.writes.length, 1);
  await f.settle(f.writes[0], status(true, false));
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.writes[1].change, { generate: false });
  assert.deepEqual(f.prefs(), { generate: false, searchChats: false });
  await f.settle(f.writes[1], status(false, false));
  assert.deepEqual(f.prefs(), { generate: false, searchChats: false });
});
test("repeated clicks preserve request order and the last explicit choice", async (t) => {
  const f = await fixture(t);
  await f.change(
    { searchChats: false },
    { searchChats: true },
    { searchChats: false },
  );
  for (let i = 0; i < 3; i++) {
    assert.equal(f.writes.length, i + 1);
    await f.settle(f.writes[i], status(true, i === 1));
  }
  assert.deepEqual(
    f.writes.map((w) => w.change),
    [{ searchChats: false }, { searchChats: true }, { searchChats: false }],
  );
  assert.deepEqual(f.prefs(), { generate: true, searchChats: false });
});
test("earlier failure rolls back only its choice and continues later changes", async (t) => {
  const f = await fixture(t);
  await f.change({ searchChats: false }, { generate: false });
  await f.settle(f.writes[0], Error("Search policy refused"));
  assert.deepEqual(f.prefs(), { generate: false, searchChats: true });
  assert.equal(f.writes.length, 2);
  await f.settle(f.writes[1], status(false, true));
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.prefs(), { generate: false, searchChats: true });
});
test("two failures restore confirmed values, not a failed optimistic snapshot", async (t) => {
  const f = await fixture(t);
  await f.change({ generate: false }, { searchChats: false });
  await f.settle(f.writes[0], Error("offline one"));
  await f.settle(f.writes[1], Error("offline two"));
  assert.deepEqual(f.prefs(), { generate: true, searchChats: true });
  assert.equal(f.errors.length, 2);
});
test("refresh during save preserves intent and stale post-save read is discarded", async (t) => {
  const f = await fixture(t);
  f.deferReads();
  await f.change({ searchChats: false });
  await f.event();
  await f.settle(f.reads[0], status());
  assert.deepEqual(f.prefs(), { generate: true, searchChats: false });
  await f.event();
  await f.settle(f.writes[0], status(true, false));
  await f.settle(f.reads[1], status());
  assert.deepEqual(f.prefs(), { generate: true, searchChats: false });
});
test("external confirmed state survives a pending save failure", async (t) => {
  const f = await fixture(t);
  f.deferReads();
  await f.change({ searchChats: false });
  await f.event();
  await f.settle(f.reads[0], status(false, true));
  await f.settle(f.writes[0], Error("refused"));
  assert.deepEqual(f.prefs(), { generate: false, searchChats: true });
});
test("unmount retires errors and queued writes without dispatching another mutation", async (t) => {
  const f = await fixture(t);
  await f.change({ searchChats: false }, { generate: false });
  await f.unmount();
  await f.settle(f.writes[0], Error("late old-account failure"));
  assert.equal(f.errors.length, 0);
  assert.equal(f.writes.length, 1);
  assert.equal(f.listeners.size, 0);
});
test("StrictMode retains one live subscription and a working save queue", async (t) => {
  const f = await fixture(t, true);
  assert.equal(f.listeners.size, 1);
  await f.change({ generate: false });
  await f.settle(f.writes[0], status(false, true));
  assert.deepEqual(f.prefs(), { generate: false, searchChats: true });
});
test("successful save clears a previous read failure", async (t) => {
  const f = await fixture(t);
  f.deferReads();
  await f.event();
  await f.settle(f.reads[0], Error("read failure"));
  assert.equal(f.memory().failed, true);
  await f.change({ searchChats: false });
  await f.settle(f.writes[0], status(true, false));
  assert.equal(f.memory().failed, false);
});
