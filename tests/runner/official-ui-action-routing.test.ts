import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { officialUiRead } from "../../runner/src/official-ui-read";
import { encodeWireValue, decodeWireValue } from "../../shared/web-wire";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { negotiatedOfficialAction, readOfficialCapabilities } from "../../src-web/official/negotiated-action";
import type { OfficialUiReadRequest } from "../../shared/official-ui-web";
import type { Project } from "../../shared/types";
import { openPolicy } from "../../shared/client-policy";
import { imageSizeFixtures } from "../fixtures/official-image-size-data";
import { createOfficialChatUpload } from "../../src-web/official/chat-upload";

const id = "22222222-2222-4222-8222-222222222222";

test("original Chat multipart upload reaches the owned Runner store and previews the same image", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-chat-upload-"));
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const gif = imageSizeFixtures.find((fixture) => fixture.name === "supported.gif")!;
  const original = Buffer.from(gif.base64, "base64");
  const account = { id: "owner" }, identity = {};
  const selectedAttachments = new Map();
  const ctx = {
    userId: 1, activeAccount: account, store: { root, settings: {}, conversations: [] }, selectedAttachments,
    signedOut: false, closedFlag: false, officialSessionIdentity: () => identity,
    onEvent: () => () => {}, setAccessToken() {}, log() {}, appVersion: "test",
    policy: () => openPolicy,
    runtime: { imageSize: async (bytes: Buffer) => bytes.equals(original) ? { width: 37, height: 23 } : undefined },
  };
  const dispatcher = {
    methods: [],
    options: { officialUiRoot: root, officialUiActions: true },
    guard: { modes: ["chat"] },
    contextFor: async () => ctx, context: () => ctx, now: () => 1,
    async run(frame: { method: string; args: unknown[] }) {
      assert.equal(frame.method, "addAttachmentData");
      const [name, data] = decodeWireValue(frame.args) as [string, Uint8Array];
      assert.equal(name, gif.name);
      assert.deepEqual(Buffer.from(data), original);
      const file = path.join(root, "attachments", id, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      selectedAttachments.set(id, { id, name, kind: "image", size: data.byteLength, path: file });
      return { id, name, kind: "image", size: data.byteLength };
    },
  };
  const call = (method: string) => (request: OfficialUiReadRequest) => officialUiRead(
    dispatcher as never, { method, args: encodeWireValue([request]), user: { id: 1, accessToken: "fixture" } } as never,
  );
  const read = call("officialUiRead");
  const action = call("officialUiAction");
  const negotiated = negotiatedOfficialAction({ mode: "engine-chat", accountId: "1", isCurrent: () => true, read, action });
  const org = organizationUuid(account.id);
  const route = `/api/${org}/upload`;
  const form = new FormData();
  form.append("file", new Blob([original], { type: "image/gif" }), gif.name);
  const request = new Request(`https://fixture.test${route}`, { method: "POST", body: form });
  const response = await action({ method: "POST", path: route,
    contentType: request.headers.get("content-type")!, body: new Uint8Array(await request.arrayBuffer()) });
  assert.equal(response.status, 403);
  assert.equal(selectedAttachments.size, 0);
  const frame = new AbortController();
  const upload = createOfficialChatUpload({ origin: "https://fixture.test", organization: org, signal: frame.signal, action: negotiated });
  assert.equal(upload(`${route}?store_as_is=true`, form), undefined);
  assert.equal((await upload(`/api/${organizationUuid("other")}/upload`, form))?.status, 404);
  const damaged = new FormData();
  damaged.append("file", new Blob([original.subarray(0, 9)], { type: "image/gif" }), gif.name);
  assert.equal((await upload(route, damaged))?.status, 400);
  assert.equal(selectedAttachments.size, 0);
  const uploaded = await upload(route, form);
  assert.equal(uploaded?.status, 200, await uploaded?.clone().text());
  const card = await uploaded!.json();
  assert.equal(card.file_uuid, id);
  assert.equal(card.file_kind, "image");
  assert.equal(card.preview_asset.image_width, 37);
  const preview = await read({ method: "GET", path: card.preview_url });
  assert.equal(preview.status, 200);
  assert.equal(preview.contentType, "image/gif");
  assert.deepEqual(Buffer.from(preview.body), original);
  frame.abort();
  await assert.rejects(upload(route, form)!, { name: "AbortError" });
  assert.equal(selectedAttachments.size, 1);
});
test("original Cowork multipart upload reaches the owned Runner store and previews the same image", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-chat-upload-"));
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const gif = imageSizeFixtures.find((fixture) => fixture.name === "supported.gif")!;
  const original = Buffer.from(gif.base64, "base64");
  const account = { id: "owner" }, identity = {};
  const selectedAttachments = new Map();
  const ctx = {
    userId: 1, activeAccount: account, store: { root, settings: {}, conversations: [] }, selectedAttachments,
    signedOut: false, closedFlag: false, officialSessionIdentity: () => identity,
    onEvent: () => () => {}, setAccessToken() {}, log() {}, appVersion: "test",
    policy: () => openPolicy,
    runtime: { imageSize: async (bytes: Buffer) => bytes.equals(original) ? { width: 37, height: 23 } : undefined },
  };
  const dispatcher = {
    methods: [],
    options: { officialUiRoot: root, officialUiActions: true },
    guard: { modes: ["chat", "cowork"] },
    contextFor: async () => ctx, context: () => ctx, now: () => 1,
    async run(frame: { method: string; args: unknown[] }) {
      assert.equal(frame.method, "addAttachmentData");
      const [name, data] = decodeWireValue(frame.args) as [string, Uint8Array];
      assert.equal(name, gif.name);
      assert.deepEqual(Buffer.from(data), original);
      const file = path.join(root, "attachments", id, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      selectedAttachments.set(id, { id, name, kind: "image", size: data.byteLength, path: file });
      return { id, name, kind: "image", size: data.byteLength };
    },
  };
  const call = (method: string) => (request: OfficialUiReadRequest) => officialUiRead(
    dispatcher as never, { method, args: encodeWireValue([request]), user: { id: 1, accessToken: "fixture" } } as never,
  );
  const read = call("officialUiRead");
  const action = call("officialUiAction");
  const negotiated = negotiatedOfficialAction({ mode: "engine-chat", accountId: "1", isCurrent: () => true, read, action });
  const org = organizationUuid(account.id);
  const route = `/api/organizations/${org}/cowork/attachments`;
  const form = new FormData();
  form.append("file", new Blob([original], { type: "image/gif" }), gif.name);
  const request = new Request(`https://fixture.test${route}`, { method: "POST", body: form });
  const response = await action({ method: "POST", path: route,
    contentType: request.headers.get("content-type")!, body: new Uint8Array(await request.arrayBuffer()) });
  assert.equal(response.status, 403);
  assert.equal(selectedAttachments.size, 0);
  const frame = new AbortController();
  const upload = createOfficialChatUpload({ origin: "https://fixture.test", organization: org, signal: frame.signal, action: negotiated });
  assert.equal(upload(`${route}?store_as_is=true`, form), undefined);
  assert.equal((await upload(`/api/${organizationUuid("other")}/upload`, form))?.status, 404);
  const damaged = new FormData();
  damaged.append("file", new Blob([original.subarray(0, 9)], { type: "image/gif" }), gif.name);
  assert.equal((await upload(route, damaged))?.status, 400);
  assert.equal(selectedAttachments.size, 0);
  const uploaded = await upload(route, form);
  assert.equal(uploaded?.status, 200, await uploaded?.clone().text());
  const card = await uploaded!.json();
  assert.equal(card.file_uuid, id);
  assert.equal(card.file_kind, "image");
  assert.equal(card.preview_asset.image_width, 37);
  const preview = await read({ method: "GET", path: card.preview_url });
  assert.equal(preview.status, 200);
  assert.equal(preview.contentType, "image/gif");
  assert.deepEqual(Buffer.from(preview.body), original);
  frame.abort();
  await assert.rejects(upload(route, form)!, { name: "AbortError" });
  assert.equal(selectedAttachments.size, 1);
});
test("authenticated action routing gates REST mutations separately from reads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-action-route-"));
  const identity = {};
  const calls: string[] = [];
  const ctx = {
    userId: "a",
    activeAccount: { id: "a" },
    store: { root, settings: {} },
    signedOut: false,
    closedFlag: false,
    officialSessionIdentity: () => identity,
    setAccessToken() {},
    onEvent: () => () => {},
    log() {},
    appVersion: "test",
    lastActive: 0,
  };
  const dispatcher = {
    options: { officialUiRoot: root, officialUiActions: true },
    guard: { modes: ["chat"] },
    contextFor: async () => ctx,
    context: () => ctx,
    now: () => 1,
    run: async (frame: any, expected: any) => {
      assert.equal(expected.context, ctx);
      assert.equal(expected.identity, identity);
      assert.equal(frame.user.id, "a");
      assert.equal(frame.user.accessToken, "local-fixture");
      calls.push(frame.method);
      if (frame.method === "snapshot")
        return {
          conversations: [{ id, mode: "chat", turns: [] }],
          projects: [],
        };
      if (frame.method === "conversationTurns") return { turns: [] };
      if (frame.method === "updateConversation") {
        assert.deepEqual(decodeWireValue(frame.args), [id, { title: "After" }]);
        return {};
      }
      throw Error(`Unexpected ${frame.method}`);
    },
  };
  const request = {
    method: "PATCH",
    path: `/api/organizations/${organizationUuid("a")}/chat_conversations/${id}`,
    contentType: "application/json",
    body: new TextEncoder().encode('{"name":"After"}'),
  };
  const frame = {
    method: "officialUiAction",
    args: encodeWireValue([request]),
    user: { id: "a", accessToken: "local-fixture" },
  };
  try {
    await assert.rejects(
      officialUiRead(
        dispatcher as never,
        { ...frame, method: "officialUiRead" } as never,
      ),
      /Invalid official Web request/,
    );
    assert.deepEqual(calls, []);
    dispatcher.options.officialUiActions = false;
    await assert.rejects(
      officialUiRead(dispatcher as never, frame as never),
      /Not available/,
    );
    assert.deepEqual(calls, []);
    dispatcher.options.officialUiActions = true;
    const result = (await officialUiRead(
      dispatcher as never,
      frame as never,
    )) as { status: number };
    assert.equal(result.status, 200);
    assert.equal(
      calls.filter((method) => method === "updateConversation").length,
      1,
    );
    ctx.signedOut = true;
    await assert.rejects(
      officialUiRead(dispatcher as never, frame as never),
      /session has ended/,
    );
    assert.equal(
      calls.filter((method) => method === "updateConversation").length,
      1,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the original project DELETE uses a current Chat lease and the account's writable project", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-project-delete-route-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let identity = {};
  let projects: Project[] = [{ id, name: "Fixture project", description: "", instructions: "", createdAt: 1 }];
  let failDelete = false;
  let deletes = 0;
  const ctx = {
    userId: 1, activeAccount: { id: "owner" }, store: { root, settings: {} },
    signedOut: false, closedFlag: false, officialSessionIdentity: () => identity,
    onEvent: () => () => {}, setAccessToken() {}, log() {}, appVersion: "test",
  };
  const dispatcher = {
    options: { officialUiRoot: root, officialUiActions: true },
    guard: { modes: ["chat"] },
    contextFor: async () => ctx, context: () => ctx, now: () => 1,
    async run(frame: { method: string; args: unknown[] }, expected: { context: unknown; identity: unknown }) {
      assert.equal(expected.context, ctx);
      assert.equal(expected.identity, identity);
      if (frame.method === "snapshot") return { projects, conversations: [] };
      if (frame.method === "listProjectKnowledge") return { files: [] };
      assert.equal(frame.method, "deleteProject");
      assert.deepEqual(decodeWireValue(frame.args), [{ id, mode: "cascade" }]);
      deletes++;
      if (failDelete) throw Error("Fixture storage failure /private/path");
      projects = [];
    },
  };
  const call = (method: string) => async (request: OfficialUiReadRequest) => officialUiRead(
    dispatcher as never,
    { method, args: encodeWireValue([request]), user: { id: 1, accessToken: "fixture" } } as never,
  );
  const read = call("officialUiRead");
  const action = call("officialUiAction");
  const fetch = createOfficialReadFetch(
    "https://fixture.test", read, async () => { throw Error("Unexpected network"); },
    undefined, negotiatedOfficialAction({ mode: "engine-chat", accountId: "1", isCurrent: () => true, read, action }),
  );
  const base = `/api/organizations/${organizationUuid("owner")}/projects/${id}`;
  const request = { method: "DELETE", path: base } as const;
  const deletePermission = "chat_project:delete";
  assert.equal((await action(request)).status, 409);
  const { activationLease } = await readOfficialCapabilities(read, "1");
  identity = {};
  assert.equal((await action({ ...request, capabilityLease: activationLease })).status, 409);
  assert.equal((await fetch(base + "?cascade=false", request)).status, 501);
  assert.equal((await fetch(base.replace("/projects/", "/projects_v2/"), request)).status, 501);
  assert.equal((await fetch(base.replace(organizationUuid("owner"), organizationUuid("other")), request)).status, 404);
  assert.equal((await fetch(base, { ...request, body: "{}" })).status, 400);

  assert.ok((await (await fetch(base)).json()).permissions.includes(deletePermission));
  for (const change of [
    { visibility: "organization" },
    { capabilities: { canEditInstructions: false, canEditKnowledgeBase: false } },
  ]) {
    const project = projects[0];
    projects = [{ ...project, ...change }];
    assert.ok(!(await (await fetch(base)).json()).permissions.includes(deletePermission));
    assert.equal((await fetch(base, request)).status, 403);
    projects = [project];
  }
  assert.equal(deletes, 0);

  failDelete = true;
  const failed = await fetch(base, request);
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /private\/path/);
  assert.equal((await fetch(base)).status, 200);
  failDelete = false;
  const deleted = await fetch(base, request);
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), "");
  assert.equal((await fetch(base)).status, 404);
  assert.equal((await fetch(base, request)).status, 404);
  assert.equal(deletes, 2);
});
