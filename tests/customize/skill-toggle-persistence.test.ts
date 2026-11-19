import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {useElectronShim} from '../runner/runner-core-support.test';
import {Store} from '../../electron/store/store';
import {skillsRoute} from '../../electron/official-ui/api/skills';
import {organizationUuid} from '../../electron/official-ui/api/context';
useElectronShim();
const {registerSkillHandlers}=await import('../../electron/ipc/skills');
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
function fixture(t:any){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'skill-toggle-owned-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new Store(root), file=path.join(root,'codex-home/skills/sample/SKILL.md'), config=path.join(root,'synthetic-runtime-config.json');
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'---\nname: sample\ndescription: Inert fixture\n---\nDo not execute.');fs.writeFileSync(config,JSON.stringify({enabled:true}));store.flush();
 let currentStore=store, identity:unknown={}, retiring=false, writeWait:Promise<void>|undefined, rejectWrite=false, lie=false, reads=0,writes=0;
 const rpc={call:async(method:string,args:any)=>{
  if(method==='skills/list'){reads++;return {data:[{skills:[{path:file,name:'sample',scope:'user',enabled:JSON.parse(fs.readFileSync(config,'utf8')).enabled}]}]};}
  if(method!=='skills/config/write')throw Error('No SDK/skill execution allowed');
  writes++;if(writeWait)await writeWait;if(rejectWrite)throw Error('inert refusal');
  if(!lie)fs.writeFileSync(config,JSON.stringify({enabled:args.enabled}));return {};
 }};
 const engine={rpc,ensure:async()=>{throw Error('Runtime start forbidden');}};
 const ctx={get store(){return currentStore},engine,window:undefined,get accountActivationIdentity(){return identity},get accountRetiring(){return retiring}};
 const handlers=new Map<string,(...args:any[])=>any>();registerSkillHandlers((n,fn)=>handlers.set(n,fn),ctx as never);
 const call=(name:string,...args:any[])=>handlers.get(name)!(...args);
 const adapter:any={account:()=>({id:'a'}),sessionIdentity:()=>identity,stateDirectory:()=>currentStore.root,isCurrent:()=>!retiring,call};
 async function request(action:string,body:any={},method='POST',org=organizationUuid('a')){
  const req=Readable.from([JSON.stringify(body)]) as any;req.method=method;req.headers={};
  const res:any={status:200,body:'',writeHead(status:number){this.status=status},end(value:string){this.body=value}};
  const p=`/api/organizations/${org}/skills/${action}`;await skillsRoute(req,res,p,new URL(p,'http://inert'),adapter);return {status:res.status,body:JSON.parse(res.body)};
 }
 return {root,store,file,config,call,request,get writes(){return writes},get reads(){return reads},wait(p:Promise<void>){writeWait=p},reject(){rejectWrite=true},lie(){lie=true},retire(){retiring=true;identity={}},aba(){identity={}},switchStore(){currentStore=new Store(path.join(root,'other'));identity={};return currentStore;}};
}
test('actual registered toggle plus API reads persist disable, reopen and re-enable using a self-authored inert skill',async t=>{
 const f=fixture(t),list=await f.request('list-skills',{},'GET'),id=list.body.skills[0].id;
 const off=await f.request('disable-skill',{skill_id:id});assert.equal(off.status,200);assert.equal(off.body.enabled,false);
 assert.deepEqual(new Store(f.root).settings.disabledSkills,[f.file]);
 const reopened=await f.request('list-skills',{},'GET');assert.equal(reopened.body.skills[0].enabled,false);
 const on=await f.request('enable-skill',{skill_id:id});assert.equal(on.status,200);assert.equal(on.body.enabled,true);
 assert.deepEqual(new Store(f.root).settings.disabledSkills,[]);assert.equal(f.writes,2);
});
test('RPC rejection or unconfirmed readback returns failure, does not fabricate enabled state or replay',async t=>{
 for(const failure of ['reject','lie'] as const){const f=fixture(t);const id=(await f.request('list-skills',{},'GET')).body.skills[0].id;f[failure]();
 const result=await f.request('disable-skill',{skill_id:id});assert.equal(result.status,400);assert.equal(f.writes,1);assert.equal(f.store.settings.disabledSkills,undefined);assert.equal(JSON.parse(fs.readFileSync(f.config,'utf8')).enabled,true);}
});
test('late config write cannot mutate replacement account or same-store activation after await',async t=>{
 for(const kind of ['store','aba','retire']){const f=fixture(t),wait=deferred();f.wait(wait.promise);const pending=f.call('setSkillEnabled',f.file,false);
 while(!f.writes)await new Promise(r=>setImmediate(r));
 const other=kind==='store'?f.switchStore():undefined;if(kind==='aba')f.aba();if(kind==='retire')f.retire();wait.resolve();
 await assert.rejects(pending,/account changed/);assert.equal(f.store.settings.disabledSkills,undefined);assert.equal(other?.settings.disabledSkills,undefined);assert.equal(f.writes,1);}
});
test('local flush failure restores only owned in-memory value and explicitly leaves runtime outcome visible',async t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.root,'settings.json.tmp'));
 await assert.rejects(f.call('setSkillEnabled',f.file,false),/runtime.*restart state/);
 assert.equal(f.store.settings.disabledSkills,undefined);assert.equal(JSON.parse(fs.readFileSync(f.config,'utf8')).enabled,false);assert.equal(f.writes,1);
});
test('method, organization, forged ID and wrong boolean fail before any configuration write',async t=>{
 const f=fixture(t),id=(await f.request('list-skills',{},'GET')).body.skills[0].id;
 assert.equal((await f.request('disable-skill',{skill_id:id},'GET')).status,405);
 const reads=f.reads;assert.equal((await f.request('disable-skill',{skill_id:id},'POST',organizationUuid('b'))).status,404);assert.equal(f.reads,reads);
 assert.equal((await f.request('disable-skill',{skill_id:'/arbitrary/path'})).status,400);
 await assert.rejects(f.call('setSkillEnabled',f.file,'false'));assert.equal(f.writes,0);
});
test('same-store toggles serialize and preserve final confirmed restart state',async t=>{
 const f=fixture(t),wait=deferred();f.wait(wait.promise);
 const off=f.call('setSkillEnabled',f.file,false),on=f.call('setSkillEnabled',f.file,true);
 while(!f.writes)await new Promise(r=>setImmediate(r));assert.equal(f.writes,1);
 wait.resolve();await Promise.all([off,on]);assert.equal(f.writes,2);
 assert.equal(JSON.parse(fs.readFileSync(f.config,'utf8')).enabled,true);assert.deepEqual(new Store(f.root).settings.disabledSkills,[]);
});
test('failed flush cannot overwrite an intervening disabledSkills value',async t=>{
 const f=fixture(t),replacement=['concurrent-setting'];
 t.mock.method(f.store,'flush',()=>{f.store.settings.disabledSkills=replacement;throw Error('inert failure');});
 await assert.rejects(f.call('setSkillEnabled',f.file,false),/restart state/);
 assert.equal(f.store.settings.disabledSkills,replacement);assert.equal(f.writes,1);
});

