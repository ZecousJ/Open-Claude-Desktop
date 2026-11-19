import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/store/store";
import { CloudStore } from "../runner/src/cloud-store";
import { registerConversationManageHandlers } from "../electron/ipc/conversation-manage-handlers";
import { codeThinkingPreferenceSnapshot } from "../shared/code-thinking-preferences";

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f094-thinking-"));
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
    turns: [
      {
        id: "turn",
        createdAt: 2,
        status: "inProgress",
        items: [],
        prompt: "private",
      },
    ],
  };
  store.conversations.push(c);
  store.flush();
  const events: any[] = [];
  const context: any = {
    store,
    engine: {},
    accountGeneration: () => 1,
    activeAccount: { id: "owner" },
    push: (e: any) => events.push(e),
  };
  const handlers = new Map<string, Function>();
  registerConversationManageHandlers({
    context,
    engineOf: () => undefined,
    handle: (name, fn) => handlers.set(name, fn),
  });
  const update = async (raw: any) =>
    handlers.get("updateConversation")!(c.id, raw);
  const guard = (wanted = false) => ({
    thinkingSummariesWanted: {
      version: 1,
      wanted,
      expected: codeThinkingPreferenceSnapshot(c),
    },
  });
  return { store, c, context, root, events, update, guard };
}

test("guarded and legacy thinking saves persist exact session preference without changing history or defaults", async (t) => {
  const f = fixture(t),
    turns = JSON.stringify(f.c.turns),
    settings = JSON.stringify(f.store.settings);
  const old = f.guard();
  assert.equal((await f.update(old)).thinkingSummariesWanted, false);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(f.root, "conversations.json"), "utf8"),
    )[0].thinkingSummariesWanted,
    false,
  );
  await assert.rejects(f.update(old), /changed/);
  await f.update(f.guard());
  assert.equal(f.events.length, 1);
  await f.update({ thinkingSummariesWanted: true });
  assert.equal(f.c.thinkingSummariesWanted, true);
  assert.equal(JSON.stringify(f.c.turns), turns);
  assert.equal(JSON.stringify(f.store.settings), settings);
});

test("disk failure leaves memory and disk unchanged and allows deliberate retry", async (t) => {
  const f = fixture(t),
    before = JSON.stringify(f.c),
    write = f.store.write.bind(f.store);
  f.store.write = () => {
    throw Error("disk full");
  };
  await assert.rejects(f.update(f.guard()), /disk full/);
  await assert.rejects(
    f.update({ thinkingSummariesWanted: true }),
    /disk full/,
  );
  assert.equal(JSON.stringify(f.c), before);
  assert.equal(f.events.length, 0);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(f.root, "conversations.json"), "utf8"),
    )[0].thinkingSummariesWanted,
    undefined,
  );
  f.store.write = write;
  await f.update(f.guard());
});

test("pending save rejects concurrent guarded and legacy requests; unknown acknowledgement never rolls back or accepts repeat", async (t) => {
  const f = fixture(t);
  let reject!: (e: Error) => void;
  f.store.persistChatMetadata = async (c, patch, current) => {
    assert.equal(current(), true);
    Object.assign(c, patch);
    await new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
  };
  const saving = f.update(f.guard());
  await assert.rejects(f.update(f.guard()), /pending or unknown/);
  await assert.rejects(
    f.update({ thinkingSummariesWanted: true }),
    /pending or unknown/,
  );
  reject(Error("ack unknown"));
  await assert.rejects(saving, /ack unknown/);
  assert.equal(f.c.thinkingSummariesWanted, false);
  await assert.rejects(f.update(f.guard()), /pending or unknown/);
  assert.equal(f.events.length, 0);
});

