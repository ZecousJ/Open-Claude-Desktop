import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { Attachment, Conversation, Turn } from "../shared/types";
import { inlineDisplayKey } from "../shared/inline-attachment-display";
import { parseTurnDoc, splitConversation } from "../shared/web-docs";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
import { flushState, writeState } from "../electron/official-ui/api/state";
import {
  loadFileRegistry,
  knownFile,
  type KnownFile,
} from "../electron/official-ui/api/files";
import {
  projectInlineAttachmentDisplays,
  inlineDisplayForSend,
} from "../electron/official-ui/api/inline-attachment-displays";
import {
  conversationRestMessages,
  conversationsRoute,
  userMessageId,
  assistantMessageId,
} from "../electron/official-ui/api/conversations";
import {
  conversationUpdate,
  createTimelineRpc,
  loadRegistry,
  deepCreate,
  STREAM_TIMELINE_PATH,
} from "../electron/official-ui/api/timeline";
import {
  organizationUuid,
  type AdapterContext,
} from "../electron/official-ui/api/context";

const text = "Emerald is green.";
const bytes = Buffer.from(text);
const ids = { user: userMessageId, assistant: assistantMessageId };
const file: Attachment = {
  id: "legacy-file",
  name: "old-note.txt.extracted.txt",
  size: bytes.length,
  path: "untrusted",
  kind: "text",
};
const row: KnownFile = {
  ...file,
  mediaType: "text/plain",
  kind: "blob",
  conversationId: "history",
  createdAt: 1,
  inlineDisplay: {
    file_name: "old-note.txt",
    file_type: "txt",
    kind: "excerpt",
    quote_message_uuid: "source:assistant",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  },
};
const source: Turn = {
  id: "source",
  prompt: "What is Emerald?",
  attachments: [],
  items: [{ id: "answer", type: "agentMessage", text }],
  status: "completed",
  createdAt: 1,
};
const legacy = (id: string): Turn => ({
  id,
  prompt: id,
  attachments: [structuredClone(file)],
  items: [],
  status: "completed",
  createdAt: 2,
});
function fixture(t: TestContext, stored = row) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-display-"));
  const identity = {};
  const scope = newAdapterScope("owner", root, identity);
  const conversation: Conversation = {
    id: "history",
    title: "History",
    turns: [
      structuredClone(source),
      legacy("first"),
      legacy("second"),
      { ...legacy("plain"), inlineAttachmentDisplays: [] },
    ],
    mode: "chat",
    providerId: "p",
    model: "m",
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    archived: false,
  };
  const calls: string[] = [];
  const ctx: AdapterContext = {
    root: "build/official-ui",
    account: () => ({
      id: "owner",
      email: "owner@example.invalid",
      name: "Owner",
    }),
    stateDirectory: () => root,
    sessionIdentity: () => identity,
    isCurrent: () => true,
    loadConversation: async () => structuredClone(conversation),
    call: async (
      name: string,
      conversationId: unknown,
      attachmentId: unknown,
    ) => {
      calls.push(name);
      assert.equal(name, "turnAttachment");
      assert.equal(conversationId, conversation.id);
      assert.equal(attachmentId, file.id);
      return { data: bytes };
    },
    settings() {
      throw Error("unused settings");
    },
    listConversations: async () => [conversation],
    onEvent: () => () => {},
    modelCatalog: async () => null,
    snapshot: async () => {
      throw Error("unused snapshot");
    },
    appVersion: "test",
    log() {},
  } satisfies AdapterContext;
  inAdapterScope(scope, () => {
    writeState("files", () => ({
      files: [structuredClone(stored)],
      aliases: [],
    }));
    flushState("files");
    loadFileRegistry();
  });
  const registryFile = path.join(
    root,
    "official-ui",
    "accounts",
    createHash("sha256").update("owner").digest("hex"),
    "files.json",
  );
  t.after(() => {
    inAdapterScope(scope, () => flushState("files"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, scope, identity, conversation, ctx, calls, registryFile };
}
async function rest(ctx: AdapterContext, conversationId: string) {
  const url = new URL(
    `https://fixture.invalid/api/organizations/${organizationUuid("owner")}/chat_conversations/${conversationId}`,
  );
  let status = 0,
    body = "";
  await conversationsRoute(
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
  );
  assert.equal(status, 200, body);
  return JSON.parse(body);
}

test("legacy reused IDs retain file-level display in REST and timeline, canonical plain remains plain after restart", async (t) => {
  const f = fixture(t),
    before = fs.readFileSync(f.registryFile, "utf8"),
    history = JSON.stringify(f.conversation);
  for (const scope of [f.scope, newAdapterScope("owner", f.root, f.identity)])
    await inAdapterScope(scope, async () => {
      loadFileRegistry();
      const projection = await projectInlineAttachmentDisplays(
        f.ctx,
        f.conversation,
        ids,
      );
      assert.deepEqual(
        [...projection.keys()],
        [
          inlineDisplayKey("first", file.id),
          inlineDisplayKey("second", file.id),
        ],
      );
      const messages = conversationRestMessages(
        f.conversation,
        organizationUuid("owner"),
        projection,
      ).messages;
      for (const id of ["first", "second"]) {
        const message = messages.find((message) => message.text === id)!;
        assert.equal(message.attachments[0].file_name, "old-note.txt");
        assert.equal(message.attachments[0].kind, "excerpt");
        assert.equal(
          message.attachments[0].quote_message_uuid,
          "source:assistant",
        );
      }
      assert.equal(
        messages.find((message) => message.text === "plain")!.attachments
          .length,
        0,
      );
      const update = conversationUpdate(f.conversation, false, {
        org: organizationUuid("owner"),
        inlineDisplays: projection,
      });
      assert.equal(
        update.messages!.find((message: any) => message.id === "first:user")!
          .attachments[0].fileName,
        "old-note.txt",
      );
      assert.equal(
        update.messages!.find((message: any) => message.id === "plain:user")!
          .attachments[0].fileName,
        file.name,
      );
      assert.equal(
        (await rest(f.ctx, f.conversation.id)).chat_messages.find(
          (message: any) => message.text === "second",
        ).attachments[0].kind,
        "excerpt",
      );
      flushState("files");
    });
  assert.equal(fs.readFileSync(f.registryFile, "utf8"), before);
  assert.equal(JSON.stringify(f.conversation), history);
  assert.ok(f.calls.every((call) => call === "turnAttachment"));
});

test("legacy reads reject wrong binding, source, bytes, aliases and account", async (t) => {
  for (const mode of [
    "conversation",
    "id",
    "name",
    "size",
    "unbound",
    "digest",
    "source",
    "passage",
    "alias",
    "bytes",
    "derivedName",
    "utf8",
  ] as const) {
    const stored = structuredClone(row);
    if (mode === "conversation") stored.conversationId = "foreign";
    if (mode === "unbound") delete stored.conversationId;
    if (mode === "id" || mode === "alias") stored.id = "other";
    if (mode === "name") stored.name = "other.txt";
    if (mode === "size") stored.size++;
    if (mode === "digest") stored.inlineDisplay!.sha256 = "0".repeat(64);
    if (mode === "source")
      stored.inlineDisplay!.quote_message_uuid = "unavailable";
    if (mode === "derivedName") stored.inlineDisplay!.file_name = "wrong.txt";
    const f = fixture(t, stored);
    if (mode === "bytes")
      f.ctx.call = async () => ({
        data: Buffer.from("x".repeat(bytes.length)),
      });
    if (mode === "utf8") {
      const data = Buffer.alloc(bytes.length, 255);
      stored.inlineDisplay!.sha256 = createHash("sha256")
        .update(data)
        .digest("hex");
      f.ctx.call = async () => ({ data });
    }
    if (mode === "passage")
      f.conversation.turns[0].items[0].text = "Other source";
    await inAdapterScope(f.scope, async () => {
      if (mode === "alias" || mode === "utf8") {
        writeState("files", () => ({
          files: [stored],
          aliases: mode === "alias" ? [[file.id, "other"]] : [],
        }));
        flushState("files");
        loadFileRegistry();
      }
      assert.equal(
        (await projectInlineAttachmentDisplays(f.ctx, f.conversation, ids))
          .size,
        0,
        mode,
      );
      if (mode === "unbound") {
        await rest(f.ctx, f.conversation.id);
        assert.equal(knownFile(file.id)!.conversationId, undefined);
        assert.equal(
          (await projectInlineAttachmentDisplays(f.ctx, f.conversation, ids))
            .size,
          0,
        );
      }
    });
  }
  const f = fixture(t);
  await inAdapterScope(newAdapterScope("foreign", f.root, {}), () =>
    assert.rejects(
      projectInlineAttachmentDisplays(f.ctx, f.conversation, ids),
      /account changed/,
    ),
  );
  f.ctx.call = async () => {
    f.ctx.isCurrent = () => false;
    return { data: bytes };
  };
  await inAdapterScope(f.scope, () =>
    assert.rejects(
      projectInlineAttachmentDisplays(f.ctx, f.conversation, ids),
      /account changed/,
    ),
  );
});

test("explicit canonical empty, invalid and valid declarations override legacy registry", async (t) => {
  const f = fixture(t);
  const canonical = inlineDisplayForSend(
    file.id,
    { file_name: "old-note.txt", file_type: "txt", kind: "pasted_text" },
    text,
  );
  f.conversation.turns = [
    source,
    { ...legacy("empty"), inlineAttachmentDisplays: [] },
    {
      ...legacy("invalid"),
      inlineAttachmentDisplays: [{ ...canonical, sha256: "invalid" }],
    },
    { ...legacy("valid"), inlineAttachmentDisplays: [canonical] },
  ];
  await inAdapterScope(f.scope, async () => {
    const projection = await projectInlineAttachmentDisplays(
      f.ctx,
      f.conversation,
      ids,
    );
    assert.equal(projection.size, 1);
    assert.equal(
      projection.get(inlineDisplayKey("valid", file.id))!.kind,
      "pasted_text",
    );
  });
  const docs = splitConversation(f.conversation);
  const invalid = docs.turns.find((doc) => doc.turn.id === "invalid")!;
  assert.deepEqual(
    parseTurnDoc(JSON.stringify(invalid)).turn.inlineAttachmentDisplays,
    [],
  );
});

test("targetless legacy excerpts and extracted files preserve only their declared kind", async (t) => {
  for (const kind of ["excerpt", undefined]) {
    const stored = structuredClone(row);
    delete stored.inlineDisplay!.quote_message_uuid;
    stored.inlineDisplay!.kind = kind;
    const f = fixture(t, stored);
    await inAdapterScope(f.scope, async () => {
      const display = (
        await projectInlineAttachmentDisplays(f.ctx, f.conversation, ids)
      ).get(inlineDisplayKey("first", file.id))!;
      assert.equal(display.kind, kind);
      assert.equal(display.quote_message_uuid, undefined);
    });
  }
});

test("fresh reader recovers exact owned Runner history projection without registry backfill", async (t) => {
  const f = fixture(t);
  let remoteReads = 0;
  const scope = newAdapterScope("owner", f.root + "-reader", {});
  const ctx: AdapterContext = {
    ...f.ctx,
    stateDirectory: () => f.root + "-reader",
    readWorkspaceDownload: async () => {
      remoteReads++;
      const answer = await inAdapterScope(f.scope, () =>
        rest(f.ctx, f.conversation.id),
      );
      return {
        status: 200,
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(answer)),
      };
    },
  };
  const conversation = {
    ...structuredClone(f.conversation),
    cloudHosted: true,
  };
  await inAdapterScope(scope, async () => {
    const projection = await projectInlineAttachmentDisplays(
      ctx,
      conversation,
      ids,
    );
    assert.equal(projection.size, 2);
    assert.equal(
      projection.get(inlineDisplayKey("first", file.id))!.quote_message_uuid,
      "source:assistant",
    );
    assert.equal(knownFile(file.id), undefined);
    assert.equal(fs.existsSync(f.root + "-reader"), false);
    assert.equal("inlineAttachmentDisplays" in conversation.turns[1], false);
  });
  assert.equal(remoteReads, 1);
  const transport = ctx.readWorkspaceDownload!;
  for (const mutation of [
    "attachment",
    "turn",
    "source",
    "conflict",
    "name",
  ] as const) {
    ctx.readWorkspaceDownload = async (request) => {
      const answer = (await transport(request))!;
      const value = JSON.parse(Buffer.from(answer.body).toString());
      for (const row of value.claudex_inline_attachment_displays) {
        if (mutation === "attachment") row.display.attachmentId = "other";
        if (mutation === "turn") row.turnId = "other";
        if (mutation === "source") row.display.quoteSource.turnId = "other";
        if (mutation === "name") row.attachmentName = "other";
      }
      if (mutation === "conflict")
        value.claudex_inline_attachment_displays.push(
          ...value.claudex_inline_attachment_displays.map((row: any) => ({
            ...row,
            attachmentName: "other",
          })),
        );
      return { ...answer, body: Buffer.from(JSON.stringify(value)) };
    };
    await inAdapterScope(scope, async () =>
      assert.equal(
        (await projectInlineAttachmentDisplays(ctx, conversation, ids)).size,
        0,
        mutation,
      ),
    );
  }
});

test("valid owning Runner projection recovers when the reader's direct registry row is ineligible", async (t) => {
  const server = fixture(t);
  for (const patch of [
    { conversationId: "other" },
    { name: "stale-name" },
    { size: 12345 },
  ]) {
    const reader = fixture(t, { ...row, ...patch });
    reader.ctx.readWorkspaceDownload = async () => ({
      status: 200,
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify(
          await inAdapterScope(server.scope, () =>
            rest(server.ctx, server.conversation.id),
          ),
        ),
      ),
    });
    await inAdapterScope(reader.scope, async () => {
      const before = fs.readFileSync(reader.registryFile, "utf8");
      const projection = await projectInlineAttachmentDisplays(
        reader.ctx,
        { ...reader.conversation, cloudHosted: true },
        ids,
      );
      assert.equal(projection.size, 2);
      assert.equal(
        projection.get(inlineDisplayKey("first", file.id))!.quote_message_uuid,
        "source:assistant",
      );
      assert.equal(fs.readFileSync(reader.registryFile, "utf8"), before);
    });
  }
});

