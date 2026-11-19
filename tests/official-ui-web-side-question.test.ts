import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createWebSideQuestionRoute } from "../electron/official-ui/api/web-side-question";
import { openOfficialSideQuestion } from "../src-web/official/side-question-fetch";
import { organizationUuid, type AdapterContext } from "../electron/official-ui/api/context";
import type { OfficialUiReadRequest,OfficialUiReadResponse } from "../shared/official-ui-web";
import type { Conversation } from "../shared/types";
import { sideQuestionErrorCode } from "../shared/side-question-errors.mjs";
async function start(handler:http.RequestListener){const server=http.createServer(handler);server.listen(0,"127.0.0.1");await once(server,"listening");return {server,url:`http://127.0.0.1:${(server.address() as any).port}`};}
const id="22222222-2222-4222-8222-222222222222",path=`/api/organizations/${organizationUuid("owner")}/chat_conversations/${id}/side_question`;
const conversation={id,mode:"chat",model:"model",providerId:"provider",turns:[{id:"one",prompt:"First",attachments:[],items:[{id:"answer",type:"agentMessage",text:"Answer"}],status:"completed",createdAt:1}],savedBranches:[]} as unknown as Conversation;

test("Web batches stream and stop the same original side-question request",async()=>{
 let calls=0,closed=0;
 const upstream=await start(async(req,res)=>{for await(const _ of req){};calls++;res.writeHead(200,{"Content-Type":"text/event-stream"});res.write(`data: ${JSON.stringify({type:"response.output_text.delta",delta:"Part "})}\n\n`);res.end(`data: ${JSON.stringify({type:"response.completed",response:{output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"Part two"}]}]}})}\n\n`);});
 const ctx={readOnly:true,account:()=>({id:"owner"}),sessionIdentity:()=>"activation",isCurrent:()=>true,loadConversation:async()=>conversation,settings:()=>({providers:[{id:"provider",model:"model",models:["model"]}]}),modelCatalog:async()=>({items:[{id:"model"}]}),sideQuestionGateway:async()=>({current:()=>true,open:async()=>({url:upstream.url,token:"token",path:"a".repeat(64)}),close:async()=>{closed++}})} as unknown as AdapterContext;
 const route=createWebSideQuestionRoute(ctx);const api=await start((req,res)=>{const url=new URL(req.url!,"http://local");void route(req,res,url.pathname,url)});
 const bridge=async(request:OfficialUiReadRequest):Promise<OfficialUiReadResponse>=>{const response=await fetch(api.url+request.path,{method:request.method,headers:request.contentType?{"content-type":request.contentType}:undefined,body:request.body as BodyInit|undefined});return {status:response.status,contentType:response.headers.get("content-type")??"",body:new Uint8Array(await response.arrayBuffer())};};
 try{
  const response=await openOfficialSideQuestion({method:"POST",path,contentType:"application/json",body:new TextEncoder().encode(JSON.stringify({question:"Why?",parent_message_uuid:"one:assistant",btw_history:[]}))},new AbortController().signal,bridge,bridge);
  const text=await response.text();assert.equal(response.status,200);assert.match(text,/Part /);assert.match(text,/two/);assert.match(text,/message_stop/);assert.equal(calls,1);assert.equal(closed,1);assert.equal(conversation.turns.length,1);
 }finally{api.server.closeAllConnections();upstream.server.closeAllConnections();await Promise.all([new Promise<void>(r=>api.server.close(()=>r())),new Promise<void>(r=>upstream.server.close(()=>r()))]);}
});

test("Web carries only safe side-question context errors without contacting a model",async()=>{
 let opened=0, unknown=false;
 const source={...conversation,turns:[{...conversation.turns[0],attachments:[{id:"missing",name:"note.txt",kind:"text",size:5}]}]} as Conversation;
 const ctx={readOnly:true,account:()=>({id:"owner"}),sessionIdentity:()=>"activation",isCurrent:()=>true,loadConversation:async()=>source,settings:()=>({providers:[{id:"provider",model:"model",models:["model"]}]}),modelCatalog:async()=>({items:[{id:"model"}]}),call:async()=>{if(unknown)throw Error('/synthetic/private-test-path');return null;},sideQuestionGateway:async()=>({current:()=>true,open:async()=>{opened++;throw Error('must not open')},close:async()=>{}})} as unknown as AdapterContext;
 const route=createWebSideQuestionRoute(ctx);const api=await start((req,res)=>{const url=new URL(req.url!,"http://local");void route(req,res,url.pathname,url)});
 const bridge=async(request:OfficialUiReadRequest):Promise<OfficialUiReadResponse>=>{const r=await fetch(api.url+request.path,{method:request.method,headers:request.contentType?{"content-type":request.contentType}:undefined,body:request.body as BodyInit|undefined});return {status:r.status,contentType:r.headers.get('content-type')??'',body:new Uint8Array(await r.arrayBuffer())};};
 const request={method:'POST' as const,path,contentType:'application/json',body:new TextEncoder().encode(JSON.stringify({question:'Why?',parent_message_uuid:'one:assistant',btw_history:[]}))};
 try{
  const known=await openOfficialSideQuestion(request,new AbortController().signal,bridge,bridge);const knownBody=await known.json();assert.equal(known.status,409);assert.equal(sideQuestionErrorCode(known.status,knownBody),'attachment');
  unknown=true;const other=await openOfficialSideQuestion(request,new AbortController().signal,bridge,bridge);const otherText=await other.text();assert.equal(other.status,409);assert.doesNotMatch(otherText,/private-test-path/);assert.equal(sideQuestionErrorCode(other.status,JSON.parse(otherText)),undefined);assert.equal(opened,0);assert.equal(conversation.turns.length,1);
 }finally{api.server.closeAllConnections();await new Promise<void>(resolve=>api.server.close(()=>resolve()));}
});
