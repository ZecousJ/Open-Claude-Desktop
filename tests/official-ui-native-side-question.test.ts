import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { once } from "node:events";
import type { AdapterContext } from "../electron/official-ui/api/context";
import { organizationUuid } from "../electron/official-ui/api/context";
import { nativeSideQuestionRoute } from "../electron/official-ui/api/native-side-question";
import type { Conversation } from "../shared/types";

async function start(handler:http.RequestListener) {
 const server=http.createServer(handler);server.listen(0,"127.0.0.1");await once(server,"listening");
 return {server,url:`http://127.0.0.1:${(server.address() as any).port}`};
}
const conversation={id:"22222222-2222-4222-8222-222222222222",mode:"chat",model:"model",providerId:"provider",turns:[{id:"one",prompt:"First",attachments:[],items:[{id:"answer",type:"agentMessage",text:"Answer"}],status:"completed",createdAt:1}],savedBranches:[]} as unknown as Conversation;
const pathname=`/api/organizations/${organizationUuid("owner")}/chat_conversations/${conversation.id}/side_question`;
const payload={question:"Why?",parent_message_uuid:"one:assistant",btw_history:[{question:"Earlier?",response:"Partial."}],model:"model",thinking_mode:"standard"};

test("native side-question route sends selected owned history through the real stream and leaves the conversation unchanged",async()=>{
 let request:any,closes=0;
 const upstream=await start(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));request=JSON.parse(Buffer.concat(chunks).toString());
  res.writeHead(200,{"Content-Type":"text/event-stream"});
  res.write(`data: ${JSON.stringify({type:"response.output_text.delta",delta:"Side "})}\n\n`);
  res.end(`data: ${JSON.stringify({type:"response.completed",response:{output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"Side answer"}]}]}})}\n\n`);
 });
 const snapshot=JSON.stringify(conversation);
 const ctx={account:()=>({id:"owner"}),sessionIdentity:()=>"activation",isCurrent:()=>true,loadConversation:async()=>conversation,settings:()=>({providers:[{id:"provider",model:"model",models:["model"]}]}),modelCatalog:async()=>({items:[{id:"model",efforts:["none","low"]}]}),sideQuestionGateway:async()=>({current:()=>true,open:async()=>({url:upstream.url,token:"token",path:"a".repeat(64)}),close:async()=>{closes++}})} as unknown as AdapterContext;
 const api=await start((req,res)=>{void nativeSideQuestionRoute(req,res,new URL(req.url!,"http://local").pathname,ctx)});
 try {
  const result=await fetch(api.url+pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
  const text=await result.text();assert.equal(result.status,200);assert.match(text,/content_block_delta/);assert.match(text,/Side /);assert.match(text,/answer/);assert.match(text,/message_stop/);
  assert.deepEqual(request.input.map((m:any)=>[m.role,m.content[0].text]),[["user","First"],["assistant","Answer"],["user","Earlier?"],["assistant","Partial."],["user","Why?"]]);
  assert.deepEqual(request.tools,[]);assert.deepEqual(request.reasoning,{effort:"none"});assert.equal(JSON.stringify(conversation),snapshot);assert.equal(closes,1);
  const file="build/official-ui/ui/assets/v1/shared-100-CDJp2jvs.js";
  const source=ts.createSourceFile(file,fs.readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const original=source.statements.filter((item):item is ts.FunctionDeclaration=>ts.isFunctionDeclaration(item)&&item.name?.text==="a0");
  assert.equal(original.length,1);
  const names=Object.fromEntries(["Ping","MessageStart","ContentBlockStart","ContentBlockStop","MessageDelta","MessageStop","MessageLimit","Error","Completion","ContentBlockDelta"].map(x=>[x,x.replace(/[A-Z]/g,(v,at)=>(at?"_":"")+v.toLowerCase())]));
  const producer=vm.runInNewContext(`(${original[0].getText(source)})`,{pD:names,wz:(s:string)=>JSON.parse(s),NG:()=>({}),Eg:()=>({}),f9:(data:any)=>Error(data.fallbackMessage),QN:async(path:string,opts:any)=>{
    const response=await fetch(api.url+path,{method:opts.method,headers:opts.headers,body:opts.body});await opts.onopen(response);
    for(const frame of (await response.text()).split("\n\n")){const event=/^event: (.+)$/m.exec(frame)?.[1],data=/^data: (.+)$/m.exec(frame)?.[1];if(event&&data)opts.onmessage({event,data});}
  }});
  let originalText="",completed=0;
  await producer({organizationUuid:organizationUuid("owner"),conversationUuid:conversation.id,question:"Why?",btwHistory:payload.btw_history,parentMessageUuid:"one:assistant",model:"model",thinkingMode:"standard",onDelta:(s:string)=>{originalText+=s},onComplete:()=>{completed++}});
  assert.equal(originalText,"Side answer");assert.equal(completed,1);assert.equal(closes,2);
  const foreign=await fetch(api.url+pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...payload,parent_message_uuid:"foreign:assistant"})});
  assert.equal(foreign.status,409);assert.equal(closes,2);
 } finally {api.server.closeAllConnections();upstream.server.closeAllConnections();await Promise.all([new Promise<void>(r=>api.server.close(()=>r())),new Promise<void>(r=>upstream.server.close(()=>r()))]);}
});

