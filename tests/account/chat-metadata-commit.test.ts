import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../../electron/store/store';
import {CloudStore} from '../../runner/src/cloud-store';
function root(t:any){const p=fs.mkdtempSync(path.join(os.tmpdir(),'metadata-ack-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function conversation(){return {id:'own',mode:'chat',title:'Before',providerId:'inert',model:'inert',createdAt:1,updatedAt:1,turns:[],pinned:false} as any;}
function deferred(){let resolve!:(x?:unknown)=>void;return {promise:new Promise(r=>resolve=r),resolve};}
test('local commit writes the candidate before publishing memory, reopens and preserves other rows',async t=>{const dir=root(t),s=new Store(dir),c=conversation(),other={...conversation(),id:'other'};s.conversations.push(c,other);s.flush();await s.persistChatMetadata(c,{title:'After',titleSetByUser:true},()=>true);assert.equal(c.title,'After');assert.equal(new Store(dir).conversation('own').title,'After');assert.equal(new Store(dir).conversation('other').title,'Before');});
test('cloud confirmation waits for the exact target acknowledgement',async t=>{const wait=deferred(),entered=deferred();const s=new CloudStore({root:root(t),userId:1,log:()=>{},transport:{request:async(op)=>{if(op==='store.conversations.put'){entered.resolve();await wait.promise;}return {};}}});t.after(()=>s.close());const c=conversation();s.conversations.push(c);let returned=false;const p=s.persistChatMetadata(c,{pinned:true},()=>true).then(()=>returned=true);await entered.promise;assert.equal(returned,false);wait.resolve();await p;assert.equal(returned,true);});
test('unrelated successful sync cannot substitute for failed target metadata ack',async t=>{let reject=true;const s=new CloudStore({root:root(t),userId:1,log:()=>{},transport:{request:async(op)=>{if(op==='store.conversations.put'&&reject)throw Error('inert');return {};}}});t.after(()=>{reject=false;return s.close();});const c=conversation();s.conversations.push(c);await assert.rejects(s.persistChatMetadata(c,{title:'After'},()=>true),/could not be confirmed/);assert.equal(c.title,'After');assert.ok(s.failedWrites);});
test('retired pending cloud commit cannot report success or overwrite a replacement store',async t=>{const wait=deferred(),entered=deferred();let current=true;const s=new CloudStore({root:root(t),userId:1,log:()=>{},transport:{request:async(op)=>{if(op==='store.conversations.put'){entered.resolve();await wait.promise;}return {};}}});t.after(()=>s.close());const c=conversation(),replacement=conversation();s.conversations.push(c);const p=s.persistChatMetadata(c,{pinned:true},()=>current);await entered.promise;current=false;wait.resolve();await assert.rejects(p,/account changed/);assert.equal(replacement.pinned,false);assert.equal(c.pinned,true);});
test('late successful ack for old metadata does not report newer concurrent value as this save',async t=>{const wait=deferred(),entered=deferred();let first=true;const s=new CloudStore({root:root(t),userId:1,log:()=>{},transport:{request:async(op)=>{if(op==='store.conversations.put'&&first){first=false;entered.resolve();await wait.promise;}return {};}}});t.after(()=>s.close());const c=conversation();s.conversations.push(c);const p=s.persistChatMetadata(c,{title:'A'},()=>true);await entered.promise;c.title='B';wait.resolve();await assert.rejects(p,/could not be confirmed/);assert.equal(c.title,'B');});
test('already retired helper does not mutate or dispatch',async t=>{let calls=0;const s=new CloudStore({root:root(t),userId:1,log:()=>{},transport:{request:async()=>{calls++;return {};}}});const c=conversation();s.conversations.push(c);await assert.rejects(s.persistChatMetadata(c,{pinned:true},()=>false),/account changed/);assert.equal(c.pinned,false);assert.equal(calls,0);await s.close();});

test('concurrent rename and pin preserve both fields; old digest cannot consume the newer acknowledgement',async t=>{
 const wait=deferred(),entered=deferred();let first=true;const writes:any[]=[];
 const s=new CloudStore({root:root(t),userId:1,log:()=>{},transport:{request:async(op,_user,body:any)=>{
  if(op==='store.conversations.put'){writes.push(structuredClone(body));if(first){first=false;entered.resolve();await wait.promise;}}return {};
 }}});t.after(()=>s.close());const c=conversation();s.conversations.push(c);
 const rename=s.persistChatMetadata(c,{title:'Renamed'},()=>true);const rejected=assert.rejects(rename,/could not be confirmed/);
 await entered.promise;
 const pin=s.persistChatMetadata(c,{pinned:true},()=>true);wait.resolve();await Promise.all([rejected,pin]);
 assert.equal(c.title,'Renamed');assert.equal(c.pinned,true);assert.equal(writes.length,2);
 assert.equal(writes[0].doc.conversation.title,'Renamed');assert.equal(writes[0].doc.conversation.pinned,false);
 assert.equal(writes[1].doc.conversation.title,'Renamed');assert.equal(writes[1].doc.conversation.pinned,true);
});
