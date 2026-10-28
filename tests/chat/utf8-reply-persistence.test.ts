/** Synthetic boundaries for #24/#52; does not replay a real account or start Codex. */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readSSE } from "../../electron/engine/gateway-support";
import { CodexRPC } from "../../electron/engine/rpc";
import { Engine } from "../../electron/engine/engine";
import { CloudStore } from "../../runner/src/cloud-store";
import { memoryWebstore } from "../runner/runner-core-support.test.ts";
import type { Conversation } from "../../shared/types";

const text = "合成回复：可调用的内置工具，é 与 🌏。";
function bytes(body: Buffer, split: number) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body.subarray(0, split));
      controller.enqueue(body.subarray(split));
      controller.close();
    },
  });
}

test("Responses SSE preserves every byte split of CJK, accented and astral reply text", async () => {
  const event = { type: "response.output_text.delta", delta: text };
  const body = Buffer.from(`data: ${JSON.stringify(event)}\r\n\r\n`);
  for (let split = 0; split <= body.length; split++) {
    const result = [];
    for await (const event of readSSE(bytes(body, split))) result.push(event);
    assert.deepEqual(result, [event], `split ${split}`);
  }
  // A nonstreaming per-chunk conversion reproduces the *shape*, not the incident.
  const boundary = body.indexOf(Buffer.from("内")) + 2;
  const broken =
    body.subarray(0, boundary).toString("utf8") +
    body.subarray(boundary).toString("utf8");
  assert.ok(broken.includes("的��置"));
});

async function persist(
  t: test.TestContext,
  deltas: string[],
  completedText: string,
) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-utf8-synthetic-"),
  );
  const web = memoryWebstore();
  const store = await CloudStore.open({ root, userId: 901, transport: web });
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const conversation: Conversation = {
    id: "synthetic-c",
    title: "Synthetic UTF-8",
    mode: "chat",
    providerId: "fixture",
    model: "fixture",
    threadId: "synthetic-thread",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "synthetic-turn",
        prompt: "Synthetic input",
        attachments: [],
        items: [],
        status: "inProgress",
        createdAt: 1,
      },
    ],
  };
  store.conversations.push(conversation);
  const engine = new Engine(
    store,
    "unused-no-process",
    () => "",
    () => {},
  );
  (engine as any).routes.set(conversation.threadId, conversation.id);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
  });
  child.stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString());
    if (request.method === "initialize")
      child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\n");
  });
  const rpc = new CodexRPC();
  const notifications: unknown[] = [];
  rpc.on("notification", (message) => {
    notifications.push(message);
    (engine as any).notification(message);
  });
  // PassThrough is an in-memory stand-in for the pipes, not a spawned engine.
  await rpc.startWith(() => child as unknown as ChildProcessWithoutNullStreams);
  t.after(() => {
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });
  function notify(method: string, params: object) {
    const wire = Buffer.from(
      JSON.stringify({
        method,
        params: {
          threadId: conversation.threadId,
          turnId: "synthetic-turn",
          ...params,
        },
      }) + "\n",
    );
    for (const byte of wire) child.stdout.write(Buffer.from([byte]));
  }
  for (const delta of deltas)
    notify("item/agentMessage/delta", { itemId: "synthetic-item", delta });
  assert.equal(conversation.turns[0].items[0].text, deltas.join(""));
  notify("item/completed", {
    item: { id: "synthetic-item", type: "agentMessage", text: completedText },
  });
  store.flush();
  await store.settled();
  const saved = web.users
    .get(901)!
    .turns.get(conversation.id)!
    .get("|synthetic-turn")!;
  assert.equal((saved.turn.items[0] as any).text, completedText);
  assert.equal((conversation.turns[0].items[0] as any).text, completedText);
  assert.equal(notifications.length, deltas.length + 1);
  return saved;
}

test("byte-fragmented engine notifications persist valid Chinese reply text unchanged", async (t) => {
  await persist(t, ["合成回复：可调用的", "内", "置工具，", "é 与 🌏。"], text);
});

test("already-replaced upstream text is preserved, not guessed or silently repaired", async (t) => {
  const incoming = text.replace("内", "\uFFFD\uFFFD");
  await persist(t, [incoming], incoming);
});

test("completed item text is authoritative even when it differs from streamed deltas", async (t) => {
  await persist(t, [text], text.replace("内", "\uFFFD\uFFFD"));
});
