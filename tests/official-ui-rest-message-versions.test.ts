/** Actual original producer pieces + request serializer -> REST -> real IPC/engine methods.
 * The terminal engine.send boundary is an explicit synthetic branch commit, never SDK/network. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { Store } from "../electron/store/store";
import { retryResponse, editPrompt } from "../electron/engine/engine-send";
import { beginReplyBranch } from "../shared/branches";
import { registerConversationTurnHandlers } from "../electron/ipc/conversation-turn-handlers";
import { createNativeRestCompletionRoute } from "../electron/official-ui/api/native-rest-completion";
import { createRestCompletionRoute } from "../electron/official-ui/api/rest-completion";
import { organizationUuid } from "../electron/official-ui/api/context";
import {
  conversationRestMessages,
  userMessageId,
  assistantMessageId,
} from "../electron/official-ui/api/conversations";
import {
  newAdapterScope,
  inAdapterScope,
} from "../electron/official-ui/api/scope";
import { completionPath } from "../shared/official-completion-stream";
const assets = "build/official-ui/ui/assets/v1/";
const cache = new Map<string, ts.SourceFile>();
function select(file: string, predicate: (n: ts.Node) => boolean) {
  let ast = cache.get(file);
  if (!ast) {
    ast = ts.createSourceFile(
      file,
      fs.readFileSync(assets + file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    cache.set(file, ast);
  }
  const found: ts.Node[] = [];
  function visit(n: ts.Node) {
    if (predicate(n)) found.push(n);
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.equal(found.length, 1, file);
  return found[0].getText(ast);
}
function wire(
  kind: "retry" | "edit",
  human: string,
  assistant: string,
  text = "2+2",
  c2 = false,
) {
  const object = select(
    kind === "retry" ? "shared-4-Kt-jV-IU.js" : "shared-160-BGt89-ku.js",
    (n) =>
      ts.isObjectLiteralExpression(n) &&
      n.getText().includes(kind === "retry" ? "isRetry: !0" : "isEdit: !0") &&
      n.properties.some((p) => p.name?.getText() === "prompt") &&
      n.properties.some((p) => p.name?.getText() === "parent_message_uuid"),
  );
  const state: any = {
    c: human,
    n: undefined,
    r: "model",
    i: "model",
    a: false,
    o: undefined,
    l: assistant,
    h: null,
    t: text,
    e: {
      parent_message_uuid: "00000000-0000-4000-8000-000000000000",
      attachments: [],
      sync_sources: [],
      metadata: {},
    },
    s: undefined,
    f: undefined,
    dT: () => [],
    kg: () => ({}),
  };
  if (kind === "edit") {
    state.l = "original";
    state.r = "model";
  }
  const produced = vm.runInNewContext("(" + object + ")", state);
  const yc = select(
    "shared-1-B16QIYNI.js",
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "YC",
  );
  const serializer = vm.runInNewContext("(" + yc + ")", {
    Ro: () => false,
    FB: () => "",
    eP: ["en-US"],
    T1: "en-US",
  });
  const serialized = serializer({
    ...produced,
    model: "model",
    timezone: "Etc/UTC",
    locale: "en-US",
    effort: "low",
    thinkingMode: "auto",
    tools: [],
    turnMessageUuids:
      kind === "retry"
        ? produced.turnMessageUuids
        : { humanMessageUuid: randomUUID(), assistantMessageUuid: assistant },
  });
  const ve = select(
    "shared-0-BgsOqC85.js",
    (n) =>
      ts.isVariableDeclaration(n) &&
      n.name.getText() === "Ve" &&
      !!n.initializer?.getText().includes('rendering_mode: "messages"'),
  );
  const expression = ve.slice(ve.indexOf("=") + 1);
  const body = vm.runInNewContext("(" + expression + ")", {
    y: serialized,
    i: {
      organization_uuid: "inert",
      conversation_uuid: "inert",
      text: produced.prompt,
      attachments: produced.attachments,
      files: produced.files,
      sync_sources: produced.syncSources,
    },
    V: randomUUID(),
    E: undefined,
    Fe: false,
  });
  const vk = select(
    "shared-0-BgsOqC85.js",
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "VK",
  );
  const endpoint = vm
    .runInNewContext("(" + vk + ")", {
      M9: {
        APPEND_MESSAGE_WITH_COMPLETION: 1,
        RETRY_MESSAGE_WITH_COMPLETION: 2,
      },
      Ml: () => (c2 ? "c2" : "c1"),
      rd() {},
      MN: () => false,
      _$() {},
      ph: (e: any) => e,
      oi: () => ({}),
    })(kind === "retry" ? 2 : 1, "org", "conv")
    .url.split("/")
    .at(-1);
  return { body: JSON.parse(JSON.stringify(body)), endpoint };
}
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rest-versions-"));
  t.after(async () => {
    await new Promise((r) => setTimeout(r, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new Store(root),
    id = randomUUID(),
    identity = {},
    calls: any[] = [],
    handlers = new Map<string, Function>();
  let scope = newAdapterScope("owner", root, identity);
  const initial: any = {
    id,
    mode: "chat",
    title: "Synthetic",
    providerId: "p",
    model: "model",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "original-turn",
        prompt: "1+1",
        attachments: [],
        items: [{ id: "answer", type: "agentMessage", text: "2" }],
        status: "completed",
        createdAt: 1,
      },
    ],
  };
  store.conversations.push(initial);
  store.flush();
  let current = true,
    fail = false,
    count = 0;
  const engine: any = {
    store,
    elsewhereFor: () => undefined,
    modelEfforts: () => ["low"],
    send: async (input: any, target: string, edit: boolean, lease: any) => {
      calls.push({ input, target, edit });
      assert.ok(lease.current());
      if (fail) throw Error("PRIVATE failure");
      const c = store.conversation(id),
        old = c.turns.find((t) => t.id === target)!;
      const group = beginReplyBranch(
        c,
        target,
        "synthetic-thread-" + ++count,
        "branch-" + count,
      );
      c.turns.push({
        id: "version-" + count,
        prompt: input.text,
        attachments: input.attachments,
        status: "completed",
        createdAt: count + 1,
        items: [
          {
            id: "answer-" + count,
            type: "agentMessage",
            text: "synthetic result",
          },
        ],
        responseGroupId: group,
        ...(edit
          ? { promptVersionId: "edited-" + count }
          : { promptVersionId: old.promptVersionId }),
      } as any);
      store.flush();
      return structuredClone(c);
    },
  };
  engine.retryResponse = (...args: any[]) =>
    retryResponse.apply(engine, args as any);
  engine.editPrompt = (...args: any[]) => editPrompt.apply(engine, args as any);
  const ipc: any = {
    store,
    engine,
    activeAccount: { id: "owner" },
    accountActivationIdentity: identity,
    accountRetiring: false,
    selectedAttachments: new Map(),
  };
  registerConversationTurnHandlers({
    context: ipc,
    handle: (name: string, fn: Function) => handlers.set(name, fn),
    cli: {},
    resumable: {},
  } as any);
  const ctx: any = {
    account: () => ({ id: "owner" }),
    sessionIdentity: () => identity,
    isCurrent: () => current,
    stateDirectory: () => root,
    settings: () => ({
      providers: [{ id: "p", model: "model" }],
      activeProviderId: "p",
    }),
    modelCatalog: async () => ({ items: [{ id: "model", efforts: ["low"] }] }),
    onEvent: () => () => {},
    loadConversation: async () => structuredClone(store.conversation(id)),
    call: async (name: string, ...args: any[]) => {
      assert.ok(
        ["retryResponse", "editPrompt", "interrupt"].includes(name),
        "No plain-send fallback",
      );
      return handlers.get(name)!(...args);
    },
  };
  let route = createRestCompletionRoute(ctx);
  const base = `/api/organizations/${organizationUuid("owner")}/chat_conversations/${id}`;
  const run = async (endpoint: string, body: any, method = "POST") =>
    inAdapterScope(scope, async () => {
      const req: any = Object.assign(
        Readable.from(
          body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
        ),
        { method, headers: { "content-type": "application/json" } },
      );
      let status = 0,
        result = "";
      const res: any = {
        writeHead: (s: number) => {
          status = s;
        },
        end: (s: string) => {
          result = s;
        },
      };
      assert.equal(
        await route(
          req,
          res,
          new URL(base + "/" + endpoint, "http://localhost").pathname,
          new URL(base + "/" + endpoint, "http://localhost"),
        ),
        true,
      );
      return { status, data: JSON.parse(result) };
    });
  return {
    store,
    root,
    id,
    ctx,
    calls,
    base,
    run,
    scope,
    fail: () => {
      fail = true;
    },
    retire: () => {
      current = false;
    },
    restart: () => {
      scope = newAdapterScope("owner", root, identity);
      route = createRestCompletionRoute(ctx);
    },
    human: () =>
      inAdapterScope(scope, () =>
        userMessageId(store.conversation(id).turns[0]),
      ),
    assistant: () =>
      inAdapterScope(scope, () =>
        assistantMessageId(store.conversation(id).turns.at(-1)!),
      ),
  };
}
test("original retry producer + YC + final Ve + VK, both endpoints, real IPC/engine preserve original human and old branch", async (t) => {
  for (const c2 of [false, true]) {
    const f = fixture(t),
      human = f.human(),
      assistant = randomUUID(),
      p = wire("retry", human, assistant, "", c2);
    assert.equal(p.endpoint, c2 ? "retry_completion2" : "retry_completion");
    assert.ok(completionPath.test(f.base + "/" + p.endpoint));
    assert.equal(p.body.prompt, "");
    assert.deepEqual(p.body.turn_message_uuids, {
      assistant_message_uuid: assistant,
    });
    const answer = await f.run(p.endpoint, p.body);
    assert.equal(answer.status, 200, JSON.stringify(answer));
    await new Promise((r) => setImmediate(r));
    const read = await f.run(
      `claudex_completion/${answer.data.operation_id}?cursor=0`,
      undefined,
      "GET",
    );
    assert.equal(read.data.events[0].data.message.parent_uuid, human);
    assert.equal(read.data.events[0].data.message.uuid, assistant);
    assert.equal(read.data.events.at(-1).event, "message_stop");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].edit, false);
    assert.equal(f.calls[0].input.effort, "low");
    assert.equal(f.calls[0].input.text, "1+1");
    assert.equal(f.human(), human);
    const reopened = new Store(f.root).conversation(f.id);
    assert.equal(reopened.savedBranches?.length, 1);
    assert.equal(reopened.turns.length, 1);
    await f.run(c2 ? "retry_completion" : "retry_completion2", p.body);
    assert.equal(f.calls.length, 1);
    f.restart();
    assert.equal((await f.run(p.endpoint, p.body)).status, 409);
    assert.equal(f.calls.length, 1);
  }
});
test("original first-message edit root sentinel dispatches editPrompt, never append; history retains old prompt", async (t) => {
  const f = fixture(t),
    p = wire("edit", f.human(), randomUUID(), "2+2");
  assert.equal(
    p.body.parent_message_uuid,
    "00000000-0000-4000-8000-000000000000",
  );
  const answer = await f.run(p.endpoint, p.body);
  assert.equal(answer.status, 200, JSON.stringify(answer));
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].edit, true);
  assert.equal(f.calls[0].input.text, "2+2");
  const c = new Store(f.root).conversation(f.id);
  assert.equal(c.turns.length, 1);
  assert.equal(c.turns[0].prompt, "2+2");
  assert.equal(c.savedBranches![0].turns[0].prompt, "1+1");
  const history = inAdapterScope(f.scope, () => conversationRestMessages(c));
  assert.equal(
    history.messages.filter((m: any) => m.sender === "human").length,
    2,
  );
  await f.run(p.endpoint, p.body);
  assert.equal(f.calls.length, 1);
});
test("readonly, invalid/foreign parents, tools, mode changes and opaque-body replacements fail before any model dispatch", async (t) => {
  for (const variant of [
    "readonly",
    "unknown",
    "assistant",
    "tools",
    "thinking",
    "attachment",
  ]) {
    const f = fixture(t),
      p = wire("retry", f.human(), randomUUID());
    if (variant === "readonly") f.ctx.readOnly = true;
    if (variant === "unknown") p.body.parent_message_uuid = "foreign";
    if (variant === "assistant") p.body.parent_message_uuid = f.assistant();
    if (variant === "tools") p.body.tools = [{ name: "unapproved" }];
    if (variant === "thinking") p.body.thinking_mode = "standard";
    if (variant === "attachment") p.body.files = ["unowned"];
    assert.notEqual((await f.run(p.endpoint, p.body)).status, 200, variant);
    assert.equal(f.calls.length, 0, variant);
    if (variant === "readonly")
      assert.equal(
        fs
          .readdirSync(f.root)
          .some((name) => name.startsWith("official-rest-completion-receipts")),
        false,
      );
  }
});
test("terminal dispatch failure and same request with different semantics never redispatch; retirement refuses", async (t) => {
  const f = fixture(t),
    p = wire("retry", f.human(), randomUUID());
  f.fail();
  const first = await f.run(p.endpoint, p.body);
  await new Promise((r) => setImmediate(r));
  const read = await f.run(
    `claudex_completion/${first.data.operation_id}?cursor=0`,
    undefined,
    "GET",
  );
  assert.equal(read.data.events.at(-1).event, "error");
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE/);
  await f.run(p.endpoint, p.body);
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await f.run(p.endpoint, { ...p.body, effort: undefined })).status,
    409,
  );
  assert.equal(f.calls.length, 1);
  const g = fixture(t);
  g.retire();
  assert.notEqual((await g.run(p.endpoint, p.body)).status, 200);
  assert.equal(g.calls.length, 0);
});
test("both retry HTTP aliases and root edit emit real native SSE terminal using the same owned operation", async (t) => {
  for (const [kind, c2] of [
    ["retry", false],
    ["retry", true],
    ["edit", false],
  ] as const) {
    const f = fixture(t),
      p = wire(kind, f.human(), randomUUID(), "2+2", c2);
    const route = createNativeRestCompletionRoute(f.ctx, {
      pollMs: 5,
      deadlineMs: 1000,
    });
    class Response extends Writable {
      status = 0;
      headers: any;
      chunks: Buffer[] = [];
      writeHead(status: number, headers: any) {
        this.status = status;
        this.headers = headers;
        return this;
      }
      _write(chunk: Buffer, _encoding: any, done: () => void) {
        this.chunks.push(Buffer.from(chunk));
        done();
      }
    }
    const req: any = Object.assign(
        Readable.from([Buffer.from(JSON.stringify(p.body))]),
        { method: "POST", headers: { "content-type": "application/json" } },
      ),
      res = new Response();
    const done = new Promise<void>((resolve, reject) => {
      res.on("finish", resolve);
      res.on("error", reject);
    });
    await inAdapterScope(f.scope, () =>
      route(
        req,
        res as any,
        f.base + "/" + p.endpoint,
        new URL(f.base + "/" + p.endpoint, "http://localhost"),
      ),
    );
    await done;
    const text = Buffer.concat(res.chunks).toString("utf8");
    assert.equal(res.status, 200, text);
    assert.match(
      res.headers["Content-Type"] ?? res.headers["content-type"],
      /text\/event-stream/,
    );
    assert.match(text, /event: message_start/);
    assert.match(text, /event: content_block_delta/);
    assert.match(text, /event: message_stop/);
    assert.doesNotMatch(text, /event: error/);
    assert.equal(f.calls.length, 1);
  }
});
test("root edit in readonly host and a busy source refuse without any dispatch", async (t) => {
  const f = fixture(t),
    p = wire("edit", f.human(), randomUUID(), "2+2");
  f.ctx.readOnly = true;
  assert.equal((await f.run(p.endpoint, p.body)).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal(
    fs
      .readdirSync(f.root)
      .some((name) => name.startsWith("official-rest-completion-receipts")),
    false,
  );
  const g = fixture(t);
  g.store.conversation(g.id).turns[0].status = "inProgress";
  const retry = wire("retry", g.human(), randomUUID());
  assert.equal((await g.run(retry.endpoint, retry.body)).status, 409);
  assert.equal(g.calls.length, 0);
});
test("same explicit standard and omitted thinking retain the source; explicit adaptive cannot replace saved standard/extended", async (t) => {
  for (const mode of ["standard", undefined] as const) {
    const f = fixture(t);
    f.store.conversation(f.id).thinkingMode = "standard";
    const p = wire("retry", f.human(), randomUUID());
    if (mode) p.body.thinking_mode = mode;
    else delete p.body.thinking_mode;
    assert.equal((await f.run(p.endpoint, p.body)).status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.length, 1);
    assert.equal(new Store(f.root).conversation(f.id).thinkingMode, "standard");
  }
  for (const mode of ["standard", "extended"] as const) {
    const f = fixture(t);
    f.store.conversation(f.id).thinkingMode = mode;
    const p = wire("retry", f.human(), randomUUID());
    p.body.thinking_mode = "auto";
    assert.equal((await f.run(p.endpoint, p.body)).status, 501);
    assert.equal(f.calls.length, 0);
  }
});
test("empty retry attachment declaration preserves the original attachment through the real IPC and engine retry method", async (t) => {
  const f = fixture(t),
    attachment = {
      id: "synthetic-original-file",
      name: "inert.txt",
      path: "/inert-not-read/inert.txt",
      kind: "text" as const,
      size: 1,
    };
  f.store.conversation(f.id).turns[0].attachments = [attachment];
  const p = wire("retry", f.human(), randomUUID());
  assert.deepEqual(p.body.attachments, []);
  assert.deepEqual(p.body.files, []);
  assert.equal((await f.run(p.endpoint, p.body)).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls[0].input.attachments, [attachment]);
  assert.deepEqual(new Store(f.root).conversation(f.id).turns[0].attachments, [
    attachment,
  ]);
});
