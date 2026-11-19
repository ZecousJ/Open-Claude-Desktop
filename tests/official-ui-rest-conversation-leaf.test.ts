import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { Readable } from "node:stream";
import { Store } from "../electron/store/store";
import { Engine } from "../electron/engine/engine";
import { registerConversationHandlers } from "../electron/ipc/conversations";
import { restConversationLeafRoute } from "../electron/official-ui/api/rest-conversation-leaf";
import { organizationUuid } from "../electron/official-ui/api/context";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
import {
  conversationAliases,
  conversationRestMessages,
} from "../electron/official-ui/api/conversations";
const assets =
  ".restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1";
function producer(org: string, conversation: string, target: string) {
  const source = fs.readFileSync(
    path.join(assets, "shared-m-1-Nm0kn4Ee.js"),
    "utf8",
  );
  const other = fs.readFileSync(
    path.join(assets, "shared-m-w-0-Dp3k4Hda.js"),
    "utf8",
  );
  const scope: any = {
    Dy: "new-assistant-message-uuid",
    u9: "new-human-message-uuid",
    J9: () => [],
    J1: () => true,
    J2: () => true,
    K1: (_s: any, _i: any, _a: any, v: any) => v,
    K2: (_s: any, _i: any, _a: any, _b: any, v: any) => v,
    nv: () => ({ activeOrganization: { uuid: org } }),
    GC: (x: string) => x,
    HP: (url: string, method: string, options: any) => ({
      url,
      method,
      body: options.transformVariables({ current_leaf_message_uuid: target }),
    }),
  };
  vm.runInNewContext(
    other.slice(
      other.indexOf("function Me(e) {"),
      other.indexOf("function eG(", other.indexOf("function Me(e) {")),
    ) +
      source.slice(
        source.indexOf("  eN = {") + 2,
        source.indexOf("var R1 =", source.indexOf("  eN = {")),
      ) +
      ";this.run=rI;",
    scope,
  );
  return scope.run(conversation);
}
function setup(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leaf-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const turn = (id: string, group = "reply") => ({
    id,
    prompt: "Self-authored",
    responseGroupId: group,
    promptGroupId: "prompt",
    items: [],
    attachments: [],
    status: "completed",
    createdAt: 1,
  });
  const c: any = {
    id: "chat-owned",
    mode: "chat",
    title: "Synthetic",
    providerId: "p",
    model: "model",
    createdAt: 1,
    updatedAt: 1,
    turns: [turn("a")],
    savedBranches: [
      {
        id: "retry",
        providerId: "p2",
        model: "other",
        visited: 1,
        turns: [turn("b")],
      },
      {
        id: "edit",
        providerId: "p",
        model: "model",
        visited: 2,
        turns: [turn("d", "edited")],
      },
    ],
  };
  store.conversations.push(c);
  store.flush();
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.ensure = async () => {
    throw Error("Model process forbidden");
  };
  engine.send = (async () => {
    throw Error("Send forbidden");
  }) as any;
  let owner = "owner",
    identity: any = {},
    alive = true,
    loads = 0;
  const handlers = new Map<string, any>();
  registerConversationHandlers((name, fn) => handlers.set(name, fn), {
    get accountActivationIdentity() { return identity; },
    get accountRetiring() { return !alive; },
    get activeAccount() { return { id: owner }; },
    store,
    engine,
    replyFeedback: {} as any,
    selectedAttachments: new Map(),
    allowedFolder() {},
    noActive() {},
  });
  const mutations: string[] = [];
  const ctx: any = {
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    isCurrent: () => alive,
    localCall: (...args: any[]) => ctx.call(...args),
    loadConversation: async (id: string) => {
      loads++;
      return structuredClone(store.conversations.find((c) => c.id === id));
    },
    call: async (name: string, ...args: any[]) => {
      assert.equal(name, "selectChatLeaf");
      mutations.push(name);
      return handlers.get(name)(...args);
    },
  };
  const route = async (body: any, options: any = {}) => {
    const req: any = Readable.from([JSON.stringify(body)]);
    req.method = options.method ?? "PUT";
    req.headers = {};
    let status = 0,
      data: any;
    const res: any = {
      writeHead(s: number) {
        status = s;
      },
      end(v: string) {
        data = JSON.parse(v);
      },
    };
    const url =
      options.url ??
      `/api/organizations/${organizationUuid("owner")}/chat_conversations/chat-owned/current_leaf_message_uuid`;
    const handled = await restConversationLeafRoute(req, res, url, ctx);
    return { handled, status, data };
  };
  return {
    root,
    store,
    c,
    ctx,
    mutations,
    route,
    retire() {
      alive = false;
    },
    aba() {
      identity = {};
    },
    foreign() {
      owner = "other";
    },
    loads: () => loads,
  };
}

