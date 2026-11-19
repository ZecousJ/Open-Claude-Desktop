import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';
// @ts-expect-error Build-time JavaScript helper.
import {hostHubResources as pins,localHubResolverSource,deriveOfficialUiHostHubModule,inspectPinnedHubResources,applyOfficialUiHostHub} from '../scripts/official-ui-host-hub.mjs';
const rawRoot=path.resolve('.restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1');
const raw=fs.readFileSync(path.join(rawRoot,pins.loader),'utf8');
const descriptor={secret:'',hash:pins.descriptorHash,body:pins.body,css:[],preload:['https://untrusted.invalid/a.js'],alsoFetch:['../../evil.js']};
function fn(source:string,name:string){const a=ts.createSourceFile('module.js',source,ts.ScriptTarget.Latest,true);const f=a.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(f,name);return f.getText(a);}
function harness(tag:string,desc:unknown,gate=true,fail=false){
 const imports:string[]=[],events:string[]=[];const returned={default:()=>null};
 const context:any={URL,Array,descriptor:desc,kH:{default:()=>null},Sf:new Map(),GO:new Set(),q1:new Set(),
 Kg:{getState:()=>({gatedImports:{[tag]:desc}})},hK:(_tag:string,load:()=>unknown)=>gate?load:()=>null,
 KJ:()=>events.push('start'),zO:(urls:string[])=>{assert.deepEqual(Array.from(urls),[]);},
 xP:()=>({primes:[],importIssued:()=>events.push('issued'),importSettled:(s:string)=>events.push(s)}),
 d0:(run:()=>unknown)=>run(),gY:()=>{},FY:(url:string)=>{imports.push(url);return fail?Promise.reject(Error('inert load failed')):Promise.resolve(returned)},
 Nf:(_ctx:unknown,run:()=>unknown)=>run(),ab:()=>undefined,LD:()=>false,Xj:()=>events.push('settled'),Kv:(n:unknown)=>Promise.resolve(n),
 IW:()=>true,Um:()=>false,_w:()=>false,Pu:(err:Error)=>err,console:{warn(){}},};
 vm.createContext(context);
 const loader=fs.readFileSync(path.join(rawRoot,'shared-l-p-m-w-4-BkeeGGW7.js'),'utf8');
 vm.runInContext('const SA=String.raw`[\\w-]{8}\\d*`;const qc=new RegExp(String.raw`^[0-9a-f]{48}-${SA}\\.m?js$`),ye=new RegExp(String.raw`^(?:[0-9a-f]{48}|c[0-9a-f]{8})-${SA}\\.m?js$`),mp=new RegExp(String.raw`^c[0-9a-f]{8}-${SA}\\.m?js$`);const $x="http://127.0.0.1/assets/v1/loader.js";'+fn(loader,'dE')+fn(loader,'zj')+localHubResolverSource+fn(deriveOfficialUiHostHubModule(pins.loader,raw),'kf').replaceAll('import.meta.url',JSON.stringify('http://127.0.0.1/assets/v1/loader.js'))+';this.load=kf;',context);
 return {context,imports,events,returned,load:()=>context.load(tag)()};
}
test('local Hub resource repair preserves the original wrapper, errors and lifecycle',async()=>{
 const derived=deriveOfficialUiHostHubModule(pins.loader,raw);
 assert.equal(fn(derived,'hK'),fn(raw,'hK'));
 assert.equal(derived.slice(localHubResolverSource.length).replace('n = t && (__claudexLocalHubResource(e, t, import.meta.url) ?? zj(t));','n = t && zj(t);'),raw);
 const h=harness(pins.gate,descriptor);assert.equal(await h.load(),h.returned);
 assert.deepEqual(h.imports,['http://127.0.0.1/assets/v1/'+pins.localEntry,'http://127.0.0.1/assets/v1/'+pins.body]);
 assert.deepEqual(h.events,['start','issued','ok','settled']);
 await h.load();assert.equal(h.imports.length,2,'original cache is retained');
});
test('missing descriptor, absent gate, wrong tag, altered metadata do not gain local entry',async()=>{
 for(const [tag,desc,gate] of [[pins.gate,undefined,true],[pins.gate,descriptor,false],['other_gate',descriptor,true],
 [pins.gate,{...descriptor,hash:'unknown'},true],[pins.gate,{...descriptor,body:'https://untrusted.invalid/body.js'},true],
 [pins.gate,{...descriptor,css:['bad']},true],[pins.gate,{...descriptor,secret:null},true]] as const){
  const h=harness(tag,desc,gate);await h.load();assert.equal(h.imports.length,0);
 }
});
test('a nonempty original descriptor retains the unchanged official resolver',async()=>{
 const h=harness(pins.gate,{...descriptor,secret:'a'.repeat(48),preload:[],alsoFetch:[]});
 await h.load();assert.equal(h.imports[0],'http://127.0.0.1/assets/v1/'+'a'.repeat(48)+'-'+pins.descriptorHash+'.js');
 assert.ok(!h.imports.some(url=>url.includes(pins.localEntry)));
});
test('local entry failure rejects via original error path and is not cached as success',async()=>{
 const h=harness(pins.gate,descriptor,true,true);await assert.rejects(h.load(),/inert load failed/);
 assert.ok(h.events.includes('download_failed'));assert.equal(h.context.Sf.size,0);
});
test('loader checksum and exact source identity fail closed',()=>{
 assert.throws(()=>deriveOfficialUiHostHubModule(pins.loader,raw+'\n'),/checksum/);
 assert.equal(deriveOfficialUiHostHubModule('unrelated.js','original'),'original');
 assert.throws(()=>applyOfficialUiHostHub(rawRoot),/immutable/);
});
test('the entire supplied catalogue, entry and body are pinned; assembly writes only a new directory',()=>{
 const verified=inspectPinnedHubResources(rawRoot);assert.equal(verified.catalogueFiles,pins.catalogueFiles);
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'claudex-hub-source-'));
 try{
  fs.cpSync(rawRoot,temp,{recursive:true});
  const manifest=applyOfficialUiHostHub(temp);
  assert.equal(manifest.entry.sha256,pins.entrySha256);
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(temp,pins.localEntry))).digest('hex'),pins.entrySha256);
  assert.equal(fs.readFileSync(path.join(rawRoot,pins.loader),'utf8'),raw);
  assert.throws(()=>applyOfficialUiHostHub(temp),/catalogue|Duplicate pinned Hub entry/);
  fs.rmSync(path.join(temp,pins.localEntry));fs.writeFileSync(path.join(temp,pins.loader),raw);
  fs.appendFileSync(path.join(temp,pins.body),'\n');
  assert.throws(()=>inspectPinnedHubResources(temp),/catalogue/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
