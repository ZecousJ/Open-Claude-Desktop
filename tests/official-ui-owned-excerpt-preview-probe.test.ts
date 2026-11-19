/** Regression for the demonstrated pre-fix history read selection. No network/provider. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {storeUpload,learnAttachment,filesRoute,rememberInlineDisplay,knownFile} from '../electron/official-ui/api/files';
import {inAdapterScope,newAdapterScope} from '../electron/official-ui/api/scope';
import {organizationUuid} from '../electron/official-ui/api/context';
import {storeAttachment} from '../electron/engine/composer-files';import {openPolicy} from '../shared/client-policy';
test('owned excerpt bytes stay readable after history binding without remote service',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'owned-excerpt-preview-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const identity={},scope=newAdapterScope('synthetic-owner');let remoteReads=0;
 const ctx:any={account:()=>({id:'synthetic-owner'}),sessionIdentity:()=>identity,stateDirectory:()=>root,isCurrent:()=>true,log:()=>{},call:async(method:string,...args:any[])=>{if(method==='addAttachmentData')return storeAttachment(path.join(root,'attachments'),args[0],args[1],openPolicy);assert.equal(method,'turnAttachment');remoteReads++;throw Object.assign(new Error('Synthetic unavailable'),{code:'CLAUDEX_WEB_METHOD_UNAVAILABLE',status:404});}};
 await inAdapterScope(scope,async()=>{
  const bytes=Buffer.from('own excerpt');const file=await storeUpload(ctx,'excerpt.txt.extracted.txt',bytes);rememberInlineDisplay(file,{file_name:'excerpt.txt',file_type:'txt',kind:'excerpt'},bytes.toString());
  async function get(){let status=0,body:any;await filesRoute({method:'GET'} as any,{writeHead:(s:number)=>status=s,end:(v:any)=>body=v} as any,`/api/${organizationUuid('synthetic-owner')}/files/${file.id}/contents`,ctx);return {status,body};}
  assert.equal((await get()).status,200);assert.equal(remoteReads,0);
  learnAttachment({id:file.id,name:file.name,size:file.size,kind:'text',path:file.path} as any,'synthetic-conversation');
  assert.equal(knownFile(file.id),file);assert.equal(fs.readFileSync(file.path!).toString(),'own excerpt');assert.equal((await get()).status,200);assert.equal(remoteReads,0);
 });
});
test('ephemeral upload proof rejects retirement, cross-scope, symlink and replaced file',async t=>{
 for(const mode of ['retire','scope','symlink','replace','parent-symlink']){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'owned-preview-boundary-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let identity:any={};const scope=newAdapterScope('owner');let remote=0;
 const ctx:any={account:()=>({id:'owner'}),sessionIdentity:()=>identity,stateDirectory:()=>root,isCurrent:()=>true,log:()=>{},call:async(m:string,...a:any[])=>{if(m==='addAttachmentData')return storeAttachment(path.join(root,'attachments'),a[0],a[1],openPolicy);remote++;throw Error('No remote call');}};
 const file=await inAdapterScope(scope,()=>storeUpload(ctx,'n.txt',Buffer.from('abc')));
 await inAdapterScope(scope,async()=>{learnAttachment({id:file.id,name:file.name,size:3,kind:'text'} as any,'c');
 if(mode==='retire')identity={};
 if(mode==='symlink'){fs.renameSync(file.path!,file.path!+'.saved');fs.symlinkSync(file.path!+'.saved',file.path!);}
 if(mode==='replace'){fs.renameSync(file.path!,file.path!+'.saved');fs.writeFileSync(file.path!,'abc');}
 if(mode==='parent-symlink'){const folder=path.dirname(file.path!);fs.renameSync(folder,folder+'.saved');fs.symlinkSync(folder+'.saved',folder);}
 let status=0;await filesRoute({method:'GET'} as any,{writeHead:(s:number)=>status=s,end:()=>{}} as any,`/api/${organizationUuid('owner')}/files/${file.id}/contents`,ctx);if(mode!=='scope')assert.ok([409,503].includes(status),mode);else assert.equal(status,200);
 });
 if(mode==='scope')await inAdapterScope(newAdapterScope('other'),async()=>{let status=0;await filesRoute({method:'GET'} as any,{writeHead:(s:number)=>status=s,end:()=>{}} as any,`/api/${organizationUuid('owner')}/files/${file.id}/contents`,ctx);assert.equal(status,404);});
 assert.equal(remote,0);
 }
});
test('unproven imported history path still uses authoritative service',async()=>{
 await inAdapterScope(newAdapterScope('owner'),async()=>{
 const a={id:'imported',name:'n.txt',size:3,kind:'text',path:'/not-an-upload/n.txt'};learnAttachment(a as any,'c');let calls=0,status=0;
 const ctx:any={account:()=>({id:'owner'}),sessionIdentity:()=>1,isCurrent:()=>true,log:()=>{},call:async(m:string)=>{assert.equal(m,'turnAttachment');calls++;return {data:Buffer.from('abc')};}};
 await filesRoute({method:'GET'} as any,{writeHead:(s:number)=>status=s,end:()=>{}} as any,`/api/${organizationUuid('owner')}/files/imported/contents`,ctx);assert.equal(status,200);assert.equal(calls,1);
 });
});
test('replacement or activation retirement during descriptor read cannot return bytes',async t=>{
 for(const mode of ['replace','retire']){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'owned-preview-race-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let identity:any={};const scope=newAdapterScope('owner');let remote=0;
 const ctx:any={account:()=>({id:'owner'}),sessionIdentity:()=>identity,stateDirectory:()=>root,isCurrent:()=>true,log:()=>{},call:async(m:string,...a:any[])=>{if(m==='addAttachmentData')return storeAttachment(path.join(root,'attachments'),a[0],a[1],openPolicy);remote++;throw Error('No remote');}};
 await inAdapterScope(scope,async()=>{
 const file=await storeUpload(ctx,'n.txt',Buffer.from('abc'));learnAttachment({id:file.id,name:file.name,size:3,kind:'text'} as any,'c');
 const original=fs.readSync;let changed=false,status=0,body:any;
 (fs as any).readSync=(...args:any[])=>{const result=(original as any)(...args);if(!changed){changed=true;if(mode==='replace'){fs.renameSync(file.path!,file.path!+'.saved');fs.writeFileSync(file.path!,'abc');}else identity={};}return result;};
 try{await filesRoute({method:'GET'} as any,{writeHead:(s:number)=>status=s,end:(v:any)=>body=v} as any,`/api/${organizationUuid('owner')}/files/${file.id}/contents`,ctx);}finally{fs.readSync=original;}
 assert.ok([409,503].includes(status));assert.notEqual(Buffer.isBuffer(body)?body.toString():body,'abc');assert.equal(remote,0);
 });}
});
test('same-size replacement before proof mint cannot substitute different uploaded bytes',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'owned-preview-mint-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const scope=newAdapterScope('owner'),identity={};
 const ctx:any={account:()=>({id:'owner'}),sessionIdentity:()=>identity,stateDirectory:()=>root,isCurrent:()=>true,log:()=>{},call:async(m:string,...a:any[])=>{assert.equal(m,'addAttachmentData');const file=storeAttachment(path.join(root,'attachments'),a[0],a[1],openPolicy);fs.writeFileSync(file.path,'xyz');return file;}};
 await inAdapterScope(scope,async()=>{await assert.rejects(storeUpload(ctx,'n.txt',Buffer.from('abc')),/content changed/);const ids=fs.readdirSync(path.join(root,'attachments'));assert.equal(ids.length,1);assert.equal(knownFile(ids[0]),undefined);});
});
