import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Attachment, Conversation } from "../shared/types";
import { prepareUploadReceipt, commitUploadReceipts, readConfirmedUploadReceipt } from "../electron/cloud/upload-receipts";
import { CloudRouter, type CloudCalls } from "../electron/cloud/cloud-router";
function fixture(t: { after(fn: () => void): void }, aliased = false) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const parent = path.join(temp, "real"), alias = path.join(temp, "alias");
  fs.mkdirSync(parent);
  if (aliased) fs.symlinkSync(parent, alias, process.platform === "win32" ? "junction" : "dir");
  const root = path.join(aliased ? alias : parent, "profile");
  const localId = randomUUID(), name = "note.txt", data = Buffer.from("own inert bytes");
  const dir = path.join(root, "attachments", localId); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name); fs.writeFileSync(file, data);
  const local: Attachment = { id: localId, name, path: file, size: data.length, kind: "text" };
  const remote: Attachment = { ...local, id: randomUUID(), path: "/remote/not-consumed" };
  const conversation = { id: "owned-c", mode: "chat", turns: [{ attachments: [remote] }] } as Conversation;
  let active = true;
  const scope = { root, service: "https://inert.invalid", current: () => active };
  return { temp, alias, root, local, remote, conversation, data, scope, retire: () => { active = false; } };
}
test("stable parent aliases support receipt reload and existing canonical journal identity", t => {
  const f = fixture(t, true), canonical = fs.realpathSync(f.root);
  assert.notEqual(f.root, canonical);
  // A pre-existing canonical v1 journal stays readable through a stable alias.
  const scope = { ...f.scope, root: canonical }, local = { ...f.local, path: fs.realpathSync(f.local.path) };
  commitUploadReceipts(scope, f.conversation, [prepareUploadReceipt(scope, local, f.data, f.remote)]);
  assert.deepEqual(readConfirmedUploadReceipt(f.scope, f.conversation, f.remote.id)!.data, new Uint8Array(f.data));
  commitUploadReceipts(f.scope, f.conversation, [prepareUploadReceipt(f.scope, f.local, f.data, f.remote)]);
  assert.deepEqual(readConfirmedUploadReceipt({ ...f.scope }, structuredClone(f.conversation), f.remote.id)!.data, new Uint8Array(f.data));
});
test("retargeted parent cannot commit a pending upload or reuse a copied journal after restart", t => {
  const f = fixture(t, true), pending = prepareUploadReceipt(f.scope, f.local, f.data, f.remote);
  commitUploadReceipts(f.scope, f.conversation, [pending]);
  const other = path.join(f.temp, "other");
  fs.mkdirSync(other);
  fs.cpSync(f.root, path.join(other, "profile"), { recursive: true });
  fs.unlinkSync(f.alias);
  fs.symlinkSync(other, f.alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => commitUploadReceipts(f.scope, f.conversation, [pending]), /profile changed/);
  assert.throws(() => readConfirmedUploadReceipt(f.scope, f.conversation, f.remote.id), /profile changed/);
  assert.throws(() => readConfirmedUploadReceipt({ ...f.scope }, f.conversation, f.remote.id), /different profile/);
});
test("replacing a pinned profile directory cannot reuse pending receipt authority", t => {
  const f = fixture(t), pending = prepareUploadReceipt(f.scope, f.local, f.data, f.remote);
  fs.renameSync(f.root, f.root + ".old");
  fs.cpSync(f.root + ".old", f.root, { recursive: true });
  assert.throws(() => commitUploadReceipts(f.scope, f.conversation, [pending]), /profile changed/);
});
test("actual upload response commits exact conversation row, reloads only canonical bytes and ignores legacy aliases", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "files.json"), JSON.stringify({ aliases: [[f.remote.id, f.local.id]] }));
  assert.equal(readConfirmedUploadReceipt(f.scope, f.conversation, f.remote.id), undefined);
  const pending = prepareUploadReceipt(f.scope, f.local, f.data, f.remote);
  assert.equal(readConfirmedUploadReceipt(f.scope, f.conversation, f.remote.id), undefined);
  commitUploadReceipts(f.scope, f.conversation, [pending]);
  const result = readConfirmedUploadReceipt({ ...f.scope }, structuredClone(f.conversation), f.remote.id)!;
  assert.deepEqual(result.data, new Uint8Array(f.data));
  assert.equal("path" in result, false);
  assert.equal(readConfirmedUploadReceipt(f.scope, { ...f.conversation, id: "other" }, f.remote.id), undefined);
});
test("unconfirmed response, foreign scope, retirement and content replacement cannot restore", t => {
  const f = fixture(t), p = prepareUploadReceipt(f.scope, f.local, f.data, f.remote);
  assert.throws(() => commitUploadReceipts(f.scope, { ...f.conversation, turns: [] }, [p]));
  assert.throws(() => prepareUploadReceipt(f.scope, f.local, f.data, { ...f.remote, size: 99 }));
  commitUploadReceipts(f.scope, f.conversation, [p]);
  assert.throws(() => readConfirmedUploadReceipt({ ...f.scope, service: "https://different.invalid" }, f.conversation, f.remote.id));
  fs.writeFileSync(f.local.path, "X".repeat(f.data.length));
  assert.throws(() => readConfirmedUploadReceipt(f.scope, f.conversation, f.remote.id));
  f.retire(); assert.throws(() => readConfirmedUploadReceipt(f.scope, f.conversation, f.remote.id));
});
test("reject journal path injection, duplicate records, old schema and symlink substitution", t => {
  const f = fixture(t), p = prepareUploadReceipt(f.scope, f.local, f.data, f.remote);
  commitUploadReceipts(f.scope, f.conversation, [p]);
  const file = path.join(f.root, "confirmed-upload-receipts-v1.json"), original = fs.readFileSync(file, "utf8");
  for (const mutate of [(j: any) => { j.rows[0].path = "/other"; }, (j: any) => { j.rows.push(j.rows[0]); }, (j: any) => { j.version = 0; }, (j: any) => { j.rows[0].localId = "../other"; }]) {
    const j = JSON.parse(original); mutate(j); fs.writeFileSync(file, JSON.stringify(j));
    assert.throws(() => readConfirmedUploadReceipt(f.scope, f.conversation, f.remote.id));
  }
  fs.writeFileSync(file, original);
  fs.renameSync(f.local.path, f.local.path + ".old"); fs.symlinkSync(f.local.path + ".old", f.local.path);
  assert.throws(() => readConfirmedUploadReceipt(f.scope, f.conversation, f.remote.id));
});
test("same local copy may have independent confirmed rows without overwriting earlier conversation", t => {
  const f = fixture(t), p = prepareUploadReceipt(f.scope, f.local, f.data, f.remote);
  commitUploadReceipts(f.scope, f.conversation, [p]);
  const remote = { ...f.remote, id: randomUUID() }, c = { ...f.conversation, id: "second", turns: [{ attachments: [remote] }] } as Conversation;
  commitUploadReceipts(f.scope, c, [prepareUploadReceipt(f.scope, f.local, f.data, remote)]);
  assert.ok(readConfirmedUploadReceipt(f.scope, f.conversation, f.remote.id));
  assert.ok(readConfirmedUploadReceipt(f.scope, c, remote.id));
});
function routerFixture(t: { after(fn: () => void): void }, send: (f: ReturnType<typeof fixture>) => Promise<unknown> | unknown) {
  const f = fixture(t), calls: string[] = [];
  const client: CloudCalls = { snapshot: async () => { throw Error("unused"); }, call: async (method) => {
    calls.push(method); return method === "conversationTurns" ? {turns:[{id:"turn",attachments:[f.remote]}]} : method === "addAttachmentData" ? f.remote : send(f);
  } };
  const router = new CloudRouter({ client: () => client, push() {}, attachmentBytes: async () => ({ name: f.local.name, data: f.data }),
    receiptScope: () => ({ ...f.scope, attachment: id => id === f.local.id ? f.local : undefined }) });
  return { ...f, router, calls };
}
test("real router upload/send binds response, restart restores; failed receipt write does not replay or reject accepted send", async t => {
  const f = routerFixture(t, f => f.conversation);
  const result = await f.router.send({ mode: "chat", attachments: [f.local] } as never, () => { throw Error("local"); });
  assert.equal((result as Conversation).id, f.conversation.id);
  assert.ok(readConfirmedUploadReceipt(f.scope, f.conversation, f.remote.id));
  assert.deepEqual(f.calls, ["addAttachmentData", "send"]);
  fs.unlinkSync(path.join(f.root, "confirmed-upload-receipts-v1.json"));
  fs.mkdirSync(path.join(f.root, "confirmed-upload-receipts-v1.json"));
  assert.equal((await f.router.send({ mode: "chat", attachments: [f.local] } as never, () => undefined) as Conversation).id, f.conversation.id);
  assert.deepEqual(f.calls, ["addAttachmentData", "send", "addAttachmentData", "send"]);
});
test("retirement during upload prevents send and does not mint; unconfirmed conversation never binds", async t => {
  const f = fixture(t); let finish!: (value: Attachment) => void; const calls: string[] = [];
  const client: CloudCalls = { snapshot: async () => { throw Error(); }, call: async method => { calls.push(method); return new Promise<Attachment>(resolve => { finish = resolve; }); } };
  const router = new CloudRouter({ client: () => client, push() {}, attachmentBytes: async () => ({name:f.local.name,data:f.data}), receiptScope: () => ({ ...f.scope, attachment: () => f.local }) });
  const sending = router.send({mode:"chat",attachments:[f.local]} as never, () => {});
  await new Promise(resolve => setImmediate(resolve)); router.reset(); finish(f.remote);
  await assert.rejects(sending); assert.deepEqual(calls,["addAttachmentData"]);
  assert.equal(readConfirmedUploadReceipt(f.scope,f.conversation,f.remote.id),undefined);
  const other = routerFixture(t, f => ({...f.conversation, turns:[]}));
  await other.router.send({mode:"chat",attachments:[other.local]} as never,()=>{});
  assert.equal(readConfirmedUploadReceipt(other.scope,other.conversation,other.remote.id),undefined);
});
test("edit and retry explicit new attachments use uploaded exact IDs and owned returned row", async t => {
  for (const method of ["editPrompt", "retryResponse"]) {
    const f = routerFixture(t, f => f.conversation); f.router.conversations.add(f.conversation.id);
    const args = method === "editPrompt" ? [f.conversation.id,"turn","new","provider","model",{attachments:[{id:f.local.id}]}] : [f.conversation.id,"turn","provider","model",{attachments:[{id:f.local.id}]}];
    await f.router.route(method,()=>{throw Error("local");})(...args);
    assert.deepEqual(f.calls,["conversationTurns","addAttachmentData",method]);
    assert.ok(readConfirmedUploadReceipt(f.scope,f.conversation,f.remote.id));
  }
});

