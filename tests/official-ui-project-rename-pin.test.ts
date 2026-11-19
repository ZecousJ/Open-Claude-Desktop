/** F028: actual native workspace save + temporary Store; no account/network/UI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {Store} from '../electron/store/store';
import {projectsRoute} from '../electron/official-ui/api/projects';
import {organizationUuid} from '../electron/official-ui/api/context';
import {useElectronShim} from './runner/runner-core-support.test';
useElectronShim();
const {registerWorkspaceHandlers}=await import('../electron/ipc/workspace');
function fixture(t:any){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'f028-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let store=new Store(path.join(root,'a')), owner='a', identity:unknown={}, saves=0;
 const handlers=new Map<string,Function>();
 const events:unknown[]=[];
 const bind=()=>{handlers.clear();registerWorkspaceHandlers((n,h)=>handlers.set(n,h),{store,selectedFolders:new Set(),selectedAttachments:new Map(),allowedFolder(){},policy:()=>({}),push(event:unknown){events.push(event);}} as any);};
 store.projects=['older','newer'].map((id,i)=>({id,kind:'chat',name:id,description:'keep',instructions:'keep',createdAt:i+1}));store.flush();bind();
 let snapshotHook:undefined|(()=>void),bodyHook:undefined|(()=>void);
 const ctx:any={account:()=>({id:owner,email:'synthetic@example.invalid'}),sessionIdentity:()=>identity,
 snapshot:async()=>{const projects=structuredClone(store.projects);const h=snapshotHook;snapshotHook=undefined;h?.();return{projects};},
 call:async(n:string,...args:any[])=>{if(n==='listProjectKnowledge')return{files:[]};if(n==='saveProject')saves++;return handlers.get(n)!(...args);}};
 return {events,get store(){return store;},get saves(){return saves;},
 reopen(){store=new Store(path.join(root,'a'));bind();},
 fail(){const write=store.write.bind(store);store.write=(n,v)=>{if(n==='projects.json')throw Error('Synthetic disk failure');write(n,v);};},
 duringSnapshot(fn:()=>void){snapshotHook=fn;},duringBody(fn:()=>void){bodyHook=fn;},
 unset(){identity=undefined;},
 switch(){owner='b';identity={};},reactivate(){identity={};},
 async run(method='GET',body?:any,suffix='/older'){
 let status=0,data:any;const req:any=Readable.from((function*(){if(body!==undefined)yield Buffer.from(JSON.stringify(body));const h=bodyHook;bodyHook=undefined;h?.();})());req.method=method;req.headers={'content-type':'application/json'};
 const p=`/api/organizations/${organizationUuid('a')}/projects${suffix}`;
 await projectsRoute(req,{writeHead:(n:number)=>{status=n;},end:(v:any)=>{if(v!==undefined)data=JSON.parse(String(v));}} as any,p,new URL(p,'http://fixture.invalid'),ctx);
 return{status,data};}
 };
}
test('F028 rename/pin repeat, list ordering, unpin and reopen use actual native Store',async t=>{
 const f=fixture(t);
 for(let i=0;i<2;i++){const r=await f.run('PUT',{name:'  中文 project ✓  ',is_starred:true,description:'keep',prompt_template:'keep',is_private:true});assert.equal(r.status,200);assert.equal(r.data.name,'中文 project ✓');assert.equal(r.data.is_starred,true);}
 f.reopen();let list=await f.run('GET',undefined,'');assert.deepEqual(list.data.map((p:any)=>p.uuid),['older','newer']);
 let detail=await f.run();assert.equal(detail.data.name,'中文 project ✓');assert.equal(detail.data.description,'keep');assert.equal(detail.data.prompt_template,'keep');
 assert.equal((await f.run('PATCH',{is_starred:false})).status,200);f.reopen();list=await f.run('GET',undefined,'');assert.deepEqual(list.data.map((p:any)=>p.uuid),['newer','older']);assert.equal((await f.run()).data.is_starred,false);
});
test('F028 native disk failure restores in-memory project and leaves reopened data unchanged',async t=>{
 const f=fixture(t);f.fail();const r=await f.run('PUT',{name:'not committed',is_starred:true});assert.notEqual(r.status,200);assert.equal(f.store.projects[0].name,'older');assert.equal(f.store.projects[0].pinned,undefined);f.reopen();assert.equal((await f.run()).data.name,'older');assert.equal((await f.run()).data.is_starred,false);assert.equal(f.saves,1);
});
test('project metadata changes notify other windows only after a successful save',async t=>{
 const f=fixture(t);
 for(const body of [{name:'Renamed project'},{is_starred:true},{prompt_template:'Updated project guidance'},{prompt_template:''}]){
  const count=f.events.length;
  assert.equal((await f.run('PUT',body)).status,200);
  assert.deepEqual(f.events.slice(count),[{type:'resync'}]);
 }
 const count=f.events.length;
 f.fail();
 assert.notEqual((await f.run('PUT',{name:'Uncommitted project'})).status,200);
 assert.equal(f.events.length,count);
});
test('project deletion refreshes other windows after the project disappears from the saved list', async t => {
 const f = fixture(t);
 assert.equal((await f.run('DELETE')).status, 204);
 assert.deepEqual(f.events, [{ type: 'resync' }]);
 f.reopen();
 assert.equal((await f.run()).status, 404);
 assert.equal((await f.run('GET', undefined, '/newer')).status, 200);

 f.fail();
 assert.notEqual((await f.run('DELETE', undefined, '/newer')).status, 204);
 assert.deepEqual(f.events, [{ type: 'resync' }]);
 assert.equal((await f.run('GET', undefined, '/newer')).status, 200);
});
test('F028 account and activation changes during snapshot/body cannot mutate project',async t=>{
 for(const point of ['snapshot','body'])for(const change of ['switch','reactivate']){
 const f=fixture(t);const fn=()=>change==='switch'?f.switch():f.reactivate();if(point==='snapshot')f.duringSnapshot(fn);else f.duringBody(fn);
 const r=await f.run('PUT',{name:'wrong activation',is_starred:true});assert.equal(r.status,409,point+'/'+change);assert.equal(f.saves,0);assert.equal(f.store.projects[0].name,'older');
 }
});
test('F028 cross-owner org and nonexistent project never save',async t=>{const f=fixture(t);assert.equal((await f.run('PUT',{name:'missing'},'/missing')).status,404);f.switch();assert.equal((await f.run('PUT',{name:'foreign'})).status,404);assert.equal(f.saves,0);});

test('F028 invalid rename/star values are errors, never successful no-op saves',async t=>{
 const f=fixture(t);for(const body of [{name:''},{name:'   '},{name:'x'.repeat(201)},{name:9},{is_starred:'true'},null,[]]){assert.equal((await f.run('PUT',body)).status,400);}
 assert.equal(f.saves,0);assert.equal(f.store.projects[0].name,'older');
});

test('F024 native instructions reject invalid inputs before writing and accept the limit and clear', async t => {
  const f = fixture(t);
  for (const prompt_template of [null, 12, [], '文'.repeat(100_001)]) {
    assert.equal((await f.run('PUT', { prompt_template })).status, 400);
  }
  assert.equal(f.saves, 0);
  assert.equal((await f.run()).data.prompt_template, 'keep');

  const instructions = '文'.repeat(100_000);
  assert.equal((await f.run('PUT', { prompt_template: instructions })).status, 200);
  f.reopen();
  assert.equal((await f.run()).data.prompt_template, instructions);
  assert.equal((await f.run('PUT', { prompt_template: '' })).status, 200);
  f.reopen();
  assert.equal((await f.run()).data.prompt_template, '');
});

test('F028 missing activation cannot authorize a project mutation',async t=>{const f=fixture(t);f.unset();assert.equal((await f.run('PATCH',{is_starred:true})).status,409);assert.equal(f.saves,0);});
