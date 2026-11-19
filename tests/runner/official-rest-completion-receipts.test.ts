import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reserveRestCompletion,
  RestCompletionReceiptError,
  type RestCompletionReceiptInput,
  restCompletionReceiptCapacity,
} from "../../electron/official-ui/api/rest-completion-receipts";
const input: RestCompletionReceiptInput = {
  conversationId: "11111111-1111-7111-8111-111111111111",
  humanId: "22222222-2222-7222-8222-222222222222",
  assistantId: "33333333-3333-7333-8333-333333333333",
  requestId: "44444444-4444-4444-8444-444444444444",
  payloadHash: "a".repeat(64),
};
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-rest-once-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let owner = "a",
    session = 1,
    current = true;
  const ctx: any = {
    account: () => (owner ? { id: owner } : undefined),
    stateDirectory: () => root,
    sessionIdentity: () => session,
    isCurrent: () => current,
  };
  return {
    ctx,
    root,
    owner: (v: string) => {
      owner = v;
    },
    retire: () => {
      current = false;
    },
    rotate: () => {
      session++;
    },
  };
}
const error = (status: number) => (e: any) =>
  e instanceof RestCompletionReceiptError && e.status === status;
test("reserve precedes send; duplicate/reconstructed context returns same UUID and never fresh again", (t) => {
  const f = fixture(t);
  const a = reserveRestCompletion(f.ctx, input);
  assert.equal(a.fresh, true);
  assert.match(a.operationId, /^[a-f0-9-]{36}$/);
  const b = reserveRestCompletion({ ...f.ctx }, input);
  assert.equal(b.fresh, false);
  assert.equal(b.operationId, a.operationId);
  const files = fs
    .readdirSync(path.join(f.root, fs.readdirSync(f.root)[0]))
    .filter((n) => n.endsWith(".json"));
  assert.equal(files.length, 2);
});
test("turn identity survives missing or changed completion request id", (t) => {
  const f = fixture(t);
  const a = reserveRestCompletion(f.ctx, { ...input, requestId: undefined });
  const b = reserveRestCompletion(f.ctx, input);
  const c = reserveRestCompletion(f.ctx, {
    ...input,
    requestId: "55555555-5555-4555-8555-555555555555",
  });
  assert.equal(a.fresh, true);
  assert.equal(b.fresh, false);
  assert.equal(c.fresh, false);
  assert.equal(a.operationId, c.operationId);
});
test("same turn with different semantic hash conflicts without new dispatch permission", (t) => {
  const f = fixture(t);
  reserveRestCompletion(f.ctx, input);
  assert.throws(
    () =>
      reserveRestCompletion(f.ctx, { ...input, payloadHash: "b".repeat(64) }),
    error(409),
  );
  assert.equal(reserveRestCompletion(f.ctx, input).fresh, false);
});
test("same completion request id cannot bind another turn or conversation even with identical payload hash", (t) => {
  const f = fixture(t);
  reserveRestCompletion(f.ctx, input);
  const second = {
    ...input,
    conversationId: "99999999-9999-7999-8999-999999999999",
  };
  assert.throws(() => reserveRestCompletion(f.ctx, second), error(409));
  assert.equal(
    reserveRestCompletion(f.ctx, { ...second, requestId: undefined }).fresh,
    false,
  );
});
test("owner namespace prevents cross-account receipt disclosure", (t) => {
  const f = fixture(t);
  const a = reserveRestCompletion(f.ctx, input);
  f.owner("b");
  const b = reserveRestCompletion(f.ctx, input);
  assert.equal(b.fresh, true);
  assert.notEqual(a.operationId, b.operationId);
  f.owner("a");
  assert.equal(reserveRestCompletion(f.ctx, input).operationId, a.operationId);
});
test("missing state directory and retired/signed-out contexts cannot reserve", (t) => {
  const f = fixture(t);
  assert.throws(
    () => reserveRestCompletion({ ...f.ctx, stateDirectory: undefined }, input),
    error(503),
  );
  f.retire();
  assert.throws(() => reserveRestCompletion(f.ctx, input), error(409));
  assert.equal(fs.readdirSync(f.root).length, 0);
});
test("symlink directory or receipt cannot redirect writes/reads; malformed persisted receipt fails closed", (t) => {
  const f = fixture(t);
  reserveRestCompletion(f.ctx, input);
  const dir = path.join(f.root, fs.readdirSync(f.root)[0]);
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  for (const file of files) fs.writeFileSync(path.join(dir, file), "not json");
  assert.throws(() => reserveRestCompletion(f.ctx, input), error(503));
  for (const file of files) {
    fs.unlinkSync(path.join(dir, file));
    fs.symlinkSync(path.join(f.root, "missing-target"), path.join(dir, file));
  }
  assert.throws(() => reserveRestCompletion(f.ctx, input), error(503));
});
test("only UUID identities and fixed SHA256 are accepted; renderer paths are never used", (t) => {
  const f = fixture(t);
  for (const patch of [
    { conversationId: "../../outside" },
    { requestId: "../../outside" },
    { humanId: input.assistantId },
    { payloadHash: "path/escape" },
  ])
    assert.throws(
      () => reserveRestCompletion(f.ctx, { ...input, ...patch }),
      error(409),
    );
  assert.equal(fs.readdirSync(f.root).length, 0);
});
test("tombstone contains no prompt/body and has no success or replay implication", (t) => {
  const f = fixture(t);
  reserveRestCompletion(f.ctx, input);
  const dir = path.join(f.root, fs.readdirSync(f.root)[0]);
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    assert.deepEqual(Object.keys(saved).sort(), [
      "key",
      "operationId",
      "payloadHash",
      "version",
    ]);
  }
  assert.equal(reserveRestCompletion(f.ctx, input).fresh, false);
});
test("growth and truncation between stat and bounded read fail closed without dispatch", (t) => {
  for (const change of ["grow", "truncate"] as const) {
    const f = fixture(t);
    reserveRestCompletion(f.ctx, input);
    const original = fs.readSync;
    let dispatches = 0,
      readSize = 0;
    const mock = t.mock.method(
      fs,
      "readSync",
      (
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        readSize = Math.max(readSize, length);
        // Mutate the opened receipt's underlying file through the controlled fixture.
        const dir = path.join(f.root, fs.readdirSync(f.root)[0]);
        for (const name of fs
          .readdirSync(dir)
          .filter((n) => n.endsWith(".json"))) {
          if (change === "grow")
            fs.appendFileSync(path.join(dir, name), "x".repeat(5000));
          else fs.truncateSync(path.join(dir, name), 1);
        }
        return original(fd, buffer, offset, length, position);
      },
    );
    try {
      assert.throws(() => {
        if (reserveRestCompletion(f.ctx, input).fresh) dispatches++;
      }, error(503));
      assert.equal(readSize, 4097);
      assert.equal(dispatches, 0);
    } finally {
      mock.mock.restore();
    }
  }
});
test("failed receipt fsync never authorizes send and its uncertain tombstone never replays", (t) => {
  const f = fixture(t);
  // Establish the namespace before injecting a file-sync error.
  reserveRestCompletion(f.ctx, input);
  const other = {
    ...input,
    humanId: "66666666-6666-7666-8666-666666666666",
    requestId: undefined,
  };
  const original = fs.fsyncSync;
  const mock = t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (fs.fstatSync(fd).isFile() && fs.fstatSync(fd).size > 100)
      throw new Error("synthetic fsync failure");
    return original(fd);
  });
  let dispatches = 0;
  try {
    assert.throws(() => {
      if (reserveRestCompletion(f.ctx, other).fresh) dispatches++;
    }, error(503));
  } finally {
    mock.mock.restore();
  }
  assert.equal(dispatches, 0);
  assert.equal(reserveRestCompletion(f.ctx, other).fresh, false);
});