test("parallel upload batches with the same service ID cannot borrow another operation's receipt", async t => {
  const f = fixture(t), secondId = randomUUID(), secondFile = path.join(f.root,"attachments",secondId,f.local.name);
  fs.mkdirSync(path.dirname(secondFile),{recursive:true});
  const secondData = Buffer.from("X".repeat(f.data.length)); fs.writeFileSync(secondFile,secondData);
  const second = {...f.local,id:secondId,path:secondFile};
  const client: CloudCalls = {snapshot:async()=>{throw Error();},call:async method=>method==="addAttachmentData"?f.remote:f.conversation};
  const router = new CloudRouter({client:()=>client,push(){},receiptScope:()=>({...f.scope,attachment:id=>id===secondId?second:f.local}),
    attachmentBytes:async id=>({name:f.local.name,data:id===secondId?secondData:f.data})});
  await router.cloudAttachments([f.local]);
  const batch = await router.cloudAttachments([second]);
  await router.cloud("send",[{attachments:batch}],batch);
  assert.deepEqual(readConfirmedUploadReceipt(f.scope,f.conversation,f.remote.id)!.data,new Uint8Array(secondData));
});
test("conflicting confirmed row is invalidated instead of returning the earlier bytes", t => {
  const f=fixture(t); commitUploadReceipts(f.scope,f.conversation,[prepareUploadReceipt(f.scope,f.local,f.data,f.remote)]);
  const changed=Buffer.from("X".repeat(f.data.length));fs.writeFileSync(f.local.path,changed);
  const next=prepareUploadReceipt(f.scope,f.local,changed,f.remote);
  assert.throws(()=>commitUploadReceipts(f.scope,f.conversation,[next]),/Conflicting/);
  assert.equal(readConfirmedUploadReceipt(f.scope,f.conversation,f.remote.id),undefined);
});

