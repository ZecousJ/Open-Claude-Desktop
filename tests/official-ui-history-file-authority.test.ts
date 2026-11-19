/** Actual import and composer handlers; only inert self-created temp bytes, no account lifecycle hooks. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebTransport } from "../shared/web-client/transport";
import { encodeWireValue, decodeWireValue } from "../shared/web-wire";
import { CloudRouter } from "../electron/cloud/cloud-router";
import { route } from "../electron/cloud/cloud-route";
import { registerCloudSyncHandlers } from "../electron/ipc/cloud-sync";
import { registerComposerHandlers } from "../electron/ipc/composer";
import { filesRoute, learnAttachment } from "../electron/official-ui/api/files";
import { organizationUuid } from "../electron/official-ui/api/context";
import { newAdapterScope, inAdapterScope } from "../electron/official-ui/api/scope";

async function fixture(t: any, outside: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, "profile"), storeDir = path.join(profile, "attachments");
  fs.mkdirSync(storeDir, { recursive: true });
  const file = path.join(outside ? root : storeDir, "inert.txt");
  fs.writeFileSync(file, "inert-marker");
  const handlers = new Map<string, (...args: any[]) => any>();
  const store: any = { root: profile, projects: [], conversations: [], flush() {},
    conversation: (id: string) => { const c = store.conversations.find((v: any) => v.id === id); if (!c) throw Error("Missing"); return c; } };
  const ctx: any = { store, push() {}, spaceFolder: () => path.join(root, "space") };
  // No onAccountActivated hook: registering handlers cannot start GitHub/other services.
  const register: any = (name: string, fn: any) => handlers.set(name, fn);
  registerCloudSyncHandlers(register, ctx);
  registerComposerHandlers(register, ctx);
  const imported = { id: "imported", title: "Inert imported fixture", mode: "chat", providerId: "p", model: "m", createdAt: 1, updatedAt: 1,
    turns: [{ id: "turn", status: "completed", attachments: [{ id: "f", name: "inert.txt", size: 12, kind: "text", path: file }] }] };
  assert.equal((await handlers.get("importConversation")!({ conversation: new Uint8Array(Buffer.from(JSON.stringify(imported))), rollouts: [] })).state, "imported");
  assert.equal(store.conversation("imported").turns[0].attachments[0].path, file);
  const scope = newAdapterScope("history-authority");
  let calls = 0, status = 0, body: any, generation = 1;
  const diagnostic: unknown[][] = [];
  const adapter: any = { log: (...args:unknown[])=>diagnostic.push(args), account: () => ({ id: "owner" }), sessionIdentity: () => generation,
    call: async (method: string, conversation: string, id: string) => {
      calls++; assert.equal(method, "turnAttachment"); assert.equal(conversation, "imported"); assert.equal(id, "f");
      return handlers.get(method)!(conversation, id);
    } };
  const run = () => inAdapterScope(scope, () => filesRoute({ method: "GET" } as any,
    { writeHead: (n: number) => status = n, end: (v: any) => body = v } as any,
    `/api/${organizationUuid("owner")}/files/f/contents`, adapter));
  return { file, adapter, scope, store, run, diagnostic, learn: () => inAdapterScope(scope, () => learnAttachment(store.conversation("imported").turns[0].attachments[0], "imported")),
    retire: () => generation++, get status() { return status; }, get body() { return body; }, get calls() { return calls; } };
}
test("actual imported outside path never reaches filesystem content read or response", async t => {
  const f = await fixture(t, true);
  const read = fs.readFileSync, open = fs.openSync;
  t.mock.method(fs, "readFileSync", (...args: any[]) => { assert.notEqual(args[0], f.file, "outside content read"); return (read as any)(...args); });
  t.mock.method(fs, "openSync", (...args: any[]) => { assert.notEqual(args[0], f.file, "outside fd opened"); return (open as any)(...args); });
  const learned = f.learn(); assert.equal(learned.path, undefined);
  await f.run(); assert.equal(f.calls, 1); assert.equal(f.status, 404);
  assert.doesNotMatch(String(f.body), /inert-marker/); assert.ok(!String(f.body).includes(f.file));
});
test("actual owned profile attachment remains readable through authoritative history service", async t => {
  const f = await fixture(t, false); f.learn(); await f.run();
  assert.equal(f.calls, 1); assert.equal(f.status, 200); assert.equal(f.body.toString(), "inert-marker");
});
test("bound cached local path cannot bypass service refusal and authoritative history cap is 32 MiB", async t => {
  const f = await fixture(t, false); const record = f.learn();
  record.path = f.file; // Legacy persisted registry still contains a path.
  f.adapter.call = async () => null;
  await f.run(); assert.equal(f.status, 404); assert.doesNotMatch(String(f.body), /inert-marker/);
  record.size = 32 * 1024 * 1024 + 1;
  f.adapter.call = async () => { throw Error("must not dispatch over cap"); };
  await f.run(); assert.equal(f.status, 413);
});
test("history source error and activation retirement never fall back to cached local path", async t => {
  const f = await fixture(t, false); const record = f.learn(); record.path = f.file;
  f.adapter.call = async () => { throw Error("private source path"); };
  await f.run(); assert.equal(f.status, 503); assert.doesNotMatch(String(f.body), /inert-marker|private source/);
  f.adapter.call = async () => { f.retire(); return { data: new Uint8Array(Buffer.from("inert-marker")) }; };
  await f.run(); assert.equal(f.status, 409); assert.doesNotMatch(String(f.body), /inert-marker/);
});

test("actual registered owned handler survives cloud routing and RPC byte codec before file preview", async t => {
 const f=await fixture(t,false);f.learn();
 const registeredCall=f.adapter.call;
 let requests=0;
 const transport=new WebTransport({timers:{setTimeout,clearTimeout} as any,fetch:async (_url:any,init:any)=>{
   requests++;const args=decodeWireValue(JSON.parse(String(init.body)).args) as any[];
   const result=await registeredCall('turnAttachment',...args);
   assert.ok(result.data instanceof Uint8Array);
   return new Response(JSON.stringify({ok:true,value:encodeWireValue(result)}),{status:200,headers:{'Content-Type':'application/json'}});
 }} as any,{accessToken:async()=> 'synthetic-only',refresh:async()=>null,expire(){throw Error('unexpected expire');}},'synthetic-tab');
 // The real account keeps one client instance until its activation changes.
 // Returning a new object per getter falsely signals retirement after the RPC.
 const client={call:(name:string,args:any[])=>transport.call(name,JSON.stringify({args:encodeWireValue(args)}))};
 const router=new CloudRouter({client:()=>client} as any);
 router.conversations.add('imported');
 const routed=route.call(router,'turnAttachment',()=>{throw Error('must use cloud route');});
 f.adapter.call=async(name:string,...args:any[])=>{assert.equal(name,'turnAttachment');return routed(...args);};
 await f.run();assert.equal(requests,1);assert.equal(f.status,200);assert.equal(f.body.toString(),'inert-marker');
});

test("client replacement while an owned cloud attachment read awaits rejects without local fallback", async t => {
 const f=await fixture(t,false);f.learn();
 const registeredCall=f.adapter.call;
 let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve);
 const pending=new Promise<void>(resolve=>release=resolve);
 let remoteCalls=0,localCalls=0,replacementCalls=0;
 const original={call:async(name:string,args:any[])=>{
   remoteCalls++;assert.equal(name,'turnAttachment');
   const result=await registeredCall(name,...args);
   assert.equal(Buffer.from(result.data).toString(),'inert-marker');
   entered();await pending;return result;
 }};
 let active:typeof original=original;
 const router=new CloudRouter({client:()=>active} as any);
 router.conversations.add('imported');
 const routed=route.call(router,'turnAttachment',()=>{localCalls++;throw Error('must not fall back');});
 f.adapter.call=async(name:string,...args:any[])=>{assert.equal(name,'turnAttachment');return routed(...args);};
 const running=f.run();await started;
 active={call:async()=>{replacementCalls++;throw Error('must not retry on replacement');}};
 release();await running;
 assert.equal(f.status,503);assert.equal(remoteCalls,1);
 assert.equal(localCalls,0);assert.equal(replacementCalls,0);
 assert.doesNotMatch(String(f.body),/inert-marker/);
 assert.ok(!String(f.body).includes(f.file));
});

test("contents diagnostics distinguish owned service failures without identifiers or raw messages",async t=>{
 const f=await fixture(t,false);f.learn();
 for(const [value,expected] of [[null,'service-null'],[{data:'base64-sensitive'},'invalid-bytes-type'],[{data:new Uint8Array(1)},'invalid-bytes-size']] as const){
  f.diagnostic.length=0;f.adapter.call=async()=>value;await f.run();
  assert.ok(JSON.stringify(f.diagnostic).includes('stage='+expected));
 }
 f.diagnostic.length=0;f.adapter.call=async()=>{const e=new TypeError('SECRET-BODY-/private/path');(e as any).code='SECRET-TOKEN';throw e;};await f.run();
 assert.equal(f.status,503);const text=JSON.stringify(f.diagnostic);
 assert.match(text,/stage=service-error status=503 error=TypeError/);assert.match(text,/stage=response status=503/);
 assert.doesNotMatch(text,/SECRET|private|imported|inert|base64-sensitive/);
});

test("conflicting historical rows cannot make an owned attachment ID read another branch",async t=>{
 const f=await fixture(t,false),c=f.store.conversation("imported"),row=c.turns[0].attachments[0];f.learn();
 c.savedBranches=[{id:"saved",turns:[{...c.turns[0],attachments:[{...row,path:path.join(path.dirname(f.file),"other.txt")}]}]}];
 await f.run();assert.equal(f.status,404);assert.doesNotMatch(String(f.body),/inert-marker/);
});
