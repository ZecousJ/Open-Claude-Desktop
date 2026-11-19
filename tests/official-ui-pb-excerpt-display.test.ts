import { projectInlineAttachmentDisplays } from "../electron/official-ui/api/inline-attachment-displays";
import { userMessageId, assistantMessageId } from "../electron/official-ui/api/conversations";
/** Actual official OF/Ob -> protobuf action -> owned upload/receipt -> PB card. No provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {fromBinary,toBinary} from '@bufbuild/protobuf';
import {createActionRpc,PERFORM_ACTION_PATH} from '../electron/official-ui/api/actions';
import {loadRegistry,deepCreate,conversationUpdate} from '../electron/official-ui/api/timeline';
import {inAdapterScope,newAdapterScope} from '../electron/official-ui/api/scope';
import {knownFile,learnAttachment,loadFileRegistry,filesRoute,aliasCloudAttachments} from '../electron/official-ui/api/files';
import {storeAttachment} from '../electron/engine/composer-files';
import {openPolicy} from '../shared/client-policy';
import {prepareUploadReceipt,commitUploadReceipts,readConfirmedUploadReceipt} from '../electron/cloud/upload-receipts';
import {prepareDerivedTextAttachment,storePreparedDerivedTextAttachment} from '../electron/official-ui/api/derived-text-attachment';
import {readState} from '../electron/official-ui/api/state';
import {organizationUuid} from '../electron/official-ui/api/context';
const assets='build/official-ui/ui/assets/v1/';
const registry=loadRegistry('build/official-ui/data/conversation-protocol.json');
const request=registry.getMessage('anthropic.bard.api.v1alpha.PerformActionRequest')!;
const response=registry.getMessage('anthropic.bard.api.v1alpha.PerformActionResponse')!;
const inlineSchema=registry.getMessage('anthropic.bard.api.v1alpha.InlineAttachment')!;
function producer(text:string){
 const ordinary=fs.readFileSync(assets+'shared-m-1-Nm0kn4Ee.js','utf8');
 const convert=fs.readFileSync(assets+'30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js','utf8');
 const scope:any={Blob,GI:'excerpt_from_previous_claude_message.txt',rM:{UserUpload:'user_upload'},dS:{Excerpt:'excerpt'},hte:inlineSchema,K:deepCreate};
 vm.runInNewContext(ordinary.slice(ordinary.indexOf('function OF('),ordinary.indexOf('function mx('))+';this.quote=OF;',scope);
 vm.runInNewContext(convert.slice(convert.indexOf('function Ob('),convert.indexOf('function Ab('))+';this.convert=Ob;',scope);
 return scope.convert([scope.quote(text)]);
}
function setup(t:any,mode='normal'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pb-excerpt-display-'));t.after(()=>{inAdapterScope(scope,()=>{for(const key of ['files','aliases','message-ids'])readState(key,{});});fs.rmSync(root,{recursive:true,force:true});});
 const identity={},scope=newAdapterScope('owner',root,identity),locals=new Map<string,any>();let live=true,sends=0,reads=0,c:any;
 const receiptScope={root,service:'https://synthetic.invalid',current:()=>live};
 const ctx:any={account:()=>({id:'owner'}),sessionIdentity:()=>identity,stateDirectory:()=>root,isCurrent:()=>live,
 settings:()=>({providers:[{id:'p',model:'inert'}]}),loadConversation:async()=>{if(mode==='retire-before-upload')live=false;return undefined;},log:()=>{},
 call:async(name:string,...args:any[])=>{
  if(name==='turnAttachment')return {data:new Uint8Array(fs.readFileSync([...locals.values()][0].path))};
  if(name==='addAttachmentData'){const file=storeAttachment(path.join(root,'attachments'),args[0],args[1],openPolicy);locals.set(file.id,file);return file;}
  assert.equal(name,'send');sends++;const src=locals.get(args[0].attachments[0].id)!;
  const row={...src,id:mode==='same-id'?src.id:'cloud-'+randomUUID(),path:'/remote/untrusted'};
  c={id:randomUUID(),createdAt:1,updatedAt:1,mode:'chat',turns:[{id:randomUUID(),createdAt:1,status:'completed',prompt:args[0].text,items:[],attachments:[row],inlineAttachmentDisplays:args[0].inlineAttachmentDisplays?.map((display:any)=>({...display,attachmentId:row.id}))}]};
  const receipt=prepareUploadReceipt(receiptScope,src,fs.readFileSync(src.path),row);commitUploadReceipts(receiptScope,c,[receipt]);
  // Actual cloud timeline may learn the returned row before send settles.
  if(mode==='existing-alias')aliasCloudAttachments([src.id],[row]);
  if(mode!=='no-placeholder')learnAttachment(row,c.id);
  return c;
 },readConfirmedUpload:async(cid:string,rid:string)=>{
  reads++;assert.equal(cid,c.id);
  if(mode==='receipt-failure')throw Error('Synthetic failure');
  const receipt=readConfirmedUploadReceipt(receiptScope,c,rid);
  if(mode==='retire')live=false;
  return mode==='foreign'?{...receipt,localId:'foreign'}:receipt;
 }};
 const route=createActionRpc(ctx,registry);
 async function run(){return inAdapterScope(scope,async()=>{
  const bytes=toBinary(request,deepCreate(request,{header:{conversationId:randomUUID()},action:{case:'sendMessage',value:{messageId:randomUUID(),assistantMessageId:randomUUID(),text:'Explain',inlineAttachments:producer('原文 😀\nabc')}}}));
  let body:any;await route(Object.assign(Readable.from([bytes]),{method:'POST',headers:{'content-type':'application/proto'}}) as any,{writeHead:()=>{},end:(b:any)=>body=b} as any,PERFORM_ACTION_PATH);
  return fromBinary(response,body) as any;
 });}
 return {root,scope,ctx,run,get c(){return c;},get sends(){return sends;},get reads(){return reads;},get local(){return [...locals.values()][0];},get uploads(){return locals.size;}};
}
const original='excerpt_from_previous_claude_message.txt';
function card(c:any,inlineDisplays?:any){return conversationUpdate(c,false,{org:organizationUuid('owner'),inlineDisplays}).messages![0].attachments[0];}
test('actual OF/Ob and PB action carry turn display declarations independently of receipt cache',async t=>{
 for(const mode of ['normal','no-placeholder','same-id']){
  const f=setup(t,mode);assert.equal((await f.run()).ack.outcome.case,'applied');assert.equal(f.sends,1);assert.equal(f.reads,0);
  await inAdapterScope(f.scope,async()=>{
   const displays=await projectInlineAttachmentDisplays(f.ctx,f.c,{user:userMessageId,assistant:assistantMessageId});
   assert.equal(card(f.c,displays).fileName,original);assert.ok([f.local.id,f.c.turns[0].attachments[0].id].includes(card(f.c,displays).id));
   assert.equal(f.local.name,original+'.extracted.txt');assert.equal(fs.readFileSync(f.local.path,'utf8'),'原文 😀\nabc');
   let status=0,body:any;await filesRoute({method:'GET'} as any,{writeHead:(s:number)=>status=s,end:(b:any)=>body=b} as any,`/api/${organizationUuid('owner')}/files/${card(f.c).id}/contents`,f.ctx);
   assert.equal(status,200);assert.equal(body.toString(),'原文 😀\nabc');
  });
  await inAdapterScope(newAdapterScope('owner',f.root,{}),async()=>{loadFileRegistry();const displays=await projectInlineAttachmentDisplays(f.ctx,f.c,{user:userMessageId,assistant:assistantMessageId});assert.equal(card(f.c,displays).fileName,original);});
 }
});
test('receipt failure or foreign local ID never turns a successful send into a retry or fabricates cloud metadata',async t=>{
 for(const mode of ['receipt-failure','foreign']){const f=setup(t,mode);assert.equal((await f.run()).ack.outcome.case,'applied');assert.equal(f.sends,1);inAdapterScope(f.scope,()=>{assert.equal(knownFile(f.c.turns[0].attachments[0].id)!.inlineDisplay,undefined);assert.equal(card(f.c).fileName,original+'.extracted.txt');});}
});
test('retirement during receipt read does not copy display or replay successful send',async t=>{
 const f=setup(t,'retire');assert.equal((await f.run()).ack.outcome.case,'applied');assert.equal(f.sends,1);
 inAdapterScope(f.scope,()=>assert.equal(knownFile(f.c.turns[0].attachments[0].id)!.inlineDisplay,undefined));
});
test('legacy derivative without original metadata remains a derivative, never guessed from filename',()=>{
 inAdapterScope(newAdapterScope('legacy'),()=>{const c:any={id:'c',createdAt:1,updatedAt:1,turns:[{id:'t',prompt:'p',createdAt:1,status:'completed',items:[],attachments:[{id:'old',name:original+'.extracted.txt',size:3,kind:'text'}]}]};assert.equal(card(c).fileName,original+'.extracted.txt');});
});

test('existing positional alias is not upgraded into a receipt-certified independent cloud record',async t=>{
 const f=setup(t,'existing-alias');assert.equal((await f.run()).ack.outcome.case,'applied');assert.equal(f.sends,1);
 inAdapterScope(f.scope,()=>{const local=knownFile(f.local.id)!;assert.equal(knownFile(f.c.turns[0].attachments[0].id),local);assert.equal(local.id,f.local.id);assert.equal(card(f.c).fileName,original+'.extracted.txt');});
});
test('retired account before ordinary inline upload causes no upload or model send',async t=>{
 const f=setup(t,'retire-before-upload');assert.equal((await f.run()).ack.outcome.case,'error');assert.equal(f.uploads,0);assert.equal(f.sends,0);
});

test('upload completion microtask retirement prevents display metadata write in the helper continuation',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pb-excerpt-microtask-'));
 const scope=newAdapterScope('owner',root,{});let live=true,uploaded:any,checks=0,sends=0;
 t.after(()=>{inAdapterScope(scope,()=>readState('files',{}));fs.rmSync(root,{recursive:true,force:true});});
 const identity={};
 const ctx:any={account:()=>({id:'owner'}),sessionIdentity:()=>identity,stateDirectory:()=>root,
  isCurrent:()=>{if(uploaded && ++checks===3)queueMicrotask(()=>{live=false;});return live;},
  call:async(name:string,...args:any[])=>{if(name==='send'){sends++;throw Error('No send expected');}assert.equal(name,'addAttachmentData');uploaded=storeAttachment(path.join(root,'attachments'),args[0],args[1],openPolicy);return uploaded;}};
 await inAdapterScope(scope,async()=>{
  await assert.rejects(storePreparedDerivedTextAttachment(ctx,prepareDerivedTextAttachment({fileName:original,fileType:'txt',extractedContent:'abc'})),/account changed/);
  assert.ok(uploaded);assert.ok(knownFile(uploaded.id));assert.equal(knownFile(uploaded.id)!.inlineDisplay,undefined);assert.equal(live,false);assert.equal(sends,0);
 });
});
