import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppContext, IpcHandle } from "../../electron/app/app-context";
import { Engine } from "../../electron/engine/engine";
import type { DynamicToolResult } from "../../electron/engine/engine-extensions";
import type { McpCallResult, McpTool } from "../../electron/browser/mcp-server";
import { loopbackPorts } from "../../runner/src/sandbox/sandbox-setup";
import { CodexRPC } from "../../electron/engine/rpc";
import { registerMemoryHandlers } from "../../electron/ipc/memory";
import { checkMs, firstCheckMs, soonMs } from "../../electron/memory/scheduler";
import {
  conversationSearchTool,
  memoryNamespace,
  recentChatsTool,
} from "../../electron/memory/tools";
import { memoryMessages } from "../../electron/memory/types";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import type { MemoryAPI } from "../../shared/memory-api";
import type { AppEvent } from "../../shared/types";
import { chat } from "../support/memory-fixtures";

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-memory-runtime-"),
  );
  const store = new Store(root);
  const events = new Set<(event: AppEvent) => void>();
  const push = (event: AppEvent) =>
    events.forEach((listener) => listener(event));
  const engine = new Engine(store, "unused", () => "", push);
  engine.policy = () => openPolicy;
  const account = {
    id: "fixture",
    name: "Fixture",
    email: "fixture@example.invalid",
  };
  const subscriptions = new Set<() => void | Promise<void>>();
  let retiring = false;
  const ctx: Pick<
    AppContext,
    | "store"
    | "engine"
    | "policy"
    | "services"
    | "activeAccount"
    | "accountActivationIdentity"
    | "accountRetiring"
    | "remote"
    | "noActive"
    | "push"
    | "onAccountActivated"
    | "onAccountDeactivating"
    | "onEvent"
  > = {
    store,
    engine,
    policy: () => engine.policy(),
    services: {},
    activeAccount: account,
    accountActivationIdentity: 1,
    get accountRetiring() {
      return retiring;
    },
    remote: undefined,
    noActive: () => engine.assertIdle(undefined),
    push,
    onAccountActivated(listener) {
      listener(account);
      return () => {};
    },
    onAccountDeactivating(listener) {
      subscriptions.add(listener);
      return () => subscriptions.delete(listener);
    },
    onEvent(listener) {
      events.add(listener);
      return () => events.delete(listener);
    },
  };
  const handlers = new Map<string, Parameters<IpcHandle>[1]>();
  registerMemoryHandlers(
    (name, handler) => handlers.set(name, handler),
    ctx as AppContext,
  );
  const deactivate = async () => {
    retiring = true;
    await Promise.all([...subscriptions].map((close) => close()));
  };
  t.after(async () => {
    await deactivate();
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const setPrefs: MemoryAPI["setMemoryPrefs"] = handlers.get("setMemoryPrefs")!;
  const status: MemoryAPI["memoryStatus"] = handlers.get("memoryStatus")!;
  const doc: MemoryAPI["memoryDoc"] = handlers.get("memoryDoc")!;
  const older = chat("older", "Research notebook", [
    ["Amber notebook", "It is on the desk."],
  ]);
  store.conversations.push(older);
  return { engine, store, setPrefs, status, doc, events, older, deactivate };
}

test(
  "the account switch adds and removes Chat search on the same engine thread",
  { timeout: 5000 },
  async (t) => {
    const { engine, store, setPrefs, deactivate } = setup(t);
    engine.ensure = async () => engine.extensions.prepareAppServer();
    engine.rpc = new CodexRPC();
    const threadId = "thread-1";
    const key = "mcp_servers.claudex_chat_history";
    await engine.extensions.prepareAppServer();
    const config = engine.extensions.appServerConfig();
    const baseUrl = config[`${key}.url`];
    assert.ok(typeof baseUrl === "string");
    assert.equal(config[`${key}.enabled`], false);
    assert.deepEqual(
      loopbackPorts(["-c", `${key}.url=${JSON.stringify(baseUrl)}`]),
      [Number(new URL(baseUrl).port)],
    );

    const loads: {
      method: string;
      config: Record<string, unknown>;
      threadId?: string;
    }[] = [];
    let turn = 0;
    t.mock.method(
      engine.rpc,
      "call",
      async (
        method: string,
        params: { config: Record<string, unknown>; threadId?: string },
      ) => {
        if (method === "thread/start" || method === "thread/resume") {
          loads.push({
            method,
            config: params.config,
            threadId: params.threadId,
          });
          return { thread: { id: threadId } };
        }
        if (method === "turn/start") return { turn: { id: `turn-${++turn}` } };
        return {};
      },
    );
    const request = {
      mode: "chat",
      text: "What did we say about the notebook?",
      cwd: store.root,
      attachments: [],
      providerId: store.settings.activeProviderId,
      model: "fixture-model",
    } satisfies Parameters<Engine["send"]>[0];
    store.settings.providers[0].model = request.model;
    store.settings.providers[0].models = [request.model];
    const finish = () =>
      engine.notification({
        method: "turn/completed",
        params: { threadId, turn: { id: `turn-${turn}`, status: "completed" } },
      });
    const original = await engine.send(request);
    assert.equal(loads[0].method, "thread/start");
    assert.equal(loads[0].config[`${key}.url`], undefined);
    finish();

    assert.deepEqual((await setPrefs({ searchChats: true })).prefs, {
      searchChats: true,
      generate: false,
    });
    const followup = { ...request, conversationId: original.id };
    assert.equal((await engine.send(followup)).threadId, threadId);
    const enabled = loads[1];
    assert.equal(enabled.method, "thread/resume");
    assert.equal(enabled.threadId, threadId);
    assert.equal(enabled.config[`${key}.enabled`], true);
    const url = enabled.config[`${key}.url`];
    const headers = enabled.config[`${key}.http_headers`];
    assert.ok(typeof url === "string" && new URL(url).origin === baseUrl);
    assert.ok(
      headers && typeof headers === "object" && "Authorization" in headers,
    );
    assert.ok(typeof headers.Authorization === "string");
    const authorization = headers.Authorization;
    let session: string | undefined;
    const post = (method: string, params?: object) =>
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "content-type": "application/json",
          ...(session ? { "Mcp-Session-Id": session } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
      });
    const initial = await post("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
    });
    assert.equal(initial.status, 200);
    session = initial.headers.get("Mcp-Session-Id") ?? undefined;
    assert.ok(session);
    const listed: { result: { tools: McpTool[] } } = await (
      await post("tools/list")
    ).json();
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      [conversationSearchTool, recentChatsTool],
    );
    const call = async (name: string, args: object): Promise<McpCallResult> => {
      const answer: { result: McpCallResult } = await (
        await post("tools/call", { name, arguments: args })
      ).json();
      return answer.result;
    };
    for (const [tool, args] of [
      [conversationSearchTool, { query: "amber" }],
      [recentChatsTool, { before: new Date(2_000).toISOString() }],
    ] as const) {
      const result = await call(tool, args);
      assert.equal(result.isError, false);
      const item = result.content[0];
      assert.ok(item?.type === "text");
      assert.match(item.text, /claudex:\/\/conversation\/older/);
      assert.match(item.text, /Amber notebook/);
      assert.ok(!item.text.includes(`id="${original.id}"`));
    }

    assert.deepEqual((await setPrefs({ searchChats: false })).prefs, {
      searchChats: false,
      generate: false,
    });
    const refused = await call(conversationSearchTool, { query: "amber" });
    assert.deepEqual(refused, {
      isError: true,
      content: [{ type: "text", text: memoryMessages.searchOff }],
    });
    const legacy = await new Promise<DynamicToolResult>((resolve) => {
      t.mock.method(
        engine.rpc!,
        "respond",
        (_id: number, result: DynamicToolResult) => resolve(result),
      );
      engine.request({
        id: 1,
        method: "item/tool/call",
        params: {
          threadId,
          turnId: `turn-${turn}`,
          callId: conversationSearchTool,
          namespace: memoryNamespace,
          tool: conversationSearchTool,
          arguments: { query: "amber" },
        },
      });
    });
    assert.deepEqual(legacy, {
      success: false,
      contentItems: [{ type: "inputText", text: memoryMessages.searchOff }],
    });

    finish();
    assert.equal((await engine.send(followup)).threadId, threadId);
    assert.equal(loads[2].method, "thread/resume");
    assert.equal(loads[2].threadId, threadId);
    assert.equal(loads[2].config[`${key}.url`], undefined);
    finish();

    await setPrefs({ searchChats: true });
    const provider = store.settings.providers[0];
    for (const [mode, extra] of [
      ["chat", { incognito: true }],
      ["chat", { memoryDisabled: true }],
      ["code", {}],
    ] as const) {
      const excluded = chat(mode, mode, [], {
        cwd: store.root,
        mode,
        ...extra,
      });
      const options = engine.threadOptions(
        excluded,
        provider,
        request.model,
        mode,
      );
      assert.equal(options.config[`${key}.url`], undefined);
    }
    engine.policy = () => ({
      ...openPolicy,
      memory: { ...openPolicy.memory!, searchChats: false },
    });
    assert.equal(
      engine.threadOptions(original, provider, request.model, "chat").config[
        `${key}.url`
      ],
      undefined,
    );
    assert.deepEqual(await call(conversationSearchTool, { query: "amber" }), {
      isError: true,
      content: [{ type: "text", text: memoryMessages.disabled }],
    });
    await deactivate();
    await assert.rejects(post("tools/list"), TypeError);
  },
);

