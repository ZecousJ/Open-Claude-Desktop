/** Real authenticated read/adapter/guard + native handler; inert frame dispatcher, no network/model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../electron/store/store';
import { officialUiRead } from '../../runner/src/official-ui-read';
import { decodeWireValue, encodeWireValue } from '../../shared/web-wire';
import { officialUiCapabilitiesPath } from '../../shared/official-ui-web';
import { organizationUuid } from '../../electron/official-ui/api/context';
import { registerConversationManageHandlers } from '../../electron/ipc/conversation-manage-handlers';
const id='11111111-1111-4111-8111-111111111111';
function fixture(t:any) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'web-project-native-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new Store(root);let identity:unknown={}, writes=0, pushes=0; let beforeUpdate=()=>{};const methods:string[]=[],handlers=new Map<string,Function>();
 store.projects=[{id:'project',kind:'chat',name:'Synthetic',instructions:'',description:'',createdAt:1}];
 store.conversations=[{id,mode:'chat',title:'Synthetic',providerId:'inert',model:'inert',createdAt:1,updatedAt:1,pinned:false,archived:false,turns:[]}];
 const ctx:any={userId:7,signedOut:false,closedFlag:false,activeAccount:{id:'owner',email:'fixture@example.invalid',name:'Fixture'},officialSessionIdentity:()=>identity,setAccessToken(){},reclaimCaches(){},onEvent:()=>()=>{},appVersion:'fixture',log(){},store};
 registerConversationManageHandlers({context:{store,engine:{},accountGeneration:()=>identity,push(){pushes++;}},engineOf:()=>undefined,handle:(n:string,f:Function)=>handlers.set(n,f)} as any);
 const dispatcher:any={options:{officialUiRoot:path.resolve('build/official-ui'),officialUiActions:true},guard:{modes:['chat']},contextFor:async()=>ctx,context:()=>ctx,now:()=>1,
  run:async(frame:any)=>{methods.push(frame.method);const args=decodeWireValue(frame.args) as any[];
   if(frame.method==='snapshot')return structuredClone({projects:store.projects,conversations:store.conversations});
   if(frame.method==='conversationTurns')return structuredClone(store.conversation(args[0]));
   if(frame.method==='updateConversation'){writes++;beforeUpdate();assert.equal(args[1].projectId.version,1);return handlers.get(frame.method)!(...args);}
   throw Error('Forbidden synthetic operation '+frame.method);
  }};
 const call=(request:any,method='officialUiAction')=>officialUiRead(dispatcher,{t:'call',id:'fixture',method,args:encodeWireValue([request]),user:{id:7,accessToken:'INERT'}} as any) as Promise<any>;
 const lease=async()=>JSON.parse(Buffer.from((await call({method:'GET',path:officialUiCapabilitiesPath},'officialUiRead')).body).toString()).activationLease;
 const move=(capabilityLease:any,target:any='project',extra:any={})=>call({method:'POST',path:`/api/organizations/${organizationUuid('owner')}/chat_conversations/move_many`,contentType:'application/json',body:Buffer.from(JSON.stringify({conversation_uuids:[id],project_uuid:target})),...(capabilityLease===undefined?{}:{capabilityLease}),...extra});
 return {store,ctx,dispatcher,methods,lease,move,beforeUpdate:(f:()=>void)=>beforeUpdate=f,get pushes(){return pushes;},retire:()=>identity={},get writes(){return writes;},data:(r:any)=>JSON.parse(Buffer.from(r.body).toString())};
}
test('engine capability lease routes versioned move/remove through real guarded native handler without generating',async t=>{
 const f=fixture(t),lease=await f.lease();
 assert.deepEqual(f.data(await f.move(lease)),{moved:[id],failed:[]});
 assert.equal(new Store(f.store.root).conversation(id).projectId,'project');
 assert.deepEqual(f.data(await f.move(lease,null)),{moved:[id],failed:[]});
 assert.equal(new Store(f.store.root).conversation(id).projectId,undefined);assert.equal(f.writes,2);
 assert.ok(f.methods.every(m=>['snapshot','conversationTurns','updateConversation'].includes(m)));
});
test('missing/stale leases and unsupported query/content type cannot reach mutation',async t=>{
 const f=fixture(t);assert.equal((await f.move(undefined)).status,409);const lease=await f.lease();f.retire();assert.equal((await f.move(lease)).status,409);
 const fresh=await f.lease();assert.equal((await f.move(fresh,'project',{contentType:'text/plain'})).status,400);
 await assert.rejects(()=>f.move(fresh,'project',{path:`/api/organizations/${organizationUuid('owner')}/chat_conversations/move_many?extra=1`}));
 assert.equal(f.writes,0);
});
test('owned engine lease preserves partial results and rejects foreign destination/account without extra writes',async t=>{
 const f=fixture(t),lease=await f.lease();
 const result=await f.move(lease,'project',{body:Buffer.from(JSON.stringify({conversation_uuids:[id,'missing'],project_uuid:'project'}))});
 assert.deepEqual(f.data(result),{moved:[id],failed:['missing']});assert.equal(f.writes,1);
 assert.equal((await f.move(lease,'foreign')).status,404);
 assert.equal((await f.move(lease,'project',{path:`/api/organizations/${organizationUuid('other')}/chat_conversations/move_many`})).status,404);assert.equal(f.writes,1);
});
test('Web dispatch preserves envelope preconditions against same-ID Code replacement and newer membership',async t=>{
 for(const change of ['mode','membership']) {
  const f=fixture(t),lease=await f.lease();
  f.beforeUpdate(()=>{f.store.conversations=[{...f.store.conversations[0],...(change==='mode'?{mode:'code' as const}:{projectId:'newer'})}];});
  assert.deepEqual(f.data(await f.move(lease)),{moved:[],failed:[id]});
  assert.equal(f.pushes,0);
  assert.equal(f.store.conversations[0].projectId,change==='membership'?'newer':undefined);
  assert.equal(f.store.conversations[0].mode,change==='mode'?'code':'chat');
 }
});
