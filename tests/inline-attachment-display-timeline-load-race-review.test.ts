import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import path from "node:path";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  createTimelineRpc,
  deepCreate,
  loadRegistry,
  STREAM_TIMELINE_PATH,
} from "../electron/official-ui/api/timeline";
import { inlineDisplayForSend } from "../electron/official-ui/api/inline-attachment-displays";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
import { conversationsRoute } from "../electron/official-ui/api/conversations";
import {
  organizationUuid,
  type AdapterContext,
} from "../electron/official-ui/api/context";
import type { AppEvent, Attachment, Conversation, Turn } from "../shared/types";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const assetRoot = path.resolve("build/official-ui");
const registry = loadRegistry(
  path.join(assetRoot, "data/conversation-protocol.json"),
);
const requestSchema = registry.getMessage(
  "anthropic.bard.api.v1alpha.StreamTimelineRequest",
)!;
const responseSchema = registry.getMessage(
  "anthropic.bard.api.v1alpha.StreamTimelineResponse",
)!;
const displayName = "notes.txt";
const turnId = "running";
const conversationId = "conversation";
const bytes = new TextEncoder().encode("Evidence.");
const attachment: Attachment = {
  id: "attachment",
  path: "unused",
  name: "notes.txt.extracted.txt",
  kind: "text",
  size: bytes.length,
};
const display = inlineDisplayForSend(
  attachment.id,
  { file_name: displayName, file_type: "txt" },
  "Evidence.",
);
const makeTurn = (overrides: Partial<Turn> = {}): Turn => ({
  id: turnId,
  prompt: "typed",
  createdAt: 1,
  status: "inProgress",
  items: [],
  attachments: [attachment],
  inlineAttachmentDisplays: [display],
  ...overrides,
});
const makeConversation = (turn: Turn): Conversation => ({
  id: conversationId,
  title: "Quote",
  mode: "chat",
  turns: [turn],
  createdAt: 1,
  updatedAt: 1,
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
});
const scope = newAdapterScope("owner");
const identity = {};
const context = (overrides: Partial<AdapterContext>) =>
  ({
    root: assetRoot,
    account: () => ({ id: "owner" }),
    stateDirectory: () => path.resolve("test-owner"),
    sessionIdentity: () => identity,
    isCurrent: () => true,
    call: async () => ({ data: bytes }),
    log: () => {},
    ...overrides,
  }) as AdapterContext;

