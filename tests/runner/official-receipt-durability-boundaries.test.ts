/** Temp-only fault injection. Platform simulation does not establish Windows durability. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reserveRestCompletion,
  RestCompletionReceiptError,
} from "../../electron/official-ui/api/rest-completion-receipts";
import {
  reserveOfficialAction,
  finishOfficialAction,
} from "../../runner/src/official-ui-receipts";
const input = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  humanId: "22222222-2222-4222-8222-222222222222",
  assistantId: "33333333-3333-4333-8333-333333333333",
  payloadHash: "a".repeat(64),
};
const other = { ...input, humanId: "44444444-4444-4444-8444-444444444444" };
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx: any = {
    account: () => ({ id: "owner" }),
    sessionIdentity: () => 1,
    stateDirectory: () => root,
    isCurrent: () => true,
  };
  return { root, ctx };
}
function windows<T>(fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}
function failRootSync(t: any, root: string) {
  const info = fs.statSync(root),
    original = fs.fsyncSync;
  let flushes = 0;
  const mock = t.mock.method(fs, "fsyncSync", (fd: number) => {
    const stat = fs.fstatSync(fd);
    if (stat.dev === info.dev && stat.ino === info.ino) {
      flushes++;
      throw Error("inert parent flush failure");
    }
    return original(fd);
  });
  return {
    restore: () => mock.mock.restore(),
    get flushes() {
      return flushes;
    },
  };
}
test("REST existing-directory parent flush failure permits no fresh reservation but preserves read-only outcome", (t) => {
  const { root, ctx } = fixture(t);
  const first = reserveRestCompletion(ctx, input);
  const dir = path.join(root, fs.readdirSync(root)[0]),
    before = fs.readdirSync(dir).sort();
  const failed = failRootSync(t, root);
  let dispatch = 0;
  assert.throws(
    () => {
      if (reserveRestCompletion(ctx, other).fresh) dispatch++;
    },
    (e: any) => e instanceof RestCompletionReceiptError && e.status === 503,
  );
  assert.equal(dispatch, 0);
  assert.equal(failed.flushes, 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  assert.deepEqual(reserveRestCompletion(ctx, input), {
    fresh: false,
    operationId: first.operationId,
  });
  failed.restore();
  assert.equal(reserveRestCompletion(ctx, other).fresh, true);
});
test("runner existing-directory parent flush failure cannot authorize dispatch and existing done remains readable", (t) => {
  const { root } = fixture(t);
  const first = reserveOfficialAction(root, "first", input.payloadHash);
  assert.equal(first.kind, "reserved");
  if (first.kind !== "reserved") throw Error();
  finishOfficialAction(first.file, input.payloadHash, {
    status: 200,
    contentType: "text/plain",
    body: Buffer.from("inert"),
  });
  const dir = path.dirname(first.file),
    before = fs.readdirSync(dir).sort();
  const failed = failRootSync(t, root);
  let dispatch = 0;
  assert.throws(() => {
    if (
      reserveOfficialAction(root, "second", input.payloadHash).kind ===
      "reserved"
    )
      dispatch++;
  });
  assert.equal(dispatch, 0);
  assert.equal(failed.flushes, 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  const read = reserveOfficialAction(root, "first", input.payloadHash);
  assert.equal(read.kind, "done");
  if (read.kind === "done")
    assert.equal(Buffer.from(read.answer.body).toString(), "inert");
  failed.restore();
});
test("simulated Windows rejects fresh REST and runner reservations without writes but permits existing records", (t) => {
  const { root, ctx } = fixture(t);
  const rest = reserveRestCompletion(ctx, input);
  const pending = reserveOfficialAction(root, "existing", input.payloadHash);
  assert.equal(pending.kind, "reserved");
  const before = fs
    .readdirSync(root)
    .map((name) => [name, fs.readdirSync(path.join(root, name)).sort()]);
  windows(() => {
    assert.throws(
      () => reserveRestCompletion(ctx, other),
      (e: any) => e.status === 503,
    );
    assert.deepEqual(reserveRestCompletion(ctx, input), {
      fresh: false,
      operationId: rest.operationId,
    });
    assert.throws(
      () => reserveOfficialAction(root, "new", input.payloadHash),
      /Windows/,
    );
    assert.equal(
      reserveOfficialAction(root, "existing", input.payloadHash).kind,
      "pending",
    );
  });
  assert.deepEqual(
    fs
      .readdirSync(root)
      .map((name) => [name, fs.readdirSync(path.join(root, name)).sort()]),
    before,
  );
  const empty = fixture(t);
  windows(() => {
    assert.throws(
      () => reserveRestCompletion(empty.ctx, input),
      (e: any) => e.status === 503,
    );
    assert.throws(() =>
      reserveOfficialAction(empty.root, "new", input.payloadHash),
    );
  });
  assert.deepEqual(fs.readdirSync(empty.root), []);
});
test("missing activation and coerced input fields cannot create REST receipts", (t) => {
  const { root, ctx } = fixture(t);
  for (const missing of [undefined, null])
    assert.throws(
      () =>
        reserveRestCompletion(
          { ...ctx, sessionIdentity: () => missing },
          input,
        ),
      (e: any) => e.status === 409,
    );
  for (const key of [
    "conversationId",
    "humanId",
    "assistantId",
    "payloadHash",
  ] as const)
    assert.throws(
      () =>
        reserveRestCompletion(ctx, { ...input, [key]: [input[key]] } as any),
      (e: any) => e.status === 409,
    );
  assert.deepEqual(fs.readdirSync(root), []);
});
test("persisted REST scalar fields reject regex-coercible arrays", (t) => {
  for (const key of ["key", "payloadHash", "operationId"]) {
    const { root, ctx } = fixture(t);
    reserveRestCompletion(ctx, input);
    const dir = path.join(root, fs.readdirSync(root)[0]);
    const file = path.join(
      dir,
      fs.readdirSync(dir).find((n) => n.endsWith(".json"))!,
    );
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value[key] = [value[key]];
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(
      () => reserveRestCompletion(ctx, input),
      (e: any) => e.status === 503,
    );
  }
});
test("runner malformed persisted hash/phase/result fields never replay a successful result", (t) => {
  const { root } = fixture(t);
  const receipt = reserveOfficialAction(root, "key", input.payloadHash);
  assert.equal(receipt.kind, "reserved");
  if (receipt.kind !== "reserved") throw Error();
  for (const patch of [
    { hash: [input.payloadHash] },
    { phase: ["pending"] },
    { phase: "done", status: "200", contentType: "text/plain", body: "" },
    { phase: "done", status: 200, contentType: ["text/plain"], body: "" },
  ]) {
    fs.writeFileSync(
      receipt.file,
      JSON.stringify({ hash: input.payloadHash, phase: "pending", ...patch }),
    );
    assert.throws(
      () => reserveOfficialAction(root, "key", input.payloadHash),
      /not valid/,
    );
  }
});
test("runner uncertain file flush never returns dispatch permission and never replays pending", (t) => {
  const { root } = fixture(t);
  reserveOfficialAction(root, "prime", input.payloadHash);
  const original = fs.fsyncSync;
  const mock = t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (fs.fstatSync(fd).isFile()) throw Error("inert file flush failure");
    return original(fd);
  });
  let dispatched = 0;
  assert.throws(() => {
    if (
      reserveOfficialAction(root, "uncertain", input.payloadHash).kind ===
      "reserved"
    )
      dispatched++;
  });
  assert.equal(dispatched, 0);
  mock.mock.restore();
  assert.equal(
    reserveOfficialAction(root, "uncertain", input.payloadHash).kind,
    "pending",
  );
});
test("REST root change during reservation cannot authorize a dispatch", (t) => {
  const f = fixture(t),
    alternate = fixture(t);
  reserveRestCompletion(f.ctx, input);
  const original = fs.fsyncSync;
  let switched = false;
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    original(fd);
    if (!switched && fs.fstatSync(fd).isFile()) {
      switched = true;
      f.ctx.stateDirectory = () => alternate.root;
    }
  });
  assert.throws(
    () => reserveRestCompletion(f.ctx, other),
    (e: any) => e.status === 409,
  );
  assert.equal(switched, true);
  assert.deepEqual(fs.readdirSync(alternate.root), []);
});
test("runner receipt growth/truncation/replacement during fixed-cap fd read fails closed", (t) => {
  for (const change of ["grow", "truncate", "replace"] as const) {
    const { root } = fixture(t),
      reserved = reserveOfficialAction(root, "key", input.payloadHash);
    if (reserved.kind !== "reserved") throw Error();
    const original = fs.readSync,
      originalSize = fs.statSync(reserved.file).size;
    let changed = false,
      largestRead = 0;
    const mock = t.mock.method(fs, "readSync", (...args: any[]) => {
      largestRead = Math.max(largestRead, args[3]);
      if (!changed) {
        changed = true;
        if (change === "grow")
          fs.appendFileSync(reserved.file, "x".repeat(8192));
        if (change === "truncate") fs.truncateSync(reserved.file, 1);
        if (change === "replace") {
          fs.renameSync(reserved.file, reserved.file + ".old");
          fs.writeFileSync(
            reserved.file,
            JSON.stringify({ hash: input.payloadHash, phase: "pending" }),
          );
        }
      }
      return (original as any)(...args);
    });
    assert.throws(
      () => reserveOfficialAction(root, "key", input.payloadHash),
      /changed during read/,
    );
    assert.equal(changed, true);
    assert.ok(largestRead <= originalSize + 1);
    mock.mock.restore();
  }
});
test("runner receipt symlink and oversize files are rejected before body allocation", (t) => {
  const { root } = fixture(t),
    reserved = reserveOfficialAction(root, "key", input.payloadHash);
  if (reserved.kind !== "reserved") throw Error();
  fs.renameSync(reserved.file, reserved.file + ".inert");
  fs.symlinkSync(reserved.file + ".inert", reserved.file);
  assert.throws(
    () => reserveOfficialAction(root, "key", input.payloadHash),
    /not valid/,
  );
  fs.unlinkSync(reserved.file);
  fs.writeFileSync(reserved.file, "");
  // Sparse, self-created temp file, not an actual response or private data.
  fs.truncateSync(reserved.file, 100 * 1024 * 1024);
  const mock = t.mock.method(fs, "readSync", () => {
    throw Error("oversize must not read");
  });
  assert.throws(
    () => reserveOfficialAction(root, "key", input.payloadHash),
    /not valid/,
  );
  mock.mock.restore();
});

test("runner preserves maximum legal 4 MiB binary response within existing JSON cap", (t) => {
  const { root } = fixture(t),
    reserved = reserveOfficialAction(root, "maximum", input.payloadHash);
  if (reserved.kind !== "reserved") throw Error();
  const body = Buffer.alloc(4 * 1024 * 1024, 117);
  finishOfficialAction(reserved.file, input.payloadHash, {
    status: 200,
    contentType: "application/octet-stream",
    body,
  });
  const saved = reserveOfficialAction(root, "maximum", input.payloadHash);
  assert.equal(saved.kind, "done");
  if (saved.kind === "done") assert.deepEqual(saved.answer.body, body);
});

test("runner canonical body validation rejects malformed padding, alphabet and ignored characters", (t) => {
  const { root } = fixture(t),
    reserved = reserveOfficialAction(root, "malformed", input.payloadHash);
  if (reserved.kind !== "reserved") throw Error();
  for (const body of [
    "AB==",
    "AAB=",
    "YQ==\n",
    "====",
    "AA=A",
    "AA-_",
    "A",
    "YWJj ",
  ]) {
    fs.writeFileSync(
      reserved.file,
      JSON.stringify({
        hash: input.payloadHash,
        phase: "done",
        status: 200,
        contentType: "text/plain",
        body,
      }),
    );
    assert.throws(
      () => reserveOfficialAction(root, "malformed", input.payloadHash),
      /not valid/,
    );
  }
});
test("runner bounded receipt reader tolerates genuine partial fd reads with explicit advancing positions", (t) => {
  const { root } = fixture(t);
  reserveOfficialAction(root, "short-read", input.payloadHash);
  const original = fs.readSync;
  let reads = 0,
    expected = 0;
  t.mock.method(
    fs,
    "readSync",
    (
      fd: number,
      bytes: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      assert.equal(position, expected);
      reads++;
      const count = original(fd, bytes, offset, Math.min(length, 7), position);
      expected += count;
      return count;
    },
  );
  assert.equal(
    reserveOfficialAction(root, "short-read", input.payloadHash).kind,
    "pending",
  );
  assert.ok(reads > 2);
});

test("REST fixed 4097-byte receipt reader tolerates seven-byte reads without changing replay identity", (t) => {
  const { ctx } = fixture(t);
  const first = reserveRestCompletion(ctx, input);
  const original = fs.readSync;
  let reads = 0,
    expected = 0;
  t.mock.method(
    fs,
    "readSync",
    (
      fd: number,
      bytes: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      assert.equal(bytes.length, 4097);
      assert.equal(position, expected);
      reads++;
      const count = original(fd, bytes, offset, Math.min(length, 7), position);
      expected += count;
      return count;
    },
  );
  assert.deepEqual(reserveRestCompletion(ctx, input), {
    fresh: false,
    operationId: first.operationId,
  });
  assert.ok(reads > 2);
});

test("simulated Windows rejects missing legacy migration without writes and reads an existing migrated binding", t => {
  for (const migrated of [false, true]) {
    const { root, ctx } = fixture(t), alias = "55555555-5555-4555-8555-555555555555";
    const old = reserveRestCompletion(ctx, { ...input, conversationId: alias });
    if (migrated) reserveRestCompletion(ctx, input, { equivalentConversationIds: [alias] });
    const dir = path.join(root, fs.readdirSync(root)[0]), before = fs.readdirSync(dir).sort();
    windows(() => {
      if (migrated) assert.deepEqual(reserveRestCompletion(ctx, input), { fresh: false, operationId: old.operationId });
      else assert.throws(() => reserveRestCompletion(ctx, input, { equivalentConversationIds: [alias] }), (e:any) => e.status === 503);
    });
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
  }
});