test("closing the side stream aborts the upstream without changing the main conversation",async()=>{
 let closed=0, notifyStarted!:()=>void;const started=new Promise<void>(resolve=>{notifyStarted=resolve});
 const upstream=await start(async(req,res)=>{
  for await(const _ of req){};
  res.writeHead(200,{"Content-Type":"text/event-stream"});res.write(`data: ${JSON.stringify({type:"response.output_text.delta",delta:"Partial"})}\n\n`);notifyStarted();
 });
 const ctx={account:()=>({id:"owner"}),sessionIdentity:()=>"activation",isCurrent:()=>true,loadConversation:async()=>conversation,settings:()=>({providers:[{id:"provider",model:"model",models:["model"]}]}),modelCatalog:async()=>({items:[{id:"model",efforts:["none"]}]}),sideQuestionGateway:async()=>({current:()=>true,open:async()=>({url:upstream.url,token:"token",path:"a".repeat(64)}),close:async()=>{closed++}})} as unknown as AdapterContext;
 const api=await start((req,res)=>{void nativeSideQuestionRoute(req,res,new URL(req.url!,"http://local").pathname,ctx)});
 try {
  const controller=new AbortController();const response=await fetch(api.url+pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload),signal:controller.signal});
  await started;await response.body!.getReader().read();controller.abort();
  for(let i=0;i<50&&!closed;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(closed,1);assert.equal(conversation.turns.length,1);
 } finally {api.server.closeAllConnections();upstream.server.closeAllConnections();await Promise.all([new Promise<void>(r=>api.server.close(()=>r())),new Promise<void>(r=>upstream.server.close(()=>r()))]);}
});

