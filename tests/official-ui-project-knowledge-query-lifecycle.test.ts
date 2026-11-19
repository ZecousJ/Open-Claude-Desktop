/** Actual pinned query observer lifecycle + React; all query functions are inert local promises. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
const assets=path.resolve(process.env.CLAUDEX_OFFICIAL_EXTRACTED??'.restore/archive-extracted','claude-frontend-4.4212.0/src/cloud/assets/v1');
async function fixture(t:any,oldEnabled:boolean){
 const file=path.resolve(`.runtime/knowledge-query-${process.pid}-${oldEnabled}.mjs`);
 const source=fs.readFileSync('scripts/official-host/project-knowledge-error.mjs','utf8');
 await build({stdin:{contents:`export {g as QueryClient,m as Provider,s as useQuery} from '${assets}/vendor-query-CdfkcLg6.js'; export {withProjectKnowledgeError} from 'panel'; export {EP as useDocs,IkJ as useFiles} from 'hooks';`,resolveDir:process.cwd()},outfile:file,bundle:true,platform:'node',format:'esm',external:['react','react/jsx-runtime'],plugins:[{name:'inert-react-query-wiring',setup(b){
  b.onResolve({filter:/^(panel|hooks)$/},a=>({path:a.path,namespace:'fixture'}));
  b.onResolve({filter:/vendor-frame-iz8L1jC9\.js$/},()=>({path:'react-hooks',namespace:'fixture'}));
  b.onResolve({filter:/vendor-intl-D9Num-b5\.js$/},()=>({path:'intl',namespace:'fixture'}));
  b.onResolve({filter:/shared-0-BgsOqC85\.js$/},()=>({path:'hooks',namespace:'fixture'}));
  b.onResolve({filter:/shared-l-p-m-w-0-C_nAiu5o\.js$/},()=>({path:'sync',namespace:'fixture'}));
  b.onResolve({filter:/shared-2-CuvP2TaI\.js$/},()=>({path:'status',namespace:'fixture'}));
  b.onResolve({filter:/^\.\/vendor-query-CdfkcLg6\.js$/},()=>({path:path.join(assets,'vendor-query-CdfkcLg6.js')}));
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',resolveDir:process.cwd(),contents:a.path==='react-hooks'?`export {useState as Do,useRef as Eo,useSyncExternalStore as Oo,useContext as ho,createContext as io,useCallback as mo,useEffect as vo,useMemo as wo} from 'react';export {jsx as qa,jsxs as Ja} from 'react/jsx-runtime';`:a.path==='intl'?`export const p=()=>({locale:'en-US',formatMessage:m=>m.defaultMessage});`:a.path==='status'?`import React from 'react';export function G3({headline,ctaLabel,ctaBusy,onCtaClick}){return React.createElement('div',null,headline,React.createElement('button',{disabled:ctaBusy,onClick:onCtaClick},ctaLabel));}`:a.path==='sync'?`export const zG='project_sync_list';`:a.path==='panel'?(oldEnabled?source.replaceAll('useDocs(projectUuid,false)','useDocs(projectUuid)').replaceAll('useFiles(projectUuid,false)','useFiles(projectUuid)'):source):`import {s as useQuery} from '${assets}/vendor-query-CdfkcLg6.js';export function EP(id,enabled){return useQuery({queryKey:['docs',id],queryFn:()=>globalThis.__knowledgeFixture.docs(),retry:false,enabled:enabled===undefined||enabled});}export function IkJ(id,enabled){return useQuery({queryKey:['files',id],queryFn:()=>globalThis.__knowledgeFixture.files(),retry:false,enabled:enabled===undefined||enabled,staleTime:300000});}`}));
 }}]});
 const dom=new JSDOM('<div id="root"></div>',{url:'https://inert.invalid/'});
 const old={window:globalThis.window,document:globalThis.document};Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 const mod=await import(pathToFileURL(file).href);let docs=0,files=0;
 // Cap the deliberately broken baseline so the test never creates an unbounded loop.
 (globalThis as any).__knowledgeFixture={docs:async()=>{docs++;if(docs>4)return [];throw Error('inert read failure');},files:async()=>{files++;return [];}};
 const client=new mod.QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 const root=createRoot(document.getElementById('root')!);
 function Parent(){const d=mod.useDocs('project'),f=mod.useFiles('project');return mod.withProjectKnowledgeError(d.isError||f.isError,0,{projectUuid:'project',organizationUuid:'org',accountUuid:'owner'},React.createElement('div',null,'normal'));}
 t.after(async()=>{await act(async()=>root.unmount());client.clear();dom.window.close();Object.assign(globalThis,old);delete (globalThis as any).__knowledgeFixture;fs.rmSync(file,{force:true});});
 await act(async()=>root.render(React.createElement(mod.Provider,{client},React.createElement(Parent))));
 const tick=async()=>act(async()=>{await new Promise(r=>setTimeout(r,15));});
 return{tick,docs:()=>docs,files:()=>files,text:()=>document.body.textContent??'',retry:async()=>act(async()=>{document.querySelector('button')!.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));})};
}
test('actual pinned QueryClient reproduces enabled error-observer remount retry loop',async t=>{
 const f=await fixture(t,true);for(let i=0;i<12&&f.docs()<3;i++)await f.tick();assert.ok(f.docs()>=3,`expected repeated reads, got ${f.docs()}`);
});
test('actual panel disabled observers retain the first error until explicit Retry, without automatic remount requests',async t=>{
 const f=await fixture(t,false);for(let i=0;i<8;i++)await f.tick();assert.equal(f.docs(),1);assert.equal(f.files(),1);assert.match(f.text(),/Something went wrong/);
 await f.retry();for(let i=0;i<8;i++)await f.tick();assert.equal(f.docs(),2);assert.equal(f.files(),2);assert.match(f.text(),/Something went wrong/);
});
