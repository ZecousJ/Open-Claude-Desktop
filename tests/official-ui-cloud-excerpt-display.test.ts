/** Native send + actual durable receipt + PB history, no remote/provider. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {withNativeCompletionAttachments} from '../electron/official-ui/api/native-completion-attachments';
import {knownFile,learnAttachment,filesRoute,restoreConfirmedUploadDisplay,rememberInlineDisplay} from '../electron/official-ui/api/files';import {conversationUpdate} from '../electron/official-ui/api/timeline';
import {storeAttachment} from '../electron/engine/composer-files';import {openPolicy} from '../shared/client-policy';
import {prepareUploadReceipt,commitUploadReceipts,readConfirmedUploadReceipt} from '../electron/cloud/upload-receipts';
import {projectInlineAttachmentDisplays} from '../electron/official-ui/api/inline-attachment-displays';import {userMessageId,assistantMessageId} from '../electron/official-ui/api/conversations';
import {inAdapterScope,newAdapterScope} from '../electron/official-ui/api/scope';import {organizationUuid} from '../electron/official-ui/api/context';
function fixture(t:any){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-excerpt-display-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const scope=newAdapterScope('owner'),identity={};let current=true,sends=0,fail=false;const local=new Map(),conversations=new Map();const receiptScope={root,service:'https://synthetic.invalid',current:()=>current};
 const source:any={id:'source',prompt:'question',items:[{id:'answer',type:'agentMessage',text:'abc'}],attachments:[],status:'completed'};const ctx:any={loadConversation:async()=>({id:'c',turns:[source],savedBranches:[]}),account:()=>({id:'owner'}),sessionIdentity:()=>identity,stateDirectory:()=>root,isCurrent:()=>current,log:()=>{},call:async(m:string,...a:any[])=>{
 if(m==='turnAttachment'){const c=conversations.get(a[0]),row=c.turns.at(-1).attachments[0];return {name:row.name,data:fs.readFileSync(local.get(row.localId).path)};}
 if(m==='addAttachmentData'){const f=storeAttachment(path.join(root,'attachments'),a[0],a[1],openPolicy);local.set(f.id,f);return f;}
 assert.equal(m,'send');sends++;const src=local.get(a[0].attachments[0].id),row={...src,id:'cloud-row-'+sends,path:'/remote/path',localId:src.id};const displays=a[0].inlineAttachmentDisplays?.map((d:any)=>({...d,attachmentId:row.id}));const c:any={id:'cloud-conversation-'+sends,createdAt:1,updatedAt:1,turns:[source,{id:'turn-'+sends,createdAt:1,status:'completed',prompt:'explain',items:[],attachments:[row],inlineAttachmentDisplays:displays}]};
 const p=prepareUploadReceipt(receiptScope,src,fs.readFileSync(src.path),row);commitUploadReceipts(receiptScope,c,[p]);conversations.set(c.id,c);learnAttachment(row,c.id);return c;
 },readConfirmedUpload:async(cid:string,rid:string)=>{if(fail)throw Error('Synthetic receipt failure');const c=conversations.get(cid);assert.ok(c);return readConfirmedUploadReceipt(receiptScope,c,rid);}};
 return {scope,ctx,host:withNativeCompletionAttachments(ctx),local,get sends(){return sends;},fail:()=>fail=true,retire:()=>current=false};}
const input={providerId:'p',model:'inert',conversationId:'c',files:[],attachments:[{file_name:'excerpt_from_previous_claude_message.txt',file_type:'txt',file_size:3,extracted_content:'abc',kind:'excerpt',origin:'user_upload',quote_message_uuid:'source:assistant'}]};
async function send(f:any,files?:string[]){const prepared=await f.host.prepareCompletionAttachments({...input,...(files?{files,attachments:[]}: {})});return f.host.submitCompletionWithAttachments({text:'explain',conversationId:'c'},prepared);}
function card(c:any){return conversationUpdate(c,false,{org:organizationUuid('owner')}).messages![0].attachments[0];}
test('cloud rewritten IDs project exact excerpt bytes and source while ordinary reuse stays ordinary',async t=>{const f=fixture(t);await inAdapterScope(f.scope,async()=>{
 const a=await send(f),localId=[...f.local.keys()][0],b=await send(f,[localId]);
 const displays=await projectInlineAttachmentDisplays(f.ctx,a,{user:userMessageId,assistant:assistantMessageId});
 const row=a.turns.at(-1).attachments[0],display=[...displays.values()][0];
 assert.equal(display.file_name,'excerpt_from_previous_claude_message.txt');assert.equal(display.extracted_content,'abc');assert.equal(display.quote_message_uuid,'source:assistant');
 const pb=conversationUpdate(a,false,{org:organizationUuid('owner'),inlineDisplays:displays}).messages!.find((m:any)=>m.attachments?.length).attachments[0];assert.equal(pb.id,row.id);assert.equal(pb.fileName,display.file_name);
 assert.equal((await projectInlineAttachmentDisplays(f.ctx,b,{user:userMessageId,assistant:assistantMessageId})).size,0);assert.equal(f.sends,2);
 });});
test('receipt failure does not affect canonical projection or replay the accepted send',async t=>{const f=fixture(t);await inAdapterScope(f.scope,async()=>{f.fail();const c=await send(f);const projection=await projectInlineAttachmentDisplays(f.ctx,c,{user:userMessageId,assistant:assistantMessageId});assert.equal([...projection.values()][0].extracted_content,'abc');assert.equal(f.sends,1);});});
test('retirement during projection rejects without consulting receipts or replaying the send',async t=>{const f=fixture(t);await inAdapterScope(f.scope,async()=>{const c=await send(f);const original=f.ctx.call;f.ctx.call=async(...args:any[])=>{const value=await original(...args);if(args[0]==='turnAttachment')f.retire();return value;};await assert.rejects(projectInlineAttachmentDisplays(f.ctx,c,{user:userMessageId,assistant:assistantMessageId}),/account changed/);assert.equal(f.sends,1);});});

test('ordinary uploads make zero receipt reads; excerpt checks only deduplicated current turn candidates',async()=>{
 await inAdapterScope(newAdapterScope('bounded-owner'),async()=>{
  const local=learnAttachment({id:'local',name:'excerpt.txt.extracted.txt',size:3,kind:'text'} as any);
  let reads=0;const ctx:any={readConfirmedUpload:async()=>{reads++;return undefined;}};
  const row={id:'current',name:local.name,size:3,kind:'text'};
  const c:any={id:'c',turns:[{attachments:[{...row,id:'historical'}]},{attachments:[row,row,{...row,id:'unrelated',name:'other.txt'}]}],savedBranches:[{turns:[{attachments:[{...row,id:'branch'}]}]}]};
  await restoreConfirmedUploadDisplay(ctx,c,['local'],()=>{});assert.equal(reads,0);
  rememberInlineDisplay(local,{file_name:'excerpt.txt',file_type:'txt',kind:'excerpt'},'abc');
  await restoreConfirmedUploadDisplay(ctx,c,['local'],()=>{});assert.equal(reads,1);
  c.turns.at(-1).attachments=Array.from({length:13},(_,i)=>({...row,id:'too-many-'+i}));
  await restoreConfirmedUploadDisplay(ctx,c,['local'],()=>{});assert.equal(reads,1);
 });
});

test('same-conversation copied excerpts restore display only from unique verified bytes',async()=>{
 for(const mode of ['valid','bytes','ambiguous','foreign','stale-source'])await inAdapterScope(newAdapterScope('copy-'+mode),async()=>{
  const name='excerpt.txt.extracted.txt',c:any={id:'c',turns:[{attachments:[{id:'copy',name,size:3,kind:'text'}]}]};
  const source=learnAttachment({id:'source',name,size:3,kind:'text'} as any,mode==='foreign'?'other':'c');
  rememberInlineDisplay(source,{file_name:'excerpt.txt',file_type:'txt',kind:'excerpt',...(mode==='stale-source'?{quote_message_uuid:'missing:assistant'}:{})},'abc');
  const ids=['source'];
  if(mode==='ambiguous'){const second=learnAttachment({id:'second',name,size:3,kind:'text'} as any,'c');rememberInlineDisplay(second,{file_name:'excerpt.txt',file_type:'text/plain',kind:'excerpt'},'abc');ids.push('second');}
  let reads=0;const ctx:any={call:async(method:string,cid:string,id:string)=>{reads++;assert.equal(method,'turnAttachment');assert.equal(cid,'c');assert.equal(id,'copy');return {name,data:Buffer.from(mode==='bytes'?'xyz':'abc')};}};
  await restoreConfirmedUploadDisplay(ctx,c,ids,()=>{});
  if(mode==='valid')assert.equal(knownFile('copy')?.inlineDisplay?.file_name,'excerpt.txt');
  else assert.equal(knownFile('copy')?.inlineDisplay,undefined);
  assert.equal(reads,mode==='foreign'?0:1);
 });
});
