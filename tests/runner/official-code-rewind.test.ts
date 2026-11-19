import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppEvent, Conversation, Turn } from "../../shared/types";
import { openOfficialCodeStream } from "../../src-web/official/code-stream";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

test("hosted Code rewind publishes only after the service acknowledges both the thread and active turns", async (t) => {
  useElectronShim();
  const { CloudStore } = await import("../../runner/src/cloud-store");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-code-rewind-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = memoryWebstore();
  let loseReply = false;
  const checkpoint = new EventEmitter();
  const written = once(checkpoint, "written");
  const reply = once(checkpoint, "reply");
  const transport = {
    async request(op: string, userId: number, body?: unknown) {
      const result = await remote.request(op, userId, body);
      if (op === "store.conversations.rewind" && loseReply) {
        checkpoint.emit("written");
        await reply;
        throw Error("The relay connection closed before the reply.");
      }
      return result;
    },
  };
  const open = (name: string) =>
    CloudStore.open({ root: path.join(root, name), userId: 1, transport });
  const store = await open("current");
  t.after(() => store.close());
  const turn = (id: string, prompt: string): Turn => ({
    id,
    prompt,
    items: [],
    attachments: [],
    createdAt: 1,
    status: "completed",
  });
  const keep = turn("kept", "Retained prompt");
  const target = {
    ...turn("target", "Prompt retained before steering"),
    items: [{ id: "later-reply", type: "agentMessage", text: "Rewound reply" }],
  } satisfies Turn;
  const retained = { ...target, items: [] };
  const remove = turn("removed", "Rewound later prompt");
  const saved = turn("saved", "Saved branch prompt");
  const conversation: Conversation = {
    id: "hosted-code",
    mode: "code",
    threadId: "original-thread",
    title: "Hosted Code",
    providerId: "fixture",
    model: "fixture",
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    turns: [keep, target, remove],
    savedBranches: [
      {
        id: "saved-branch",
        turns: [saved],
        providerId: "fixture",
        model: "fixture",
        visited: 1,
      },
    ],
  };
  store.conversations.push(conversation);
  store.flush();
  await store.settled();

  const patch = {
    threadId: "rewound-thread",
    turns: [keep, retained],
    updatedAt: 2,
  };
  loseReply = true;
  const operation = store.commitHostedCodeRewind(
    conversation,
    patch,
    1,
    () => true,
  );
  const rejected = assert.rejects(operation, /save could not be confirmed/);
  await written;
  assert.equal(conversation.threadId, "original-thread");
  assert.deepEqual(conversation.turns, [keep, target, remove]);
  checkpoint.emit("reply");
  await rejected;
  await assert.rejects(
    store.commitHostedCodeRewind(conversation, patch, 1, () => true),
    /changed during rewind/,
  );

  const reopened = await open("reopened");
  t.after(() => reopened.close());
  const restored = reopened.conversation(conversation.id);
  assert.equal(restored.threadId, "rewound-thread");
  assert.deepEqual(restored.turns, [keep, retained]);
  assert.deepEqual(restored.savedBranches?.[0].turns, [saved]);
});

test("an open hosted Code stream replaces its invalidated cursor with the current transcript", async () => {
  const key = "a".repeat(32);
  const session = { id: `session_${key}`, worker_status: "idle" };
  const url = new URL(
    `http://localhost/v1/code/sessions/${session.id}/events/stream`,
  );
  const event = (sequence_num: number, letter: string, uuid: string) => ({
    sequence_num,
    event_id: `evt_${letter.repeat(64)}`,
    payload: { type: "assistant", uuid },
  });
  const kept = event(1, "a", "kept-reply");
  const removed = event(2, "b", "removed-reply");
  const answer = (status: number, value: unknown) => ({
    status,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(value)),
  });
  const events = new EventEmitter();
  let rewound = false;
  const response = await openOfficialCodeStream(
    new Request(url),
    url,
    { kind: "stream", key, from: 0 },
    async (request) => {
      const from = new URL(request.path, url).searchParams.get(
        "from_sequence_num",
      );
      if (rewound && from === "2")
        return answer(410, { error: "Cursor no longer available" });
      return answer(200, {
        conversation_id: "owned-code",
        session,
        data: rewound ? [kept] : [kept, removed],
        has_more: false,
      });
    },
    (notify: (event: AppEvent) => void) => {
      events.on("change", notify);
      return () => events.off("change", notify);
    },
  );
  assert.ok(response.body);
  const reader = response.body.getReader();
  const read = async () =>
    new TextDecoder().decode((await reader.read()).value);
  try {
    assert.match(await read(), /removed-reply/);
    rewound = true;
    events.emit("change", { type: "resync" });
    assert.match(
      await read(),
      /id: 0\nevent: catch_up_truncated\ndata: {"claudex_transcript_reset":true}/,
    );
    const replay = await read();
    assert.match(replay, /kept-reply/);
    assert.doesNotMatch(replay, /removed-reply/);
  } finally {
    await reader.cancel();
  }
});
