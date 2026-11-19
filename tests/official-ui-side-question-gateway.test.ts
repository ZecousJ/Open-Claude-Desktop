import test from "node:test";
import assert from "node:assert/strict";
import { streamSideQuestion } from "../electron/official-ui/api/side-question-gateway";
const path="a".repeat(64);
const events=(...values:unknown[])=>new Response(values.map(value=>`data: ${JSON.stringify(value)}\n\n`).join(""),{status:200,headers:{"content-type":"text/event-stream"}});
const completed=(text:string)=>({type:"response.completed",response:{output:[{type:"message",role:"assistant",content:[{type:"output_text",text}]}]}});
const setup=()=>{let opens=0, closes=0, active=true;return {gateway:{open:async()=>{opens++;return {url:"http://127.0.0.1/v1",token:"private",path}},close:async(p:string)=>{assert.equal(p,path);closes++},current:()=>active},counts:()=>({opens,closes}),retire:()=>{active=false}}};
const options=(onDelta:(text:string)=>void)=>({model:"model",messages:[{role:"user" as const,text:"Hello"},{role:"assistant" as const,text:"Earlier"},{role:"user" as const,text:"Why?"}],signal:new AbortController().signal,onDelta});
test("forwards exact role history through a single tool-free request and streams the answer",async()=>{
 const {gateway,counts}=setup(),received:string[]=[];let calls=0;
 await streamSideQuestion(gateway,options(x=>received.push(x)),async(url,init)=>{
  calls++;assert.equal(url,`http://127.0.0.1/v1/side/${path}/responses`);
  const body=JSON.parse(String(init?.body));assert.deepEqual(body.tools,[]);assert.equal(body.model,"model");
  assert.deepEqual(body.input.map((m:any)=>[m.role,m.content[0].text]),[["user","Hello"],["assistant","Earlier"],["user","Why?"]]);
  return events({type:"response.output_text.delta",delta:"Hello"},completed("Hello world"));
 });
 assert.equal(received.join(""),"Hello world");assert.equal(calls,1);assert.deepEqual(counts(),{opens:1,closes:1});
});
test("does not retry, invent completion, or accept a rewritten answer",async()=>{
 for(const body of [events({type:"response.output_text.delta",delta:"first"}),events({type:"response.output_text.delta",delta:"first"},completed("changed")),events({type:"response.completed",response:{output:[{type:"function_call",name:"shell"}]}}),events({type:"response.output_item.added",item:{type:"function_call",name:"shell"}},completed("Done"))]){
  const {gateway,counts}=setup();let calls=0;
  await assert.rejects(streamSideQuestion(gateway,options(()=>{}),async()=>{calls++;return body}));
  assert.equal(calls,1);assert.deepEqual(counts(),{opens:1,closes:1});
 }
});
test("account retirement closes the side capability before any later output",async()=>{
 const {gateway,counts,retire}=setup();const seen:string[]=[];
 await assert.rejects(streamSideQuestion(gateway,options(value=>{seen.push(value);retire()}),async()=>events({type:"response.output_text.delta",delta:"first"},completed("first"))),/account changed/);
 assert.deepEqual(seen,["first"]);assert.deepEqual(counts(),{opens:1,closes:1});
});

test("historical tool results are input data, with no executable tools offered",async()=>{
 const {gateway}=setup();let seen:any;
 await streamSideQuestion(gateway,{...options(()=>{}),messages:[{role:"user",text:"Search"},{type:"function_call",call_id:"call_1",name:"WebSearch",arguments:'{"query":"weather"}'},{type:"function_call_output",call_id:"call_1",output:"Sunny"},{role:"user",text:"What did it find?"}]},async(_url,init)=>{seen=JSON.parse(String(init?.body));return events(completed("Sunny"));});
 assert.deepEqual(seen.tools,[]);assert.deepEqual(seen.input[1],{type:"function_call",call_id:"call_1",name:"WebSearch",arguments:'{"query":"weather"}'});assert.equal(seen.input[2].output,"Sunny");
});

test("Chat-provider conversion keeps recorded tool results without enabling tools",async()=>{
 const {toChat}=await import("../electron/engine/gateway-chat");
 const {body}=toChat({model:"model",tools:[],input:[{role:"user",content:[{type:"input_text",text:"Search"}]},{type:"function_call",call_id:"call_1",name:"WebSearch",arguments:'{"query":"weather"}'},{type:"function_call_output",call_id:"call_1",output:"Sunny"},{role:"user",content:[{type:"input_text",text:"What did it find?"}]}]});
 assert.equal(body.tools,undefined);assert.equal(body.messages[1].tool_calls[0].id,"call_1");assert.equal(body.messages[2].role,"tool");assert.equal(body.messages[2].content,"Sunny");
});
