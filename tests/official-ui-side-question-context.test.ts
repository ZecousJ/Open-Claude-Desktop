import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation, GeneratedFile, Turn } from "../shared/types";
import { sideQuestionContext, sideQuestionInputSchema } from "../electron/official-ui/api/side-question-context";

const turn = (id:string, prompt:string, answer:string):Turn => ({id, prompt, attachments:[], items:[{id:`${id}-reply`,type:"agentMessage",text:answer}], status:"completed",createdAt:1});
const first=turn("one","First question","First answer"), second=turn("two","Second question","Partial answer");
const conversation = {mode:"chat",turns:[first,second],savedBranches:[]} as unknown as Conversation;
const request = (parent:string|null, history: {question:string;response:string}[] = []) => sideQuestionInputSchema.parse({question:"New question",btw_history:history,parent_message_uuid:parent});

test("selected parent and supplied side history preserve their roles and order",()=>{
  assert.deepEqual(sideQuestionContext(conversation,request("one:assistant",[{question:"Earlier?",response:"Partial."}])),[
    {role:"user",text:"First question"},{role:"assistant",text:"First answer"},{role:"user",text:"Earlier?"},{role:"assistant",text:"Partial."},{role:"user",text:"New question"},
  ]);
  assert.deepEqual(sideQuestionContext(conversation,request("two:user")).map(m=>"text" in m ? m.text : undefined),["First question","First answer","Second question","New question"]);
  assert.deepEqual(sideQuestionContext(conversation,request(null)).map(m=>"text" in m ? m.text : undefined),["First question","First answer","Second question","Partial answer","New question"]);
});

test("a saved branch can be selected but ambiguous or foreign parents fail",()=>{
  const other=turn("other","Branch question","Branch answer");
  const branched={...conversation,savedBranches:[{id:"saved",turns:[first,other]}]} as unknown as Conversation;
  assert.deepEqual(sideQuestionContext(branched,request("other:assistant")).map(m=>"text" in m ? m.text : undefined),["First question","First answer","Branch question","Branch answer","New question"]);
  assert.throws(()=>sideQuestionContext(branched,request("foreign:assistant")),/not in this conversation/);
  const conflicting={...branched,savedBranches:[{id:"saved",turns:[{...first,prompt:"Changed"},other]}]} as unknown as Conversation;
  assert.throws(()=>sideQuestionContext(conflicting,request("one:assistant")),/ambiguous/);
});

test("unsupported history and malformed request are rejected instead of flattened",()=>{
  const attachment={...first,attachments:[{id:"file"}]};
  assert.throws(()=>sideQuestionContext({...conversation,turns:[attachment]} as Conversation,request("one:assistant")),/attachments are unavailable/i);
  const tool={...first,items:[{id:"tool",type:"tool",text:"secret"}]};
  assert.throws(()=>sideQuestionContext({...conversation,turns:[tool]} as Conversation,request("one:assistant")),/unsupported/i);
  assert.equal(sideQuestionInputSchema.safeParse({question:"Q",btw_history:[{question:"Q",response:"A",extra:true}]}).success,false);
});

test("completed tool use and its recorded result remain paired in conversation order",()=>{
  const source={...first,items:[{id:"before",type:"agentMessage",text:"Searching."},{id:"search",type:"webSearch",status:"completed",query:"weather",result:"Sunny",sources:[{url:"https://example.test",title:"Weather"}]},{id:"after",type:"agentMessage",text:"It is sunny."}]};
  const messages=sideQuestionContext({...conversation,turns:[source]} as Conversation,request("one:assistant"));
  assert.equal(messages.length,6);assert.deepEqual(messages[1],{role:"assistant",text:"Searching."});
  const call=messages[2],output=messages[3];assert.ok("type" in call && call.type==="function_call");assert.ok("type" in output && output.type==="function_call_output");
  if("type" in call && call.type==="function_call" && "type" in output && output.type==="function_call_output"){
    assert.equal(call.call_id,output.call_id);assert.equal(call.name,"WebSearch");assert.match(call.arguments,/weather/);assert.match(output.output,/Sunny/);
  }
  assert.deepEqual(messages[4],{role:"assistant",text:"It is sunny."});
});

test("a completed file edit retains its recorded patch in side-question history",()=>{
 const source={...first,items:[{id:"edit",type:"fileChange",status:"completed",changes:[{path:"notes.txt",kind:{type:"update"},diff:"-old\n+F016_EDIT_MARKER"}]},{id:"reply",type:"agentMessage",text:"Updated."}]};
 const messages=sideQuestionContext({...conversation,turns:[source]} as Conversation,request("one:assistant"));
 const call=messages.find(item=>"type" in item&&item.type==="function_call");
 assert.ok(call&&"arguments" in call);assert.match(call.arguments,/F016_EDIT_MARKER/);
});

