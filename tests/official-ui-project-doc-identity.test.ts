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
  const ctx:any = {account:()=>({id:'synthetic-owner'}),stateDirectory:()=>root,sessionIdentity:()=>activation,isCurrent:()=>true,
    snapshot:async()=>({projects:store.projects}),call:async(n:string,...args:any[])=>{calls.push(n);return handlers.get(n)(...args);}};
  const base = `/api/organizations/${organizationUuid('synthetic-owner')}/projects/p/`;
  async function run(method:string, rest:string, body?:unknown, prefix=base, routeCtx=ctx) {
    let status=0, content='';
    const req:any=Readable.from(body===undefined?[]:[JSON.stringify(body)]);req.method=method;
    const res:any={writeHead(s:number){status=s;},end(b:any){content=String(b??'');}};
    const url=new URL(prefix+rest,'http://localhost');
    const handled=await projectsRoute(req,res,url.pathname,url,routeCtx);
    return {status,handled,body:content?JSON.parse(content):undefined};
  }
  return {ctx,calls,run,handlers,retire:()=>activation++};
}
test('official title/body shape saves actual normalized identity and detail/list agree',async t=>{
  const f=fixture(t);
  for(const title of ['Notes','  spaced  title.TXT  ','nested/你好']) {
    const content='你好\r\nsecond line 🦊';
    const added=await f.run('POST','docs',{file_name:title,content});
    assert.equal(added.status,200);
    const inventory:any=await f.handlers.get('listProjectKnowledge')('p');
    const real=inventory.files.find((x:any)=>knowledgeId('p',x.name)===added.body.uuid);
    assert.ok(real); assert.equal(added.body.file_name,real.name);
    assert.equal(added.body.content,content);
    const reopened=await f.run('GET',`docs/${added.body.uuid}`);
    assert.deepEqual(reopened.body,added.body);
    const list=await f.run('GET','docs');
    assert.deepEqual(list.body.find((x:any)=>x.uuid===added.body.uuid),added.body);
  }
});
test('compact project knowledge lists do not read every document body and details still return the full text',async t=>{
  const f=fixture(t);
  const text='Original 中文 project document 🦊\n';
  const saved=await f.run('POST','docs',{file_name:'Notes',content:text});
  f.calls.length=0;
  const list=await f.run('GET','docs?compact=true');
  assert.equal(list.status,200);
  assert.equal(list.body.length,1);
  assert.equal(list.body[0].content,'');
  assert.equal(list.body[0].content_length,[...text].length);
  assert.equal(saved.body.content_length,list.body[0].content_length);
  assert.ok(!f.calls.includes('readProjectKnowledge'));
  assert.equal((await f.run('GET',`docs/${saved.body.uuid}`)).body.content,text);
  const cold = newAdapterScope('synthetic-owner');
  await inAdapterScope(cold, async()=>{
    f.calls.length=0;
    const first=await f.run('GET','docs?compact=true');
    assert.equal(first.body[0].content_length,[...text].length);
    assert.equal(first.body[0].content,'');
    assert.equal(f.calls.filter(c=>c==='readProjectKnowledge').length,1);
    await f.run('GET','docs?compact=true');
    assert.equal(f.calls.filter(c=>c==='readProjectKnowledge').length,1,'unchanged compact lists reuse the character count');
    await f.handlers.get('addProjectKnowledgeText')('p',{name:'Notes',text:'Changed 中文'});
    const changed=await f.run('GET','docs?compact=true');
    assert.equal(changed.body[0].content_length,[...'Changed 中文'].length);
    assert.equal(f.calls.filter(c=>c==='readProjectKnowledge').length,2);
  });
});
test('same-name overwrite remains existing store behavior, not an edit/version claim',async t=>{
  const f=fixture(t);
  const a=await f.run('POST','docs',{file_name:'Note',content:'old'});
  const b=await f.run('POST','docs',{file_name:'Note',content:'new'});
  assert.equal(a.body.uuid,b.body.uuid);
  assert.equal((await f.run('GET',`docs/${b.body.uuid}`)).body.content,'new');
  assert.equal((await f.run('GET','docs')).body.length,1);
});
test('uploaded text extensions and converted document display names survive fresh reads', async t => {
  const f = fixture(t);
  for (const title of ['script.py', 'data.json', 'table.tsv', 'table.csv', 'report.docx', 'book.epub', 'notebook.ipynb', 'App.vue', 'schema.proto', 'Dockerfile', 'Makefile', '.env', '.gitignore']) {
    const saved = await f.run('POST', 'docs', { file_name: title, content: 'Complete document text' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.file_name, title);
    const scope = newAdapterScope('synthetic-owner');
    const cold = await inAdapterScope(scope, () => f.run('GET', `docs/${saved.body.uuid}`));
    assert.equal(cold.body.file_name, title);
    assert.equal(cold.body.content, 'Complete document text');
  }
  const rows = (await f.handlers.get('listProjectKnowledge')('p')).files;
  assert.ok(rows.some((file: { name: string }) => file.name === 'script.py'));
  assert.ok(rows.some((file: { name: string; displayName?: string }) => file.name === 'report.docx.md' && file.displayName === 'report.docx'));
});
test('unsupported filenames are rejected before dispatching a document write', async t => {
  const f = fixture(t);
  for (const file_name of ['x'.repeat(121), '文'.repeat(84) + '.txt']) {
    const result = await f.run('POST', 'docs', { file_name, content: 'Keep existing files.' });
    assert.equal(result.status, 400);
  }
  assert.ok(!f.calls.includes('addProjectKnowledgeText'));
});
test('full projects return the original upload refusal codes without writing and allow retry after removal', async t => {
  const f = fixture(t);
  const folder = path.join(f.ctx.stateDirectory(), 'projects', 'p', 'knowledge');
  fs.mkdirSync(folder, { recursive: true });
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(folder, `seed-${i}.md`), 'x');
  const text = await f.run('POST', 'docs', { file_name: 'overflow', content: 'new text' });
  assert.equal(text.status, 400);
  assert.equal(text.body.error.details.error_code, 'project_file_limit_reached');
  assert.equal(fs.readdirSync(folder).length, 200);

  const upload = async () => {
    const boundary = 'capacity-fixture';
    const req = Readable.from([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="overflow.csv"\r\nContent-Type: text/csv\r\n\r\nx,y\r\n--${boundary}--\r\n`)]) as any;
    req.method = 'POST'; req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    let status = 0, body = '';
    const res: any = { writeHead(code: number) { status = code; }, end(value: unknown) { body = String(value ?? ''); } };
    const url = new URL(`/api/organizations/${organizationUuid('synthetic-owner')}/projects/p/upload`, 'http://localhost');
    await projectsRoute(req, res, url.pathname, url, f.ctx);
    return { status, body: JSON.parse(body) };
  };
  const raw = await upload();
  assert.equal(raw.status, 400);
  assert.equal(raw.body.error.details.error_code, 'project_file_limit_reached');
  assert.equal(fs.readdirSync(folder).length, 200);
  await f.handlers.get('removeProjectKnowledge')('p', 'seed-0.md');
  assert.equal((await upload()).status, 200);
  assert.equal(fs.readFileSync(path.join(folder, 'overflow.csv'), 'utf8'), 'x,y');
});
test('project byte capacity is a storage refusal rather than an unknown upload outcome', async t => {
  const f = fixture(t);
  const folder = path.join(f.ctx.stateDirectory(), 'projects', 'p', 'knowledge');
  fs.mkdirSync(folder, { recursive: true });
  const content = Buffer.alloc(25_000_000, 'x');
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(folder, `seed-${i}.txt`), content);
  const result = await f.run('POST', 'docs', { file_name: 'overflow', content: 'x' });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.details.error_code, 'project_storage_full');
  assert.equal(fs.readdirSync(folder).length, 4);
});
test('unknown document and foreign organization never read arbitrary file paths',async t=>{
  const f=fixture(t);
  assert.equal((await f.run('GET','docs/unknown')).status,404);
  assert.ok(!f.calls.includes('readProjectKnowledge'));
  f.calls.length=0;
  assert.equal((await f.run('GET','docs/unknown',undefined,'/api/organizations/foreign/projects/p/')).status,404);
  assert.deepEqual(f.calls,[]);
});
test('readonly rejects add before IPC and malformed bodies never mutate',async t=>{
  const f=fixture(t); f.ctx.readOnly=true;
  assert.equal((await f.run('POST','docs',{file_name:'x',content:'y'})).status,501);
  f.ctx.readOnly=false;
  for(const body of [null,[],{file_name:42,content:'x'},{file_name:'x',content:{}},{file_name:'x',content:''}])
    assert.equal((await f.run('POST','docs',body)).status,400);
  assert.ok(!f.calls.includes('addProjectKnowledgeText'));
});
test('mutation inventory absence or readback mismatch is unconfirmed, not fabricated success',async t=>{
  for(const mode of ['missing','mismatch','error']) {
    const f=fixture(t), call=f.ctx.call;
    f.ctx.call=async(n:string,...a:any[])=>{
      const value=await call(n,...a);
      if(n==='addProjectKnowledgeText' && mode==='missing') return {...value,files:[]};
      if(n==='readProjectKnowledge' && mode==='mismatch') return {...value,text:'changed'};
      if(n==='readProjectKnowledge' && mode==='error') throw Error('/private/path');
      return value;
    };
    const result=await f.run('POST','docs',{file_name:'Note',content:'saved'});
    assert.equal(result.status,503); assert.match(result.body.error.message,/could not be confirmed/);
    assert.doesNotMatch(result.body.error.message,/private/);
    assert.equal(f.calls.filter(x=>x==='addProjectKnowledgeText').length,1);
    assert.equal((await f.handlers.get('readProjectKnowledge')('p','Note.md')).text,'saved');
  }
});
test('retired request cannot dispatch add after project lookup or disclose detail',async t=>{
  const f=fixture(t);
  f.ctx.snapshot=async()=>{f.retire();return {projects:[{id:'p',name:'P'}]};};
  assert.equal((await f.run('POST','docs',{file_name:'Note',content:'x'})).status,409);
  assert.equal((await f.run('GET','docs/'+knowledgeId('p','Note.md'))).status,409);
  assert.deepEqual(f.calls,[]);
});
test('retirement after write returns conflict without retry or claimed rollback',async t=>{
  const f=fixture(t),call=f.ctx.call;
  f.ctx.call=async(n:string,...a:any[])=>{const value=await call(n,...a);if(n==='addProjectKnowledgeText')f.retire();return value;};
  assert.equal((await f.run('POST','docs',{file_name:'Note',content:'x'})).status,409);
  assert.equal(f.calls.filter(x=>x==='addProjectKnowledgeText').length,1);
  assert.equal((await f.handlers.get('readProjectKnowledge')('p','Note.md')).text,'x');
});
test('batch delete acknowledgement excludes unmatched IDs after follow-on receipt repair',async t=>{
  const f=fixture(t);
  const a=await f.run('POST','docs',{file_name:'Note',content:'x'});
  const result=await f.run('POST','docs/delete_many',{doc_uuids:[a.body.uuid,'unknown']});
  assert.deepEqual(result.body.deleted,[a.body.uuid]);
  assert.equal((await f.run('GET','docs')).body.length,0);
});

test('actual original uP detail consumer reaches owned doc route with original response shape',async t=>{
  const f=fixture(t);
  const added=await f.run('POST','docs',{file_name:'Consumer title',content:'Actual body'});
  const source=fs.readFileSync('build/official-ui/ui/assets/v1/shared-0-BgsOqC85.js','utf8');
  const start=source.indexOf('function uP(e) {'),end=source.indexOf('\nfunction tA(',start);
  assert.ok(start>=0 && end>start);
  let request:Promise<any>|undefined;
  const consumer=vm.runInNewContext('('+source.slice(start,end)+')',{
    J9:()=>[],J3:()=>false,J1:()=>false,
    a4:()=>({activeOrganization:{uuid:organizationUuid('synthetic-owner')}}),
    jg:(url:string)=>{const prefix=`/api/organizations/${organizationUuid('synthetic-owner')}/projects/p/`;assert.ok(url.startsWith(prefix));request=f.run('GET',url.slice(prefix.length));return {data:added.body};},wh:()=>{},
  });
  const result=consumer({projectUuid:'p',docUuid:added.body.uuid});
  assert.deepEqual(result.data,added.body);
  assert.deepEqual((await request!).body,added.body);
});

test('real readback follows exact UTF8 decoder single BOM behavior, preserving second BOM and CRLF',async t=>{
  const f=fixture(t);
  for(const content of ['\ufeff你好\r\n🦊','\ufeff\ufefftext','No BOM 🦊']) {
    const r=await f.run('POST','docs',{file_name:'BOM',content});
    assert.equal(r.status,200);
    assert.equal(r.body.content,new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(content)));
    assert.equal((await f.run('GET',`docs/${r.body.uuid}`)).body.content,r.body.content);
  }
});
test('state directory changes and empty activation fail closed before write',async t=>{
  const f=fixture(t);let root='synthetic-root-A';f.ctx.stateDirectory=()=>root;
  f.ctx.snapshot=async()=>{root='synthetic-root-B';return {projects:[{id:'p',name:'P'}]};};
  assert.equal((await f.run('POST','docs',{file_name:'Note',content:'x'})).status,409);
  assert.deepEqual(f.calls,[]);
  f.ctx.sessionIdentity=()=>'';
  assert.equal((await f.run('GET','docs/unknown')).status,409);
});

test('detail inventory failure is sanitized and retirement wins over read error',async t=>{
  for(const mode of ['error','malformed','retired']) {
    const f=fixture(t);
    f.ctx.call=async()=>{
      if(mode==='malformed')return {files:null};
      if(mode==='retired')f.retire();
      throw Error('/private/path');
    };
    const r=await f.run('GET','docs/unknown');
    assert.equal(r.status,mode==='retired'?409:503);
    assert.doesNotMatch(JSON.stringify(r.body),/private/);
  }
});

test('actual scoped adapter retirement during snapshot or readback returns 409 without replay',async t=>{
  for(const phase of ['snapshot','readback']) {
    const f=fixture(t),call=f.ctx.call;
    const base=`/api/organizations/${organizationUuid('synthetic-owner')}/projects/p/`;
    f.ctx.stateDirectory=()=> 'fixture-root';
    if(phase==='snapshot')f.ctx.snapshot=async()=>{f.retire();return {projects:[{id:'p',name:'P'}]};};
    else f.ctx.call=async(n:string,...a:any[])=>{const value=await call(n,...a);if(n==='readProjectKnowledge')f.retire();return value;};
    const scoped=guardAdapterContext(f.ctx);
    const r=await inAdapterScope(newAdapterScope('synthetic-owner','fixture-root',1),()=>f.run('POST','docs',{file_name:'Note',content:'x'},base,scoped));
    assert.equal(r.status,409);
    assert.equal(f.calls.filter(x=>x==='addProjectKnowledgeText').length,phase==='snapshot'?0:1);
  }
});
