import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalMemoryStore } from "../electron/memory/local-store";
import {
  RemoteMemoryStore,
  readMemoryCache,
  type MemoryApi,
} from "../electron/memory/remote-store";
import { MemoryService } from "../electron/memory/service";
import { openPolicy } from "../shared/client-policy";
import { memoryLimits, type MemorySnapshot } from "../electron/memory/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function snapshot(): MemorySnapshot {
  return {
    available: true,
    allowed: { generate: true, searchChats: true },
    prefs: { generate: true, searchChats: true },
    limits: memoryLimits,
    docs: [],
    edits: [],
  };
}
function root(t: test.TestContext) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "f051-memory-race-"));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("disable-only preserves default-on local search and persists both switches", async (t) => {
  const directory = root(t);
  const policy = structuredClone(openPolicy);
  policy.memory!.defaultOn = true;
  const service = new MemoryService({
    store: new LocalMemoryStore(directory),
    policy: () => policy,
    changed() {},
  });
  service.ready = async () => {
    throw Error("Unexpected ready");
  };
  service.refresh = async () => {
    throw Error("Unexpected refresh");
  };
  assert.deepEqual(service.status().prefs, {
    generate: true,
    searchChats: true,
  });
  await service.setPrefs({ generate: false }, { disableOnly: true });
  assert.deepEqual(service.status().prefs, {
    generate: false,
    searchChats: true,
  });
  assert.deepEqual(new LocalMemoryStore(directory).current().prefs, {
    generate: false,
    searchChats: true,
  });
  service.close();
});

test("disable-only preserves an independent persisted local search change", async (t) => {
  const directory = root(t);
  const store = new LocalMemoryStore(directory);
  await store.setPrefs({ generate: true, searchChats: true });
  const service = new MemoryService({
    store,
    policy: () => openPolicy,
    changed() {},
  });
  await new LocalMemoryStore(directory).setPrefs({ searchChats: false });
  await service.setPrefs({ generate: false }, { disableOnly: true });
  assert.deepEqual(service.status().prefs, {
    generate: false,
    searchChats: false,
  });
  service.close();
});

for (const during of [false, true])
  test(`stale GET ${during ? "during" : "before"} disable cannot restore generation/cache`, async (t) => {
    const directory = root(t),
      read = deferred<MemorySnapshot>(),
      write = deferred<MemorySnapshot>();
    const initial = snapshot();
    let gets = 0;
    const store = new RemoteMemoryStore(
      {
        get: async () =>
          ++gets === 1 ? structuredClone(initial) : read.promise,
        setPrefs: async () => write.promise,
      } as unknown as MemoryApi,
      (call) => call("inert"),
      directory,
    );
    await store.load();
    let loading: Promise<MemorySnapshot> | undefined;
    if (!during) loading = store.load();
    const saving = store.setPrefs({ generate: false });
    await tick();
    if (during) loading = store.load();
    write.resolve({
      ...snapshot(),
      prefs: { generate: false, searchChats: true },
    });
    await saving;
    read.resolve(initial);
    await loading;
    assert.deepEqual(store.current()!.prefs, {
      generate: false,
      searchChats: true,
    });
    assert.deepEqual(readMemoryCache(directory)!.prefs, {
      generate: false,
      searchChats: true,
    });
    store.close();
  });

test("remote preference writes serialize and a failed write does not block the next", async (t) => {
  const first = deferred<MemorySnapshot>();
  const calls: unknown[] = [];
  const store = new RemoteMemoryStore(
    {
      get: async () => snapshot(),
      setPrefs: async (token: string, prefs: object) => {
        calls.push(prefs);
        if (calls.length === 1) return first.promise;
        return { ...snapshot(), prefs: { generate: true, searchChats: false } };
      },
    } as unknown as MemoryApi,
    (call) => call("inert"),
    root(t),
  );
  await store.load();
  const failed = assert.rejects(store.setPrefs({ generate: false }), /failed/);
  const next = store.setPrefs({ searchChats: false });
  await tick();
  assert.equal(calls.length, 1);
  first.reject(Error("failed"));
  await failed;
  await next;
  assert.deepEqual(calls, [{ generate: false }, { searchChats: false }]);
  assert.deepEqual(store.current()!.prefs, {
    generate: true,
    searchChats: false,
  });
  store.close();
});

