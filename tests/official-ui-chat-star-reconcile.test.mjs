import { verifyOfficialWebAssets } from "../scripts/official-web-assets.mjs";
import os from "node:os";
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import assert from 'node:assert/strict';import test from 'node:test';import ts from 'typescript';import {createHash} from 'node:crypto';
import {applyOfficialChatStarReconcile,verifyOfficialChatStarReconcileManifest,deriveOfficialChatStarReconcile,chatStarReconcileInputHashes,chatStarReconcileTarget,chatStarReconcileBefore,chatStarReconcileAfter} from '../scripts/official-ui-chat-star-reconcile.mjs';
const repo=process.cwd(),assets=path.resolve(process.env.CLAUDEX_F009_ORIGINAL_RESOURCES??path.join(repo,'build/official-ui/ui/assets/v1'));
const sources={};
verifyOfficialWebAssets(repo,{officialUi:path.resolve(assets,'../../..'),onChatStarInput:(name,source)=>{if(Object.hasOwn(chatStarReconcileInputHashes,name))sources[name]=source;}});
assert.deepEqual(Object.keys(sources).sort(),Object.keys(chatStarReconcileInputHashes).sort());
const shared=ts.createSourceFile('original.js',sources['shared-m-1-Nm0kn4Ee.js'],ts.ScriptTarget.Latest,true),fn=name=>{const node=shared.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert(node);return node.getText(shared);};
function queryClient(authoritative){
 const rows=[{uuid:'owned',is_starred:false,is_archived:false},{uuid:'other',is_starred:false,is_archived:false}];
 const pageData=()=>({pages:[{data:[{...rows[0],is_starred:authoritative}],has_more:true},{data:[rows[1]],has_more:false}],pageParams:[0,30]});
 const qs=['own','foreign'].map(org=>({queryKey:['conversations',{orgUuid:org},'infinite',{limit:30,archived:false}],state:{data:{pages:[{data:[{...rows[0]}],has_more:true},{data:[{...rows[1]}],has_more:false}],pageParams:[0,30]}},isActive:()=>true,isDisabled:()=>false,refetch:pageData}));
 const matches=(q,f)=>f.queryKey.every((v,i)=>JSON.stringify(v)===JSON.stringify(q.queryKey[i]))&&(!f.predicate||f.predicate(q));
 const client={qs,invalidations:[],getQueryCache:()=>({findAll:f=>qs.filter(q=>matches(q,f))}),cancelQueries:async()=>{},getQueriesData:f=>qs.filter(q=>matches(q,f)).map(q=>[q.queryKey,q.state.data]),getQueryData:k=>qs.find(q=>JSON.stringify(k)===JSON.stringify(q.queryKey))?.state.data,setQueryData(k,v){const q=qs.find(q=>JSON.stringify(k)===JSON.stringify(q.queryKey));if(q)q.state.data=v;},setQueriesData(f,updater){for(const q of qs.filter(q=>matches(q,f)))q.state.data=updater(q.state.data);},async invalidateQueries(f){for(const q of qs.filter(q=>matches(q,f))){this.invalidations.push(q.queryKey);q.state.data=q.refetch();}}};return client;
}
function originals(client){const context={yS:'conversations',$G:{limit:30,archived:false},M8:new WeakMap(),FF:()=>true,VE:()=>1,KT:{post:()=>{}},fetch:()=>{throw Error('Infinite branch must not directly fetch');},hJ:f=>f(),JK:()=>new URLSearchParams(),Nf:{__errorMarked:()=>{}},Sp:{CHAT_COMPLETION:'chat'}};vm.runInNewContext(['RV','BX','fu','W2','p_','qh','KA','bu','CH','IC','Sq'].map(fn).join('\n'),context);return context;}
function callback(statement,client,org,action,oo){return new Function('e','BP','br','claudexChatStarListKey','oo','jP',statement)({action},client,org,'conversations',oo,()=>{});}
test('exact four source pins; only original star-refusal expression changes',()=>{const out=deriveOfficialChatStarReconcile(sources);assert.equal(out,sources[chatStarReconcileTarget].replace('  yS as Ht,','  yS as Ht,\n  yS as claudexChatStarListKey,').replace(chatStarReconcileBefore,chatStarReconcileAfter));assert.equal(out.split(chatStarReconcileAfter).length,2);});
test('changed source or dependency fails closed; applying twice fails closed',()=>{for(const file of Object.keys(sources))assert.throws(()=>deriveOfficialChatStarReconcile({...sources,[file]:sources[file]+' '}),/pinned input/);assert.throws(()=>deriveOfficialChatStarReconcile({...sources,[chatStarReconcileTarget]:deriveOfficialChatStarReconcile(sources)}),/pinned input/);});
test('actual original IC then Sq preserves stale infinite starred cache (regression)',async()=>{const c=queryClient(false),o=originals(c);o.IC(c,'own','owned',true);assert.equal(c.qs[0].state.data.pages[0].data[0].is_starred,true);await o.Sq(c,'own');assert.equal(c.invalidations.length,0);assert.equal(c.qs[0].state.data.pages[0].data[0].is_starred,true);});
for(const authoritative of [false,true])test('original callback derivation refetches authoritative '+authoritative+' without inverse flip; keeps pages',async()=>{const c=queryClient(authoritative),o=originals(c),foreign=structuredClone(c.qs[1].state.data);o.IC(c,'own','owned',true);callback(chatStarReconcileAfter,c,'own','star_conversation',o.Sq);await new Promise(r=>setImmediate(r));assert.equal(c.qs[0].state.data.pages[0].data[0].is_starred,authoritative);assert.deepEqual(c.qs[0].state.data.pageParams,[0,30]);assert.equal(c.qs[0].state.data.pages.length,2);assert.equal(c.qs[0].state.data.pages[1].data[0].uuid,'other');assert.deepEqual(c.qs[1].state.data,foreign);assert.equal(c.invalidations.length,1);});
test('non-star refusal does not invalidate or change cache',()=>{const c=queryClient(false);for(const a of ['rename_conversation','archive_conversation','send_message'])callback(chatStarReconcileAfter,c,'own',a,()=>{throw Error('Unexpected old invalidation');});assert.equal(c.invalidations.length,0);});
test('missing org cannot expand invalidation; absent own query does not create cache',async()=>{const c=queryClient(false);callback(chatStarReconcileAfter,c,undefined,'star_conversation',()=>{});callback(chatStarReconcileAfter,c,'absent','star_conversation',()=>{});await new Promise(r=>setImmediate(r));assert.equal(c.invalidations.length,0);assert.equal(c.qs.length,2);});
test('refetch rejection is contained and does not invert cache',async()=>{const c=queryClient(false),o=originals(c);o.IC(c,'own','owned',true);c.invalidateQueries=async()=>{throw Error('offline');};callback(chatStarReconcileAfter,c,'own','star_conversation',()=>{});await new Promise(r=>setImmediate(r));assert.equal(c.qs[0].state.data.pages[0].data[0].is_starred,true);});
function originalQueryRuntime(){
 const source=sources['vendor-query-CdfkcLg6.js'];assert.equal(createHash('sha256').update(source).digest('hex'),chatStarReconcileInputHashes['vendor-query-CdfkcLg6.js']);
 const tree=ts.createSourceFile('vendor-query.js',source,ts.ScriptTarget.Latest,true);
 const body=tree.statements.filter(n=>!ts.isImportDeclaration(n)&&!ts.isExportDeclaration(n)).map(n=>n.getText(tree)).join('\n');
 const context={i:()=>({}),t:{createContext:()=>({})},setTimeout,clearTimeout,setInterval,clearInterval,AbortController,console};
 vm.runInNewContext(body+'\nthis.RealQueryClient=Ue;this.RealInfiniteObserver=Pe;',context);
 return context;
}
for(const authoritative of [false,true])test('actual original QueryClient and InfiniteQueryObserver refetch both pages, authority '+authoritative,async()=>{
 const {RealQueryClient,RealInfiniteObserver}=originalQueryRuntime(),client=new RealQueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity,staleTime:Infinity}}});
 const initial={pages:[{data:[{uuid:'owned',is_starred:false,is_archived:false}],has_more:true},{data:[{uuid:'other',is_starred:false,is_archived:false}],has_more:false}],pageParams:[0,30]};
 const key=org=>['conversations',{orgUuid:org},'infinite',{limit:30,archived:false}],reads=[];
 const observer=org=>new RealInfiniteObserver(client,{queryKey:key(org),queryFn:async({pageParam})=>{reads.push({org,pageParam});return pageParam===0?{data:[{uuid:'owned',is_starred:authoritative,is_archived:false}],has_more:true}:{data:[{uuid:'other',is_starred:false,is_archived:false}],has_more:false};},initialData:structuredClone(initial),initialPageParam:0,getNextPageParam:last=>last.has_more?30:undefined,retry:false,gcTime:Infinity,staleTime:Infinity});
 const own=observer('own'),foreign=observer('foreign'),unsubOwn=own.subscribe(()=>{}),unsubForeign=foreign.subscribe(()=>{});
 try{
  const o=originals(client);o.IC(client,'own','owned',true);await o.Sq(client,'own');assert.equal(reads.length,0);assert.equal(client.getQueryData(key('own')).pages[0].data[0].is_starred,true);
  callback(chatStarReconcileAfter,client,'own','star_conversation',o.Sq);
  for(let i=0;i<20&&client.isFetching();i++)await new Promise(r=>setImmediate(r));
  assert.deepEqual(reads,[{org:'own',pageParam:0},{org:'own',pageParam:30}]);
  const result=client.getQueryData(key('own'));assert.equal(result.pages[0].data[0].is_starred,authoritative);assert.deepEqual(Array.from(result.pageParams),[0,30]);assert.equal(result.pages.length,2);assert.deepEqual(client.getQueryData(key('foreign')),initial);
 }finally{unsubOwn();unsubForeign();client.clear();}
});