test("original rI/eN/Me PUT → registered IPC → real Engine/Store restores reply and prompt branches, no generation", async (t) => {
  const x = setup(t);
  await inAdapterScope(newAdapterScope("owner"), async () => {
    for (const [target, model] of [
      ["b", "other"],
      ["a", "model"],
      ["d", "model"],
      ["a", "model"],
    ]) {
      const original = producer(
        organizationUuid("owner"),
        "chat-owned",
        `new-assistant-message-uuid-${target}:assistant`,
      );
      assert.equal(original.method, "PUT");
      const result = await x.route(original.body, {
        url: original.url,
        method: original.method,
      });
      assert.equal(result.status, 200, JSON.stringify({ target, result }));
      assert.equal(result.data.uuid, "chat-owned");
      assert.equal(
        result.data.current_leaf_message_uuid,
        `${target}:assistant`,
      );
      assert.equal(typeof result.data.updated_at, "string");
      const reopened = new Store(x.root).conversation("chat-owned");
      assert.equal(reopened.turns[0].id, target);
      assert.equal(reopened.model, model);
      assert.ok(
        conversationRestMessages(reopened).messages.some(
          (m: any) => m.uuid === `${target}:assistant`,
        ),
      );
    }
    const before = fs.readFileSync(path.join(x.root, "conversations.json"));
    assert.equal(
      (await x.route({ current_leaf_message_uuid: "a:assistant" })).status,
      200,
    );
    assert.deepEqual(fs.readFileSync(path.join(x.root, "conversations.json")), before);
    conversationAliases.set("page-alias", "chat-owned");
    assert.equal(
      (
        await x.route(
          { current_leaf_message_uuid: "b:assistant" },
          {
            url: `/api/organizations/${organizationUuid("owner")}/chat_conversations/page-alias/current_leaf_message_uuid`,
          },
        )
      ).status,
      200,
    );
  });
});

