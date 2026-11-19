import { randomUUID } from "node:crypto";
import { syntheticWindowsReceiptCleanup } from "./support/windows-receipt-cleanup";
/** In-memory native HTTP streams + temporary receipts, no server socket/model/host execution. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { createNativeRestCompletionRoute } from "../electron/official-ui/api/native-rest-completion";
import {
  newAdapterScope,
  inAdapterScope,
} from "../electron/official-ui/api/scope";
import { organizationUuid } from "../electron/official-ui/api/context";
import type { OfficialUiReadRequest } from "../shared/official-ui-web";
import { connectorUuid } from "../electron/official-ui/api/connector-auth";
import {conversationsRoute,loadConversationState} from "../electron/official-ui/api/conversations";
import {flushState} from "../electron/official-ui/api/state";
import {storeUpload, filesRoute, loadFileRegistry} from "../electron/official-ui/api/files";
import {attachmentKind} from "../shared/client-policy";
import { HIWONDER_KNOWLEDGE_SERVER, HUANER_TECH, knowledgeRoute } from "../shared/knowledge-api";
const id = "11111111-1111-4111-8111-111111111111";
const knowledgeOrigin = "https://knowledge.example.test";
const knowledgeRelay = knowledgeOrigin + knowledgeRoute(HUANER_TECH);
const knowledgeRead = {
  name: "rag_read", description: "Read a source", input_schema: { type: "object" },
  integration_name: "Hiwonder", mcp_server_uuid: connectorUuid(HIWONDER_KNOWLEDGE_SERVER),
  mcp_server_url: knowledgeRelay, backend_execution: true, is_mcp_app: false,
};
function fixture(t: any, options: { knowledgeAvailable?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-completion-"));
  const initialOwner = process.platform === "win32" ? `native-test-${randomUUID()}` : "owner";
  const cleanupReceipts = syntheticWindowsReceiptCleanup(root,[initialOwner]);
  t.after(async () => {
    // These fixtures queue real 500 ms adapter-state saves; keep their owned
    // temporary directory alive until the queue runs. Do not hide write errors.
    await new Promise((resolve) => setTimeout(resolve, 550));
    cleanupReceipts();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let owner = initialOwner,
    identity = {},
    c: any,
    sends = 0,
    interrupts = 0;
  const stored: {id:string;name:string;data:Buffer}[]=[];
  const sendInputs:any[]=[];
  let failStore=false,failSend=false,retireOnRead=false;
  const listeners = new Set<(e: any) => void>();
  let scope = newAdapterScope(owner, root, identity);
  const ctx: any = {
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    ...(options.knowledgeAvailable !== undefined ? {
      knowledgeOffer: async () => ({
        baseUrl: knowledgeOrigin,
        bases: [{ id: HUANER_TECH, name: "Hiwonder", description: "Manuals", available: options.knowledgeAvailable }],
      }),
    } : {}),
    snapshot: async () => ({ projects: [], conversations: c ? [structuredClone(c)] : [] }),
    settings: () => ({
      providers: [{ id: "p", model: "model" }],
      activeProviderId: "p",
    }),
    modelCatalog: async () => ({
      defaultModel: "model",
      items: [{ id: "model", efforts: [] }],
    }),
    loadConversation: async () => c && structuredClone(c),
    onEvent: (fn: any) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    call: async (name: string, input: any, data?:Uint8Array) => {
      if(name === "turnAttachment") {
        assert.equal(input,c?.id);
        const attachmentId=data as unknown as string;
        assert.ok(c.turns.some((turn:any)=>turn.attachments.some((a:any)=>a.id===attachmentId)));
        const file=stored.find(f=>f.id===attachmentId);
        if(!file)return null;
        const bytes=fs.readFileSync(path.join(root,"attachments",file.id,file.name));
        if(retireOnRead)identity={};
        return {data:bytes};
      }
      if(name === "addAttachmentData") {
        if(failStore)throw Error("Synthetic store failure");
        const id="stored-"+(stored.length+1), bytes=Buffer.from(data!);
        const file=path.join(root,"attachments",id,input);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
        stored.push({id,name:input,data:bytes});
        return {id,name:input,path:file,size:bytes.length,kind:attachmentKind(path.extname(input).slice(1))};
      }
      if (name === "interrupt") {
        interrupts++;
        throw Error("Must not interrupt on disconnect");
      }
      assert.equal(name, "send");
      sends++;
      sendInputs.push(structuredClone(input));
      if(failSend)throw Error("Synthetic send failure");
      const previousTurns = c?.turns ?? [];
      c = {
        id: input.newConversationId ?? input.conversationId,
        mode: "chat",
        title: "T",
        providerId: "p",
        model: "model",
        connectorOverrides: input.connectorOverrides ?? c?.connectorOverrides,
        connectorToolOverrides: input.connectorToolOverrides ?? c?.connectorToolOverrides,
        createdAt: 1,
        updatedAt: 1,
        turns: [
          ...previousTurns,
          {
            id: "turn-" + sends,
            prompt: input.text,
            attachments: (input.attachments ?? []).map(({id}:any) => {
              const file=stored.find(f=>f.id===id)!;
              return {id,name:file.name,path:path.join(root,"attachments",id,file.name),size:file.data.length,kind:"text"};
            }),
            ...(input.inlineAttachmentDisplays !== undefined ? { inlineAttachmentDisplays: structuredClone(input.inlineAttachmentDisplays) } : {}),
            createdAt: 1,
            status: "inProgress",
            items: [{ id: "answer", type: "agentMessage", text: "你好" }],
          },
        ],
      };
      return structuredClone(c);
    },
  };
  const route = createNativeRestCompletionRoute(ctx, {
    pollMs: 5,
    deadlineMs: 1000,
  });
  const body = {
    prompt: "hello",
    model: "model",
    tools: [],
    attachments: [],
    files: [],
    sync_sources: [],
    rendering_mode: "messages",
    turn_message_uuids: {
      human_message_uuid: "22222222-2222-7222-8222-222222222222",
      assistant_message_uuid: "33333333-3333-7333-8333-333333333333",
    },
    completion_request_id: "44444444-4444-7444-8444-444444444444",
    create_conversation_params: {
      name: "",
      model: "model",
      include_conversation_preferences: true,
      is_temporary: false,
    },
  };
  return {
    stored,sendInputs,
    reopen(){
      inAdapterScope(scope,()=>flushState("message-ids"));
      scope=newAdapterScope(owner,root,identity);
      inAdapterScope(scope,()=>{loadFileRegistry();loadConversationState();});
    },
    get conversation(){return c;},
    async read(kind: "conversation" | "file", suffix = "", asForeign: boolean | "own-org" = false) {
      const org = organizationUuid(asForeign === "own-org" ? "foreign" : initialOwner);
      const p = kind === "conversation" ? `/api/organizations/${org}/chat_conversations/${id}` : `/api/${org}/files/${suffix}`;
      let status=0, output:any;
      const res:any={writeHead:(n:number)=>{status=n;},end:(data:any)=>{output=data;}};
      const readCtx=asForeign?{...ctx,account:()=>({id:"foreign"})}:ctx;
      await inAdapterScope(asForeign?newAdapterScope("foreign",root,{}):scope,()=>kind === "conversation"
        ? conversationsRoute({method:"GET"} as any,res,p,new URL(p,"http://localhost"),readCtx)
        : filesRoute({method:"GET"} as any,res,p,readCtx));
      return {status,output};
    },
    retireOnRead(){retireOnRead=true;},
    failStore(){failStore=true;},
    failSend(){failSend=true;},
    upload(name:string,text:string){return inAdapterScope(scope,()=>storeUpload(ctx,name,new TextEncoder().encode(text)));},
    get sends() {
      return sends;
    },
    get interrupts() {
      return interrupts;
    },
    get listeners() {
      return listeners.size;
    },
    complete(citations?: { url: string; title: string; start: number; end: number }[]) {
      const turn = c.turns.at(-1);
      turn.items[0].text += "世界";
      if (citations) turn.items[0].citations = citations;
      turn.status = "completed";
      for (const fn of listeners)
        fn({ type: "conversation", conversation: structuredClone(c) });
    },
    reactivate() {
      identity = {};
    },
    retire() {
      owner = "other";
      identity = {};
      for (const fn of listeners) fn({ type: "signed-out" });
    },
    async run(
      onChunk?: (res: any, text: string) => void,
      patch: any = {},
      duringBody?: () => void,
    ) {
      let status = 0,
        headers: any = {},
        text = "";
      const req: any = Readable.from(
        (function* () {
          yield Buffer.from(JSON.stringify({ ...body, ...patch }));
          duringBody?.();
        })(),
      );
      req.method = "POST";
      req.headers = { "content-type": "application/json" };
      const res: any = new Writable({
        write(chunk, _encoding, done) {
          text += chunk.toString();
          onChunk?.(res, text);
          done();
        },
      });
      res.headersSent = false;
      res.writeHead = (s: number, h: any) => {
        status = s;
        headers = h;
        res.headersSent = true;
        return res;
      };
      const p = `/api/organizations/${organizationUuid(initialOwner)}/chat_conversations/${id}/completion`;
      await inAdapterScope(scope, () =>
        route(req, res, p, new URL(p, "http://localhost")),
      );
      return { status, headers, text };
    },
  };
}
test("desktop relays only an existing shared cloud Chat through the original stream and Stop", async () => {
  const identity = {};
  const org = randomUUID();
  const operation = randomUUID();
  const calls: OfficialUiReadRequest[] = [];
  const batch = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: Buffer.from(value === undefined ? "" : JSON.stringify(value)) });
  const route = createNativeRestCompletionRoute({
    account: () => ({ id: "owner" }), sessionIdentity: () => identity,
    isCloudConversation: (value: string) => value === id,
    listConversations: async () => [{ id, mode: "chat", projectOrganizationId: org }],
    call: async () => assert.fail("A native hosted chat must not call the local engine."),
    onEvent: () => () => {},
    captureOfficialOrganizationProjectChat: () => async (request: OfficialUiReadRequest, signal: AbortSignal) => {
      signal.throwIfAborted();
      calls.push(request);
      if (request.path.endsWith("/stop_response")) return batch(undefined, 204);
      const poll = request.method === "GET";
      const event = poll ? "message_stop" : "message_start";
      return batch({ operation_id: operation, cursor: poll ? 2 : 1, done: poll, events: [{ event, data: { type: event } }] });
    },
  } as unknown as Parameters<typeof createNativeRestCompletionRoute>[0], { pollMs: 1, deadlineMs: 1000 });
  const base = `/api/organizations/${org}/chat_conversations/${id}`;
  const run = async (p: string, body: unknown) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", headers: { "content-type": "application/json" } });
    let status = 0;
    let text = "";
    const res = Object.assign(new Writable({ write(chunk, _, done) { text += chunk.toString(); done(); } }), {
      writeHead(code: number) { status = code; return this; },
    });
    await inAdapterScope(newAdapterScope("owner", undefined, identity), () => route(req as never, res as never, p, new URL(p, "http://localhost")));
    return { status, text };
  };
  assert.equal((await run(`${base.replace(org, randomUUID())}/completion`, {})).status, 404);
  const complete = await run(`${base}/completion`, { prompt: "Next question" });
  assert.equal(complete.status, 200);
  assert.match(complete.text, /message_start[\s\S]*message_stop/);
  assert.equal((await run(`${base}/stop_response`, { completion_request_id: operation })).status, 204);
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ["POST", `${base}/completion`], ["GET", `${base}/claudex_completion/${operation}?cursor=1`], ["POST", `${base}/stop_response`],
  ]);
  assert.match(Buffer.from(calls[0].body!).toString(), /Next question/);
});
test("native completion is real progressive SSE with UTF8 text and observed terminal", async (t) => {
  const f = fixture(t);
  let completed = false;
  const r = await f.run((_res, text) => {
    if (!completed && text.includes("你好")) {
      completed = true;
      f.complete();
    }
  });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/event-stream/);
  assert.match(r.text, /event: message_start/);
  assert.match(r.text, /你好/);
  assert.match(r.text, /世界/);
  assert.match(r.text, /event: message_stop/);
  assert.equal(f.sends, 1);
  assert.equal(f.listeners, 0);
});
test("native disconnect only detaches, never sends again or interrupts", async (t) => {
  const f = fixture(t);
  const r = await f.run((res, text) => {
    if (text.includes("你好")) res.destroy();
  });
  assert.equal(r.status, 200);
  assert.equal(f.sends, 1);
  assert.equal(f.interrupts, 0);
  assert.equal(f.listeners, 0);
});
test("native unsupported tools retain explicit JSON error and zero dispatch", async (t) => {
  const f = fixture(t);
  const r = await f.run(undefined, { tools: [{ name: "repl" }] });
  assert.notEqual(r.status, 200);
  assert.match(r.headers["content-type"], /application\/json/);
  assert.equal(f.sends, 0);
  assert.equal(f.listeners, 0);
});
test("native first Chat sends only the selected Hiwonder tool and streams its recorded citation", async (t) => {
  const f = fixture(t, { knowledgeAvailable: true });
  let completed = false;
  const citation = { url: "https://manuals.example.test/robot/guide", title: "Robot guide", start: 0, end: 2 };
  const streamed = await f.run((_res, text) => {
    if (completed || !text.includes("event: message_start")) return;
    completed = true;
    assert.doesNotMatch(text, /你好/);
    f.complete([citation]);
  }, { tools: [knowledgeRead] });
  assert.equal(streamed.status, 200, streamed.text);
  assert.match(streamed.text, /"url":"https:\/\/manuals\.example\.test\/robot\/guide"/);
  assert.match(streamed.text, /event: message_stop/);
  const [send] = f.sendInputs;
  assert.deepEqual(send.connectorOverrides, { [HIWONDER_KNOWLEDGE_SERVER]: true });
  assert.deepEqual(send.connectorToolOverrides, { [HIWONDER_KNOWLEDGE_SERVER]: { rag_search: false, rag_read: true } });
  assert.equal(send.tools, undefined);
  const replay = await f.run(undefined, { tools: [knowledgeRead] });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(f.sends, 1);
});

test("native first Chat refuses an unavailable or changed knowledge descriptor before sending", async (t) => {
  const available = fixture(t, { knowledgeAvailable: true });
  for (const tool of [
    { ...knowledgeRead, name: "unknown" },
    { ...knowledgeRead, mcp_server_url: "https://wrong.example.test/mcp" },
  ]) {
    assert.equal((await available.run(undefined, { tools: [tool] })).status, 501);
  }
  assert.equal(available.sends, 0);
  const unavailable = fixture(t, { knowledgeAvailable: false });
  assert.equal((await unavailable.run(undefined, { tools: [knowledgeRead] })).status, 409);
  assert.equal(unavailable.sends, 0);
});
test("native signout closes the stream without another-account text or mutation", async (t) => {
  const f = fixture(t);
  const r = await f.run((_res, text) => {
    if (text.includes("你好")) f.retire();
  });
  assert.equal(f.sends, 1);
  assert.equal(f.interrupts, 0);
  assert.equal(f.listeners, 0);
  assert.doesNotMatch(r.text, /世界/);
});

test("native request body cannot cross account or same-account activation", async (t) => {
  for (const sameAccount of [false, true]) {
    const f = fixture(t);
    const r = await f.run(undefined, {}, () =>
      sameAccount ? f.reactivate() : f.retire(),
    );
    assert.equal(r.status, 409);
    assert.equal(f.sends, 0);
    assert.equal(f.listeners, 0);
  }
});
test('native event-driven polling stays in opening request scope even from a foreign event scope',async t=>{
 const f=fixture(t);let scheduled=false;
 const r=await f.run((_res,text)=>{if(!scheduled&&text.includes('你好')){scheduled=true;inAdapterScope(newAdapterScope('foreign'),()=>setTimeout(()=>f.complete(),1));}});
 assert.match(r.text,/世界/);assert.match(r.text,/event: message_stop/);assert.equal(f.sends,1);assert.equal(f.listeners,0);
});

test('native stored upload and pasted UTF8 reach original send once without reupload',async t=>{
 const f=fixture(t), uploaded=await f.upload('note.txt','本地 existing text');let completed=false;
 const patch={files:[uploaded.id],attachments:[{file_name:'pasted.md',file_type:'text/markdown',file_size:9999,extracted_content:'粘贴 UTF8 ✓',kind:'pasted_text'}]};
 const r=await f.run((_res,text)=>{if(!completed&&text.includes('你好')){completed=true;f.complete();}},patch);
 assert.equal(r.status,200);assert.match(r.text,/event: message_stop/);assert.equal(f.sends,1);
 assert.equal(f.stored.length,2);assert.equal(f.stored[0].id,uploaded.id);
 assert.equal(f.stored[1].name,'pasted.md.extracted.txt');assert.equal(f.stored[1].data.toString(),'粘贴 UTF8 ✓');
 assert.deepEqual(f.sendInputs[0].attachments,[{id:uploaded.id},{id:f.stored[1].id}]);
 await f.run(undefined,patch);assert.equal(f.sends,1);assert.equal(f.stored.length,2);
});
test('native foreign or renderer-path attachment IDs cannot dispatch or write',async t=>{
 for(const file of ['unknown','/etc/passwd']){const f=fixture(t);const r=await f.run(undefined,{files:[file]});assert.equal(r.status,404);assert.equal(f.sends,0);assert.equal(f.stored.length,0);}
});
test('native inline storage failure and send failure never retry mutation',async t=>{
 for(const failAt of ['store','send']){const f=fixture(t);if(failAt==='store')f.failStore();else f.failSend();
 const patch={attachments:[{file_name:'note.txt',file_type:'text/plain',file_size:4,extracted_content:'text'}]};
 await f.run(undefined,patch);await f.run(undefined,patch);
 assert.equal(f.sends,failAt==='store'?0:1);assert.equal(f.stored.length,failAt==='store'?0:1);
 }
});
test('native attachment body retirement rejects same-account reactivation and account switch',async t=>{
 for(const same of [true,false]){const f=fixture(t),file=await f.upload('note.txt','owned');
 const r=await f.run(undefined,{files:[file.id]},()=>same?f.reactivate():f.retire());assert.equal(r.status,409);assert.equal(f.sends,0);assert.equal(f.stored.length,1);}
});

test('native pasted text above Web64KiB and 1MiB schemas retains original 2MiB per-file support',async t=>{
 for(const length of [65*1024,1024*1024+1]){
 const f=fixture(t),text='a'.repeat(length);let completed=false;
 const r=await f.run((_res,stream)=>{if(!completed&&stream.includes('你好')){completed=true;f.complete();}},{attachments:[{file_name:'pasted.txt',file_type:'text/plain',file_size:length,extracted_content:text}]});
 assert.equal(r.status,200);assert.equal(f.sends,1);assert.equal(f.stored.length,1);assert.equal(f.stored[0].data.length,length);assert.equal(f.stored[0].data.toString(),text);
 }
});
test('native inline UTF8 byte ceiling remains 2MiB even when character count fits',async t=>{
 const f=fixture(t),text='中'.repeat(Math.floor(2*1024*1024/3)+1);
 const r=await f.run(undefined,{attachments:[{file_name:'pasted.txt',file_type:'text/plain',file_size:0,extracted_content:text}]});
 assert.equal(r.status,400);assert.equal(f.sends,0);assert.equal(f.stored.length,0);
});


test('native uploaded attachment survives REST send, history reload and attachment-free followup; owned bytes remain readable', async t=>{
 const f=fixture(t), content='固定 TXT attachment ✓ 中文', file=await f.upload('roundtrip.txt',content);
 const finish=()=>{let done=false;return (_res:any,text:string)=>{if(!done&&text.includes('你好')){done=true;f.complete();}};};
 const first=await f.run(finish(),{files:[file.id]});
 assert.equal(first.status,200);assert.match(first.text,/event: message_stop/);
 const detail=await f.read('conversation');assert.equal(detail.status,200);
 const history=JSON.parse(String(detail.output));
 const human=history.chat_messages.find((m:any)=>m.sender==='human');
 assert.equal(human.files_v2.length,1);assert.equal(human.files_v2[0].file_uuid,file.id);
 assert.equal(human.files_v2[0].file_name,'roundtrip.txt');
 for(const variant of ['contents','preview','content_preview']){
   const read=await f.read('file',file.id+'/'+variant);assert.equal(read.status,200);
   assert.equal(variant!=='content_preview'?String(read.output):JSON.parse(String(read.output)).content,content);
   const denied=await f.read('file',file.id+'/'+variant,true);assert.equal(denied.status,403);assert.doesNotMatch(String(denied.output),/固定 TXT/);
   const foreignRegistry=await f.read('file',file.id+'/'+variant,'own-org');assert.equal(foreignRegistry.status,404);assert.doesNotMatch(String(foreignRegistry.output),/固定 TXT/);
 }
 const followup=await f.run(finish(),{prompt:'Follow up without uploading again',create_conversation_params:undefined,
 completion_request_id:'66666666-6666-4666-8666-666666666666',
 turn_message_uuids:{human_message_uuid:'77777777-7777-4777-8777-777777777777',assistant_message_uuid:'88888888-8888-4888-8888-888888888888'}});
 assert.equal(followup.status,200,followup.text);assert.match(followup.text,/event: message_stop/);
 assert.equal(f.sends,2);assert.equal(f.stored.length,1);assert.deepEqual(f.sendInputs[0].attachments,[{id:file.id}]);
 assert.deepEqual(f.sendInputs[1].attachments??[],[]);
 const reloaded=await f.read('conversation');assert.equal(reloaded.status,200);
 const humans=JSON.parse(String(reloaded.output)).chat_messages.filter((m:any)=>m.sender==='human');
 assert.equal(humans.length,2);assert.equal(humans[0].files_v2.length,1);assert.equal(humans[1].files_v2.length,0);
});

test("native inline history retains original card and lines after reopen without renaming stored derivatives", async t => {
 for(const name of ['claudex-acceptance-test.txt','report.pdf']) {
  const f=fixture(t);const content='ORANGE\nsecond\nthird';let done=false;
  const sent=await f.run((_res,stream)=>{if(!done&&stream.includes('你好')){done=true;f.complete();}},
    {attachments:[{file_name:name,file_type:name.endsWith('.pdf')?'application/pdf':'text/plain',file_size:999,extracted_content:content,kind:'file'}]});
  assert.equal(sent.status,200);assert.equal(f.stored[0].name,name+'.extracted.txt');
  assert.deepEqual(f.sendInputs[0].attachments,[{id:f.stored[0].id}]);
  const original=f.conversation.turns[0].attachments[0];
  assert.equal(original.name,name+'.extracted.txt');assert.match(original.path,/\.extracted\.txt$/);
  assert.equal(original.kind,'text');
  for(const reopen of [false,true]) {
   if(reopen)f.reopen();
   const response=await f.read('conversation');assert.equal(response.status,200,String(response.output));
   const human=JSON.parse(String(response.output)).chat_messages.find((m:any)=>m.sender==='human');
   assert.equal(human.attachments.length,1);assert.equal(human.files.length,0);assert.equal(human.files_v2.length,0);
   const inline=human.attachments[0];assert.equal(inline.file_name,name);assert.equal(inline.extracted_content,content);
   assert.equal(inline.extracted_content.split('\n').length,3);assert.equal(inline.file_size,Buffer.byteLength(content));
   assert.equal(inline.kind,'file');assert.ok(!JSON.stringify(inline).includes(original.path));
  }
  const foreign=await f.read('conversation','',true);assert.equal(foreign.status,404);assert.doesNotMatch(String(foreign.output),/ORANGE/);
  const denied=await f.read('file',f.stored[0].id+'/contents','own-org');assert.equal(denied.status,404);
 }
});
test("inline history falls back to a file card when the owned derivative bytes change", async t => {
 const f=fixture(t);let done=false;
 await f.run((_res,stream)=>{if(!done&&stream.includes('你好')){done=true;f.complete();}},
   {attachments:[{file_name:'original.txt',file_type:'text/plain',file_size:3,extracted_content:'old'}]});
 const original=f.conversation.turns[0].attachments[0];
 fs.writeFileSync(original.path,Buffer.from('new'));
 const changed=await f.read('conversation');assert.equal(changed.status,200);
 const human=JSON.parse(String(changed.output)).chat_messages.find((message:any)=>message.sender==='human');
 assert.deepEqual(human.attachments,[]);
 assert.equal(human.files_v2[0].file_name,'original.txt.extracted.txt');
});

test("inline history rejects over-budget projection without reusing a mutated file fixture", async t => {
 const f=fixture(t);let done=false;
 await f.run((_res,stream)=>{if(!done&&stream.includes('你好')){done=true;f.complete();}},
   {attachments:[{file_name:'original.txt',file_type:'text/plain',file_size:3,extracted_content:'old'}]});
 const base=f.conversation.turns[0];
 // Repeated branch representation still charges each serialized message's content budget.
 f.conversation.turns=Array.from({length:10000},(_,i)=>({...base,id:'large-'+i,prompt:'x'.repeat(400)}));
 const large=await f.read('conversation');assert.equal(large.status,413);
});

test("inline history stops a same-account activation change during the actual local text read",async t=>{
 const f=fixture(t);let done=false;
 await f.run((_res,stream)=>{if(!done&&stream.includes('你好')){done=true;f.complete();}},
  {attachments:[{file_name:'lease.txt',file_type:'text/plain',file_size:6,extracted_content:'SECRET'}]});
 const read=fs.readSync;
 let entered=false;
 t.mock.method(fs,'readSync',(...args:any[])=>{
  const count=(read as any)(...args);
  if(!entered){entered=true;f.reactivate();}
  return count;
 });
 const result=await f.read('conversation');assert.equal(entered,true);assert.equal(result.status,409);
 assert.doesNotMatch(String(result.output),/SECRET/);
});

test("restored inline history still rejects account retirement during authoritative service read",async t=>{
 const f=fixture(t);let done=false;
 await f.run((_res,stream)=>{if(!done&&stream.includes('你好')){done=true;f.complete();}},
  {attachments:[{file_name:'restored.txt',file_type:'text/plain',file_size:6,extracted_content:'SECRET'}]});
 f.reopen();f.retireOnRead();const result=await f.read('conversation');
 assert.equal(result.status,409);assert.doesNotMatch(String(result.output),/SECRET/);
});

test("actual pinned blob source resolver chooses the owned files endpoint, not fabricated wiggle path",async t=>{
 const f=fixture(t);const file=await f.upload('old.extracted.txt','inert bytes');let done=false;
 await f.run((_res,stream)=>{if(!done&&stream.includes('你好')){done=true;f.complete();}},{files:[file.id]});
 const detail=await f.read('conversation');const blob=JSON.parse(String(detail.output)).chat_messages[0].files_v2[0];
 assert.equal(blob.download_source,'files-api');
 const source=fs.readFileSync('.restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1/shared-5-DQLFfFYX.js','utf8');
 const ast=ts.createSourceFile('pinned.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const def=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='ZZ');assert.ok(def);
 const hooks:any={J9:()=>[],Tm:()=>id,ys:()=>({activeOrganization:{uuid:organizationUuid('owner')}}),aX:()=>false,
  r$:(org:string,id:string)=>`/api/organizations/${org}/files/${encodeURIComponent(id)}/contents`,
  kC:()=>'/unimplemented-wiggle-path'};
 for(let n=0;n<=5;n++){hooks['J'+n]=()=>true;hooks['K'+n]=(...args:any[])=>args.at(-1);}
 const resolve=vm.runInNewContext('('+def.getText(ast)+')',hooks);
 const selected=resolve({fileUuid:blob.file_uuid,wigglePath:blob.path,downloadSource:blob.download_source,conversationUuid:id});
 assert.equal(selected.usesFilesApi,true);assert.equal(selected.isExplicitFilesApi,true);
 assert.equal(selected.url,`/api/organizations/${organizationUuid('owner')}/files/${blob.file_uuid}/contents`);
 assert.equal(resolve({fileUuid:blob.file_uuid,wigglePath:blob.path,conversationUuid:id}).url,'/unimplemented-wiggle-path');
 const content=await f.read('file',file.id+'/contents');assert.equal(content.status,200);assert.equal(String(content.output),'inert bytes');
});
test("legal multiple large inline attachments fall back to readable named files and shared branches do not double-charge",async t=>{
 const f=fixture(t);const text='x'.repeat(Math.floor(1.6*1024*1024));let done=false;
 const sent=await f.run((_res,stream)=>{if(!done&&stream.includes('你好')){done=true;f.complete();}},
 {attachments:['one.txt','two.txt'].map(file_name=>({file_name,file_type:'text/plain',file_size:text.length,extracted_content:text}))});
 assert.equal(sent.status,200);assert.equal(f.sends,1);
 let result=await f.read('conversation');assert.equal(result.status,200,String(result.output));
 let human=JSON.parse(String(result.output)).chat_messages[0];
 assert.equal(human.attachments.length+human.files_v2.length,2);
 const names=[...human.attachments,...human.files_v2].map((x:any)=>x.file_name);assert.deepEqual(names.sort(),['one.txt','two.txt']);
 for(const file of human.files_v2){assert.equal(file.download_source,'files-api');assert.equal((await f.read('file',file.file_uuid+'/contents')).status,200);}
 f.conversation.savedBranches=[{id:'shared',turns:structuredClone(f.conversation.turns)}];
 result=await f.read('conversation');assert.equal(result.status,200,String(result.output));
 assert.equal(JSON.parse(String(result.output)).chat_messages.length,2);
});

test("original REST excerpt retains its verified source identity after native SSE send and history reload",async t=>{
 const f=fixture(t);let completed=false;
 const first=await f.run((_res,text)=>{if(!completed&&text.includes("你好")){completed=true;f.complete();}});
 assert.equal(first.status,200);assert.equal(f.sends,1);
 completed=false;
 const second=await f.run((_res,text)=>{if(!completed&&text.includes("你好")){completed=true;f.complete();}}, {
   create_conversation_params:undefined,
   parent_message_uuid:"33333333-3333-7333-8333-333333333333",
   turn_message_uuids:{human_message_uuid:"55555555-5555-7555-8555-555555555555",assistant_message_uuid:"66666666-6666-7666-8666-666666666666"},
   completion_request_id:"77777777-7777-7777-8777-777777777777",
   prompt:"Explain the selected phrase",
   attachments:[{file_name:"excerpt_from_previous_claude_message.txt",file_type:"txt",file_size:6,extracted_content:"你好",origin:"user_upload",kind:"excerpt",quote_message_uuid:"33333333-3333-7333-8333-333333333333"}],
 });
 assert.equal(second.status,200);assert.match(second.text,/event: message_stop/);assert.equal(f.sends,2);
 assert.equal(f.sendInputs[1].text,"Explain the selected phrase");
 await new Promise(resolve=>setTimeout(resolve,550));f.reopen();
 const history=await f.read("conversation");assert.equal(history.status,200);
 const body=JSON.parse(String(history.output));const inline=body.chat_messages.find((m:any)=>m.sender==="human"&&m.text==="Explain the selected phrase").attachments[0];
 assert.equal(inline.extracted_content,"你好");assert.equal(inline.quote_message_uuid,"33333333-3333-7333-8333-333333333333");
});
