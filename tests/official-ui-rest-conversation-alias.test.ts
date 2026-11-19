import { syntheticWindowsReceiptCleanup } from "./support/windows-receipt-cleanup";
/** Actual REST/native routes, strict service IDs and temporary durable state. No network/model. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { createRestCompletionRoute } from "../electron/official-ui/api/rest-completion";
import { createNativeRestCompletionRoute } from "../electron/official-ui/api/native-rest-completion";
import { reserveRestCompletion } from "../electron/official-ui/api/rest-completion-receipts";
import {
  conversationAliases,
  conversationRow,
  loadConversationState,
} from "../electron/official-ui/api/conversations";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
import { organizationUuid } from "../electron/official-ui/api/context";
const real = "11111111-1111-4111-8111-111111111111",
  page = "55555555-5555-4555-8555-555555555555";
const human = "22222222-2222-4222-8222-222222222222",
  assistant = "33333333-3333-4333-8333-333333333333",
  requestId = "44444444-4444-4444-8444-444444444444";
const input = () => ({
  prompt: "synthetic follow-up",
  model: "model",
  tools: [],
  attachments: [],
  files: [],
  sync_sources: [],
  rendering_mode: "messages",
  parent_message_uuid: "seed:assistant",
  turn_message_uuids: {
    human_message_uuid: human,
    assistant_message_uuid: assistant,
  },
  completion_request_id: requestId,
});
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rest-alias-review-"));
  const initialOwner = process.platform === "win32" ? `alias-test-${randomUUID()}` : "owner";
  const cleanupReceipts = syntheticWindowsReceiptCleanup(root,[initialOwner]);
  t.after(async () => {
    await new Promise((r) => setTimeout(r, 550));
    cleanupReceipts();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let owner = initialOwner,
    identity = {},
    scope = newAdapterScope(owner, root, identity),
    done = false,
    remap = false;
  let nextRead: (() => void) | undefined;
  const calls: any[] = [],
    reads: string[] = [];
  const c: any = {
    id: real,
    mode: "chat",
    title: "synthetic",
    model: "model",
    providerId: "p",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "seed",
        prompt: "seed",
        createdAt: 1,
        status: "completed",
        attachments: [],
        items: [
          { id: "seed-answer", type: "agentMessage", text: "seed answer" },
        ],
      },
    ],
  };
  const ctx: any = {
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    isCurrent: () => true,
    settings: () => ({
      activeProviderId: "p",
      providers: [{ id: "p", model: "model" }],
    }),
    modelCatalog: async () => {
      if (remap)
        conversationAliases.restore(
          page,
          "99999999-9999-4999-8999-999999999999",
        );
      return { items: [{ id: "model", efforts: [] }] };
    },
    snapshot: async () => ({ projects: [], conversations: [structuredClone(c)] }),
    loadConversation: async (id: string) => {
      reads.push(id);
      const hook = nextRead;
      nextRead = undefined;
      hook?.();
      return id === real ? structuredClone(c) : undefined;
    },
    call: async (method: string, ...args: any[]) => {
      calls.push([method, ...args]);
      if (method === "interrupt") return { status: "accepted" };
      assert.equal(method, "send");
      assert.equal(args[0].conversationId, real);
      assert.equal(args[0].newConversationId, undefined);
      c.turns.push({
        id: "next-" + calls.length,
        prompt: args[0].text,
        createdAt: 2,
        status: done ? "completed" : "inProgress",
        attachments: [],
        items: [
          { id: "next-answer", type: "agentMessage", text: "synthetic answer" },
        ],
      });
      return structuredClone(c);
    },
    onEvent: () => () => {},
    log() {},
  };
  let route = createRestCompletionRoute(ctx);
  const base = (id = page) =>
    `/api/organizations/${organizationUuid(owner)}/chat_conversations/${id}`;
  const runScope = <T>(work: () => T) => inAdapterScope(scope, work);
  const restore = () => {
    scope = newAdapterScope(owner, root, identity);
    runScope(loadConversationState);
    route = createRestCompletionRoute(ctx);
  };
  runScope(() => conversationAliases.set(page, real));
  restore();
  return {
    root,
    ctx,
    c,
    calls,
    reads,
    base,
    runScope,
    restore,
    complete: () => {
      c.turns.at(-1).status = "completed";
    },
    onNextRead: (hook: () => void) => {
      nextRead = hook;
    },
    autoComplete: () => {
      done = true;
    },
    remapDuringCatalog: () => {
      remap = true;
    },
    switchAccount: () => {
      owner = "other";
      identity = {};
      scope = newAdapterScope(owner, root, identity);
    },
    async listId() {
      return runScope(() => conversationRow(c).uuid);
    },
    async run(method: string, suffix: string, body?: unknown, id = page) {
      const p = base(id) + suffix;
      let status = 0,
        text = "";
      const req: any = Readable.from(
        body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
      );
      req.method = method;
      req.headers = { "content-type": "application/json" };
      const res: any = {
        writeHead: (s: number) => (status = s),
        end: (v = "") => (text = String(v)),
      };
      await runScope(() =>
        route(
          req,
          res,
          new URL(p, "http://synthetic.invalid").pathname,
          new URL(p, "http://synthetic.invalid"),
        ),
      );
      return { status, data: text ? JSON.parse(text) : null };
    },
    async native(body: unknown) {
      const route = createNativeRestCompletionRoute(ctx, {
          pollMs: 1,
          deadlineMs: 2000,
        }),
        p = base() + "/completion";
      let status = 0;
      const chunks: Buffer[] = [];
      const req: any = Readable.from([Buffer.from(JSON.stringify(body))]);
      req.method = "POST";
      req.headers = { "content-type": "application/json" };
      const res: any = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      res.writeHead = (s: number) => {
        status = s;
        return res;
      };
      res.flushHeaders = () => {};
      await runScope(() =>
        route(
          req,
          res,
          new URL(p, "http://synthetic.invalid").pathname,
          new URL(p, "http://synthetic.invalid"),
        ),
      );
      return { status, text: Buffer.concat(chunks).toString() };
    },
  };
}
test("restored list alias supports REST follow-up, duplicate, poll and tuple-bound Stop through both IDs", async (t) => {
  const f = fixture(t);
  assert.equal(await f.listId(), page);
  const sent = await f.run("POST", "/completion", input());
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(f.calls.length, 1);
  const op = sent.data.operation_id;
  const replay = await f.run("POST", "/completion", input(), real);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.operation_id, op);
  assert.equal(f.calls.length, 1);
  for (const id of [page, real]) {
    const poll = await f.run(
      "GET",
      `/claudex_completion/${op}?cursor=0`,
      undefined,
      id,
    );
    assert.equal(poll.status, 200);
    assert.equal(poll.data.done, false);
    assert.equal(
      (
        await f.run(
          "POST",
          "/stop_response",
          { completion_request_id: requestId },
          id,
        )
      ).status,
      204,
    );
  }
  assert.ok(
    f.calls.filter(([m]) => m === "interrupt").every(([, id]) => id === real),
  );
  assert.ok(f.reads.every((id) => id === real));
  assert.equal(
    (
      await f.run(
        "GET",
        `/claudex_completion/${op}?cursor=0`,
        undefined,
        "99999999-9999-4999-8999-999999999999",
      )
    ).status,
    409,
  );
  f.complete();
  const end = await f.run("GET", `/claudex_completion/${op}?cursor=0`);
  assert.equal(end.data.done, true);
  assert.equal(end.data.events.at(-1).event, "message_stop");
  f.restore();
  for (const id of [page, real]) {
    const replay = await f.run(
      "POST",
      "/completion",
      { ...input(), completion_request_id: undefined },
      id,
    );
    assert.equal(replay.status, 409);
    assert.equal(replay.data.error.type, "completion_outcome_unknown");
  }
  assert.equal(f.calls.filter(([m]) => m === "send").length, 1);
});
test("native SSE follows restored list alias without losing the saved conversation", async (t) => {
  const f = fixture(t);
  f.autoComplete();
  const response = await f.native(input());
  assert.equal(response.status, 200, response.text);
  assert.match(response.text, /event: message_stop/);
  assert.doesNotMatch(response.text, /event: error/);
  assert.equal(f.calls.filter(([m]) => m === "send").length, 1);
  assert.equal(f.c.turns.length, 2);
});
const canonical = (value: any): any =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
test("legacy receipts under either conversation ID block redispatch even without the old request ID", async (t) => {
  for (const oldId of [page, real]) {
    const f = fixture(t),
      { completion_request_id, ...semantic } = input();
    reserveRestCompletion(f.ctx, {
      conversationId: oldId,
      humanId: human,
      assistantId: assistant,
      payloadHash: createHash("sha256")
        .update(JSON.stringify(canonical(semantic)))
        .digest("hex"),
    });
    f.restore();
    for (const id of [page, real]) {
      const answer = await f.run("POST", "/completion", semantic, id);
      assert.equal(answer.status, 409);
      assert.equal(answer.data.error.type, "completion_outcome_unknown");
    }
    assert.equal(f.calls.length, 0);
  }
});
test("concurrent aliases share preparation guard and alias retargeting cannot redirect dispatch", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([
    f.run("POST", "/completion", input()),
    f.run("POST", "/completion", input(), real),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 1);
  assert.equal(f.calls.length, 1);
  const g = fixture(t);
  g.remapDuringCatalog();
  assert.equal((await g.run("POST", "/completion", input())).status, 409);
  assert.equal(g.calls.length, 0);
});
test("poll and Stop cannot follow a retargeted alias or another account into an old operation", async (t) => {
  const f = fixture(t),
    sent = await f.run("POST", "/completion", input());
  assert.equal(sent.status, 200);
  const op = sent.data.operation_id;
  f.runScope(() =>
    conversationAliases.restore(page, "99999999-9999-4999-8999-999999999999"),
  );
  assert.equal(
    (await f.run("GET", `/claudex_completion/${op}?cursor=0`)).status,
    409,
  );
  assert.equal(
    (
      await f.run("POST", "/stop_response", {
        completion_request_id: requestId,
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.run("GET", `/claudex_completion/${op}?cursor=0`, undefined, real))
      .status,
    200,
  );
  f.switchAccount();
  assert.equal(
    (await f.run("GET", `/claudex_completion/${op}?cursor=0`, undefined, real))
      .status,
    409,
  );
  assert.equal(
    (
      await f.run(
        "POST",
        "/stop_response",
        { completion_request_id: requestId },
        real,
      )
    ).status,
    409,
  );
  assert.equal(f.calls.length, 1);
});

test("alias change while Stop awaits history rejects before interrupting any turn", async (t) => {
  const f = fixture(t);
  assert.equal((await f.run("POST", "/completion", input())).status, 200);
  f.onNextRead(() =>
    f.runScope(() =>
      conversationAliases.restore(page, "99999999-9999-4999-8999-999999999999"),
    ),
  );
  assert.equal(
    (
      await f.run("POST", "/stop_response", {
        completion_request_id: requestId,
      })
    ).status,
    409,
  );
  assert.equal(f.calls.filter(([method]) => method === "interrupt").length, 0);
});

test("legacy receipt remains non-dispatchable after actual alias eviction and state reload", async (t) => {
  const f = fixture(t),
    { completion_request_id, ...semantic } = input();
  const old = reserveRestCompletion(f.ctx, {
    conversationId: page,
    humanId: human,
    assistantId: assistant,
    payloadHash: createHash("sha256")
      .update(JSON.stringify(canonical(semantic)))
      .digest("hex"),
  });
  const first = await f.run("POST", "/completion", semantic, real);
  assert.equal(first.status, 409);
  assert.equal(f.calls.length, 0);
  f.runScope(() => {
    for (let i = 0; i < 5000; i++) {
      const suffix = i.toString(16).padStart(12, "0");
      conversationAliases.set(
        `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
        `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
      );
    }
  });
  f.restore();
  assert.equal(
    f.runScope(() => conversationAliases.has(page)),
    false,
  );
  const replay = await f.run("POST", "/completion", semantic, real);
  assert.equal(replay.status, 409);
  assert.equal(replay.data.error.type, "completion_outcome_unknown");
  assert.equal(f.calls.length, 0);
  const canonicalReceipt = reserveRestCompletion(f.ctx, {
    conversationId: real,
    humanId: human,
    assistantId: assistant,
    payloadHash: createHash("sha256")
      .update(JSON.stringify(canonical(semantic)))
      .digest("hex"),
  });
  assert.equal(canonicalReceipt.fresh, false);
  assert.equal(canonicalReceipt.operationId, old.operationId);
});
