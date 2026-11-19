/** Real REST -> collections IPC -> temporary project store. No account, network, or model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { guardAdapterContext } from '../electron/official-ui/api/scoped-context';
import { inAdapterScope, newAdapterScope } from '../electron/official-ui/api/scope';
import { registerCollectionHandlers } from '../electron/ipc/collections';
import { projectsRoute, knowledgeId } from '../electron/official-ui/api/projects';
import { organizationUuid } from '../electron/official-ui/api/context';

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f025-doc-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const handlers = new Map<string, any>();
  const store = {root, projects:[{id:'p',name:'Synthetic',description:'',instructions:'',createdAt:1}]};
  registerCollectionHandlers((n,fn)=>handlers.set(n,fn), {store,onSettingsChanged(){},onAccountActivated(){},onAccountDeactivating(){}} as any);
  let activation = 1;
  const calls: string[] = [];
  const ctx:any = {account:()=>({id:'synthetic-owner'}),sessionIdentity:()=>activation,isCurrent:()=>true,
    snapshot:async()=>({projects:store.projects}),call:async(n:string,...args:any[])=>{calls.push(n);return handlers.get(n)(...args);}};
  const base = `/api/organizations/${organizationUuid('synthetic-owner')}/projects/p/`;
  async function run(method:string, rest:string, body?:unknown, prefix=base, routeCtx=ctx) {
    let status=0, content='';
    const req:any=Readable.from(body===undefined?[]:[JSON.stringify(body)]);req.method=method;
    const res:any={writeHead(s:number){status=s;},end(b:any){content=String(b??'');}};
    const handled=await projectsRoute(req,res,prefix+rest,new URL(prefix+rest,'http://localhost'),routeCtx);
    return {status,handled,body:content?JSON.parse(content):undefined};
  }
  return {root,ctx,calls,run,handlers,retire:()=>activation++};
}
async function add(f:any,title='Note'){return (await f.run('POST','docs',{file_name:title,content:'synthetic'})).body.uuid;}
test('mixed unknown/duplicate IDs report only confirmed removals and repeated deletes converge',async t=>{
 const f=fixture(t),id=await add(f);f.calls.length=0;
 assert.deepEqual((await f.run('POST','docs/delete_many',{doc_uuids:[id,id,'unknown']})).body,{deleted:[id]});
 assert.equal(f.calls.filter(x=>x==='removeProjectKnowledge').length,1);
 assert.deepEqual((await f.run('POST','docs/delete_many',{doc_uuids:[id,'unknown']})).body,{deleted:[]});
 assert.equal((await f.run('DELETE','docs/'+id)).status,204);
 assert.equal(f.calls.filter(x=>x==='removeProjectKnowledge').length,1);
});
test('files partition cannot delete an ID listed as docs; foreign IDs never become names',async t=>{
 const f=fixture(t),id=await add(f);f.calls.length=0;
 assert.deepEqual((await f.run('POST','files/delete_many',{file_uuids:[id,knowledgeId('foreign','Note.md')]})).body,{deleted:[]});
 assert.ok(!f.calls.includes('removeProjectKnowledge'));
 assert.equal((await f.run('GET','docs/'+id)).status,200);
});
test('original 1000 wire limit remains while native receives only unique existing matches',async t=>{
 const f=fixture(t),id=await add(f);
 assert.deepEqual((await f.run('POST','docs/delete_many',{doc_uuids:Array(1000).fill(id)})).body,{deleted:[id]});
 assert.equal((await f.run('POST','docs/delete_many',{doc_uuids:Array(1001).fill(id)})).status,400);
 assert.equal((await f.run('POST','docs/delete_many',null)).status,400);
});
test('source errors and unconfirmed/partial removals never acknowledge success or redispatch',async t=>{
 for(const mode of ['inventory','unchanged','partial']) {
  const f=fixture(t),one=await add(f,'One'),two=await add(f,'Two'),call=f.ctx.call;f.calls.length=0;let dispatches=0;
  f.ctx.call=async(n:string,...args:any[])=>{
   if(n==='listProjectKnowledge'&&mode==='inventory')throw Error('/private/source');
   if(n==='removeProjectKnowledge'){
    dispatches++;
    if(mode==='unchanged')return f.handlers.get('listProjectKnowledge')('p');
    if(mode==='partial'){await f.handlers.get('removeProjectKnowledge')('p',[args[1][0]]);throw Error('/private/partial');}
   }
   return call(n,...args);
  };
  const r=await f.run('POST','docs/delete_many',{doc_uuids:[one,two]});
  assert.equal(r.status,503);assert.match(r.body.error.message,/could not be confirmed/);assert.doesNotMatch(JSON.stringify(r.body),/private/);
  assert.equal(dispatches,mode==='inventory'?0:1);
  const inventory=await f.handlers.get('listProjectKnowledge')('p');assert.equal(inventory.files.length,mode==='partial'?1:2);
 }
});
test('known permission denials remain visible and readonly/foreign routes never delete',async t=>{
 const f=fixture(t),id=await add(f),call=f.ctx.call;let dispatches=0;
 f.ctx.call=async(n:string,...a:any[])=>{if(n==='removeProjectKnowledge'){dispatches++;throw Error("You do not have permission to edit this project's context.");}return call(n,...a);};
 assert.equal((await f.run('DELETE','docs/'+id)).status,403);
 f.ctx.readOnly=true;assert.equal((await f.run('DELETE','docs/'+id)).status,501);
 assert.equal((await f.run('DELETE','docs/'+id,undefined,'/api/organizations/foreign/projects/p/')).status,404);
 assert.equal(dispatches,1);
});
test('actual scoped removal retirement returns 409, never retries already completed deletion',async t=>{
 const f=fixture(t),id=await add(f),call=f.ctx.call;let dispatches=0;
 f.ctx.call=async(n:string,...a:any[])=>{const result=await call(n,...a);if(n==='removeProjectKnowledge'){dispatches++;f.retire();}return result;};
 const base=`/api/organizations/${organizationUuid('synthetic-owner')}/projects/p/`;
 const r=await inAdapterScope(newAdapterScope('synthetic-owner',undefined,1),()=>f.run('DELETE','docs/'+id,undefined,base,guardAdapterContext(f.ctx)));
 assert.equal(r.status,409);assert.equal(dispatches,1);
 assert.equal((await f.handlers.get('listProjectKnowledge')('p')).files.length,0);
});

function original(name:string){const s=fs.readFileSync('build/official-ui/ui/assets/v1/shared-0-BgsOqC85.js','utf8');const a=s.indexOf(`function ${name}(`),b=s.indexOf('\nfunction ',a+1);assert.ok(a>=0&&b>a);return '('+s.slice(a,b)+')';}
test('original B7/Ft/n1 ignore success response and original docs-only envelope 404 handling remains exact',async()=>{
 class ApiError extends Error{statusCode=404;fromApiEnvelope=true;}
 const common:any={J9:()=>[],a4:()=>({activeOrganization:{uuid:'org'}}),_V:()=>({invalidateQueries(){}}),bek:()=>({addError(){}}),QT:()=>['docs'],rE:()=>['files'],nB:()=>false,qt:()=>true,gQ:(x:any)=>x,um(){},SH(){},TL(){},_3:ApiError};
 for(let n=0;n<=5;n++){common['J'+n]=()=>true;common['K'+n]=(...a:any[])=>a.at(-1);common['I'+n]=(...a:any[])=>a[2];common['Z'+n]=(...a:any[])=>a[2];}
 common.tZ=vm.runInNewContext(original('tZ'),common);common.yq=vm.runInNewContext(original('yq'),common);
 common.c1=vm.runInNewContext(original('c1'),common);common.AY=vm.runInNewContext(original('AY'),common);common.b_=vm.runInNewContext(original('b_'),common);
 for(const name of ['B7','Ft','n1']){
  let captured:any;common.Ha=(url:any,method:any,optimistic:any,options:any)=>{captured={url,method,optimistic,options};return {mutateAsync:async()=>{},isPending:false};};
  vm.runInNewContext(original(name),common)('project');
  const args=name==='B7'?{docUuid:'id'}:name==='Ft'?{doc_uuids:['id']}:{file_uuids:['id']};
  assert.equal(captured.url(args),`/api/organizations/org/projects/project/${name==='B7'?'docs/id':name==='Ft'?'docs/delete_many':'files/delete_many'}`);
  captured.options.onSuccess(new Proxy({}, {get(){throw Error('response body must not be consumed');}}),args);
  let rollbacks=0;captured.options.onError(new Error('unknown outcome'),args,{rollback(){rollbacks++;}});assert.equal(rollbacks,1);
  rollbacks=0;captured.options.onError(new ApiError(),args,{rollback(){rollbacks++;}});assert.equal(rollbacks,name==='n1'?1:0);
 }
 assert.equal(common.yq(new ApiError()),undefined);
 const raw=new ApiError();raw.fromApiEnvelope=false;assert.throws(()=>common.yq(raw));
});

test('files branch removes only its actual listed synthetic file, not docs',async t=>{
 const f=fixture(t),doc=await add(f);
 // Synthetic pre-existing inventory fixture, not a claim that normal upload accepts .bin.
 fs.writeFileSync(path.join(f.root,'projects/p/knowledge/fixture.bin'),Buffer.from([1,2,3]));
 const file=knowledgeId('p','fixture.bin');
 const r=await f.run('POST','files/delete_many',{file_uuids:[file,doc]});
 assert.deepEqual(r.body,{deleted:[file]});assert.equal(r.status,200);
 assert.equal(fs.existsSync(path.join(f.root,'projects/p/knowledge/fixture.bin')),false);
 assert.equal((await f.run('GET','docs/'+doc)).status,200);
});
test('owned explicit read-only capability rejects even absent target before mutation',async t=>{
 const f=fixture(t);
 f.ctx.snapshot=async()=>({projects:[{id:'p',name:'P',capabilities:{canEditInstructions:true,canEditKnowledgeBase:false}}]});
 assert.equal((await f.run('DELETE','docs/unknown')).status,403);
 assert.deepEqual(f.calls,[]);
});

test('batch endpoints reject GET PUT HEAD with valid bodies before all native calls, including readonly',async t=>{
 for(const route of ['docs/delete_many','files/delete_many'])for(const readOnly of [false,true])for(const method of ['GET','PUT','HEAD']) {
  const f=fixture(t),id=await add(f);f.calls.length=0;f.ctx.readOnly=readOnly;
  const body=route.startsWith('docs')?{doc_uuids:[id]}:{file_uuids:[id]};
  const r=await f.run(method,route,body);
  assert.equal(r.status,readOnly&&method!=='GET'?501:405,`${route} ${method} readonly=${readOnly}`);
  assert.deepEqual(f.calls,[]);
  assert.equal((await f.handlers.get('listProjectKnowledge')('p')).files.length,1);
 }
});