test(
  "Classic pause cancels queued and active synthesis, and resuming starts fresh",
  { timeout: 5000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { engine, setPrefs, status, doc, events } = setup(t);
    let requests = 0;
    let answer!: (res: http.ServerResponse) => void;
    let answerFresh!: (res: http.ServerResponse) => void;
    const requested = new Promise<http.ServerResponse>((resolve) => {
      answer = resolve;
    });
    const freshRequested = new Promise<http.ServerResponse>((resolve) => {
      answerFresh = resolve;
    });
    const gateway = http
      .createServer((req, res) => {
        const received = ++requests;
        req.resume();
        req.once("end", () => (received === 1 ? answer : answerFresh)(res));
      })
      .listen(0, "127.0.0.1");
    t.after(() => {
      gateway.closeAllConnections();
      gateway.close();
    });
    await once(gateway, "listening");
    const address = gateway.address();
    assert.ok(address && typeof address === "object");
    engine.gatewayEndpoint = () => ({
      url: `http://127.0.0.1:${address.port}/v1`,
      token: "fixture",
    });
    const scope = { kind: "global" } as const;
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

    await setPrefs({ searchChats: true });
    t.mock.timers.tick(firstCheckMs);
    await flush();
    assert.equal(requests, 0);
    assert.equal((await status()).prefs.generate, false);

    await setPrefs({ generate: true });
    await setPrefs({ generate: false }, { disableOnly: true });
    t.mock.timers.tick(soonMs);
    await flush();
    assert.equal(requests, 0);
    assert.equal(await doc(scope), null);

    await setPrefs({ generate: true });
    t.mock.timers.tick(soonMs);
    const res = await requested;
    assert.equal((await status()).synthesizing, true);
    assert.equal(requests, 1);
    const settled = () =>
      new Promise<void>((resolve) => {
        const listener = (event: AppEvent) => {
          if (event.type !== "memory-changed") return;
          void status({ snapshotOnly: true }).then((value) => {
            if (!value.synthesizing) {
              events.delete(listener);
              resolve();
            }
          });
        };
        events.add(listener);
      });
    const respond = (response: http.ServerResponse, text: string) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            output: [
              {
                content: [
                  { type: "output_text", text: `## Work context\n${text}` },
                ],
              },
            ],
          },
        })}\n\n`,
      );
    };
    const stopped = settled();
    await setPrefs({ generate: false }, { disableOnly: true });
    await setPrefs({ generate: true });
    respond(res, "Uses a stale amber notebook.");
    await stopped;
    await flush();
    assert.equal(await doc(scope), null);
    assert.deepEqual((await status()).prefs, {
      searchChats: true,
      generate: true,
    });

    t.mock.timers.tick(soonMs);
    const fresh = await freshRequested;
    assert.equal(requests, 2);
    const completed = settled();
    respond(fresh, "Uses a current notebook.");
    await completed;
    assert.match((await doc(scope))?.content ?? "", /Uses a current notebook/);
    await setPrefs({ generate: false }, { disableOnly: true });
    t.mock.timers.tick(checkMs);
    await flush();
    assert.equal(requests, 2);
  },
);
