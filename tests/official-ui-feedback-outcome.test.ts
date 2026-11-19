/** Pinned descriptor + inert host spies. No diagnostics service or filesystem writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { toBinary, toJson, fromBinary } from '@bufbuild/protobuf';
import { loadRegistry, deepCreate } from '../electron/official-ui/api/timeline';
import { createActionRpc, PERFORM_ACTION_PATH } from '../electron/official-ui/api/actions';
import { messageIndex } from '../electron/official-ui/api/conversations';
import { newAdapterScope, inAdapterScope } from '../electron/official-ui/api/scope';
const registry=loadRegistry('build/official-ui/data/conversation-protocol.json');
const pkg='anthropic.bard.api.v1alpha';
const input=registry.getMessage(pkg+'.PerformActionRequest')!;
const output=registry.getMessage(pkg+'.PerformActionResponse')!;
async function request(type:number, result:unknown={sent:true}, options:{binary?:boolean;comment?:string;kind?:'user'|'assistant';foreign?:boolean;incognito?:boolean;retired?:boolean;savedBranch?:boolean;wrongIdentity?:boolean}={}) {
 const calls:any[]=[];
 return inAdapterScope(newAdapterScope('feedback-fixture'),async()=>{
  messageIndex.set('owned',new Map([['turn:assistant',{turnId:'turn',kind:options.kind??'assistant',branchId:'original',active:true}]]));
  let activation = {};
  const turn = { id: options.wrongIdentity ? 'different' : 'turn', status: 'completed' };
  const route=createActionRpc({
    account: () => ({ id: 'feedback-fixture' }), sessionIdentity: () => activation,
    loadConversation: async () => {
      if (options.retired) activation = {};
      return { id: 'owned', mode: 'chat', incognito: options.incognito,
        turns: options.savedBranch ? [] : [turn],
        savedBranches: options.savedBranch ? [{ turns: [turn] }] : [] };
    },
    call:async(name:string,...args:unknown[])=>{calls.push([name,...args]);if(name==='submitReplyFeedback'){if(result instanceof Error)throw result;return result;}},log() {}
  } as never,registry);
  const message=deepCreate(input,{header:{conversationId:options.foreign?'other':'owned',mutationId:{sessionId:'feedback-mutation',version:7n}},action:{case:'messageFeedback',value:{messageId:'turn:assistant',type,...(options.comment!==undefined?{comment:options.comment}:{})}}});
  const binary=options.binary??false;
  const req:any=Readable.from([binary?Buffer.from(toBinary(input,message)):Buffer.from(JSON.stringify(toJson(input,message,{useProtoFieldName:true})))]);
  req.method='POST';req.headers={'content-type':binary?'application/proto':'application/json'};
  let answer:any;
  const res:any={writeHead(){},end(value:any){answer=binary?fromBinary(output,value):JSON.parse(String(value));}};
  assert.equal(await route(req,res,PERFORM_ACTION_PATH),true);return {calls,answer};
 });
}
function applied(value:any){return value?.ack?.outcome?.case==='applied'||value?.ack?.applied===true;}
const printable=(value:unknown)=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?String(item):item);
test('feedback refusals correlate to the original mutation and wire action',async()=>{
 for(const binary of [false,true])for(const [type,result,options] of [
  [1,{sent:false},{comment:'inert'}],
  [1,Error('inert private detail'),{comment:'inert'}],
  [999,{sent:true},{}],
  [1,{sent:true},{kind:'user'}],
  [1,{sent:true},{foreign:true}],
 ] as const){
  const {answer}=await request(type,result,{...options,binary});
  const error=answer.ack.outcome?.value??answer.ack.error;
  assert.equal(applied(answer),false);
  assert.equal(answer.ack.highWaterMark.sessionId,'feedback-mutation');
  assert.equal(String(answer.ack.highWaterMark.version),'7');
  assert.equal(error.action,'message_feedback');
 }
});
test('category-only feedback preserves its category, while bare thumbs remain rating-only',async()=>{
 for(const binary of [false,true]){
  for(const type of [0,1,2]){
   const r=await request(type,{sent:true},{binary});
   assert.equal(applied(r.answer),true);assert.equal(r.calls.length,1);
   assert.deepEqual(r.calls[0][4],{localOnly:true});
  }
  const categories=registry.getEnum(pkg+'.FeedbackType')!.values.filter(value=>value.number>2);
  assert.ok(categories.length>0,'Pinned protocol must contain a categorized feedback enum');
  for(const {number:type} of categories){
   const r=await request(type,{sent:true},{binary});
   assert.equal(applied(r.answer),true);assert.equal(r.calls.length,2);
   assert.equal(r.calls[1][0],'submitReplyFeedback');
   assert.deepEqual(r.calls[1][1].categories,[String(type)]);
   assert.equal(r.calls[1][1].comment,'');
   const failed=await request(type,{sent:false},{binary});
   assert.equal(applied(failed.answer),false);
  }
 }
});
test('feedback false or thrown service outcome never reports applied success',async()=>{
 for(const binary of [false,true])for(const result of [{sent:false},null,Error('sensitive inert internal marker')]){
  const r=await request(1,result,{binary,comment:'inert feedback'});
  assert.equal(applied(r.answer),false);assert.equal(r.calls.length,2);assert.doesNotMatch(printable(r.answer),/sensitive inert internal marker/);
 }
});
test('known rating and explicitly sent or queued reports retain success without duplicate submission',async()=>{
 for(const binary of [false,true])for(const result of [{sent:true},{sent:false,queued:true}]){const r=await request(2,result,{binary,comment:'inert'});assert.equal(applied(r.answer),true);assert.equal(r.calls.length,2);}
 const rating=await request(1);assert.equal(applied(rating.answer),true);assert.equal(rating.calls.length,1);
 const clear=await request(0);assert.equal(applied(clear.answer),true);assert.equal(clear.calls[0][3],null);
});
test('unknown enum, user-message, foreign conversation and oversized comment reject before mutation',async()=>{
 for(const binary of [false,true])for(const [type,options] of [[999,{}],[1,{kind:'user'}],[1,{foreign:true}],[1,{comment:'x'.repeat(4001)}]] as const){
  const r=await request(type,{sent:true},{...options,binary});assert.equal(applied(r.answer),false);assert.equal(r.calls.length,0);
 }
});
test('all actual pinned feedback enums have intentional clear/up/down mapping',async()=>{
 const values=registry.getEnum(pkg+'.FeedbackType')!.values;
 for(const binary of [false,true])for(const value of values){const r=await request(value.number,{sent:true},{binary});assert.equal(applied(r.answer),true,value.name+' '+printable(r.answer));assert.equal(r.calls[0][3],value.number===0?null:value.number===1?'up':'down');}
});


test('feedback checks the exact completed assistant reply and current account before writing', async () => {
 for (const options of [{incognito:true},{retired:true},{wrongIdentity:true}]) {
  const result=await request(1,{sent:true},{...options,binary:true});
  assert.equal(applied(result.answer),false);
  assert.deepEqual(result.calls,[]);
 }
 const result=await request(1,{sent:true},{savedBranch:true,binary:true});
 assert.equal(applied(result.answer),true);
 assert.deepEqual(result.calls,[['setReplyFeedback','owned','turn','up',{localOnly:true}]]);
});