test("retry existing remote attachment preserves old ID validation and does not upload or fabricate receipt", async t => {
  const f=routerFixture(t,f=>f.conversation); f.router.conversations.add(f.conversation.id);
  await f.router.route("retryResponse",()=>{throw Error("local");})(f.conversation.id,"turn","provider","model",{attachments:[{id:f.remote.id}]});
  assert.deepEqual(f.calls,["conversationTurns","retryResponse"]);
  assert.equal(readConfirmedUploadReceipt(f.scope,f.conversation,f.remote.id),undefined);
});
test("failed send leaves no committed receipt and does not replay the model", async t => {
  const f=routerFixture(t,()=>{throw Error("send failed");});
  await assert.rejects(f.router.send({mode:"chat",attachments:[f.local]} as never,()=>{}),/send failed/);
  assert.deepEqual(f.calls,["addAttachmentData","send"]);
  assert.equal(readConfirmedUploadReceipt(f.scope,f.conversation,f.remote.id),undefined);
});

test("caller-provided new conversation ID must match before recording an upload receipt", async t => {
  const f=routerFixture(t,f=>f.conversation);
  const result=await f.router.send({mode:"chat",newConversationId:"different-new-id",attachments:[f.local]} as never,()=>{});
  assert.equal((result as Conversation).id,f.conversation.id);
  assert.equal(readConfirmedUploadReceipt(f.scope,f.conversation,f.remote.id),undefined);
});