test("switching accounts during a side stream prevents later output from crossing accounts",async()=>{
 let owner="owner",closes=0,release!:()=>void;
 const proceed=new Promise<void>(resolve=>{release=resolve});
 const upstream=await start(async(req,res)=>{
  for await(const _ of req){};
  res.writeHead(200,{"Content-Type":"text/event-stream"});
  res.write(`data: ${JSON.stringify({type:"response.output_text.delta",delta:"before switch"})}\n\n`);
  await proceed;
  res.end(`data: ${JSON.stringify({type:"response.output_text.delta",delta:"after switch private content"})}\n\n`);
 });
 const ctx={account:()=>({id:owner}),sessionIdentity:()=>"activation",isCurrent:()=>true,loadConversation:async()=>conversation,settings:()=>({providers:[{id:"provider",model:"model",models:["model"]}]}),modelCatalog:async()=>({items:[{id:"model",efforts:["none"]}]}),sideQuestionGateway:async()=>({current:()=>true,open:async()=>({url:upstream.url,token:"token",path:"a".repeat(64)}),close:async()=>{closes++}})} as unknown as AdapterContext;
 const api=await start((req,res)=>{void nativeSideQuestionRoute(req,res,new URL(req.url!,"http://local").pathname,ctx)});
 try{
  const response=await fetch(api.url+pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
  const reader=response.body!.getReader();const first=await reader.read();
  assert.match(Buffer.from(first.value!).toString(),/before switch/);
  owner="other";release();
  let later="";for(;;){const chunk=await reader.read();if(chunk.done)break;later+=Buffer.from(chunk.value).toString();}
  assert.doesNotMatch(later,/after switch private content/);
  assert.equal(closes,1);assert.equal(conversation.turns.length,1);
 }finally{release();api.server.closeAllConnections();upstream.server.closeAllConnections();await Promise.all([new Promise<void>(r=>api.server.close(()=>r())),new Promise<void>(r=>upstream.server.close(()=>r()))]);}
});

test("a source changed while opening the gateway is rejected before a model request",async()=>{
 let reads=0,opens=0;
 const ctx={account:()=>({id:"owner"}),sessionIdentity:()=>"activation",isCurrent:()=>true,loadConversation:async()=>{reads++;return reads===1?conversation:{...conversation,turns:[{...conversation.turns[0],prompt:"Changed"}]};},settings:()=>({providers:[{id:"provider",model:"model",models:["model"]}]}),modelCatalog:async()=>({items:[{id:"model",efforts:["none"]}]}),sideQuestionGateway:async()=>({current:()=>true,open:async()=>{opens++;throw Error("must not open")},close:async()=>{}})} as unknown as AdapterContext;
 const api=await start((req,res)=>{void nativeSideQuestionRoute(req,res,new URL(req.url!,"http://local").pathname,ctx)});
 try{const response=await fetch(api.url+pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});assert.equal(response.status,409);assert.match(await response.text(),/source changed/);assert.equal(opens,0);}
 finally{api.server.closeAllConnections();await new Promise<void>(resolve=>api.server.close(()=>resolve()));}
});

test("native side question sends owned image and text bytes and refuses changed bytes before the model call",async()=>{
 const bytes=Buffer.from("saved note"),picture=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);let changed=false,calls=0,closed=0;
 const source={...conversation,turns:[{...conversation.turns[0],attachments:[{id:"note",name:"note.txt",kind:"text",size:bytes.length},{id:"image",name:"photo.png",kind:"image",size:picture.length}]}]} as Conversation;
 const upstream=await start(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const request=JSON.parse(Buffer.concat(chunks).toString());calls++;
  assert.equal(request.input[0].content[1].text.includes("saved note"),true);assert.match(request.input[0].content[2].image_url,/^data:image\/png;base64,/);assert.deepEqual(request.tools,[]);
  res.writeHead(200,{"Content-Type":"text/event-stream"});res.end(`data: ${JSON.stringify({type:"response.completed",response:{output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"Seen"}]}]}})}\n\n`);
 });
 const ctx={account:()=>({id:"owner"}),sessionIdentity:()=>"activation",isCurrent:()=>true,loadConversation:async()=>source,settings:()=>({providers:[{id:"provider",model:"model",models:["model"]}]}),modelCatalog:async()=>({items:[{id:"model",efforts:["none"]}]}),call:async(method:string,id:string,attachment:string)=>{assert.equal(method,"turnAttachment");assert.equal(id,conversation.id);return attachment==="note"?{name:"note.txt",data:changed?Buffer.from("bad! note"):bytes}:{name:"photo.png",data:picture};},sideQuestionGateway:async()=>({current:()=>true,open:async()=>({url:upstream.url,token:"token",path:"a".repeat(64)}),close:async()=>{closed++}})} as unknown as AdapterContext;
 const api=await start((req,res)=>{void nativeSideQuestionRoute(req,res,new URL(req.url!,"http://local").pathname,ctx)});
 try{
  const send=()=>fetch(api.url+pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
  const first=await send();assert.match(await first.text(),/Seen/);assert.equal(calls,1);assert.equal(closed,1);
  let reads=0;const original=ctx.call;ctx.call=async(...args:any[])=>{const result=await (original as any)(...args);if(++reads===2)changed=true;return result;};
  const second=await send();assert.match(await second.text(),/event: error/);assert.equal(calls,1);assert.equal(closed,2);
 }finally{api.server.closeAllConnections();upstream.server.closeAllConnections();await Promise.all([new Promise<void>(r=>api.server.close(()=>r())),new Promise<void>(r=>upstream.server.close(()=>r()))]);}
});

