import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../electron/engine/engine";
import { Store } from "../electron/store/store";
import { storeAttachment } from "../electron/engine/composer-files";
import { openPolicy } from "../shared/client-policy";
import { inlineDisplayForSend } from "../electron/official-ui/api/inline-attachment-displays";
import type { Conversation } from "../shared/types";

test("actual Engine.send verifies the same quote bytes that it passes to turn/start", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quote-byte-race-"));
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
  const c: Conversation = {
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
    turns: [
      {
        id: "source",
        prompt: "Previous question",
        attachments: [],
        items: [{ id: "answer", type: "agentMessage", text: "Evidence." }],
        status: "completed",
        createdAt: 1,
      },
    ],
  };
  store.conversations.push(c);
  const name = "excerpt_from_previous_claude_message.txt";
  const data = Buffer.from("Evidence.");
  const file = storeAttachment(
    path.join(root, "attachments"),
    name + ".extracted.txt",
    data,
    openPolicy,
  );
  const display = inlineDisplayForSend(
    file.id,
    { file_name: name, file_type: "txt", kind: "excerpt" },
    "Evidence.",
    { role: "assistant", turnId: "source" },
  );
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  engine.ensure = async () => {};
  (engine as any).windowsSandbox = {
    assertReady() {},
    async ensureReady() {
      fs.writeFileSync(file.path, "Tampered!");
    },
  };
  (engine as any).loaded.add("thread");
  (engine as any).routes.set("thread", "c");
  const threadOptions = engine.threadOptions.bind(engine);
  engine.threadOptions = (...args) => {
    queueMicrotask(() => fs.writeFileSync(file.path, data));
    return threadOptions(...args);
  };
  const sent: string[][] = [];
  engine.rpc = {
    call: async (method: string, params: any) => {
      if (method === "thread/unsubscribe" || method === "thread/resume")
        return {};
      assert.equal(method, "turn/start");
      sent.push(params.input.map((part: any) => part.text));
      return { turn: { id: "new-turn" } };
    },
  } as any;
  try {
    await engine.send({
      conversationId: "c",
      text: "typed",
      mode: "chat",
      attachments: [file],
      inlineAttachmentDisplays: [display],
      providerId: "p",
      model: "m",
    });
  } catch (error) {
    assert.match(String(error), /attachment bytes changed/);
    assert.deepEqual(sent, []);
    return;
  }
  store.flush();
  assert.deepEqual(
    new Store(root).conversation("c").turns.at(-1)?.inlineAttachmentDisplays,
    [display],
  );
  assert.equal(sent[0][0], "typed");
  assert.match(
    sent[0][1],
    /Evidence\./,
    "accepted quote must dispatch its verified bytes",
  );
});