test("actual PB timeline reads legacy-only history with original names", async (t) => {
  const f = fixture(t);
  const registry = loadRegistry(
    path.resolve("build/official-ui/data/conversation-protocol.json"),
  );
  const requestSchema = registry.getMessage(
    "anthropic.bard.api.v1alpha.StreamTimelineRequest",
  )!;
  const responseSchema = registry.getMessage(
    "anthropic.bard.api.v1alpha.StreamTimelineResponse",
  )!;
  const route = createTimelineRpc(f.ctx, {
    heartbeatMs: 20,
    missingConversationWaitMs: 0,
  });
  const server = createServer((request, response) =>
    inAdapterScope(f.scope, () =>
      route(request, response, STREAM_TIMELINE_PATH),
    ),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const abort = new AbortController();
  try {
    const payload = toBinary(
      requestSchema,
      deepCreate(requestSchema, { conversationId: f.conversation.id }),
    );
    const header = Buffer.alloc(5);
    header.writeUInt32BE(payload.length, 1);
    const response = await fetch(
      `http://127.0.0.1:${address.port}${STREAM_TIMELINE_PATH}`,
      {
        method: "POST",
        signal: abort.signal,
        headers: { "Content-Type": "application/connect+proto" },
        body: Buffer.concat([header, payload]),
      },
    );
    const reader = response.body!.getReader();
    let pending = Buffer.alloc(0),
      found = false;
    for (let reads = 0; reads < 10 && !found; reads++) {
      const part = await reader.read();
      if (part.done) break;
      pending = Buffer.concat([pending, part.value]);
      while (
        pending.length >= 5 &&
        pending.length >= 5 + pending.readUInt32BE(1)
      ) {
        const length = pending.readUInt32BE(1);
        const frame: any = fromBinary(
          responseSchema,
          pending.subarray(5, 5 + length),
        );
        pending = pending.subarray(5 + length);
        if (frame.event?.event?.case !== "update") continue;
        const messages = frame.event.event.value.messages;
        assert.equal(
          messages.find((message: any) => message.id === "first:user")
            .attachments[0].fileName,
          "old-note.txt",
        );
        assert.equal(
          messages.find((message: any) => message.id === "second:user")
            .attachments[0].fileName,
          "old-note.txt",
        );
        assert.equal(
          messages.find((message: any) => message.id === "plain:user")
            .attachments[0].fileName,
          file.name,
        );
        found = true;
      }
    }
    assert.equal(found, true);
  } finally {
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fresh readers receive valid legacy rows in long but bounded REST histories", async (t) => {
  const owner = fixture(t);
  owner.conversation.turns = [
    source,
    ...Array.from({ length: 1001 }, (_, i) => legacy("old-" + i)),
  ];
  const payload = await inAdapterScope(owner.scope, () =>
    rest(owner.ctx, owner.conversation.id),
  );
  assert.equal(payload.claudex_inline_attachment_displays.length, 1001);
  assert.equal(
    payload.chat_messages.find((m: { text: string }) => m.text === "old-0")
      .attachments[0].kind,
    "excerpt",
  );
  const body = Buffer.from(JSON.stringify(payload));
  assert.ok(body.byteLength < 4 * 1024 * 1024);
  const identity = {};
  const root = owner.root + "-long-reader";
  const scope = newAdapterScope("owner", root, identity);
  const ctx: AdapterContext = {
    ...owner.ctx,
    stateDirectory: () => root,
    sessionIdentity: () => identity,
    readWorkspaceDownload: async () => ({
      status: 200,
      contentType: "application/json",
      body,
    }),
  };
  const projection = await inAdapterScope(scope, () =>
    projectInlineAttachmentDisplays(
      ctx,
      { ...owner.conversation, cloudHosted: true },
      ids,
    ),
  );
  assert.deepEqual(
    {
      ownerRows: payload.claudex_inline_attachment_displays.length,
      readerRows: projection.size,
    },
    { ownerRows: 1001, readerRows: 1001 },
  );
});

async function historyAnswer(
  ctx: AdapterContext,
  conversationId: string,
  requestPath?: string,
) {
  const url = new URL(
    requestPath
      ? `https://fixture.invalid${requestPath}`
      : `https://fixture.invalid/api/organizations/${organizationUuid("owner")}/chat_conversations/${conversationId}`,
  );
  let status = 0,
    body = "";
  await conversationsRoute(
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
  );
  return { status, contentType: "application/json", body: Buffer.from(body) };
}

test("fresh PB history restores legacy cards even when the owning transcript includes a compact turn", async (t) => {
  const owner = fixture(t);
  owner.conversation.turns.splice(1, 0, {
    id: "compact",
    prompt: "",
    compaction: "manual",
    attachments: [],
    items: [],
    status: "completed",
    createdAt: 2,
  });
  const ownerProjection = await inAdapterScope(owner.scope, () =>
    projectInlineAttachmentDisplays(owner.ctx, owner.conversation, ids),
  );
  assert.equal(
    ownerProjection.get(inlineDisplayKey("first", file.id))?.file_name,
    "old-note.txt",
  );
  let ownerHistoryStatus = 0;
  const identity = {};
  const root = owner.root + "-rich-reader";
  const scope = newAdapterScope("owner", root, identity);
  const conversation = { ...owner.conversation, cloudHosted: true };
  const ctx: AdapterContext = {
    ...owner.ctx,
    stateDirectory: () => root,
    sessionIdentity: () => identity,
    loadConversation: async () => conversation,
    readWorkspaceDownload: async (request) => {
      const answer = await inAdapterScope(owner.scope, () =>
        historyAnswer(owner.ctx, owner.conversation.id, request.path),
      );
      ownerHistoryStatus = answer.status;
      return answer;
    },
  };
  const registry = loadRegistry(
    path.resolve("build/official-ui/data/conversation-protocol.json"),
  );
  const requestSchema = registry.getMessage(
    "anthropic.bard.api.v1alpha.StreamTimelineRequest",
  )!;
  const responseSchema = registry.getMessage(
    "anthropic.bard.api.v1alpha.StreamTimelineResponse",
  )!;
  const route = createTimelineRpc(ctx, {
    heartbeatMs: 20,
    missingConversationWaitMs: 0,
  });
  const server = createServer((request, response) =>
    inAdapterScope(scope, () => route(request, response, STREAM_TIMELINE_PATH)),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const abort = new AbortController();
  try {
    const payload = toBinary(
      requestSchema,
      deepCreate(requestSchema, { conversationId: conversation.id }),
    );
    const header = Buffer.alloc(5);
    header.writeUInt32BE(payload.length, 1);
    const response = await fetch(
      `http://127.0.0.1:${address.port}${STREAM_TIMELINE_PATH}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/connect+proto" },
        body: Buffer.concat([header, payload]),
        signal: abort.signal,
      },
    );
    assert.equal(response.status, 200);
    const stream = response.body!.getReader();
    let accumulated = Buffer.alloc(0);
    let shownName: string | undefined;
    while (shownName === undefined) {
      const chunk = await stream.read();
      if (chunk.done) break;
      accumulated = Buffer.concat([accumulated, chunk.value]);
      while (accumulated.length >= 5) {
        const length = accumulated.readUInt32BE(1);
        if (accumulated.length < length + 5) break;
        const frame: any = fromBinary(
          responseSchema,
          accumulated.subarray(5, length + 5),
        );
        accumulated = accumulated.subarray(length + 5);
        const message =
          frame.event?.event?.case === "update"
            ? frame.event.event.value.messages.find(
                (m: { id: string }) => m.id === "first:user",
              )
            : undefined;
        if (message) shownName = message.attachments[0]?.fileName;
      }
    }
    assert.equal(
      shownName,
      "old-note.txt",
      `Owning REST history returned ${ownerHistoryStatus}; PB rendered ${shownName}`,
    );
  } finally {
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a mismatched sidecar conversation or retired activation authorizes no byte reads", async (t) => {
  const owner = fixture(t);
  const payload = await inAdapterScope(owner.scope, () =>
    rest(owner.ctx, owner.conversation.id),
  );
  const root = owner.root + "-fence-reader";
  let identity = {};
  const scope = newAdapterScope("owner", root, identity);
  let byteReads = 0;
  const ctx: AdapterContext = {
    ...owner.ctx,
    stateDirectory: () => root,
    sessionIdentity: () => identity,
    async call() {
      byteReads++;
      return { data: bytes };
    },
    async readWorkspaceDownload() {
      return {
        status: 200,
        contentType: "application/json",
        body: Buffer.from(
          JSON.stringify({ ...payload, uuid: "foreign-conversation" }),
        ),
      };
    },
  };
  const conversation = { ...owner.conversation, cloudHosted: true };
  await inAdapterScope(scope, async () => {
    assert.equal(
      (await projectInlineAttachmentDisplays(ctx, conversation, ids)).size,
      0,
    );
    ctx.readWorkspaceDownload = async () => {
      identity = {};
      return {
        status: 200,
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(payload)),
      };
    };
    await assert.rejects(
      projectInlineAttachmentDisplays(ctx, conversation, ids),
      /account changed/,
    );
    assert.equal(byteReads, 0);
  });
});

test("sidecar-only history preserves route account fences and leaves rich REST behavior unchanged", async t => {
  const f = fixture(t);
  f.conversation.turns.splice(1, 0, { ...source, id: "compact", prompt: "", items: [], compaction: "manual" });
  const query = `/api/organizations/${organizationUuid("owner")}/chat_conversations/${f.conversation.id}?claudex_inline_displays=1`;
  await inAdapterScope(f.scope, async () => {
    const before = fs.readFileSync(f.registryFile, "utf8");
    assert.equal((await historyAnswer(f.ctx, f.conversation.id)).status, 501);
    const answer = await historyAnswer(f.ctx, f.conversation.id, query);
    assert.equal(answer.status, 200);
    const value = JSON.parse(answer.body.toString());
    assert.equal(value.claudex_inline_attachment_displays.length, 2);
    assert.equal("chat_messages" in value, false);
    assert.equal((await historyAnswer(f.ctx, f.conversation.id, query + "&extra=1")).status, 501);
    assert.equal((await historyAnswer(f.ctx, f.conversation.id, query.replace(organizationUuid("owner"), organizationUuid("foreign")))).status, 404);
    const call = f.ctx.call;
    f.ctx.call = async (...args) => {
      const data = await call(...args);
      const replacement = {};
      f.ctx.sessionIdentity = () => replacement;
      return data;
    };
    assert.equal((await historyAnswer(f.ctx, f.conversation.id, query)).status, 409);
    assert.equal(fs.readFileSync(f.registryFile, "utf8"), before);
  });
});

test("an unbound legacy declaration preserves owned plain file reads across reload", async (t) => {
  const stored = structuredClone(row);
  delete stored.conversationId;
  stored.path = path.join(os.tmpdir(), "stale-legacy-path");
  const f = fixture(t, stored);
  const registry = fs.readFileSync(f.registryFile, "utf8");
  const history = JSON.stringify(f.conversation);
  for (const scope of [f.scope, newAdapterScope("owner", f.root, f.identity)]) {
    await inAdapterScope(scope, async () => {
      loadFileRegistry();
      const response = await rest(f.ctx, f.conversation.id);
      for (const message of response.chat_messages.filter((m: any) => ["first", "second", "plain"].includes(m.text))) {
        assert.equal(message.attachments.length, 0);
        assert.equal(message.files_v2[0].file_name, file.name);
      }
      const { filesRoute } = await import("../electron/official-ui/api/files");
      let status = 0, body: unknown;
      await filesRoute({ method: "GET" } as any, { writeHead(value: number) { status = value; }, end(value: unknown) { body = value; } } as any, `/api/${organizationUuid("owner")}/files/${file.id}/contents`, f.ctx);
      assert.equal(status, 200);
      assert.deepEqual(body, bytes);
      assert.deepEqual(knownFile(file.id), stored);
      flushState("files");
    });
  }
  assert.equal(fs.readFileSync(f.registryFile, "utf8"), registry);
  assert.equal(JSON.stringify(f.conversation), history);
});

test("an unbound legacy alias reads the actual history row", async (t) => {
  const stored = { ...structuredClone(row), id: "local-file" };
  delete stored.conversationId;
  const f = fixture(t, stored);
  await inAdapterScope(f.scope, async () => {
    const { aliasCloudAttachments, filesRoute } = await import("../electron/official-ui/api/files");
    aliasCloudAttachments([stored.id], [file]);
    const response = await rest(f.ctx, f.conversation.id);
    assert.equal(response.chat_messages.find((m: any) => m.text === "plain").attachments.length, 0);
    let status = 0, body: unknown;
    await filesRoute({ method: "GET" } as any, { writeHead(value: number) { status = value; }, end(value: unknown) { body = value; } } as any, `/api/${organizationUuid("owner")}/files/${stored.id}/contents`, f.ctx);
    assert.equal(status, 200);
    assert.deepEqual(body, bytes);
    assert.deepEqual(knownFile(stored.id), stored);
  });
});
