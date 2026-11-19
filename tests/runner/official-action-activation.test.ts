/** Actual adapter/protobuf/local temp receipts; all dispatches are inert mocks. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toBinary } from "@bufbuild/protobuf";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import {
  registryFor,
  deepCreate,
} from "../../electron/official-ui/api/timeline";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { officialUiActionPath } from "../../shared/official-ui-web";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { builtInAttachmentBytes } from "../../shared/client-policy";
const id = "11111111-1111-4111-8111-111111111111";
function fixture(t: any, initial: unknown = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "action-activation-"));
  t.after(async () => {
    t.mock.restoreAll();
    // Adapter state uses a 500 ms coalescing timer; do not delete its fixture
    // destination while a real pending save is still queued.
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let identity: unknown = initial,
    owner = "a",
    currentRoot = root;
  let sends = 0,
    calls = 0;
  const stored: { name: string; size: number }[] = [];
  let snapshot: () => Promise<any> = async () => ({
    conversations: [],
    projects: [],
  });
  let send: () => Promise<any> = async () => ({ id, mode: "chat", turns: [] });
  const host: any = {
    account: () => ({
      id: owner,
      email: "fixture@example.invalid",
      name: "Fixture",
    }),
    settings: () => ({
      providers: [
        { id: "p", backend: "sub2api", protocol: "responses", model: "m" },
      ],
    }),
    sessionIdentity: () => identity,
    stateDirectory: () => currentRoot,
    onEvent: () => () => {},
    appVersion: "test",
    log() {},
  };
  const adapter = createRunnerOfficialAdapter(
    host,
    async (method, args) => {
      calls++;
      if (method === "snapshot") return snapshot();
      if (method === "send") {
        sends++;
        return send();
      }
      if (method === "addAttachmentData") {
        const [name, bytes] = args;
        assert.ok(typeof name === "string");
        assert.ok(bytes instanceof Uint8Array);
        const attachmentId = "fixture-" + (stored.length + 1);
        const directory = path.join(root, "attachments", attachmentId);
        fs.mkdirSync(directory, { recursive: true });
        const filename = path.join(directory, name);
        fs.writeFileSync(filename, bytes);
        stored.push({ name, size: bytes.byteLength });
        return {
          id: attachmentId,
          name,
          path: filename,
          size: bytes.byteLength,
          kind: "text",
        };
      }
      throw Error(`Unexpected ${method}`);
    },
    path.resolve("build/official-ui"),
    { modes: ["chat"] },
    { allowTextActions: true },
  );
  const schema = registryFor(path.resolve("build/official-ui")).getMessage(
    "anthropic.bard.api.v1alpha.PerformActionRequest",
  )!;
  const requestFor = (
    version = 1n,
    { conversationId = id, text = "Inert fixture", isTemporary = false } = {},
  ) => ({
    method: "POST" as const,
    path: officialUiActionPath,
    contentType: "application/proto",
    body: Buffer.from(
      toBinary(
        schema,
        deepCreate(schema, {
          header: {
            conversationId,
            mutationId: { sessionId: "fixture-session", version },
          },
          action: {
            case: "sendMessage",
            value: {
              messageId: `22222222-2222-4222-8222-${version.toString(16).padStart(12, "0")}`,
              assistantMessageId: `33333333-3333-4333-8333-${version.toString(16).padStart(12, "0")}`,
              text,
              isTemporary,
            },
          },
        }),
      ),
    ),
  });
  return {
    root,
    host,
    adapter,
    stored,
    run: (...args: Parameters<typeof requestFor>) => adapter(requestFor(...args)),
    retire: () => (identity = {}),
    identity: (v: unknown) => (identity = v),
    snapshot: (fn: typeof snapshot) => (snapshot = fn),
    send: (fn: typeof send) => (send = fn),
    switchRoot: (value: string) => (currentRoot = value),
    switchOwner: (value: string) => (owner = value),
    get sends() {
      return sends;
    },
    get calls() {
      return calls;
    },
  };
}

test("original Web protobuf carries two exact-limit text files and rejects an oversized file or count", async (t) => {
  const f = fixture(t);
  const schema = registryFor(path.resolve("build/official-ui")).getMessage(
    "anthropic.bard.api.v1alpha.PerformActionRequest",
  )!;
  const fetch = createOfficialReadFetch(
    "https://fixture.invalid",
    async () => assert.fail("Unexpected read"),
    async () => assert.fail("Unexpected network"),
    undefined,
    f.adapter,
  );
  const file = (index: number, extractedContent: string) => ({
    fileName: `fixture-${index}.txt`,
    fileType: "text/plain",
    fileSize: BigInt(Buffer.byteLength(extractedContent)),
    extractedContent,
  });
  const submit = (
    version: bigint,
    inlineAttachments: ReturnType<typeof file>[],
  ) =>
    fetch(officialUiActionPath, {
      method: "POST",
      headers: { "content-type": "application/proto" },
      body: Buffer.from(
        toBinary(
          schema,
          deepCreate(schema, {
            header: {
              conversationId: id,
              mutationId: { sessionId: "fixture-session", version },
            },
            action: {
              case: "sendMessage",
              value: {
                messageId: "22222222-2222-4222-8222-222222222222",
                assistantMessageId: "33333333-3333-4333-8333-333333333333",
                text: "Inert file-size probe",
                inlineAttachments,
              },
            },
          }),
        ),
      ),
    });
  const exact = "a".repeat(builtInAttachmentBytes.text);
  assert.equal((await submit(1n, [file(1, exact + "a")])).status, 400);
  assert.equal(
    (
      await submit(
        2n,
        Array.from({ length: 13 }, (_, index) => file(index, "x")),
      )
    ).status,
    400,
  );
  assert.equal(f.sends, 0);
  assert.deepEqual(f.stored, []);
  assert.equal(
    (await submit(3n, [file(1, exact), file(2, "b" + exact.slice(1))])).status,
    200,
  );
  assert.equal(f.sends, 1);
  assert.deepEqual(
    f.stored,
    [1, 2].map((index) => ({
      name: `fixture-${index}.txt.extracted.txt`,
      size: builtInAttachmentBytes.text,
    })),
  );
});
function receipts(root: string) {
  const dir = path.join(root, "official-ui-action-receipts");
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((n) => n.endsWith(".json"))
        .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")))
    : [];
}
test("missing/null/empty activation cannot reserve or dispatch; ordinary account reads remain available", async (t) => {
  for (const value of [undefined, null, ""]) {
    const f = fixture(t);
    f.identity(value);
    assert.equal((await f.run()).status, 409);
    assert.equal(f.calls, 0);
    assert.deepEqual(receipts(f.root), []);
    assert.equal(
      (await f.adapter({ method: "GET", path: "/api/account" })).status,
      200,
    );
  }
});
test("activation retirement during durable reservation leaves pending, never dispatches under new activation", async (t) => {
  const f = fixture(t),
    original = fs.fsyncSync;
  let retired = false;
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    original(fd);
    if (!retired) {
      retired = true;
      f.retire();
    }
  });
  assert.equal((await f.run()).status, 409);
  assert.equal(f.calls, 0);
  assert.equal(f.sends, 0);
  assert.equal(receipts(f.root)[0].phase, "pending");
  assert.equal((await f.run()).status, 409);
  assert.equal(f.sends, 0);
});
test("retirement after snapshot cannot dispatch send or finish its pending receipt", async (t) => {
  const f = fixture(t);
  let resolve!: (v: any) => void, started!: () => void;
  const entered = new Promise<void>((r) => (started = r));
  f.snapshot(() => {
    started();
    return new Promise((r) => (resolve = r));
  });
  const result = f.run();
  await entered;
  f.retire();
  resolve({ conversations: [], projects: [] });
  assert.equal((await result).status, 409);
  assert.equal(f.sends, 0);
  assert.equal(receipts(f.root)[0].phase, "pending");
});
test("retired in-flight send and its duplicate disclose no old answer and cannot replay", async (t) => {
  const f = fixture(t);
  let resolve!: (v: any) => void, started!: () => void;
  const entered = new Promise<void>((r) => (started = r));
  f.send(() => {
    started();
    return new Promise((r) => (resolve = r));
  });
  const first = f.run();
  await entered;
  const duplicate = f.run();
  f.retire();
  resolve({ id, mode: "chat", turns: [] });
  assert.equal((await first).status, 409);
  assert.equal((await duplicate).status, 409);
  assert.equal(f.sends, 1);
  assert.equal(receipts(f.root)[0].phase, "pending");
  assert.equal((await f.run()).status, 409);
  assert.equal(f.sends, 1);
});
test("valid activation retains deduplicated done reads and root changes do not reuse memory results", async (t) => {
  const f = fixture(t);
  assert.equal((await f.run()).status, 200);
  assert.equal((await f.run()).status, 200);
  assert.equal(f.sends, 1);
  f.retire();
  assert.equal((await f.run()).status, 200);
  assert.equal(f.sends, 1);
  const other = path.join(f.root, "other-account");
  fs.mkdirSync(other);
  f.switchOwner("b");
  f.switchRoot(other);
  assert.equal((await f.run()).status, 200);
  assert.equal(f.sends, 2);
});
test("settled original Web actions do not consume the allowance for new actions", async (t) => {
  const f = fixture(t);
  const first = await f.run();
  assert.equal(first.status, 200);
  for (let version = 2n; version <= 256n; version++) {
    assert.equal((await f.run(version)).status, 200, `action ${version}`);
  }

  let release!: (value: { id: string; mode: string; turns: [] }) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => (started = resolve));
  f.send(() => {
    started();
    return new Promise((resolve) => (release = resolve));
  });
  const next = f.run(257n);
  await Promise.race([
    entered,
    next.then((answer) => {
      assert.fail(`action 257 returned ${answer.status} without dispatching`);
    }),
  ]);
  const duplicate = f.run(257n);
  assert.equal((await f.run(257n, { text: "Different payload" })).status, 409);
  release({ id, mode: "chat", turns: [] });
  const [answer, repeated] = await Promise.all([next, duplicate]);
  assert.equal(answer.status, 200);
  assert.deepEqual(repeated, answer);
  assert.deepEqual(await f.run(), first);
  assert.equal((await f.run(1n, { text: "Different payload" })).status, 409);
  assert.equal(f.sends, 257);
});
test("opaque objects, generation zero and nonempty tokens remain legal activation identities", async (t) => {
  for (const identity of [{}, 0, "trusted-activation"]) {
    const f = fixture(t, identity);
    assert.equal((await f.run()).status, 200);
    assert.equal(f.sends, 1);
    assert.equal((await f.run()).status, 200);
    assert.equal(f.sends, 1);
  }
});
test("new owner cannot finish or overwrite prior owner's pending receipt after in-flight retirement", async (t) => {
  const f = fixture(t);
  let resolve!: (v: any) => void, started!: () => void;
  const entered = new Promise<void>((r) => (started = r));
  f.send(() => {
    started();
    return new Promise((r) => (resolve = r));
  });
  const old = f.run();
  await entered;
  const other = path.join(f.root, "new-owner");
  fs.mkdirSync(other);
  f.switchOwner("b");
  f.switchRoot(other);
  f.retire();
  assert.deepEqual(receipts(other), []);
  let releaseNew!: typeof resolve, startNew!: () => void;
  const newEntered = new Promise<void>((r) => (startNew = r));
  f.send(() => {
    startNew();
    return new Promise((r) => (releaseNew = r));
  });
  const current = f.run();
  await Promise.race([
    newEntered,
    current.then((result) => assert.fail(`New owner got ${result.status} without dispatching`)),
  ]);
  resolve({ id, mode: "chat", turns: [] });
  assert.equal((await old).status, 409);
  assert.equal(receipts(f.root)[0].phase, "pending");
  assert.equal(receipts(other)[0].phase, "pending");
  const duplicate = f.run();
  releaseNew({ id, mode: "chat", turns: [] });
  const answer = await current;
  assert.equal(answer.status, 200);
  assert.deepEqual(await duplicate, answer);
  assert.equal(f.sends, 2);
  assert.equal(receipts(other)[0].phase, "done");
  assert.equal(receipts(f.root)[0].phase, "pending");
});

test("retry after a failed receipt finish reports an unknown outcome without sending again", async (t) => {
  const f = fixture(t);
  const mocked = t.mock.method(fs, "renameSync", () => {
    throw Error("inert-old-activation-error");
  });
  await assert.rejects(() => f.run(), /inert-old-activation-error/);
  mocked.mock.restore();
  assert.equal(f.sends, 1);
  assert.equal(receipts(f.root)[0].phase, "pending");
  const answer = await f.run();
  assert.equal(answer.status, 409);
  assert.match(
    Buffer.from(answer.body).toString(),
    /may have completed/,
  );
  assert.equal(f.sends, 1);
  assert.equal(receipts(f.root)[0].phase, "pending");
});
test("retirement in a synchronous finish failure returns bounded 409 and leaves old pending untouched", async (t) => {
  const f = fixture(t);
  t.mock.method(fs, "renameSync", () => {
    f.retire();
    throw Error("inert-retired-finish-error");
  });
  const answer = await f.run();
  assert.equal(answer.status, 409);
  assert.doesNotMatch(
    Buffer.from(answer.body).toString(),
    /inert-retired-finish-error/,
  );
  assert.equal(f.sends, 1);
  assert.equal(receipts(f.root)[0].phase, "pending");
});

test("root-only retirement during snapshot forbids send while concurrent ordinary account reads stay independent", async (t) => {
  const f = fixture(t);
  let resolve!: (v: any) => void, started!: () => void;
  const entered = new Promise<void>((r) => (started = r));
  const snapshotResult = new Promise<any>((r) => (resolve = r));
  f.snapshot(() => {
    started();
    return snapshotResult;
  });
  const old = f.run();
  await entered;
  const other = path.join(f.root, "rotated-root");
  fs.mkdirSync(other);
  f.switchRoot(other);
  assert.equal(
    (await f.adapter({ method: "GET", path: "/api/account" })).status,
    200,
  );
  const ordinary = f.adapter({
    method: "GET",
    path: `/api/organizations/${organizationUuid("a")}/chat_conversations_v2`,
  });
  resolve({ conversations: [], projects: [] });
  assert.equal((await ordinary).status, 200);
  assert.equal((await old).status, 409);
  assert.equal(f.sends, 0);
  assert.equal(receipts(f.root)[0].phase, "pending");
  assert.deepEqual(receipts(other), []);
});

test("temporary original Web receipts stay in memory and their limit does not block durable actions", async (t) => {
  const f = fixture(t);
  const privateOptions = { isTemporary: true };
  const first = await f.run(1n, privateOptions);
  assert.equal(first.status, 200);
  for (let version = 2n; version <= 256n; version++) {
    assert.equal((await f.run(version, privateOptions)).status, 200);
  }
  assert.deepEqual(await f.run(1n, privateOptions), first);
  assert.equal((await f.run(257n, privateOptions)).status, 429);
  assert.equal(f.sends, 256);
  assert.deepEqual(receipts(f.root), []);
  const durableOptions = { conversationId: "44444444-4444-4444-8444-444444444444" };
  assert.equal((await f.run(1n, durableOptions)).status, 409);
  assert.equal((await f.run(257n, durableOptions)).status, 200);
  assert.equal((await f.run(257n, privateOptions)).status, 409);
  assert.equal(f.sends, 257);
  assert.deepEqual(receipts(f.root).map(receipt => receipt.phase), ["done"]);
});
