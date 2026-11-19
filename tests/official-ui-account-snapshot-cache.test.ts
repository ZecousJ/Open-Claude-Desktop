import test from "node:test";
import assert from "node:assert/strict";
import {
  createAccountSnapshotCache,
  type NativeAccountLease,
} from "../electron/official-ui/account-snapshot-cache";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
type SnapshotFixture = {
  replyFeedback: Record<string, "up" | "down">;
  marker: string;
};
function fixture() {
  let lease: NativeAccountLease = {
      owner: "a",
      store: {},
      generation: 1,
      active: true,
    },
    time = 0;
  const reads: ReturnType<typeof deferred<SnapshotFixture>>[] = [];
  const cache = createAccountSnapshotCache({
    current: () => lease,
    now: () => time,
    read: () => {
      const request = deferred<SnapshotFixture>();
      reads.push(request);
      return request.promise;
    },
  });
  return {
    cache,
    reads,
    advance() {
      time += 1600;
    },
    switch(owner = "b", reuseStore = false) {
      lease = {
        owner,
        store: reuseStore ? lease.store : {},
        generation: Number(lease.generation) + 1,
        active: true,
      };
    },
    retire() {
      lease = { ...lease, active: false };
    },
    restore() {
      lease = {
        ...lease,
        generation: Number(lease.generation) + 1,
        active: true,
      };
    },
  };
}
test("snapshot cache deduplicates only within real owner/store/generation and ratings never cross accounts", async () => {
  const f = fixture(),
    first = f.cache.read(),
    duplicate = f.cache.read();
  assert.equal(first, duplicate);
  await Promise.resolve();
  assert.equal(f.reads.length, 1);
  f.reads[0].resolve({ marker: "a", replyFeedback: { a: "up" } });
  await first;
  assert.deepEqual(f.cache.ratings(), { a: "up" });
  f.switch();
  assert.deepEqual(f.cache.ratings(), {});
  const second = f.cache.read();
  await Promise.resolve();
  assert.equal(f.reads.length, 2);
  f.reads[1].resolve({ marker: "b", replyFeedback: { b: "down" } });
  assert.equal((await second).marker, "b");
  assert.deepEqual(f.cache.ratings(), { b: "down" });
});
test("old successful or failed read cannot publish into replacement cache, including same-owner reactivation", async () => {
  for (const sameOwner of [false, true]) {
    const f = fixture(),
      old = f.cache.read();
    const rejected = assert.rejects(old, /account changed/);
    await Promise.resolve();
    f.switch(sameOwner ? "a" : "b", true);
    const fresh = f.cache.read();
    await Promise.resolve();
    f.reads[1].resolve({ marker: "new", replyFeedback: { new: "up" } });
    await fresh;
    f.reads[0].resolve({ marker: "old", replyFeedback: { old: "down" } });
    await rejected;
    assert.equal(await f.cache.read(), await fresh);
    assert.deepEqual(f.cache.ratings(), { new: "up" });
  }
  const f = fixture(),
    old = f.cache.read();
  const rejected = assert.rejects(old, /account changed/);
  await Promise.resolve();
  f.switch();
  const fresh = f.cache.read();
  await Promise.resolve();
  f.reads[1].resolve({ marker: "new", replyFeedback: { new: "up" } });
  await fresh;
  f.reads[0].reject(Error("old failure"));
  await rejected;
  assert.equal(await f.cache.read(), await fresh);
});
test("retirement blocks before dispatch and cannot revive old read after same-store restore", async () => {
  const f = fixture();
  f.retire();
  assert.throws(() => f.cache.read(), /account changed/);
  assert.equal(f.reads.length, 0);
  f.restore();
  const pending = f.cache.read(),
    rejected = assert.rejects(pending, /account changed/);
  f.retire();
  await rejected;
  assert.equal(f.reads.length, 0);
  f.restore();
  const old = f.cache.read(),
    late = assert.rejects(old, /account changed/);
  await Promise.resolve();
  f.retire();
  f.restore();
  f.reads[0].resolve({ marker: "old", replyFeedback: { old: "up" } });
  await late;
  assert.deepEqual(f.cache.ratings(), {});
});
test("older concurrent same-account refresh cannot roll ratings back; composite lease checks every boundary", async () => {
  const f = fixture(),
    old = f.cache.read();
  await Promise.resolve();
  const fresh = f.cache.read(true);
  await Promise.resolve();
  f.reads[1].resolve({ marker: "new", replyFeedback: { new: "up" } });
  await fresh;
  f.reads[0].resolve({ marker: "old", replyFeedback: { old: "down" } });
  await old;
  assert.deepEqual(f.cache.ratings(), { new: "up" });
  const captured = f.cache.capture();
  f.switch("a");
  assert.throws(captured.check, /account changed/);
  assert.deepEqual(f.cache.ratings(), {});
});

test("current read failure releases only its own cache entry and permits an explicit fresh read", async () => {
  const f = fixture(),
    failed = f.cache.read(),
    rejected = assert.rejects(failed, /source unavailable/);
  await Promise.resolve();
  f.reads[0].reject(Error("source unavailable"));
  await rejected;
  const retry = f.cache.read();
  await Promise.resolve();
  assert.equal(f.reads.length, 2);
  f.reads[1].resolve({
    marker: "recovered",
    replyFeedback: { recovered: "up" },
  });
  assert.equal((await retry).marker, "recovered");
  assert.deepEqual(f.cache.ratings(), { recovered: "up" });
});