test("unknown, human, stale, foreign, malformed, readonly and retired activations never select a branch", async (t) => {
  const x = setup(t);
  await inAdapterScope(newAdapterScope("owner"), async () => {
    for (const target of [
      "missing",
      "a:user",
      "foreign:assistant",
      "00000000-0000-4000-8000-000000000000",
    ])
      assert.equal(
        (await x.route({ current_leaf_message_uuid: target })).status,
        409,
      );
    x.c.savedBranches = x.c.savedBranches.filter((b: any) => b.id !== "retry");
    assert.equal(
      (await x.route({ current_leaf_message_uuid: "b:assistant" })).status,
      409,
    );
    for (const body of [
      {},
      { current_leaf_message_uuid: null },
      { current_leaf_message_uuid: "d:assistant", extra: true },
    ])
      assert.equal((await x.route(body)).status, 400);
    assert.equal(
      (
        await x.route(
          { current_leaf_message_uuid: "d:assistant" },
          {
            url: `/api/organizations/${organizationUuid("other")}/chat_conversations/chat-owned/current_leaf_message_uuid`,
          },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await x.route(
          { current_leaf_message_uuid: "d:assistant" },
          {
            url: `/api/organizations/${organizationUuid("owner")}/chat_conversations/foreign/current_leaf_message_uuid`,
          },
        )
      ).status,
      404,
    );
    x.ctx.readOnly = true;
    assert.equal(
      (await x.route({ current_leaf_message_uuid: "d:assistant" })).status,
      403,
    );
    x.ctx.readOnly = false;
    x.c.sessionAuthors = { ownerAccountUuid: "owner", viewerAccountUuid: "other" };
    assert.equal((await x.route({ current_leaf_message_uuid: "d:assistant" })).status, 404);
    delete x.c.sessionAuthors;
    const load = x.ctx.loadConversation;
    x.ctx.loadConversation = async (id: string) => {
      const result = await load(id);
      x.aba();
      return result;
    };
    assert.equal(
      (await x.route({ current_leaf_message_uuid: "d:assistant" })).status,
      409,
    );
    x.ctx.loadConversation = load;
    x.retire();
    assert.equal(
      (await x.route({ current_leaf_message_uuid: "d:assistant" })).status,
      409,
    );
    assert.deepEqual(x.mutations, []);
    assert.equal(x.c.turns[0].id, "a");
  });
});

test("pending turn and failed/uncertain service results are visible, never retried or replaced by latest", async (t) => {
  const x = setup(t);
  await inAdapterScope(newAdapterScope("owner"), async () => {
    x.c.turns[0].status = "inProgress";
    assert.equal(
      (await x.route({ current_leaf_message_uuid: "b:assistant" })).status,
      409,
    );
    assert.equal(x.c.turns[0].id, "a");
    x.c.turns[0].status = "completed";
    let calls = 0;
    x.ctx.call = async () => {
      calls++;
      throw Error("Inert unavailable");
    };
    assert.equal(
      (await x.route({ current_leaf_message_uuid: "b:assistant" })).status,
      409,
    );
    assert.equal(calls, 1);
    x.ctx.call = async () => {
      calls++;
    };
    assert.equal(
      (await x.route({ current_leaf_message_uuid: "b:assistant" })).status,
      409,
    );
    assert.equal(calls, 2);
    assert.equal(x.c.turns[0].id, "a");
  });
});

test("an exact older continuation is restored, while ambiguous and interior messages are refused", async (t) => {
  const x = setup(t);
  await inAdapterScope(newAdapterScope("owner"), async () => {
    x.c.savedBranches.push({
      ...structuredClone(x.c.savedBranches[0]),
      id: "duplicate",
      visited: 99,
    });
    assert.equal(
      (await x.route({ current_leaf_message_uuid: "b:assistant" })).status,
      409,
    );
    assert.deepEqual(x.mutations, []);
    x.c.savedBranches.pop();
    assert.equal(
      (await x.route({ current_leaf_message_uuid: "b:assistant" })).status,
      200,
    );
    assert.equal(
      (await x.route({ current_leaf_message_uuid: "d:assistant" })).status,
      200,
    );
    assert.equal(
      (await x.route({ current_leaf_message_uuid: "a:assistant" })).status,
      200,
    );
    assert.equal(new Store(x.root).conversation(x.c.id).turns.at(-1)?.id, "a");
    x.c.turns.push({ ...structuredClone(x.c.turns[0]), id: "continued" });
    const count = x.mutations.length;
    assert.equal(
      (await x.route({ current_leaf_message_uuid: "a:assistant" })).status,
      409,
    );
    assert.equal(x.mutations.length, count);
  });
});

test("a rejected local save leaves the original version and file intact", async (t) => {
  const x = setup(t);
  const old = fs.readFileSync(path.join(x.root, "conversations.json"));
  x.store.write = () => { throw Error("Synthetic local save rejection"); };
  await inAdapterScope(newAdapterScope("owner"), async () => {
    assert.equal((await x.route({ current_leaf_message_uuid: "b:assistant" })).status, 409);
    assert.equal(x.c.turns.at(-1)?.id, "a");
    assert.deepEqual(fs.readFileSync(path.join(x.root, "conversations.json")), old);
  });
});

test("account retirement after a committed selection reports uncertain result and does not replay", async (t) => {
  const x = setup(t);
  await inAdapterScope(newAdapterScope("owner"), async () => {
    const original = x.ctx.call;
    x.ctx.call = async (...args: any[]) => {
      const result = await original(...args);
      x.foreign();
      return result;
    };
    assert.equal(
      (await x.route({ current_leaf_message_uuid: "b:assistant" })).status,
      409,
    );
    assert.equal(x.mutations.length, 1);
    assert.equal(new Store(x.root).conversation("chat-owned").turns[0].id, "b");
  });
});