test("failed edits stay failed and incomplete patches are not flattened",()=>{
 const edit={id:"edit",type:"fileChange",status:"failed",error:"permission denied",changes:[{path:"notes.txt",kind:{type:"update"},diff:"-old\n+new"}]};
 const source={...first,items:[edit,{id:"reply",type:"agentMessage",text:"Could not edit."}]};
 const messages=sideQuestionContext({...conversation,turns:[source]} as Conversation,request("one:assistant"));
 const output=messages.find(item=>"type" in item&&item.type==="function_call_output");
 assert.ok(output&&"output" in output);assert.match(output.output,/\[Recorded tool failed\]/);assert.match(output.output,/permission denied/);
 const incomplete={...source,items:[{...edit,changes:[{path:"notes.txt",kind:{type:"update"}}]}]};
 assert.throws(()=>sideQuestionContext({...conversation,turns:[incomplete]} as Conversation,request("one:assistant")),/edit history is unavailable/i);
});

test("host-generated file cards do not replace the recorded edit history",()=>{
 const file={id:"file",path:"/synthetic/notes.txt",name:"notes.txt",bytes:10,language:"text",operation:"update",state:"ready"} satisfies GeneratedFile;
 const edit={id:"edit",type:"fileChange",status:"completed",changes:[{path:"notes.txt",kind:{type:"update"},diff:"-old\n+F016_EDIT_MARKER"}],generatedFiles:[file]};
 const source={...first,items:[edit,{id:"reply",type:"agentMessage",text:"Updated."},{id:"outputs-one",type:"outputFiles",status:"completed",generatedFiles:[file]}]};
 const messages=sideQuestionContext({...conversation,turns:[source]} as Conversation,request("one:assistant"));
 const call=messages.find(item=>"type" in item&&item.type==="function_call");assert.ok(call&&"arguments" in call);assert.match(call.arguments,/F016_EDIT_MARKER/);assert.doesNotMatch(JSON.stringify(messages),/\/synthetic\//);
 const forged={...source,items:[edit,{id:"unexpected",type:"outputFiles",status:"completed",generatedFiles:[file]}]};
 assert.throws(()=>sideQuestionContext({...conversation,turns:[forged]} as Conversation,request("one:assistant")),/unsupported/i);
});

test("a recorded turn-wide diff remains labeled historical data alongside its edit",()=>{
 const edit={id:"edit",type:"fileChange",status:"completed",changes:[{path:"notes.txt",kind:{type:"add"},diff:"F016_EDIT_GARNET\n"}]};
 const source={...first,items:[edit,{id:"diff-one",type:"diff",text:"diff --git a/notes.txt b/notes.txt\n+F016_EDIT_GARNET\n"},{id:"reply",type:"agentMessage",text:"Done."}]};
 const messages=sideQuestionContext({...conversation,turns:[source]} as Conversation,request("one:assistant"));
 const output=messages.find(item=>"type" in item&&item.type==="function_call_output");assert.ok(output&&"output" in output);assert.match(output.output,/Recorded turn-wide diff/);assert.match(output.output,/F016_EDIT_GARNET/);
 for(const invalid of [{...source,items:[source.items[1],source.items[2]]},{...source,items:[edit,{id:"diff-one",type:"diff",text:"x".repeat(128*1024+1)}]}])
  assert.throws(()=>sideQuestionContext({...conversation,turns:[invalid]} as Conversation,request("one:assistant")),/unsupported|too large/i);
});

test("unfinished or unsupported historical tools cannot be presented as completed results",()=>{
 const running={...first,status:"inProgress",items:[{id:"search",type:"webSearch",status:"inProgress",query:"weather"}]};
 assert.throws(()=>sideQuestionContext({...conversation,turns:[running]} as Conversation,request("one:assistant")),/not yet available|incomplete/);
 const missing={...first,items:[{id:"tool",type:"mcpToolCall",status:"completed",tool:"search",input:{}}]};
 assert.throws(()=>sideQuestionContext({...conversation,turns:[missing]} as Conversation,request("one:assistant")),/unsupported/i);
});

test("side-question length matches the native side-chat boundary",()=>{
 const max=200000;
 assert.equal(sideQuestionInputSchema.safeParse({question:"x".repeat(max)}).success,true);
 assert.equal(sideQuestionInputSchema.safeParse({question:"x".repeat(max+1)}).success,false);
 assert.equal(sideQuestionInputSchema.safeParse({question:"   "}).success,false);
});


test("unusual recorded tool names remain visible while provider identifiers stay valid",()=>{
 const source={...first,items:[{id:"tool",type:"mcpToolCall",status:"completed",tool:"remote tool/name",input:{query:"q"},result:"result"}]};
 const messages=sideQuestionContext({...conversation,turns:[source]} as Conversation,request("one:assistant"));
 const call=messages.find(item=>"type" in item&&item.type==="function_call"),output=messages.find(item=>"type" in item&&item.type==="function_call_output");
 assert.ok(call&&"name" in call&&/^tool_[a-f0-9]{48}$/.test(call.name));assert.ok(output&&"output" in output&&output.output.includes("remote tool/name")&&output.output.includes("result"));
});