test("fixed slot capacity prevents new receipts but preserves existing reads without eviction", (t) => {
  const f = fixture(t);
  const first = reserveRestCompletion(f.ctx, input);
  const dir = path.join(f.root, fs.readdirSync(f.root)[0]);
  for (let i = 0; i < restCompletionReceiptCapacity; i++) {
    try {
      fs.writeFileSync(path.join(dir, `capacity-slot-${i}`), "", {
        flag: "wx",
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  assert.equal(
    reserveRestCompletion(f.ctx, input).operationId,
    first.operationId,
  );
  const before = fs.readdirSync(dir).length;
  assert.throws(
    () =>
      reserveRestCompletion(f.ctx, {
        ...input,
        humanId: "66666666-6666-7666-8666-666666666666",
        requestId: undefined,
      }),
    error(503),
  );
  assert.equal(fs.readdirSync(dir).length, before);
});
test("legacy directory without quota marker never forgets receipts or silently initializes new capacity", (t) => {
  const f = fixture(t);
  const first = reserveRestCompletion(f.ctx, input);
  const dir = path.join(f.root, fs.readdirSync(f.root)[0]);
  fs.unlinkSync(path.join(dir, "capacity-v1")); // Test-only legacy layout; no production deletion.
  assert.equal(
    reserveRestCompletion(f.ctx, input).operationId,
    first.operationId,
  );
  assert.throws(
    () =>
      reserveRestCompletion(f.ctx, {
        ...input,
        requestId: "55555555-5555-4555-8555-555555555555",
      }),
    error(503),
  );
  assert.equal(fs.existsSync(path.join(dir, "capacity-v1")), false);
});

// Compatibility is supplied only by the trusted adapter's account-local alias map.
test("legacy alias tombstone is recognized under the real ID without request identity", t => {
  const f = fixture(t), alias = "55555555-5555-4555-8555-555555555555";
  const old = reserveRestCompletion(f.ctx, { ...input, conversationId: alias, requestId: undefined });
  const next = reserveRestCompletion(f.ctx, { ...input, requestId: undefined }, { equivalentConversationIds: [alias] });
  assert.equal(next.fresh, false); assert.equal(next.operationId, old.operationId);
  assert.throws(() => reserveRestCompletion(f.ctx, { ...input, requestId: undefined, payloadHash: "b".repeat(64) }, { equivalentConversationIds: [alias] }), error(409));
});
test("conflicting canonical and legacy operations cannot choose one outcome or dispatch", t => {
  const f = fixture(t), alias = "55555555-5555-4555-8555-555555555555";
  const first = reserveRestCompletion(f.ctx, { ...input, requestId: undefined });
  const second = reserveRestCompletion(f.ctx, { ...input, conversationId: alias, requestId: undefined });
  assert.notEqual(first.operationId, second.operationId);
  assert.throws(() => reserveRestCompletion(f.ctx, { ...input, requestId: undefined }, { equivalentConversationIds: [alias] }), error(409));
});
test("invalid or excessive alias inventory refuses before creating any receipt", t => {
  for (const equivalentConversationIds of [["../outside"], Array(5001).fill(input.conversationId)]) {
    const f = fixture(t); assert.throws(() => reserveRestCompletion(f.ctx, input, { equivalentConversationIds }), error(409));
    assert.deepEqual(fs.readdirSync(f.root), []);
  }
});

test("legacy migration persists the original operation before alias-free restart reads", t => {
  const f = fixture(t), alias = "55555555-5555-4555-8555-555555555555";
  const old = reserveRestCompletion(f.ctx, { ...input, conversationId: alias, requestId: undefined });
  const migrated = reserveRestCompletion(f.ctx, { ...input, requestId: undefined }, { equivalentConversationIds: [alias] });
  assert.deepEqual(migrated, { fresh: false, operationId: old.operationId });
  const reopened = reserveRestCompletion({ ...f.ctx }, { ...input, requestId: undefined });
  assert.deepEqual(reopened, migrated);
  assert.throws(() => reserveRestCompletion(f.ctx, { ...input, requestId: undefined, payloadHash: "b".repeat(64) }), error(409));
});
test("full capacity rejects missing canonical migration but preserves already migrated reads", t => {
  for (const migrated of [false, true]) {
    const f = fixture(t), alias = "55555555-5555-4555-8555-555555555555";
    const old = reserveRestCompletion(f.ctx, { ...input, conversationId: alias, requestId: undefined });
    if (migrated) reserveRestCompletion(f.ctx, { ...input, requestId: undefined }, { equivalentConversationIds: [alias] });
    const dir = path.join(f.root, fs.readdirSync(f.root)[0]);
    for (let i = 0; i < restCompletionReceiptCapacity; i++) {
      const slot = path.join(dir, `capacity-slot-${i}`);
      if (!fs.existsSync(slot)) fs.writeFileSync(slot, "", { flag: "wx" });
    }
    const before = fs.readdirSync(dir).sort();
    if (migrated) assert.deepEqual(reserveRestCompletion(f.ctx, { ...input, requestId: undefined }), { fresh: false, operationId: old.operationId });
    else {
      assert.throws(() => reserveRestCompletion(f.ctx, { ...input, requestId: undefined }, { equivalentConversationIds: [alias] }), error(503));
      assert.throws(() => reserveRestCompletion(f.ctx, { ...input, requestId: undefined }), error(503));
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
  }
});
test("migration write and flush failures never return fresh or permit an alias-free replay", t => {
  for (const mode of ["write", "file-sync", "directory-sync"]) {
    const f = fixture(t), alias = "55555555-5555-4555-8555-555555555555";
    const old = reserveRestCompletion(f.ctx, { ...input, conversationId: alias, requestId: undefined });
    const write = fs.writeFileSync, sync = fs.fsyncSync;
    let entered = false, wrote = false;
    const writeMock = t.mock.method(fs, "writeFileSync", (...args: any[]) => {
      if (typeof args[1] === "string" && args[1].includes(old.operationId)) {
        wrote = true;
        if (mode === "write") { entered = true; throw Error("synthetic migration write failure"); }
      }
      return (write as any)(...args);
    });
    const syncMock = t.mock.method(fs, "fsyncSync", (fd: number) => {
      if (wrote && (mode === "file-sync" ? fs.fstatSync(fd).isFile() : mode === "directory-sync" && fs.fstatSync(fd).isDirectory())) {
        entered = true; throw Error("synthetic migration flush failure");
      }
      return sync(fd);
    });
    try {
      assert.throws(() => reserveRestCompletion(f.ctx, { ...input, requestId: undefined }, { equivalentConversationIds: [alias] }), error(503));
      assert.equal(entered, true);
    } finally { writeMock.mock.restore(); syncMock.mock.restore(); }
    if (mode === "write") assert.throws(() => reserveRestCompletion(f.ctx, { ...input, requestId: undefined }), error(503));
    else assert.deepEqual(reserveRestCompletion(f.ctx, { ...input, requestId: undefined }), { fresh: false, operationId: old.operationId });
  }
});
test("canonical publication race cannot replace the legacy operation identity", t => {
  const f = fixture(t), alias = "55555555-5555-4555-8555-555555555555";
  const old = reserveRestCompletion(f.ctx, { ...input, conversationId: alias, requestId: undefined });
  const open = fs.openSync;
  let entered = false;
  const mock = t.mock.method(fs, "openSync", (...args: any[]) => {
    if (!entered && typeof args[0] === "string" && args[0].endsWith(".json") && typeof args[1] === "number" && (args[1] & fs.constants.O_EXCL)) {
      entered = true;
      fs.writeFileSync(args[0], JSON.stringify({version:1,key:path.basename(args[0],".json"),payloadHash:input.payloadHash,operationId:"99999999-9999-4999-8999-999999999999"}), {flag:"wx"});
    }
    return (open as any)(...args);
  });
  try { assert.throws(() => reserveRestCompletion(f.ctx, { ...input, requestId: undefined }, { equivalentConversationIds: [alias] }), error(409)); assert.equal(entered,true); }
  finally { mock.mock.restore(); }
  assert.equal(reserveRestCompletion(f.ctx,{...input,conversationId:alias,requestId:undefined}).operationId,old.operationId);
});
