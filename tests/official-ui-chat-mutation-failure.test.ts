/** Synthetic temporary stores only. Documents failure boundaries, not live UI acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {Readable,PassThrough} from 'node:stream';
import {Store} from '../electron/store/store';
import {CloudStore} from '../runner/src/cloud-store';
import {registerConversationManageHandlers} from '../electron/ipc/conversation-manage-handlers';
import {conversationsRoute} from '../electron/official-ui/api/conversations';
import {organizationUuid} from '../electron/official-ui/api/context';
import {createOfficialActivationLease} from '../electron/official-ui/activation-lease';
const source=fs.readFileSync('build/official-ui/ui/assets/v1/shared-m-1-Nm0kn4Ee.js','utf8');
function original(name:string,next:string){const begin=source.indexOf(`function ${name}(`),end=source.indexOf(`function ${next}(`,begin);assert.ok(begin>=0&&end>begin);return source.slice(begin,end);}
const producer:any={GC:(id:string)=>id};
vm.runInNewContext(original('Hi','xd')+original('xd','et')+original('qn','vt')+original('m$','uk').replace(/var p\$ = new Map\(\);\s*$/,'')+original('HH','S5'),producer);
const cases=[{name:'rename',field:'title',value:'Renamed synthetic',body:()=>producer.xd({conversationUuid:'owned',name:'Renamed synthetic'})}, {name:'pin',field:'pinned',value:true,body:()=>producer['m$']({conversationUuid:'owned',is_starred:true})}, {name:'archive',field:'archived',value:true,body:()=>producer.qn({conversationUuid:'owned',is_archived:true})}];
function tmp(t:any){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-failure-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function seed(store:Store){for(const id of ['owned','other'])store.conversations.push({id,mode:'chat',title:'Original',providerId:'inert',model:'inert',turns:[],createdAt:1,updatedAt:1,pinned:false,archived:false} as any);}
function harness(store:Store){const handlers=new Map<string,Function>();registerConversationManageHandlers({context:{store,engine:{},accountGeneration:()=>identity.generation},engineOf:()=>undefined,handle:(n:string,f:Function)=>handlers.set(n,f)} as any);let identity={owner:'synthetic',store:store as object,generation:1,active:true};const lease=createOfficialActivationLease(identity,()=>identity);
 // Execute the exact production window call fence, not an unguarded adapter mock.
 const windowSource=fs.readFileSync('electron/official-ui/window.ts','utf8');const start=windowSource.indexOf('  context.call = (method, ...args) => {'),end=windowSource.indexOf('\n  runtime.starting',start);assert.ok(start>0&&end>start);
 const ctx:any={account:()=>({id:identity.owner}),sessionIdentity:()=>identity.store,isCurrent:()=>lease.current(),strictActionSemantics:true,loadConversation:async(id:string)=>structuredClone(store.conversation(id))};
 vm.runInNewContext(windowSource.slice(start,end),{context:ctx,runtime:{lease},authorizeRetiredTerminalResponse:()=>undefined,routedCall:(name:string,...args:any[])=>handlers.get(name)!(...args)});
 return {ctx,rotate:(same:boolean)=>{identity={...identity,owner:same?'synthetic':'replacement',generation:2,store:same?store:{}};}};}
function invoke(ctx:any,entry:typeof cases[number],req?:any){const url=new URL(entry.name==='rename'?producer.Hi(organizationUuid('synthetic'),{conversationUuid:'owned'}):producer.HH(organizationUuid('synthetic'),'owned'),'http://fixture.invalid');req??=Readable.from([Buffer.from(JSON.stringify(entry.body()))]);req.method='PUT';req.headers={'content-type':'application/json'};let status=0,body='';const res:any={writeHead:(s:number)=>status=s,end:(v:string)=>body=v};return {run:conversationsRoute(req,res,url.pathname,url,ctx),response:()=>({status,body})};}
async function assertFailure(entry: typeof cases[number], operation: ReturnType<typeof invoke>, message: RegExp) {
  if (entry.name !== 'archive') {
    await assert.rejects(operation.run, message);
    assert.equal(operation.response().status, 0);
    return;
  }
  assert.equal(await operation.run, true);
  const {status, body} = operation.response();
  assert.equal(status, 500);
  const {error} = JSON.parse(String(body));
  assert.equal(error.type, 'api_error');
  assert.equal(error.details.error_visibility, 'user_facing');
  assert.match(error.message, /archive update could not be confirmed/);
}
for(const entry of cases){
 test(`${entry.name}: disk failure rejects API; rename/pin preserve memory, archive reports unknown with original effects retained`,async t=>{const dir=tmp(t),store=new Store(dir);seed(store);store.flush();const other=JSON.stringify(store.conversation('other')),write=store.write.bind(store);store.write=(name,value)=>{if(name==='conversations.json')throw Error('inert persistence failure');write(name,value);};const f=harness(store),op=invoke(f.ctx,entry);await assertFailure(entry,op,/inert persistence failure/);if(entry.name==='archive')assert.equal((store.conversation('owned') as any)[entry.field],entry.value);else assert.notEqual((store.conversation('owned') as any)[entry.field],entry.value);const reopened=new Store(dir);assert.notEqual((reopened.conversation('owned') as any)[entry.field],entry.value);assert.equal(JSON.stringify(store.conversation('other')),other);});
 test(`${entry.name}: service write rejection rejects rename/pin; archive also rejects its uncertain outcome`,async t=>{const dir=tmp(t);let calls=0;const store=new CloudStore({root:dir,userId:1,transport:{request:async()=>{calls++;throw Error('inert rejected transport');}},log:()=>{}});t.after(()=>store.close());seed(store);const f=harness(store),op=invoke(f.ctx,entry);await assertFailure(entry,op,/save could not be confirmed/);await store.settled();assert.ok(calls>0);assert.ok(store.failedWrites>0);assert.equal((store.conversation('owned') as any)[entry.field],entry.value);assert.equal(store.conversation('other').title,'Original');});
 test(`${entry.name}: account replacement and same-owner activation while body pending cause no dispatch`,async t=>{for(const same of [false,true]){const store=new Store(tmp(t));seed(store);store.flush();const before=JSON.stringify(store.conversations),f=harness(store),req=new PassThrough(),op=invoke(f.ctx,entry,req);await new Promise(r=>setImmediate(r));f.rotate(same);req.end(JSON.stringify(entry.body()));await assert.rejects(op.run,/account window has retired/);assert.equal(op.response().status,0);assert.equal(JSON.stringify(store.conversations),before);}});
}
