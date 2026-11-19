/** Actual Engine/branch/Store paths. Engine bootstrap and RPC are inert; no provider, SDK process or network.
 * Each simulated turn is marked completed locally before the next version operation. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import { normalizeCompletionQuotes } from "../../electron/official-ui/api/completion-quotes";
test("real Engine.send persists normalized quotes and dispatches full text through inert RPC", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "real-quote-engine-"));
  const store = new Store(root);
  t.after(() => {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  store.settings.providers = [
    {
      id: "p",
      name: "Inert",
      protocol: "responses",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      models: ["m"],
    },
  ];
  store.settings.activeProviderId = "p";
  const c: any = {
    id: "c",
    title: "Inert",
    mode: "chat",
    providerId: "p",
    model: "m",
    threadId: "thread",
    cwd: root,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
  };
  store.conversations.push(c);
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  engine.ensure = async () => {};
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  (engine as any).loaded.add("thread");
  (engine as any).routes.set("thread", "c");
  let expected: any;
  let turnCount = 0;
  const calls: any[] = [];
  engine.rpc = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/start" || method === "thread/fork")
        return { thread: { id: "thread-" + turnCount } };
      if (method !== "turn/start") {
        assert.ok(["thread/unsubscribe", "thread/resume"].includes(method));
        return {};
      }
      store.flush();
      const pending = new Store(root).conversation("c").turns.at(-1)!;
      assert.deepEqual(pending.completionQuotes, expected.quotes);
      assert.equal(pending.prompt, expected.text);
      return { turn: { id: "inert-turn-" + ++turnCount } };
    },
  } as any;
  const prepared = normalizeCompletionQuotes({
    text: "typed 🧠",
    quotes: [
      {
        passage: { case: "excerpt", value: { text: "😀 source" } },
        comment: "explain",
      },
    ],
  });
  expected = prepared;
  const result = await engine.send({
    conversationId: "c",
    text: prepared.text,
    completionQuotes: prepared.quotes,
    mode: "chat",
    attachments: [],
    providerId: "p",
    model: "m",
  });
  store.flush();
  const stored = new Store(root).conversation("c").turns.at(-1)!;
  assert.deepEqual(stored.completionQuotes, prepared.quotes);
  assert.equal(stored.prompt, prepared.text);
  assert.equal(result.turns.at(-1)!.id, "inert-turn-1");
  assert.equal(calls.filter((c) => c.method === "turn/start").length, 1);
  assert.equal(
    calls.find((c) => c.method === "turn/start").params.input[0].text,
    prepared.text,
  );
  c.turns.at(-1).status = "completed";
  await engine.retryResponse("c", c.turns.at(-1).id, "p", "m");
  store.flush();
  assert.deepEqual(
    new Store(root).conversation("c").turns.at(-1)!.completionQuotes,
    prepared.quotes,
  );
  c.turns.at(-1).status = "completed";
  expected = normalizeCompletionQuotes({
    text: "edited",
    quotes: [{ passage: { case: "excerpt", value: { text: "new source" } } }],
  });
  await engine.editPrompt("c", c.turns.at(-1).id, expected.text, "p", "m", {
    completionQuotes: expected.quotes,
  });
  store.flush();
  assert.deepEqual(
    new Store(root).conversation("c").turns.at(-1)!.completionQuotes,
    expected.quotes,
  );
  c.turns.at(-1).status = "completed";
  expected = { text: "plain edited", quotes: undefined };
  await engine.editPrompt("c", c.turns.at(-1).id, expected.text, "p", "m");
  store.flush();
  const reopened = new Store(root).conversation("c");
  assert.equal(reopened.turns.at(-1)!.completionQuotes, undefined);
  assert.ok(
    reopened.savedBranches?.some((b) =>
      b.turns.some((t) => t.completionQuotes?.length),
    ),
  );
  assert.equal(calls.filter((c) => c.method === "turn/start").length, 4);
});