test("changed side-question instructions close the gateway before any provider request",async()=>{
 let calls=0,closed=0;
 const source={...conversation,sessionInstructions:"initial rule"} as Conversation;
 const upstream=await start((_req,res)=>{calls++;res.writeHead(500);res.end();});
 const ctx={account:()=>({id:"owner"}),sessionIdentity:()=>"activation",isCurrent:()=>true,loadConversation:async()=>source,settings:()=>({providers:[{id:"provider",model:"model",models:["model"]}]}),modelCatalog:async()=>({items:[{id:"model",efforts:["none"]}]}),sideQuestionGateway:async()=>({current:()=>true,instructions:"initial rule",verifyContext:()=>{throw Error("The side-question instructions changed.");},open:async()=>({url:upstream.url,token:"token",path:"a".repeat(64)}),close:async()=>{closed++}})} as unknown as AdapterContext;
 const api=await start((req,res)=>{void nativeSideQuestionRoute(req,res,new URL(req.url!,"http://local").pathname,ctx)});
 try{const response=await fetch(api.url+pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});assert.match(await response.text(),/event: error/);assert.equal(calls,0);assert.equal(closed,1);}
 finally{api.server.closeAllConnections();upstream.server.closeAllConnections();await Promise.all([new Promise<void>(r=>api.server.close(()=>r())),new Promise<void>(r=>upstream.server.close(()=>r()))]);}
});

test("project side question refuses a host that cannot attest its instructions",async()=>{
 let opened=0;
 const source={...conversation,projectId:"project"} as Conversation;
 const ctx={account:()=>({id:"owner"}),sessionIdentity:()=>"activation",isCurrent:()=>true,loadConversation:async()=>source,settings:()=>({providers:[{id:"provider",model:"model",models:["model"]}]}),modelCatalog:async()=>({items:[{id:"model",efforts:["none"]}]}),sideQuestionGateway:async()=>({current:()=>true,open:async()=>{opened++;return {url:"http://127.0.0.1",token:"token",path:"a".repeat(64)}},close:async()=>{}})} as unknown as AdapterContext;
 const api=await start((req,res)=>{void nativeSideQuestionRoute(req,res,new URL(req.url!,"http://local").pathname,ctx)});
 try{const response=await fetch(api.url+pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});assert.equal(response.status,409);assert.match(await response.text(),/instructions are unavailable/);assert.equal(opened,0);}
 finally{api.server.closeAllConnections();await new Promise<void>(resolve=>api.server.close(()=>resolve()));}
});

test("side-question failures never expose unexpected internal errors",async()=>{
 const source={...conversation,turns:[{...conversation.turns[0],attachments:[{id:"missing",name:"note.txt",kind:"text",size:5}]}]} as Conversation;
 let opened=0;
 const ctx={account:()=>({id:"owner"}),sessionIdentity:()=>"activation",isCurrent:()=>true,loadConversation:async()=>source,settings:()=>({providers:[{id:"provider",model:"model",models:["model"]}]}),modelCatalog:async()=>({items:[{id:"model",efforts:["none"]}]}),call:async()=>{throw Error("/synthetic/private-test-path")},sideQuestionGateway:async()=>({current:()=>true,open:async()=>{opened++;throw Error("must not open")},close:async()=>{}})} as unknown as AdapterContext;
 const api=await start((req,res)=>{void nativeSideQuestionRoute(req,res,new URL(req.url!,"http://local").pathname,ctx)});
 try{const response=await fetch(api.url+pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});const text=await response.text();assert.equal(response.status,409);assert.doesNotMatch(text,/private-test-path/);assert.equal(opened,0);}
 finally{api.server.closeAllConnections();await new Promise<void>(resolve=>api.server.close(()=>resolve()));}
});
