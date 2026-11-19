/** Inert real-handler integration; isolated disk, no native adapter or execution. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/store/store";
import { CloudStore } from "../runner/src/cloud-store";
import { registerConversationManageHandlers } from "../electron/ipc/conversation-manage-handlers";
import {
  codeReadSnapshot,
  sameCodeReadActivity,
  sameCodeReadSnapshot,
} from "../shared/code-read-state";

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f090-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const c: any = {
    id: "one",
    createdAt: 1,
    updatedAt: 2,
    mode: "code",
    cwd: root,
    title: "Fixture",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    unread: true,
    turns: [
      {
        id: "turn",
        createdAt: 2,
        status: "completed",
        prompt: "private",
        items: [],
        attachments: [],
      },
    ],
  };
  store.conversations.push(c);
  store.flush();
  const events: any[] = [],
    read: string[] = [];
  const context: any = {
    store,
    engine: {},
    accountGeneration: () => 1,
    activeAccount: { id: "owner" },
    push: (event: any) => events.push(event),
    scheduler: { markConversationRead: (id: string) => read.push(id) },
  };
  const handlers = new Map<string, Function>();
  registerConversationManageHandlers({
    context,
    engineOf: () => undefined,
    handle: (name, fn) => handlers.set(name, fn),
  });
  const update = (raw: any) => handlers.get("updateConversation")!(c.id, raw);
  const guard = () => ({
    unread: { version: 1, expected: codeReadSnapshot(c) },
  });
  return { store, c, context, events, read, root, update, guard };
}

test("guarded Code read commits before effects and repeated current snapshot is inert", async (t) => {
  const f = fixture(t),
    before = codeReadSnapshot(f.c);
  const result = await f.update(f.guard());
  assert.equal(result.unread, false);
  assert.equal(result.readStateRevision, 1);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(f.root, "conversations.json"), "utf8"),
    )[0].unread,
    false,
  );
  assert.equal(sameCodeReadActivity(result, before), true);
  assert.equal(sameCodeReadSnapshot(result, before), false);
  assert.deepEqual(f.read, ["one"]);
  assert.deepEqual(f.events, [{
    type: "code-read-state", conversationId: f.c.id, unread: false, readStateRevision: 1,
  }]);
  f.store.write = () => {
    throw Error("duplicate write");
  };
  await f.update(f.guard());
  assert.equal(f.events.length, 1);
  assert.equal(f.read.length, 1);
  assert.equal(JSON.stringify(before).includes("private"), false);
});

test("disk failure preserves unread memory, revision, disk and effects", async (t) => {
  const f = fixture(t),
    before = JSON.stringify(f.c);
  f.store.write = () => {
    throw Error("disk full");
  };
  await assert.rejects(f.update(f.guard()), /disk full/);
  assert.equal(JSON.stringify(f.c), before);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(f.root, "conversations.json"), "utf8"),
    )[0].unread,
    true,
  );
  assert.equal(f.events.length + f.read.length, 0);
});

test("ordinary Code unread true invalidates delayed open even when already true", async (t) => {
  const f = fixture(t),
    old = f.guard();
  f.update({ unread: true });
  assert.equal(f.c.readStateRevision, 1);
  await assert.rejects(f.update(old), /changed/);
  assert.equal(f.c.unread, true);
  f.c.mode = "chat";
  f.update({ unread: true });
  assert.equal(f.c.readStateRevision, 1);
});

test("strict envelope rejects malformed guards and unsupported targets without effects", async (t) => {
  const f = fixture(t);
  for (const raw of [
    { unread: { version: 2, expected: codeReadSnapshot(f.c) } },
    { ...f.guard(), title: "side effect" },
    {
      unread: {
        version: 1,
        expected: { ...codeReadSnapshot(f.c), readStateRevision: NaN },
      },
    },
    {
      unread: {
        version: 1,
        expected: { ...codeReadSnapshot(f.c), extra: "history" },
      },
    },
  ])
    await assert.rejects(f.update(raw));
  for (const mutation of [
    { mode: "chat" },
    { cloudHosted: true },
    { cloudEnvironmentId: "remote" },
    { environment: { kind: "space", spaceId: "remote" } },
    { cwd: "" },
    {
      sessionAuthors: { ownerAccountUuid: "other", viewerAccountUuid: "owner" },
    },
  ]) {
    const original = structuredClone(f.c);
    Object.assign(f.c, mutation);
    await assert.rejects(f.update(f.guard()), /unavailable/);
    for (const key of Object.keys(f.c)) delete f.c[key];
    Object.assign(f.c, original);
  }
  f.context.accountRetiring = true;
  await assert.rejects(f.update(f.guard()), /unavailable/);
  delete f.context.accountRetiring;
  delete f.context.accountGeneration;
  await assert.rejects(f.update(f.guard()), /unavailable/);
  assert.equal(f.c.unread, true);
  assert.equal(f.events.length + f.read.length, 0);
});

test("new activity, replacement identity and account switches during save cannot acknowledge", async (t) => {
  for (const change of [
    (f: any) => {
      f.c.turns[0].status = "inProgress";
    },
    (f: any) => {
      f.c.updatedAt++;
    },
    (f: any) => {
      f.c.threadId = "new-thread";
    },
    (f: any) => {
      f.c.readStateRevision = 7;
      f.c.unread = true;
    },
    (f: any) => {
      f.store.conversations = [structuredClone(f.c)];
    },
    (f: any) => {
      f.context.accountGeneration = () => 2;
    },
    (f: any) => {
      f.context.accountRetiring = true;
    },
  ]) {
    const f = fixture(t),
      persist = f.store.persistChatMetadata.bind(f.store);
    f.store.persistChatMetadata = async (...args) => {
      await persist(...args);
      change(f);
    };
    await assert.rejects(f.update(f.guard()), /confirmed/);
    assert.equal(f.events.length + f.read.length, 0);
  }
});

test("mutated unknown save is never retried or reported as an already-read success", async (t) => {
  const f = fixture(t);
  let writes = 0;
  f.store.persistChatMetadata = async (c, patch) => {
    writes++;
    Object.assign(c, patch);
    throw Error("service outcome unknown");
  };
  await assert.rejects(f.update(f.guard()), /unknown/);
  await assert.rejects(f.update(f.guard()), /unknown/);
  assert.equal(writes, 1);
  assert.equal(f.events.length + f.read.length, 0);
});

test("a delayed save rejects intervening ordinary read and a concurrent guarded duplicate", async (t) => {
  const f = fixture(t),
    persist = f.store.persistChatMetadata.bind(f.store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.store.persistChatMetadata = async (...args) => {
    await gate;
    await persist(...args);
  };
  const first = f.update(f.guard());
  await assert.rejects(f.update(f.guard()), /pending/);
  f.update({ unread: false });
  const before = f.events.length,
    readBefore = f.read.length;
  release();
  await assert.rejects(first, /account changed/);
  assert.equal(f.events.length, before);
  assert.equal(f.read.length, readBefore);
  assert.equal(f.c.readStateRevision, 1);
});

test("malformed activity and missing/replaced rows fail closed", async (t) => {
  const f = fixture(t),
    raw = f.guard();
  f.c.turns = undefined;
  assert.throws(() => codeReadSnapshot(f.c), /snapshot is invalid/);
  assert.equal(sameCodeReadSnapshot(f.c, raw.unread.expected), false);
  await assert.rejects(f.update(raw), /changed/);
  f.c.turns = [];
  f.store.conversations.push({ ...f.c });
  await assert.rejects(f.update(f.guard()), /unavailable/);
  f.store.conversations = [];
  assert.throws(() => f.update(raw), /not found/);
});

for (const fails of [false, true])
  test(`real CloudStore ${fails ? "unknown failure" : "confirmed row"} is not mistaken for local completion`, async (t) => {
    const f = fixture(t),
      rows: any[] = [];
    let fail = fails;
    const cloud = new CloudStore({
      root: path.join(f.root, "cloud"),
      userId: 1,
      log() {},
      transport: {
        request: async (op, _user, body) => {
          if (op === "store.conversations.put") {
            rows.push(body);
            if (fail) throw Error("inert service unavailable");
          }
          return {};
        },
      },
    });
    t.after(async () => {
      fail = false;
      await cloud.close();
    });
    const c = structuredClone(f.c);
    cloud.conversations.push(c);
    f.context.store = cloud;
    const request = f.guard();
    if (fails) {
      await assert.rejects(f.update(request), /could not be confirmed/);
      const count = rows.length;
      await assert.rejects(
        f.update({ unread: { version: 1, expected: codeReadSnapshot(c) } }),
        /pending or unknown/,
      );
      assert.equal(rows.length, count);
      assert.equal(f.events.length + f.read.length, 0);
      assert.equal(
        c.unread,
        false,
        "Unknown remote outcome is not represented as a local rollback",
      );
    } else {
      await f.update(request);
      assert.equal(c.unread, false);
      assert.equal(c.readStateRevision, 1);
      assert.ok(
        rows.some(
          (row) =>
            row.doc.conversation.id === c.id &&
            row.doc.conversation.unread === false &&
            row.doc.conversation.readStateRevision === 1,
        ),
      );
      assert.equal(f.events.length, 1);
      assert.deepEqual(f.read, [c.id]);
    }
  });
