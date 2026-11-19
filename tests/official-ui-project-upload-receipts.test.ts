/** Temporary synthetic receipt directories only; no account/profile data. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  reserveProjectUpload,
  ProjectUploadReceiptError,
  projectUploadReceiptCapacity,
} from "../electron/official-ui/api/project-upload-receipts";
const hash = "a".repeat(64);
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-receipt-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let owner = "synthetic",
    activation = 1;
  const ctx: any = {
    account: () => ({ id: owner }),
    stateDirectory: () => root,
    sessionIdentity: () => activation,
    isCurrent: () => true,
  };
  return {
    root,
    ctx,
    dir: () => path.join(root, fs.readdirSync(root)[0]),
    retire: () => activation++,
    account: () => (owner = "other"),
  };
}
const status = (n: number) => (e: unknown) =>
  e instanceof ProjectUploadReceiptError && e.status === n;
test("reservation is durable before success; pending survives restart and confirmed can be read without fresh dispatch", async (t) => {
  const f = fixture(t);
  const first = await reserveProjectUpload(f.ctx, "id", hash);
  assert.equal(first.fresh, true);
  await assert.rejects(
    () => reserveProjectUpload({ ...f.ctx }, "id", hash),
    status(409),
  );
  await first.confirm();
  f.retire();
  assert.equal(
    (await reserveProjectUpload({ ...f.ctx }, "id", hash)).fresh,
    false,
  );
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "id", "b".repeat(64)),
    status(409),
  );
  f.account();
  assert.equal((await reserveProjectUpload(f.ctx, "id", hash)).fresh, true);
});
test("retirement prevents confirmation, missing root fails closed, errors contain no paths", async (t) => {
  const f = fixture(t);
  const first = await reserveProjectUpload(f.ctx, "id", hash);
  f.retire();
  await assert.rejects(() => first.confirm(), status(409));
  await assert.rejects(
    async () =>
      await reserveProjectUpload(
        { ...f.ctx, stateDirectory: () => undefined },
        "id",
        hash,
      ),
    status(503),
  );
  try {
    await reserveProjectUpload(
      { ...f.ctx, stateDirectory: () => path.join(f.root, "missing-root") },
      "id",
      hash,
    );
    assert.fail();
  } catch (e) {
    assert.doesNotMatch(String(e), /missing-root/);
  }
});
test("corrupt/truncated/symlink/grown records cannot authorize fresh dispatch", async (t) => {
  for (const variant of ["corrupt", "truncated", "symlink", "oversize"]) {
    const f = fixture(t);
    await reserveProjectUpload(f.ctx, "id", hash);
    const file = path.join(f.dir(), fs.readdirSync(f.dir())[0]);
    if (variant === "symlink") {
      const inert = path.join(f.root, "inert");
      fs.writeFileSync(inert, "{}");
      fs.unlinkSync(file);
      fs.symlinkSync(inert, file);
    } else
      fs.writeFileSync(
        file,
        variant === "corrupt"
          ? "{}"
          : variant === "truncated"
            ? "{"
            : "x".repeat(4097),
      );
    await assert.rejects(
      () => reserveProjectUpload(f.ctx, "id", hash),
      status(503),
      variant,
    );
  }
});
test("fixed capacity never evicts, and existing confirmed receipts remain readable at capacity", async (t) => {
  const f = fixture(t);
  const first = await reserveProjectUpload(f.ctx, "known", hash);
  await first.confirm();
  for (let i = 0; i < projectUploadReceiptCapacity; i++) {
    const file = path.join(f.dir(), `slot-${i}.json`);
    if (!fs.existsSync(file))
      fs.writeFileSync(
        file,
        JSON.stringify({ version: 1, key: "0".repeat(64), payloadHash: hash }),
      );
  }
  const before = fs.readdirSync(f.dir()).length;
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "new", hash),
    status(503),
  );
  assert.equal(fs.readdirSync(f.dir()).length, before);
  assert.equal((await reserveProjectUpload(f.ctx, "known", hash)).fresh, false);
});
test("reservation fsync failure never yields fresh authorization and leaves fail-closed tombstone", async (t) => {
  const f = fixture(t);
  await reserveProjectUpload(f.ctx, "existing", hash);
  const original = fs.promises.open;
  t.mock.method(
    fs.promises,
    "open",
    async (...args: Parameters<typeof fs.promises.open>) => {
      const fd = await original(...args);
      if ((await fd.stat()).isFile())
        fd.sync = async () => {
          throw Error("private failure");
        };
      return fd;
    },
  );
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "new", hash),
    status(503),
  );
  t.mock.restoreAll();
  assert.equal(fs.promises.open, original);
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "new", hash),
    status(409),
  );
});
test("done write failure cannot remove reservation or permit replay", async (t) => {
  const f = fixture(t);
  const first = await reserveProjectUpload(f.ctx, "id", hash);
  const original = fs.promises.open;
  t.mock.method(
    fs.promises,
    "open",
    async (...args: Parameters<typeof fs.promises.open>) => {
      const fd = await original(...args);
      if (String(args[0]).includes(".done."))
        fd.writeFile = async () => {
          throw Error("private failure");
        };
      return fd;
    },
  );
  await assert.rejects(() => first.confirm(), status(503));
  t.mock.restoreAll();
  assert.equal(fs.promises.open, original);
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "id", hash),
    status(503),
  );
});

test("existing directory EEXIST must sync parent before new reservation", async (t) => {
  const f = fixture(t);
  await reserveProjectUpload(f.ctx, "existing", hash);
  const before = fs.readdirSync(f.dir()).sort();
  const original = fs.promises.open;
  t.mock.method(
    fs.promises,
    "open",
    async (...args: Parameters<typeof fs.promises.open>) => {
      const fd = await original(...args);
      fd.sync = async () => {
        throw Error("parent sync failed");
      };
      return fd;
    },
  );
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "new", hash),
    status(503),
  );
  assert.deepEqual(fs.readdirSync(f.dir()).sort(), before);
  t.mock.restoreAll();
  assert.equal(fs.promises.open, original);
  assert.equal((await reserveProjectUpload(f.ctx, "new", hash)).fresh, true);
});
test("wrong JSON types cannot be coerced into valid receipt hashes", async (t) => {
  const f = fixture(t);
  await reserveProjectUpload(f.ctx, "id", hash);
  const file = path.join(f.dir(), fs.readdirSync(f.dir())[0]);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.key = [value.key];
  fs.writeFileSync(file, JSON.stringify(value));
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "id", hash),
    status(503),
  );
});

test("missing activation identity never authorizes a receipt-backed mutation", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    async () =>
      await reserveProjectUpload(
        { ...f.ctx, sessionIdentity: undefined },
        "id",
        hash,
      ),
    status(503),
  );
  await assert.rejects(
    async () =>
      await reserveProjectUpload(
        { ...f.ctx, sessionIdentity: () => undefined },
        "id",
        hash,
      ),
    status(503),
  );
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("orphan confirmation with missing reservation never becomes a fresh upload", async (t) => {
  const f = fixture(t);
  const first = await reserveProjectUpload(f.ctx, "id", hash);
  await first.confirm();
  const reserved = fs
    .readdirSync(f.dir())
    .find((name) => !name.includes(".done."))!;
  fs.unlinkSync(path.join(f.dir(), reserved));
  const before = fs.readdirSync(f.dir());
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "id", hash),
    status(503),
  );
  assert.deepEqual(fs.readdirSync(f.dir()), before);
});

test("a lost earlier collision slot cannot hide a later confirmed same-ID receipt", async (t) => {
  const f = fixture(t);
  const first = await reserveProjectUpload(f.ctx, "id", hash);
  await first.confirm();
  const reserved = fs
    .readdirSync(f.dir())
    .find((name) => !name.includes(".done."))!;
  const slot = Number(/slot-(\d+)/.exec(reserved)![1]);
  const later = (slot + 1) % projectUploadReceiptCapacity;
  fs.renameSync(
    path.join(f.dir(), reserved),
    path.join(f.dir(), `slot-${later}.json`),
  );
  fs.renameSync(
    path.join(f.dir(), `slot-${slot}.done.json`),
    path.join(f.dir(), `slot-${later}.done.json`),
  );
  assert.equal((await reserveProjectUpload(f.ctx, "id", hash)).fresh, false);
  assert.equal(fs.existsSync(path.join(f.dir(), reserved)), false);
});
test("duplicate records for same identity cannot pick an arbitrary confirmation", async (t) => {
  const f = fixture(t);
  await (await reserveProjectUpload(f.ctx, "id", hash)).confirm();
  const reserved = fs
    .readdirSync(f.dir())
    .find((name) => !name.includes(".done."))!;
  const slot = Number(/slot-(\d+)/.exec(reserved)![1]);
  fs.copyFileSync(
    path.join(f.dir(), reserved),
    path.join(
      f.dir(),
      `slot-${(slot + 1) % projectUploadReceiptCapacity}.json`,
    ),
  );
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "id", hash),
    status(503),
  );
});

test("unknown directory entries and enumerated reservations disappearing fail closed", async (t) => {
  const f = fixture(t);
  await reserveProjectUpload(f.ctx, "id", hash);
  fs.writeFileSync(path.join(f.dir(), "unexpected.tmp"), "inert");
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "new", hash),
    status(503),
  );
  fs.unlinkSync(path.join(f.dir(), "unexpected.tmp"));
  const reserved = path.join(f.dir(), fs.readdirSync(f.dir())[0]);
  const original = fs.promises.open;
  let removed = false;
  t.mock.method(
    fs.promises,
    "open",
    async (...args: Parameters<typeof fs.promises.open>) => {
      if (String(args[0]) === reserved && !removed) {
        removed = true;
        fs.unlinkSync(reserved);
      }
      return original(...args);
    },
  );
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "id", hash),
    status(503),
  );
  assert.equal(removed, true);
  assert.deepEqual(fs.readdirSync(f.dir()), []);
});
test("lease retirement after asynchronous handle open closes it and never writes a reservation", async (t) => {
  const f = fixture(t);
  await reserveProjectUpload(f.ctx, "existing", hash);
  const before = fs.readdirSync(f.dir());
  const original = fs.promises.open;
  let closed = 0;
  t.mock.method(
    fs.promises,
    "open",
    async (...args: Parameters<typeof fs.promises.open>) => {
      const fd = await original(...args);
      const close = fd.close.bind(fd);
      fd.close = async () => {
        closed++;
        await close();
      };
      f.retire();
      return fd;
    },
  );
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "new", hash),
    status(409),
  );
  assert.ok(closed > 0);
  assert.deepEqual(fs.readdirSync(f.dir()), before);
});
test("eight exclusive-create races are bounded, never share fresh, and release in-flight guard", async (t) => {
  const f = fixture(t);
  await reserveProjectUpload(f.ctx, "existing", hash);
  const original = fs.promises.open;
  let attempts = 0;
  t.mock.method(
    fs.promises,
    "open",
    async (...args: Parameters<typeof fs.promises.open>) => {
      if (
        String(args[0]).includes("slot-") &&
        !String(args[0]).includes(".done.") &&
        typeof args[1] === "number" &&
        args[1] & fs.constants.O_CREAT
      ) {
        attempts++;
        throw Object.assign(Error("synthetic race"), { code: "EEXIST" });
      }
      return original(...args);
    },
  );
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "new", hash),
    status(503),
  );
  assert.equal(attempts, 8);
  t.mock.restoreAll();
  assert.equal((await reserveProjectUpload(f.ctx, "new", hash)).fresh, true);
});
test("full-capacity async scan yields to an event-loop heartbeat", async (t) => {
  const f = fixture(t);
  await (await reserveProjectUpload(f.ctx, "known", hash)).confirm();
  for (let i = 0; i < projectUploadReceiptCapacity; i++) {
    const file = path.join(f.dir(), `slot-${i}.json`);
    if (!fs.existsSync(file))
      fs.writeFileSync(
        file,
        JSON.stringify({ version: 1, key: "0".repeat(64), payloadHash: hash }),
      );
  }
  let ticks = 0,
    last = performance.now(),
    maxGap = 0;
  const start = last;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 2);
  try {
    assert.equal(
      (await reserveProjectUpload(f.ctx, "known", hash)).fresh,
      false,
    );
  } finally {
    clearInterval(timer);
  }
  assert.ok(
    ticks >= 2,
    "filesystem work must yield instead of one blocking synchronous scan",
  );
  t.diagnostic(
    JSON.stringify({
      elapsedMs: +(performance.now() - start).toFixed(2),
      ticks,
      maxHeartbeatGapMs: +maxGap.toFixed(2),
    }),
  );
});
test("different upload identities queue behind an incomplete local reservation without observing partial JSON", async (t) => {
  const f = fixture(t);
  const original = fs.promises.open;
  let entered!: () => void, release!: () => void;
  const opened = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  let paused = false;
  t.mock.method(
    fs.promises,
    "open",
    async (...args: Parameters<typeof fs.promises.open>) => {
      const fd = await original(...args);
      if (
        !paused &&
        String(args[0]).includes("slot-") &&
        typeof args[1] === "number" &&
        args[1] & fs.constants.O_CREAT
      ) {
        paused = true;
        const write = fd.writeFile.bind(fd);
        fd.writeFile = async (...values: Parameters<typeof fd.writeFile>) => {
          entered();
          await gate;
          return write(...values);
        };
      }
      return fd;
    },
  );
  const first = reserveProjectUpload(f.ctx, "first-parallel", hash);
  await opened;
  let settled = false;
  const second = reserveProjectUpload(f.ctx, "second-parallel", hash).then(
    (v) => {
      settled = true;
      return v;
    },
    (e) => {
      settled = true;
      return e;
    },
  );
  try {
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      settled,
      false,
      "a different local upload must wait rather than parse partial reservation JSON",
    );
  } finally {
    release();
    await first;
  }
  const result = await second;
  assert.equal(result.fresh, true);
});
test("bounded per-account queue drains after cancellation and never grants queued stale requests", async (t) => {
  const f = fixture(t);
  const original = fs.promises.open;
  let entered!: () => void,
    release!: () => void,
    paused = false;
  const opened = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  t.mock.method(
    fs.promises,
    "open",
    async (...args: Parameters<typeof fs.promises.open>) => {
      const fd = await original(...args);
      if (
        !paused &&
        String(args[0]).includes("slot-") &&
        typeof args[1] === "number" &&
        args[1] & fs.constants.O_CREAT
      ) {
        paused = true;
        const write = fd.writeFile.bind(fd);
        fd.writeFile = async (...values: Parameters<typeof fd.writeFile>) => {
          entered();
          await gate;
          return write(...values);
        };
      }
      return fd;
    },
  );
  const first = reserveProjectUpload(f.ctx, "queue-first", hash);
  await opened;
  let active = true;
  const cancelled = { ...f.ctx, isCurrent: () => active };
  const waiting = Array.from({ length: 15 }, (_, i) =>
    reserveProjectUpload(cancelled, `queued-${i}`, hash).then(
      (v) => v,
      (e) => e,
    ),
  );
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "overflow", hash),
    status(503),
  );
  active = false;
  release();
  assert.equal((await first).fresh, true);
  const results = await Promise.all(waiting);
  assert.ok(
    results.every(
      (e) => e instanceof ProjectUploadReceiptError && e.status === 409,
    ),
  );
  assert.equal(fs.readdirSync(f.dir()).length, 1);
  assert.equal(
    (await reserveProjectUpload(f.ctx, "after-drain", hash)).fresh,
    true,
  );
});
test("confirmation waits in same queue and lease retirement leaves unknown receipt instead of replay", async (t) => {
  const f = fixture(t);
  const confirmed = await reserveProjectUpload(f.ctx, "to-confirm", hash);
  const original = fs.promises.open;
  let entered!: () => void,
    release!: () => void,
    paused = false;
  const opened = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  t.mock.method(
    fs.promises,
    "open",
    async (...args: Parameters<typeof fs.promises.open>) => {
      const fd = await original(...args);
      if (
        !paused &&
        String(args[0]).includes("slot-") &&
        typeof args[1] === "number" &&
        args[1] & fs.constants.O_CREAT
      ) {
        paused = true;
        const write = fd.writeFile.bind(fd);
        fd.writeFile = async (...values: Parameters<typeof fd.writeFile>) => {
          entered();
          await gate;
          return write(...values);
        };
      }
      return fd;
    },
  );
  const blocking = reserveProjectUpload(f.ctx, "other-upload", hash).then(
    (v) => v,
    (e) => e,
  );
  await opened;
  const done = confirmed.confirm().then(
    (v) => v,
    (e) => e,
  );
  f.retire();
  release();
  await blocking;
  const result = await done;
  assert.ok(
    result instanceof ProjectUploadReceiptError && result.status === 409,
  );
  assert.equal(
    fs.readdirSync(f.dir()).some((name) => name.includes(".done.")),
    false,
  );
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "to-confirm", hash),
    status(409),
  );
});
test("a same-ID completed record inserted after enumeration forces a full rescan, never fresh", async (t) => {
  const f = fixture(t);
  await reserveProjectUpload(f.ctx, "existing", hash);
  const key = createHash("sha256").update("inserted").digest("hex");
  let slot = parseInt(key.slice(0, 8), 16) % projectUploadReceiptCapacity;
  while (fs.existsSync(path.join(f.dir(), `slot-${slot}.json`)))
    slot = (slot + 1) % projectUploadReceiptCapacity;
  const original = fs.promises.opendir;
  let scans = 0,
    inserted = false;
  t.mock.method(
    fs.promises,
    "opendir",
    async (...args: Parameters<typeof fs.promises.opendir>) => {
      const handle = await original(...args);
      scans++;
      const read = handle.read.bind(handle);
      handle.read = (async () => {
        const entry = await read();
        if (!entry && !inserted) {
          inserted = true;
          await fs.promises.writeFile(
            path.join(f.dir(), `slot-${slot}.json`),
            JSON.stringify({ version: 1, key, payloadHash: hash }),
          );
          await fs.promises.writeFile(
            path.join(f.dir(), `slot-${slot}.done.json`),
            JSON.stringify({
              version: 1,
              key,
              payloadHash: hash,
              confirmed: true,
            }),
          );
        }
        return entry;
      }) as typeof handle.read;
      return handle;
    },
  );
  assert.equal(
    (await reserveProjectUpload(f.ctx, "inserted", hash)).fresh,
    false,
  );
  assert.ok(scans >= 2);
  assert.equal(fs.readdirSync(f.dir()).length, 3);
});
test("continuous directory changes exhaust eight rescans with no new reservation", async (t) => {
  const f = fixture(t);
  await reserveProjectUpload(f.ctx, "existing", hash);
  const before = fs.readdirSync(f.dir());
  const original = fs.promises.opendir;
  let scans = 0;
  t.mock.method(
    fs.promises,
    "opendir",
    async (...args: Parameters<typeof fs.promises.opendir>) => {
      const handle = await original(...args);
      scans++;
      const read = handle.read.bind(handle);
      handle.read = (async () => {
        const entry = await read();
        if (!entry) {
          await fs.promises.utimes(
            f.dir(),
            new Date(),
            new Date(Date.now() + scans * 1000),
          );
        }
        return entry;
      }) as typeof handle.read;
      return handle;
    },
  );
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "new", hash),
    status(503),
  );
  assert.equal(scans, 8);
  assert.deepEqual(fs.readdirSync(f.dir()), before);
});
test("lease retirement immediately after opendir still closes the directory handle", async (t) => {
  const f = fixture(t);
  await reserveProjectUpload(f.ctx, "existing", hash);
  const before = fs.readdirSync(f.dir());
  const original = fs.promises.opendir;
  let closed = 0;
  t.mock.method(
    fs.promises,
    "opendir",
    async (...args: Parameters<typeof fs.promises.opendir>) => {
      const handle = await original(...args);
      const close = handle.close.bind(handle);
      handle.close = (async () => {
        closed++;
        await close();
      }) as typeof handle.close;
      f.retire();
      return handle;
    },
  );
  await assert.rejects(
    () => reserveProjectUpload(f.ctx, "new", hash),
    status(409),
  );
  assert.equal(closed, 1);
  assert.deepEqual(fs.readdirSync(f.dir()), before);
});
