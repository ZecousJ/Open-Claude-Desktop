import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendDraft } from "../../src/app/composer-send";
import {
  editSkillTokens,
  insertSkillToken,
} from "../../src/composer/skill-tokens";
import {
  clearQueued,
  queuedMessages,
  removeQueued,
} from "../../src/composer/queue";
import {
  conversationChanged,
  sendQueued,
  sendQueuedNow,
} from "../../src/composer/queue";
import type { AppController } from "../../src/app/AppContext";
import type { Conversation } from "../../shared/types";
import { openPolicy } from "../../shared/client-policy";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";

let next = 0;
function controller(active?: Conversation) {
  const inserted = insertSkillToken("Review this", [], "review", 0)!;
  const errors: unknown[] = [];
  const app = {
    ...inserted,
    accountId: "skill-owner",
    controllerScope: {},
    draftSession: "draft",
    attachments: [],
    sending: false,
    running: Boolean(active),
    active,
    activeId: active?.id,
    model: "m",
    providerId: "default",
    mode: "chat",
    effort: "high",
    snapshot: { settings: {} },
    policy: openPolicy,
    draftWebSearch: false,
    incognitoShown: Boolean(active?.incognito),
    selectNext: { current: false },
    follow: { current: false },
    navigation: { replaceNext() {} },
    composer: { current: { focus() {}, blur() {} } },
    latest: { current: { conversations: active ? [active] : [] } },
    setSending(value: boolean) {
      this.sending = value;
    },
    setError() {},
    setAttachments() {},
    upsert() {},
    setActiveId() {},
    setPage() {},
    notify() {},
    setText(value: string) {
      this.skillTokens = editSkillTokens(this.text, value, this.skillTokens);
      this.text = value;
    },
    setSkillTokens(value: typeof inserted.skillTokens) {
      this.skillTokens = value;
    },
    report(error: unknown) {
      errors.push(error);
    },
  };
  return { app: app as unknown as AppController, inserted, errors };
}
function conversation(incognito = false): Conversation {
  return {
    id: `skill-queue-${++next}`,
    title: "Fixture",
    mode: "chat",
    model: "m",
    providerId: "default",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    incognito,
    turns: [
      {
        id: "running",
        prompt: "Previous",
        attachments: [],
        items: [],
        status: "inProgress",
        createdAt: 1,
      },
    ],
  };
}
async function withBridge(bridge: object, run: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { desktop: bridge },
  });
  try {
    await run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("real manual send transmits only $name text and clears its draft metadata on success", async () => {
  const f = controller();
  const requests: any[] = [];
  await withBridge(
    {
      send: async (input: unknown) => {
        requests.push(input);
        return conversation();
      },
    },
    async () => {
      await sendDraft(f.app);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].text, f.inserted.text);
      assert.equal("skillTokens" in requests[0], false);
      assert.equal(f.app.text, "");
      assert.deepEqual(f.app.skillTokens, []);
      assert.deepEqual(f.errors, []);
    },
  );
});

test("failed manual send restores the same command and token ranges for an explicit retry", async () => {
  const f = controller();
  let fail = true;
  const requests: any[] = [];
  await withBridge(
    {
      send: async (input: unknown) => {
        requests.push(input);
        if (fail) throw Error("Actual synthetic refusal");
        return conversation();
      },
    },
    async () => {
      await sendDraft(f.app);
      assert.equal(f.app.text, f.inserted.text);
      assert.deepEqual(f.app.skillTokens, f.inserted.skillTokens);
      assert.equal(f.errors.length, 1);
      fail = false;
      await sendDraft(f.app);
      assert.deepEqual(
        requests.map((input) => input.text),
        [f.inserted.text, f.inserted.text],
      );
      assert.deepEqual(f.app.skillTokens, []);
    },
  );
});

test("real steer and queue paths retain skill text, metadata and failed-queue retry without global changes", async () => {
  for (const incognito of [false, true]) {
    const active = conversation(incognito);
    const f = controller(active);
    const steers: unknown[][] = [];
    const sent: any[] = [];
    let take = false,
      fail = true;
    await withBridge(
      {
        steerTurn: async (...args: unknown[]) => {
          steers.push(args);
          return take ? { messageId: "accepted", conversation: active } : null;
        },
        send: async (input: unknown) => {
          sent.push(input);
          if (fail) throw Error("Queue transport failure");
          return active;
        },
      },
      async () => {
        await sendDraft(f.app);
        const [entry] = queuedMessages(active.id);
        assert.ok(entry);
        assert.equal(entry.text, f.inserted.text);
        assert.deepEqual(entry.skillTokens, f.inserted.skillTokens);
        assert.deepEqual(steers[0], [active.id, f.inserted.text, []]);
        assert.equal(f.app.text, "");
        assert.deepEqual(f.app.skillTokens, []);
        active.turns[0]!.status = "completed";
        await conversationChanged(active, sendQueued);
        assert.match(
          queuedMessages(active.id)[0]!.error!,
          /Queue transport failure/,
        );
        fail = false;
        await sendQueuedNow(active, entry.id, () => {}, sendQueued);
        assert.equal(queuedMessages(active.id).length, 0);
        assert.deepEqual(
          sent.map((input) => input.text),
          [f.inserted.text, f.inserted.text],
        );
        assert.ok(sent.every((input) => !("skillTokens" in input)));
        active.turns[0]!.status = "inProgress";
        const second = controller(active);
        take = true;
        await sendDraft(second.app);
        assert.equal(queuedMessages(active.id)[0]!.state, "steered");
        assert.deepEqual(
          queuedMessages(active.id)[0]!.skillTokens,
          second.inserted.skillTokens,
        );
        for (const entry of queuedMessages(active.id))
          removeQueued(active.id, entry.id);
        clearQueued(active.id);
      },
    );
  }
});

test("the actual Engine preserves the invocation in turn/start, turn/steer and retry payloads", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-skill-protocol-"),
  );
  const store = new Store(root);
  const calls: { method: string; params: any }[] = [];
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  engine.ensure = async () => {};
  engine.rpc = {
    async call(method: string, params: unknown) {
      calls.push({ method, params: structuredClone(params) });
      if (method === "thread/start" || method === "thread/fork")
        return { thread: { id: `thread-${calls.length}` } };
      if (method === "turn/start")
        return { turn: { id: `turn-${calls.length}` } };
      return {};
    },
    respond() {},
    reject() {},
  } as never;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  const text = insertSkillToken("Inspect this", [], "review", 0)!.text;
  try {
    const chat = await engine.send({
      text,
      mode: "chat",
      providerId: "default",
      model: "m",
      attachments: [],
    });
    assert.deepEqual(
      calls.find((call) => call.method === "turn/start")!.params.input,
      [{ type: "text", text, text_elements: [] }],
    );
    assert.equal(store.conversation(chat.id).turns[0]!.prompt, text);
    await engine.steerTurn(chat.id, text, []);
    assert.deepEqual(
      calls.find((call) => call.method === "turn/steer")!.params.input,
      [{ type: "text", text, text_elements: [] }],
    );
    const turn = store.conversation(chat.id).turns[0]!;
    turn.status = "completed";
    await engine.retryResponse(chat.id, turn.id, "default", "m");
    const starts = calls.filter((call) => call.method === "turn/start");
    assert.equal(starts.length, 2);
    assert.deepEqual(starts[1]!.params.input, starts[0]!.params.input);
  } finally {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
