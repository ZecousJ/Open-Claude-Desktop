/** Inert original producer contracts. No browser, account, engine, model or network.
 * QN is an explicit recording transport; these tests do NOT claim route support. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { completionPath } from "../shared/official-completion-stream";
import { completionInlineSchema, nativeCompletionInlineSchema } from "../electron/official-ui/api/completion-attachments";
import { sideQuestionErrorCode } from "../shared/side-question-errors.mjs";
const assets = "build/official-ui/ui/assets/v1/";
const cache = new Map<string, ts.SourceFile>();
function original(file: string, name: string) {
  let ast = cache.get(file);
  if (!ast) {
    ast = ts.createSourceFile(file, fs.readFileSync(assets + file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    cache.set(file, ast);
  }
  const found = ast.statements.filter((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.equal(found.length, 1, `original ${file}:${name}`);
  return `(${found[0].getText(ast)})`;
}
const sideFile = "shared-100-CDJp2jvs.js";
const org = "11111111-1111-4111-8111-111111111111";
const conv = "22222222-2222-4222-8222-222222222222";
function sideProducer(record: (path: string, options: any) => Promise<void>) {
  const eventNames = Object.fromEntries(["Ping", "MessageStart", "ContentBlockStart", "ContentBlockStop", "MessageDelta", "MessageStop", "MessageLimit", "Error", "Completion", "ContentBlockDelta"].map(x => [x, x.replace(/[A-Z]/g, (v, at) => (at ? "_" : "") + v.toLowerCase())]));
  return vm.runInNewContext(original(sideFile, "a0"), {
    QN: record, NG: () => ({}), Eg: () => ({}), pD: eventNames, __claudexSideQuestionErrorCode: sideQuestionErrorCode,
    wz: (data: string) => JSON.parse(data), f9: (data: any) => Object.assign(new Error(data.fallbackMessage), data),
  });
}
test("original side question keeps history, explicit parent/model/thinking and uses distinct SSE endpoint", async () => {
  const seen: any[] = [], deltas: string[] = []; let completed = 0;
  const send = sideProducer(async (path, options) => {
    seen.push({path,body:JSON.parse(options.body)});
    assert.equal(options.headers.Accept,"text/event-stream");
    assert.equal(options.method,"POST");
    await options.onopen({ok:true,headers:new Headers({"content-type":"text/event-stream"})});
    options.onmessage({event:"content_block_delta",data:JSON.stringify({delta:{type:"text_delta",text:"two"}})});
    options.onmessage({event:"message_delta",data:JSON.stringify({delta:{stop_reason:"end_turn"}})});
    options.onmessage({event:"message_stop",data:"{}"});
  });
  await send({organizationUuid:org,conversationUuid:conv,question:"Why?",btwHistory:[{question:"Before?",response:"Earlier."}],parentMessageUuid:"original-leaf",model:"picked",thinkingMode:"standard",onDelta:(s:string)=>deltas.push(s),onComplete:()=>completed++});
  assert.deepEqual(seen,[{path:`/api/organizations/${org}/chat_conversations/${conv}/side_question`,body:{question:"Why?",btw_history:[{question:"Before?",response:"Earlier."}],parent_message_uuid:"original-leaf",model:"picked",thinking_mode:"standard"}}]);
  assert.deepEqual(deltas,["two"]); assert.equal(completed,1);
  assert.equal(completionPath.test(seen[0].path),false,"current completion SSE wrapper does not support this endpoint");
});
test("original side-question defaults are null parent and empty history; errors do not auto retry", async () => {
  let calls=0;
  const send=sideProducer(async (_path,options)=>{
    calls++;
    assert.deepEqual(JSON.parse(options.body),{question:"First?",btw_history:[],parent_message_uuid:null});
    assert.throws(()=>options.onerror(new Error("unknown transport outcome")),/unknown transport outcome/);
    await options.onopen({ok:false,status:501,headers:new Headers(),text:async()=>"{}"});
  });
  await assert.rejects(send({organizationUuid:org,conversationUuid:conv,question:"First?"}),/Failed to start side question/);
  assert.equal(calls,1);
});
test("the recovered producer tags only a known unavailable-attachment response", async () => {
  let calls = 0;
  const send = sideProducer(async (_path, options) => {
    calls++;
    await options.onopen({ ok: false, status: 409, headers: new Headers(), text: async () => JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "A side-question attachment is unavailable or changed." } }) });
  });
  await assert.rejects(send({ organizationUuid: org, conversationUuid: conv, question: "Where is the file?" }), (error: any) => error.claudexSideQuestionCode === "attachment");
  assert.equal(calls, 1);
});
test("actual original quote producer yields composer excerpt, while rich reply identity is not accepted by current REST inline schema",()=>{
  const quote=vm.runInNewContext(original("shared-m-1-Nm0kn4Ee.js","OF"),{
    Blob,GI:"excerpt_from_previous_claude_message.txt",rM:{UserUpload:"user_upload"},dS:{Excerpt:"excerpt"},
  });
  const basic=JSON.parse(JSON.stringify(quote("Selected line\nsecond")));
  assert.deepEqual(basic,{file_name:"excerpt_from_previous_claude_message.txt",file_size:20,file_type:"txt",extracted_content:"Selected line\nsecond",origin:"user_upload",kind:"excerpt"});
  assert.equal(completionInlineSchema.safeParse([basic]).success,true);
  const rich=JSON.parse(JSON.stringify(quote("Selected line",{reply:"Explain this",messageUuid:"msg_original"})));
  assert.equal(rich.quote_reply,"Explain this");assert.equal(rich.quote_message_uuid,"msg_original");
  assert.equal(completionInlineSchema.safeParse([rich]).success,false,"do not silently drop rich quote comment/target");
  const forwarded={...rich};delete forwarded.quote_reply;
  assert.equal(nativeCompletionInlineSchema.safeParse([forwarded]).success,true,"native REST keeps the original source identity after the producer folds the reply into text");
});
test("original rich-quote selection rejects one-character reply and normalizes two-character passage",()=>{
  const select=vm.runInNewContext(original("shared-39-BVbIfnmZ.js","I0"),{nl:2});
  assert.equal(select("2"),undefined);
  assert.equal(select("  1+1\r\nwhy  "),"1+1\nwhy");
  assert.equal(select("x".repeat(10001)),undefined);
});
