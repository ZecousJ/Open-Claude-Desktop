import test from 'node:test';
import assert from 'node:assert/strict';
import {withNativeCompletionAttachments} from '../electron/official-ui/api/native-completion-attachments';
import {inAdapterScope,newAdapterScope} from '../electron/official-ui/api/scope';
import {learnAttachment} from '../electron/official-ui/api/files';
const input={providerId:'p',model:'model',files:[],attachments:[{file_name:'n.txt',file_type:'text/plain',file_size:1,extracted_content:'x'}]};
function setup(){
 let identity:unknown={},owner='a',calls=0;
 const scope=newAdapterScope('a');
 const ctx:any={account:()=>({id:owner}),sessionIdentity:()=>identity,stateDirectory:()=>'/synthetic-native-root',call:async()=>{calls++;throw Error('Unexpected write');}};
 return {ctx,scope,host:withNativeCompletionAttachments(ctx),get calls(){return calls;},retire(){identity={};},switch(){owner='b';},unset(){identity=undefined;}};
}
test('native attachment prepared result cannot cross account, activation, or scope',async()=>{
 for(const scenario of ['switch','retire','scope']){
  const f=setup();const prepared=await inAdapterScope(f.scope,()=>f.host.prepareCompletionAttachments!(input));
  if(scenario==='switch')f.switch();if(scenario==='retire')f.retire();
  await assert.rejects(inAdapterScope(scenario==='scope'?newAdapterScope('other'):f.scope,()=>f.host.submitCompletionWithAttachments!({},prepared)),/account changed/);
  assert.equal(f.calls,0);
 }
});
test('native prepared result rejects modified, forged and replayed payloads before write',async()=>{
 const f=setup();await inAdapterScope(f.scope,async()=>{
 const prepared=await f.host.prepareCompletionAttachments!(input);
 prepared[0].name='tampered.txt';
 await assert.rejects(f.host.submitCompletionWithAttachments!({},prepared),/Reattach/);
 await assert.rejects(f.host.submitCompletionWithAttachments!({},prepared),/Reattach/);
 await assert.rejects(f.host.submitCompletionWithAttachments!({},structuredClone(prepared)),/Reattach/);
 });assert.equal(f.calls,0);
});
test('native helper cannot enable readonly or partially installed executor hooks',()=>{
 const f=setup();f.ctx.readOnly=true;assert.equal(withNativeCompletionAttachments(f.ctx),f.ctx);
 delete f.ctx.readOnly;f.ctx.prepareCompletionAttachments=async()=>[];assert.equal(withNativeCompletionAttachments(f.ctx),f.ctx);
});
test('native missing activation identity is fail closed before lookup/storage',async()=>{
 const f=setup();f.unset();await assert.rejects(inAdapterScope(f.scope,()=>f.host.prepareCompletionAttachments!(input)),/account changed/);assert.equal(f.calls,0);
});

test('native stored document IDs preserve per-file limits without Web 32MB aggregate limit',async()=>{
 const f=setup();await inAdapterScope(f.scope,async()=>{
 for(const id of ['doc-a','doc-b'])learnAttachment({id,name:id+'.pdf',size:20*1024*1024,kind:'document',path:''} as any);
 const prepared=await f.host.prepareCompletionAttachments!({...input,attachments:[],files:['doc-a','doc-b']});
 assert.equal(prepared.length,2);assert.equal(prepared.reduce((n,a)=>n+a.size,0),40*1024*1024);
 });assert.equal(f.calls,0);
});

test('native REST excerpt retains a verified message source through stored display and rejects stale or foreign sources',async t=>{
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
 const {storeAttachment}=await import('../electron/engine/composer-files');const {openPolicy}=await import('../shared/client-policy');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rest-quote-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const scope=newAdapterScope('owner'),identity={},conversation:any={id:'c',mode:'chat',turns:[{id:'one',prompt:'question',items:[{id:'answer',type:'agentMessage',text:'This is the selected source.'}],attachments:[],status:'completed'}],savedBranches:[]};let sends=0,changeOnUpload=false;
 const ctx:any={account:()=>({id:'owner'}),sessionIdentity:()=>identity,stateDirectory:()=>root,isCurrent:()=>true,loadConversation:async()=>conversation,call:async(method:string,...args:any[])=>{
   if(method==='addAttachmentData'){const file=storeAttachment(path.join(root,'attachments'),args[0],args[1],openPolicy);if(changeOnUpload)conversation.turns[0].items[0].text='Changed source';return file;}
   if(method==='send'){sends++;return {...conversation,turns:[...conversation.turns,{id:'new',attachments:args[0].attachments,inlineAttachmentDisplays:args[0].inlineAttachmentDisplays}]};}
   throw Error('Unexpected operation '+method);
 }};
 const host=withNativeCompletionAttachments(ctx);
 const quote={file_name:'excerpt_from_previous_claude_message.txt',file_type:'txt',file_size:15,extracted_content:'selected source',kind:'excerpt' as const,origin:'user_upload' as const,quote_message_uuid:'one:assistant'};
 await inAdapterScope(scope,async()=>{
  const prepare=async(row:any=quote)=>host.prepareCompletionAttachments!({providerId:'p',model:'model',conversationId:'c',files:[],attachments:[row]});
  const prepared=await prepare();const sent=await host.submitCompletionWithAttachments!({conversationId:'c'},prepared) as any;
  const turn=sent.turns.at(-1),display=turn.inlineAttachmentDisplays[0];
  assert.deepEqual(display.quoteSource,{role:'assistant',turnId:'one'});assert.equal(display.attachmentId,turn.attachments[0].id);assert.equal(display.bytes,15);assert.equal(sends,1);
  const twelve=await host.prepareCompletionAttachments!({providerId:'p',model:'model',conversationId:'c',files:[],attachments:Array.from({length:12},()=>({...quote}))});assert.equal(twelve.length,12);
  await assert.rejects(prepare({...quote,quote_message_uuid:'foreign:assistant'}),/source changed or is unavailable/);
  await assert.rejects(prepare({...quote,extracted_content:'not from message',file_size:16}),/source changed or is unavailable/);
  const raced=await prepare();changeOnUpload=true;await assert.rejects(host.submitCompletionWithAttachments!({conversationId:'c'},raced),/source changed or is unavailable/);assert.equal(sends,1);
 });
});