function envelope(payload: Uint8Array) {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

test("PB StreamTimeline publishes completion that arrives during initial conversation read", () =>
  publishesTimelineCompletionDuringLoad("conversation"));

test("PB StreamTimeline publishes persisted cloud completion when resync arrives during initial conversation read", () =>
  publishesTimelineCompletionDuringLoad("resync"));

async function publishesTimelineCompletionDuringLoad(source: "conversation" | "resync") {
  const started = deferred(),
    release = deferred();
  const listeners = new Set<(event: AppEvent) => void>();
  let live = makeConversation(makeTurn());
  const ctx = context({
    loadConversation: async () => { const snapshot = structuredClone(live); started.resolve(); await release.promise; return snapshot; },
    isCloudConversation: (id) => source === "resync" && id === conversationId,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    call: async () => ({ data: bytes }),
  });
  const route = createTimelineRpc(ctx, {
    heartbeatMs: 20,
    missingConversationWaitMs: 0,
  });
  const server = createServer((req, res) =>
    inAdapterScope(scope, () => route(req, res, STREAM_TIMELINE_PATH)),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const abort = new AbortController();
  try {
    const response = fetch(
      `http://127.0.0.1:${address.port}${STREAM_TIMELINE_PATH}`,
      {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/connect+proto" },
        body: envelope(
          toBinary(
            requestSchema,
            deepCreate(requestSchema, { conversationId }),
          ),
        ),
      },
    );
    await started.promise;
    live = makeConversation(
      makeTurn({
        status: "completed",
        items: [
          { id: "text", type: "agentMessage", text: "finished response" },
        ],
      }),
    );
    const event: AppEvent = source === "resync"
      ? { type: "resync" }
      : { type: "conversation", conversation: live };
    for (const emit of listeners) emit(event);
    release.resolve();
    const reader = (await response).body!.getReader();
    let pending = Buffer.alloc(0),
      sawComplete = false,
      sawHeartbeat = false;
    for (let reads = 0; reads < 10 && !sawHeartbeat; reads++) {
      const part = await reader.read();
      if (part.done) break;
      pending = Buffer.concat([pending, part.value]);
      while (
        pending.length >= 5 &&
        pending.length >= 5 + pending.readUInt32BE(1)
      ) {
        const n = pending.readUInt32BE(1);
        const frame = fromBinary(
          responseSchema,
          pending.subarray(5, 5 + n),
        ) as any;
        pending = pending.subarray(5 + n);
        const event = frame.event?.event;
        if (event?.case === "heartbeat") sawHeartbeat = true;
        if (event?.case === "update")
          sawComplete ||=
            event.value.messages.some(
              (msg: any) => msg.role === 2 && msg.isComplete,
            ) &&
            event.value.contentBlocks.some(
              (block: any) => block.text === "finished response",
            );
      }
    }
    assert.ok(sawHeartbeat, "stream should still be open and heartbeating");
    assert.equal(
      sawComplete,
      true,
      "the stream must publish the completed response before the first heartbeat",
    );
  } finally {
    release.resolve();
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("REST detail remains readable when reply versions share attachments but have distinct display assertions", async () => {
  const first = makeTurn({
    id: "old",
    status: "completed",
    promptVersionId: "prompt-key",
  });
  const second = makeTurn({
    id: "new",
    status: "completed",
    promptVersionId: "prompt-key",
    inlineAttachmentDisplays: [],
  });
  const conversation = {
    ...makeConversation(second),
    savedBranches: [{ id: "saved", visited: 0, providerId: "p", model: "m", turns: [first] }],
  };
  const ctx = context({
    loadConversation: async () => structuredClone(conversation),
  });
  const url = new URL(
    `http://127.0.0.1/api/organizations/${organizationUuid("owner")}/chat_conversations/${conversationId}`,
  );
  let status: number | undefined, body: string | undefined;
  await inAdapterScope(newAdapterScope("owner"), () =>
    conversationsRoute(
      { method: "GET" } as any,
      {
        writeHead(code: number) {
          status = code;
        },
        end(value: string) {
          body = value;
        },
      } as any,
      url.pathname,
      url,
      ctx,
    ),
  );
  assert.equal(status, 200, body);
});

async function getRest(
  conversation: Conversation,
  read: AdapterContext["call"],
) {
  const ctx = context({
    loadConversation: async () => structuredClone(conversation),
    call: read,
  });
  const url = new URL(
    `http://127.0.0.1/api/organizations/${organizationUuid("owner")}/chat_conversations/${conversationId}`,
  );
  let status: number | undefined,
    body = "";
  await inAdapterScope(newAdapterScope("owner"), () =>
    conversationsRoute(
      { method: "GET" } as any,
      {
        writeHead(code: number) {
          status = code;
        },
        end(value: string) {
          body = value;
        },
      } as any,
      url.pathname,
      url,
      ctx,
    ),
  );
  return { status, body };
}

test("REST detail handles byte budget without hiding a valid history after ordinary retry", async () => {
  const text = "x".repeat(Math.floor(1.6 * 1024 * 1024));
  const data = new TextEncoder().encode(text);
  const file = { ...attachment, size: data.length };
  const inherited = inlineDisplayForSend(
    file.id,
    { file_name: displayName, file_type: "txt" },
    text,
  );
  const first = makeTurn({
    id: "old",
    status: "completed",
    promptVersionId: "prompt-key",
    attachments: [file],
    inlineAttachmentDisplays: [inherited],
  });
  const second = { ...first, id: "new" };
  const conversation = {
    ...makeConversation(second),
    savedBranches: [{ id: "saved", visited: 0, providerId: "p", model: "m", turns: [first] }],
  };
  const { status, body } = await getRest(conversation, async () => ({ data }));
  assert.equal(status, 200, body);
  const messages = JSON.parse(body).chat_messages;
  assert.equal(
    messages.find((message: any) => message.sender === "human").attachments[0]
      .extracted_content,
    text,
  );
});

test("REST detail keeps valid inline attachments beside a damaged derivative", async () => {
  const second = {
    ...attachment,
    id: "second",
    name: "quoted.txt.extracted.txt",
  };
  const secondDisplay = inlineDisplayForSend(
    second.id,
    { file_name: "quoted.txt", file_type: "txt" },
    "Evidence.",
  );
  const conversation = makeConversation(
    makeTurn({
      status: "completed",
      attachments: [attachment, second],
      inlineAttachmentDisplays: [display, secondDisplay],
    }),
  );
  const { status, body } = await getRest(
    conversation,
    async (_name, _id, fileId) => ({
      data:
        fileId === attachment.id
          ? new TextEncoder().encode("Damaged!!")
          : bytes,
    }),
  );
  assert.equal(status, 200, body);
  const user = JSON.parse(body).chat_messages.find(
    (message: any) => message.sender === "human",
  );
  assert.deepEqual(
    user.attachments.map((row: any) => row.file_name),
    ["quoted.txt"],
  );
  assert.equal(user.files_v2.length, 1);
});

test("PB StreamTimeline handles account retirement during an event projection", async () => {
  const started = deferred(),
    release = deferred();
  const subscribed = deferred();
  let live = makeConversation(
    makeTurn({ attachments: [], inlineAttachmentDisplays: undefined }),
  );
  let emit: ((event: AppEvent) => void) | undefined;
  let current = true;
  const ctx = context({
    isCurrent: () => current,
    loadConversation: async () => structuredClone(live),
    onEvent(listener) {
      emit = listener;
      subscribed.resolve();
      return () => {
        emit = undefined;
      };
    },
    call: async () => {
      started.resolve();
      await release.promise;
      return { data: bytes };
    },
  });
  const route = createTimelineRpc(ctx, {
    heartbeatMs: 20,
    missingConversationWaitMs: 0,
  });
  const server = createServer((req, res) =>
    inAdapterScope(scope, () => route(req, res, STREAM_TIMELINE_PATH)),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const abort = new AbortController();
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}${STREAM_TIMELINE_PATH}`,
      {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/connect+proto" },
        body: envelope(
          toBinary(
            requestSchema,
            deepCreate(requestSchema, { conversationId }),
          ),
        ),
      },
    );
    await subscribed.promise;
    live = makeConversation(makeTurn());
    emit?.({ type: "conversation", conversation: live });
    await started.promise;
    current = false;
    release.resolve();
    await response.arrayBuffer();
    assert.equal(emit, undefined);
  } finally {
    release.resolve();
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