test("closing a remote store rejects queued preferences before dispatch", async (t) => {
  const first = deferred<MemorySnapshot>();
  let calls = 0;
  const store = new RemoteMemoryStore(
    {
      get: async () => snapshot(),
      setPrefs: async () => {
        calls++;
        return first.promise;
      },
    } as unknown as MemoryApi,
    (call) => call("inert"),
    root(t),
  );
  await store.load();
  const one = assert.rejects(
    store.setPrefs({ generate: false }),
    /account changed/,
  );
  const two = assert.rejects(
    store.setPrefs({ searchChats: false }),
    /account changed/,
  );
  await tick();
  store.close();
  first.resolve(snapshot());
  await Promise.all([one, two]);
  assert.equal(calls, 1);
});

test("overlapping remote switches preserve dispatch order and both final values", async (t) => {
  const first = deferred<void>();
  const state = snapshot();
  let calls = 0;
  const store = new RemoteMemoryStore(
    {
      get: async () => structuredClone(state),
      setPrefs: async (_token: string, prefs: object) => {
        if (++calls === 1) await first.promise;
        Object.assign(state.prefs!, prefs);
        return structuredClone(state);
      },
    } as unknown as MemoryApi,
    (call) => call("inert"),
    root(t),
  );
  await store.load();
  const one = store.setPrefs({ generate: false });
  const two = store.setPrefs({ searchChats: false });
  await tick();
  assert.equal(calls, 1);
  first.resolve();
  await Promise.all([one, two]);
  assert.deepEqual(store.current()!.prefs, {
    generate: false,
    searchChats: false,
  });
  store.close();
});

test("remote preference write without a cache still initializes its snapshot", async (t) => {
  const state = snapshot();
  const store = new RemoteMemoryStore(
    {
      get: async () => structuredClone(state),
      setPrefs: async (_token: string, prefs: object) => {
        Object.assign(state.prefs!, prefs);
        return structuredClone(state);
      },
    } as unknown as MemoryApi,
    (call) => call("inert"),
    root(t),
  );
  await store.setPrefs({ generate: false });
  assert.deepEqual(store.current()!.prefs, {
    generate: false,
    searchChats: true,
  });
  store.close();
});

test("ordinary local preference updates preserve another instance's independent switch", async (t) => {
  const directory = root(t);
  const store = new LocalMemoryStore(directory);
  await store.setPrefs({ generate: true, searchChats: true });
  const service = new MemoryService({
    store,
    policy: () => openPolicy,
    changed() {},
  });
  await new LocalMemoryStore(directory).setPrefs({ searchChats: false });
  await service.setPrefs({ generate: false });
  assert.deepEqual(service.status().prefs, {
    generate: false,
    searchChats: false,
  });
  assert.deepEqual(new LocalMemoryStore(directory).current().prefs, {
    generate: false,
    searchChats: false,
  });
  service.close();
});

test("first ordinary local choice still materializes the other policy default", async (t) => {
  const directory = root(t),
    policy = structuredClone(openPolicy);
  policy.memory!.defaultOn = true;
  const service = new MemoryService({
    store: new LocalMemoryStore(directory),
    policy: () => policy,
    changed() {},
  });
  await service.setPrefs({ searchChats: false });
  assert.deepEqual(new LocalMemoryStore(directory).current().prefs, {
    generate: true,
    searchChats: false,
  });
  service.close();
});

for (const disableOnly of [false, true])
  test(`stale null prefs preserve a newer independent persisted search choice (${disableOnly ? "disable-only" : "ordinary"})`, async (t) => {
    const directory = root(t),
      policy = structuredClone(openPolicy);
    policy.memory!.defaultOn = true;
    const store = new LocalMemoryStore(directory);
    const service = new MemoryService({
      store,
      policy: () => policy,
      changed() {},
    });
    assert.equal(store.current().prefs, null);
    assert.deepEqual(service.status().prefs, {
      generate: true,
      searchChats: true,
    });
    await new LocalMemoryStore(directory).setPrefs({
      generate: true,
      searchChats: false,
    });
    service.ready = async () => {
      throw Error("Unexpected ready");
    };
    service.refresh = async () => {
      throw Error("Unexpected refresh");
    };
    await service.setPrefs(
      { generate: false },
      disableOnly ? { disableOnly: true } : undefined,
    );
    assert.deepEqual(service.status().prefs, {
      generate: false,
      searchChats: false,
    });
    assert.deepEqual(new LocalMemoryStore(directory).current().prefs, {
      generate: false,
      searchChats: false,
    });
    service.close();
  });