for (const change of [
  (f: any) => {
    f.context.accountGeneration = () => 2;
  },
  (f: any) => {
    f.context.activeAccount = { id: "other" };
  },
  (f: any) => {
    f.context.accountRetiring = true;
  },
  (f: any) => {
    f.context.store = new Store(f.root);
  },
  (f: any) => {
    f.store.conversations = [];
  },
])
  test("account or session retirement during pending save rejects acknowledgement", async (t) => {
    const f = fixture(t);
    let finish!: () => void;
    f.store.persistChatMetadata = async (c, patch, current) => {
      assert.equal(current(), true);
      Object.assign(c, patch);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    const saving = f.update(f.guard());
    change(f);
    finish();
    await assert.rejects(saving, /could not be confirmed/);
    assert.equal(f.events.length, 0);
  });

test("strict envelope rejects every malformed shape and stale expected value", async (t) => {
  const f = fixture(t),
    good = f.guard(),
    inner = good.thinkingSummariesWanted;
  const invalid = [
    { ...good, title: "side effect" },
    ...[
      { ...inner, version: 2 },
      { ...inner, wanted: null },
      { ...inner, wanted: "false" },
      { ...inner, extra: 1 },
      { wanted: false, expected: inner.expected },
      { version: 1, expected: inner.expected },
      { version: 1, wanted: false },
      ...[
        {},
        null,
        { ...inner.expected, id: "other" },
        { ...inner.expected, createdAt: 2 },
        { ...inner.expected, createdAt: NaN },
        { ...inner.expected, createdAt: -1 },
        { ...inner.expected, id: "" },
        { ...inner.expected, thinkingSummariesWanted: true },
        { ...inner.expected, thinkingSummariesWanted: "false" },
        { ...inner.expected, extra: 1 },
      ].map((expected) => ({ ...inner, expected })),
    ].map((thinkingSummariesWanted) => ({ thinkingSummariesWanted })),
    { thinkingSummariesWanted: null },
    { thinkingSummariesWanted: [] },
    { thinkingSummariesWanted: "true" },
    { thinkingSummariesWanted: false, title: "mixed" },
  ];
  for (const raw of invalid) await assert.rejects(f.update(raw));
  assert.equal(f.c.thinkingSummariesWanted, undefined);
  assert.equal(f.events.length, 0);
});

for (const patch of [
  { mode: "chat" },
  { incognito: true },
  { cloudHosted: true },
  { cloudEnvironmentId: "env" },
  { environment: { kind: "ssh", host: "host" } },
  { cwd: " " },
  { sessionAuthors: { viewerAccountUuid: "owner", ownerAccountUuid: "other" } },
])
  test("guarded thinking update rejects unsupported or unowned session", async (t) => {
    const f = fixture(t);
    Object.assign(f.c, patch);
    await assert.rejects(f.update(f.guard()), /unavailable/);
    assert.equal(f.events.length, 0);
  });

test("missing generation, duplicate identity, unknown owner and invalid persisted preference fail closed", async (t) => {
  const f = fixture(t);
  f.context.accountGeneration = undefined;
  await assert.rejects(f.update(f.guard()), /unavailable/);
  f.context.accountGeneration = () => 1;
  f.store.conversations.push({ ...f.c });
  await assert.rejects(f.update(f.guard()), /unavailable/);
  f.store.conversations.pop();
  f.c.sessionAuthors = {
    ownerAccountUuid: "owner",
    viewerAccountUuid: "owner",
  };
  f.context.activeAccount = undefined;
  await assert.rejects(f.update(f.guard()), /unavailable/);
  f.c.thinkingSummariesWanted = "false";
  assert.throws(() => codeThinkingPreferenceSnapshot(f.c));
});

for (const fails of [false, true])
  test(`real CloudStore ${fails ? "unknown acknowledgement" : "confirmed row"} waits for durability`, async (t) => {
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
    if (fails) {
      await assert.rejects(f.update(f.guard()), /could not be confirmed/);
      const count = rows.length;
      await assert.rejects(
        f.update({
          thinkingSummariesWanted: {
            version: 1,
            wanted: false,
            expected: codeThinkingPreferenceSnapshot(c),
          },
        }),
        /pending or unknown/,
      );
      assert.equal(rows.length, count);
      assert.equal(c.thinkingSummariesWanted, false);
      assert.equal(f.events.length, 0);
    } else {
      const saved = await f.update(f.guard());
      assert.equal(saved.thinkingSummariesWanted, false);
      assert.ok(rows.length > 0);
      assert.equal(f.events.length, 1);
    }
  });

test("pending save rejects same-account retirement before mutation and remains unknown after the lease returns", async (t) => {
  const f = fixture(t),
    persist = f.store.persistChatMetadata.bind(f.store);
  let finish!: () => void;
  f.store.persistChatMetadata = async (...args) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return persist(...args);
  };
  const saving = f.update(f.guard());
  f.context.accountRetiring = true;
  finish();
  await assert.rejects(saving, /account changed/);
  f.context.accountRetiring = false;
  await assert.rejects(f.update(f.guard()), /pending or unknown/);
  assert.equal(f.c.thinkingSummariesWanted, undefined);
  assert.equal(f.events.length, 0);
});
