/** Actual HTTP adapter calls via inert streams/temp files, no sockets or engine. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { createNativeAccountApi } from "../electron/official-ui/api/native-account-api";
import { organizationUuid } from "../electron/official-ui/api/context";
import { setStateDir } from "../electron/official-ui/api/state";
import { currentAdapterScope } from "../electron/official-ui/api/scope";
import {
  registryFor,
  deepCreate,
  STREAM_TIMELINE_PATH,
} from "../electron/official-ui/api/timeline";
import { PERFORM_ACTION_PATH } from "../electron/official-ui/api/actions";
import { connectorUuid } from "../electron/official-ui/api/connector-auth";
import { HIWONDER_KNOWLEDGE_SERVER, HUANER_TECH } from "../shared/knowledge-api";
const fileId = "11111111-1111-4111-8111-111111111111",
  conversationId = "22222222-2222-4222-8222-222222222222";
class ResponseCapture extends EventEmitter {
  status = 0;
  chunks: Buffer[] = [];
  writableEnded = false;
  destroyed = false;
  writeHead(status: number) {
    this.status = status;
    return this;
  }
  write(value: Uint8Array | string) {
    this.chunks.push(Buffer.from(value));
    this.emit("written");
    return true;
  }
  end(value?: Uint8Array | string) {
    if (value) this.write(value);
    this.writableEnded = true;
    this.emit("close");
    return this;
  }
  get body() {
    return Buffer.concat(this.chunks);
  }
}
async function fixture(t: any) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "native-account-boundary-"),
  );
  t.after(async () => {
    await new Promise((r) => setTimeout(r, 650));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const id of ["a", "b"]) fs.mkdirSync(path.join(root, id));
  let owner: string | undefined = "a",
    identity = {},
    active = true,
    uploadWait: Promise<void> | undefined;
  const events = new Set<(event: any) => void>(),
    calls: {
      owner: string | undefined;
      scope: string;
      method: string;
      args: any[];
    }[] = [];
  let conversation: any;
  const ctx: any = {
    root: path.resolve("build/official-ui"),
    account: () => (owner ? { id: owner } : undefined),
    isCurrent: () => active,
    sessionIdentity: () => identity,
    stateDirectory: () => {
      assert.ok(owner);
      return path.join(root, owner!);
    },
    settings: () => ({
      providers: [{ id: "p", backend: "sub2api", model: "m" }],
    }),
    log() {},
    onEvent: (fn: any) => {
      events.add(fn);
      return () => events.delete(fn);
    },
    loadConversation: async () => {
      calls.push({
        owner,
        scope: currentAdapterScope().owner,
        method: "loadConversation",
        args: [],
      });
      return conversation;
    },
    ratings: () => ({}),
    call: async (method: string, ...args: any[]) => {
      calls.push({ owner, scope: currentAdapterScope().owner, method, args });
      if (method === "addAttachmentData") {
        const [name, data] = args,
          file = path.join(root, owner!, "attachments", fileId, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, data);
        if (uploadWait) await uploadWait;
        return {
          id: fileId,
          name,
          size: data.byteLength,
          path: file,
          kind: "text",
        };
      }
      if (method === "send") return { id: conversationId, turns: [] };
      throw Error("Unexpected inert call " + method);
    },
  };
  const api = createNativeAccountApi(ctx);
  const run = async (
    method: string,
    url: string,
    body?: Uint8Array,
    contentType?: string,
  ) => {
    const req: any = Readable.from(body ? [body] : []);
    Object.assign(req, {
      method,
      url,
      headers: contentType ? { "content-type": contentType } : {},
    });
    const res = new ResponseCapture();
    await api(req, res as any);
    return res;
  };
  return {
    api,
    root,
    ctx,
    events,
    calls,
    run,
    conversation: (c: any) => (conversation = c),
    switch(id: string | undefined) {
      owner = id;
      identity = {};
    },
    retire() {
      active = false;
    },
    pauseUpload(wait: Promise<void>) {
      uploadWait = wait;
    },
    async upload() {
      const form = new FormData();
      form.append(
        "file",
        new Blob(["inert A-only marker"], { type: "text/plain" }),
        "fixture.txt",
      );
      const req = new Request("https://fixture.invalid", {
        method: "POST",
        body: form,
      });
      return run(
        "POST",
        `/api/${organizationUuid(owner!)}/upload`,
        new Uint8Array(await req.arrayBuffer()),
        req.headers.get("content-type")!,
      );
    },
    filePath(id: string) {
      return `/api/${organizationUuid(id)}/files/${fileId}/contents`;
    },
  };
}
test("native default factory keeps upload/PerformAction in one account scope and never serves A file to B", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.upload()).status, 200);
  assert.equal(
    (await f.run("GET", f.filePath("a"))).body.toString(),
    "inert A-only marker",
  );
  const schema = registryFor(f.ctx.root).getMessage(
    "anthropic.bard.api.v1alpha.PerformActionRequest",
  )!;
  const body = toBinary(
    schema,
    deepCreate(schema, {
      header: { conversationId },
      action: {
        case: "sendMessage",
        value: {
          text: "inert",
          attachments: [{ id: fileId, fileName: "fixture.txt" }],
        },
      },
    }),
  );
  const own = await f.run(
    "POST",
    PERFORM_ACTION_PATH,
    body,
    "application/proto",
  );
  assert.equal(own.status, 200);
  assert.equal(f.calls.filter((c) => c.method === "send").length, 1);
  assert.deepEqual(
    f.calls.find((c) => c.method === "send")!.args[0].attachments,
    [{ id: fileId }],
  );
  assert.ok(f.calls.every((c) => c.scope === "a"));
  f.switch("b");
  assert.equal((await f.run("GET", f.filePath("b"))).status, 404);
  assert.equal((await f.run("GET", f.filePath("a"))).status, 403);
  await f.run("POST", PERFORM_ACTION_PATH, body, "application/proto");
  assert.equal(f.calls.filter((c) => c.method === "send").length, 1);
});
test("native PerformAction passes the draft knowledge selection to the first Chat send", async (t) => {
  const f = await fixture(t);
  f.ctx.knowledgeOffer = async () => ({
    baseUrl: "https://knowledge.example.test",
    bases: [{ id: HUANER_TECH, name: "Hiwonder", description: "Manuals", available: true }],
  });
  const registry = registryFor(f.ctx.root);
  const input = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
  const output = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
  const key = `${connectorUuid(HIWONDER_KNOWLEDGE_SERVER)}:rag_read`;
  const reply = await f.run("POST", PERFORM_ACTION_PATH, toBinary(input, deepCreate(input, {
    header: { conversationId },
    action: { case: "sendMessage", value: {
      text: "Read the manual",
      settingsUpdate: { settings: { enabledMcpTools: { tools: { [key]: true, "local:other:unrelated": true } } } },
    } },
  })), "application/proto");
  assert.equal(reply.status, 200);
  const message = fromBinary(output, reply.body) as { ack?: { outcome?: { case?: string } } };
  assert.equal(message.ack?.outcome?.case, "applied");
  const send = f.calls.find((call) => call.method === "send")?.args[0];
  assert.deepEqual(send?.connectorOverrides, { [HIWONDER_KNOWLEDGE_SERVER]: true });
  assert.deepEqual({ ...send?.connectorToolOverrides }, { [HIWONDER_KNOWLEDGE_SERVER]: { rag_search: false, rag_read: true } });
});
test("legacy ownerless registry is neither read nor migrated into current profile", async (t) => {
  const f = await fixture(t);
  setStateDir(f.root);
  const legacy = path.join(f.root, "legacy.txt");
  fs.writeFileSync(legacy, "legacy inert marker");
  fs.writeFileSync(
    path.join(f.root, "official-ui", "files.json"),
    JSON.stringify({
      files: [
        {
          id: fileId,
          name: "legacy.txt",
          size: 19,
          path: legacy,
          kind: "blob",
          mediaType: "text/plain",
          createdAt: 1,
        },
      ],
    }),
  );
  assert.equal((await f.run("GET", f.filePath("a"))).status, 404);
  assert.equal(fs.readFileSync(legacy, "utf8"), "legacy inert marker");
  f.switch(undefined);
  assert.equal((await f.run("GET", "/api/account")).status, 401);
  f.switch("a");
  f.retire();
  assert.equal((await f.run("GET", f.filePath("a"))).status, 409);
});
test("timeline source callbacks run in their captured account scope and retire on foreign emitter event", async (t) => {
  const f = await fixture(t);
  f.conversation({
    id: conversationId,
    title: "Inert",
    mode: "chat",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "turn",
        prompt: "A-only timeline",
        attachments: [],
        items: [],
        createdAt: 1,
        status: "completed",
      },
    ],
  });
  const schema = registryFor(f.ctx.root).getMessage(
      "anthropic.bard.api.v1alpha.StreamTimelineRequest",
    )!,
    payload = Buffer.from(
      toBinary(schema, deepCreate(schema, { conversationId })),
    ),
    header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  const res = await f.run(
    "POST",
    STREAM_TIMELINE_PATH,
    Buffer.concat([header, payload]),
    "application/connect+proto",
  );
  t.after(() => res.end());
  for (let i = 0; i < 20 && !res.chunks.length; i++)
    await new Promise((r) => setImmediate(r));
  assert.ok(res.body.includes(Buffer.from("A-only timeline")));
  assert.equal(f.events.size, 1);
  for (const cb of [...f.events])
    cb({ type: "conversation-turn", conversationId });
  await new Promise((r) => setImmediate(r));
  assert.ok(
    f.calls
      .filter((c) => c.method === "loadConversation")
      .every((c) => c.scope === "a"),
  );
  const before = f.calls.length;
  f.switch("b");
  for (const cb of [...f.events])
    cb({ type: "conversation-turn", conversationId });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.length, before);
  assert.equal(f.events.size, 0);
  res.end();
});

test("late upload completion cannot register bytes after account switch or same-owner activation replacement", async (t) => {
  for (const next of ["b", "a"]) {
    const f = await fixture(t);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    f.pauseUpload(wait);
    const pending = f.upload();
    for (
      let i = 0;
      i < 30 && !f.calls.some((c) => c.method === "addAttachmentData");
      i++
    )
      await new Promise((r) => setImmediate(r));
    assert.equal(
      f.calls.filter((c) => c.method === "addAttachmentData").length,
      1,
    );
    f.switch(next);
    release();
    const result = await pending;
    assert.notEqual(result.status, 200);
    assert.doesNotMatch(result.body.toString(), /inert A-only marker/);
    assert.equal((await f.run("GET", f.filePath(next))).status, 404);
    assert.equal(
      f.calls.filter((c) => c.method === "addAttachmentData").length,
      1,
    );
  }
});

test("same-account activation change while multipart body is pending prevents any upload dispatch", async (t) => {
  const f = await fixture(t),
    form = new FormData();
  form.append(
    "file",
    new Blob(["inert pending body"], { type: "text/plain" }),
    "fixture.txt",
  );
  const request = new Request("https://fixture.invalid", {
      method: "POST",
      body: form,
    }),
    body = Buffer.from(await request.arrayBuffer());
  const req: any = new PassThrough();
  Object.assign(req, {
    method: "POST",
    url: `/api/${organizationUuid("a")}/upload`,
    headers: { "content-type": request.headers.get("content-type") },
  });
  const res = new ResponseCapture(),
    pending = f.api(req, res as any);
  await new Promise((r) => setImmediate(r));
  req.write(body.subarray(0, 10));
  f.switch("a");
  req.end(body.subarray(10));
  await pending;
  assert.notEqual(res.status, 200);
  assert.equal(
    f.calls.filter((c) => c.method === "addAttachmentData").length,
    0,
  );
  assert.equal((await f.run("GET", f.filePath("a"))).status, 404);
});

test("native factory rejects malformed empty identity without constraining valid opaque identities", async (t) => {
  const f = await fixture(t);
  f.ctx.sessionIdentity = () => "";
  assert.equal((await f.run("GET", f.filePath("a"))).status, 409);
  assert.equal(f.calls.length, 0);
  for (const identity of [{}, 0, "nonempty"]) {
    f.ctx.sessionIdentity = () => identity;
    assert.equal((await f.run("GET", f.filePath("a"))).status, 404);
  }
});