test('scoped assembly verifies manifest and all dependencies; tampering fails closed',()=>{const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'chat-star-assembly-'));try{for(const [f,s] of Object.entries(sources))fs.writeFileSync(path.join(dir,f),s);const manifest=applyOfficialChatStarReconcile(dir);const files=Object.keys(sources).map(f=>({path:'assets/v1/'+f,sha256:createHash('sha256').update(fs.readFileSync(path.join(dir,f))).digest('hex')}));const out=manifest.modules[0].outputSha256;verifyOfficialChatStarReconcileManifest(manifest,files,out);assert.throws(()=>verifyOfficialChatStarReconcileManifest({...manifest,revision:'changed'},files,out),/manifest mismatch/);assert.throws(()=>verifyOfficialChatStarReconcileManifest(manifest,files.slice(1),out),/dependency mismatch/);assert.throws(()=>applyOfficialChatStarReconcile(dir),/pinned input/);}finally{fs.rmSync(dir,{recursive:true,force:true});}});

test('actual enclosing lexical Ht shadow reproduces old failure; unique import alias resolves original query key',async()=>{
 const original=ts.createSourceFile('target.js',sources[chatStarReconcileTarget],ts.ScriptTarget.Latest,true),changed=ts.createSourceFile('target.js',deriveOfficialChatStarReconcile(sources),ts.ScriptTarget.Latest,true);
 let enclosing,bindings=[];function walk(node){if(ts.isFunctionDeclaration(node)&&node.getText(original).includes(chatStarReconcileBefore))enclosing=node;ts.forEachChild(node,walk);}walk(original);assert(enclosing);
 function bindingWalk(node){if(ts.isBindingElement(node)&&node.name.getText(original)==='Ht')bindings.push(node);ts.forEachChild(node,bindingWalk);}bindingWalk(enclosing);
 const binding=bindings.find(n=>n.propertyName?.getText(original)==='undeliveredSendCount');assert(binding);const declaration=binding.parent.parent;assert(ts.isVariableDeclaration(declaration));
 const originalScope='const '+declaration.name.getText(original)+' = X;';
 const alias=changed.statements.filter(ts.isImportDeclaration).flatMap(n=>n.importClause?.namedBindings&&ts.isNamedImports(n.importClause.namedBindings)?n.importClause.namedBindings.elements:[]).find(n=>n.name.text==='claudexChatStarListKey');assert.equal(alias?.propertyName?.text,'yS');
 let occurrences=0;function count(n){if(ts.isIdentifier(n)&&n.text==='claudexChatStarListKey')occurrences++;ts.forEachChild(n,count);}count(changed);assert.equal(occurrences,2);
 const sharedTree=ts.createSourceFile('shared.js',sources['shared-l-p-m-w-0-C_nAiu5o.js'],ts.ScriptTarget.Latest,true);let initializer;function find(n){if(ts.isVariableDeclaration(n)&&n.name.getText(sharedTree)==='yS')initializer=n.initializer.getText(sharedTree);ts.forEachChild(n,find);}find(sharedTree);assert(initializer);
 const key=vm.runInNewContext(initializer),seen=[];const client={invalidateQueries:async f=>{seen.push(f.queryKey[0]);}};
 const run=statement=>new Function('X','BP','br','e','oo','jP', 'const claudexChatStarListKey='+initializer+';'+originalScope+statement)({undeliveredSendCount:0},client,'own',{action:'star_conversation'},()=>{},()=>{});
 run(chatStarReconcileAfter.replaceAll('claudexChatStarListKey','Ht'));await Promise.resolve();assert.equal(seen.pop(),0);
 run(chatStarReconcileAfter);await Promise.resolve();assert.equal(seen.pop(),key);assert.equal(key,'chat_conversation_list');
});