test('actual CloudStore delayed/rejected settings acknowledgement cannot report toggle success',async t=>{
 const {CloudStore}=await import('../../runner/src/cloud-store');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'skill-toggle-cloud-'));
 let release!:()=>void,reject!:()=>void,ack=false,puts=0,writeCalls=0,enabled=true;
 let saved:any;
 const store=new CloudStore({root,userId:1,log(){},transport:{request:async(op,_id,body:any)=>{
  if(op==='store.settings.put'){puts++;if(!ack)await new Promise<void>((r,j)=>{release=r;reject=()=>j(Error('inert service refusal'));});saved=structuredClone(body.settings);}
  return {};
 }}});
 t.after(async()=>{ack=true;await store.close();fs.rmSync(root,{recursive:true,force:true});});
 const file=path.join(root,'codex-home/skills/sample/SKILL.md');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'---\nname: sample\n---\nInert only.');
 const engine={rpc:{call:async(method:string,args:any)=>{if(method==='skills/list')return{data:[{skills:[{path:file,name:'sample',enabled}]}]};if(method==='skills/config/write'){writeCalls++;enabled=args.enabled;return{}}throw Error('No execution');}}};
 const handlers=new Map<string,Function>();const ctx={store,engine,window:undefined,accountActivationIdentity:{},accountRetiring:false};
 registerSkillHandlers((n,h)=>handlers.set(n,h),ctx as never);
 let completed=false;const pending=handlers.get('setSkillEnabled')!(file,false).then(()=>{completed=true});
 while(!puts)await new Promise(r=>setImmediate(r));assert.equal(completed,false);reject();
 await assert.rejects(pending,/restart state/);assert.equal(completed,false);assert.equal(writeCalls,1);assert.equal(store.settings.disabledSkills,undefined);assert.equal(saved,undefined);assert.equal(enabled,false);
 // An explicit later operation may confirm its own save; no automatic RPC replay occurred.
 ack=true;await handlers.get('setSkillEnabled')!(file,true);assert.equal(writeCalls,2);assert.deepEqual(Reflect.get(saved ?? {},'disabledSkills'),[]);
 const reopened=await CloudStore.open({root:path.join(root,'reopened'),userId:1,log(){},transport:{request:async(op)=>op==='store.settings.get'?{settings:saved}:op==='store.projects.list'?{projects:[]}:{items:[]}}});
 assert.deepEqual(reopened.settings.disabledSkills,[]);await reopened.close();void release;
});
test('activation replacement while settings persistence awaits cannot return success',async t=>{
 const f=fixture(t),wait=deferred();let entered=false;
 t.mock.method(f.store,'persistSkillPreference',async()=>{entered=true;await wait.promise;});
 const pending=f.call('setSkillEnabled',f.file,false);
 while(!entered)await new Promise(r=>setImmediate(r));f.aba();wait.resolve();
 await assert.rejects(pending,/account changed/);assert.equal(f.writes,1);
});
