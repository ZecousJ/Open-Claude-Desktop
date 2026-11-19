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
async function fixture(t:any,generation=false){
 const file=path.resolve(`.runtime/memory-query-${process.pid}-${generation}.mjs`);
 const source=fs.readFileSync('scripts/official-host/memory-status.mjs','utf8');
 await build({stdin:{contents:`export {g as QueryClient,m as Provider,s as useQuery} from '${assets}/vendor-query-CdfkcLg6.js'; export {HostMemoryStatus,HostMemorySwitch} from 'panel';`,resolveDir:process.cwd()},outfile:file,bundle:true,platform:'node',format:'esm',external:['react','react/jsx-runtime'],plugins:[{name:'inert-react-query-wiring',setup(b){
  b.onResolve({filter:/^(panel|hooks)$/},a=>({path:a.path,namespace:'fixture'}));
  b.onResolve({filter:/vendor-frame-iz8L1jC9\.js$/},()=>({path:'react-hooks',namespace:'fixture'}));
  b.onResolve({filter:/vendor-intl-D9Num-b5\.js$/},()=>({path:'intl',namespace:'fixture'}));
  b.onResolve({filter:/shared-l-p-m-w-2-BMCa56Vr\.js$/},()=>({path:'account',namespace:'fixture'}));
  b.onResolve({filter:/shared-l-p-m-w-1-O9prfPUL\.js$/},()=>({path:'hooks',namespace:'fixture'}));
  b.onResolve({filter:/shared-l-p-m-w-0-C_nAiu5o\.js$/},()=>({path:'sync',namespace:'fixture'}));
  b.onResolve({filter:/^\.\/vendor-query-CdfkcLg6\.js$/},()=>({path:path.join(assets,'vendor-query-CdfkcLg6.js')}));
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',resolveDir:process.cwd(),contents:a.path==='react-hooks'?`export {useState as Do,useRef as Eo,useSyncExternalStore as Oo,useContext as ho,createContext as io,useCallback as mo,useEffect as vo,useMemo as wo} from 'react';export {jsx as qa,jsxs as Ja} from 'react/jsx-runtime';`:a.path==='account'?`export const ce=()=>({account:{uuid:'owner'},activeOrganization:{uuid:'org'}});export const oS=()=>({addError:m=>globalThis.__memoryErrors.push(m)});`:a.path==='intl'?`export const p=()=>({locale:'en-US',formatMessage:m=>m.defaultMessage});`:a.path==='sync'?`export const k0='memory_settings';`:a.path==='panel'?source:`import {s as useQuery} from '${assets}/vendor-query-CdfkcLg6.js';export function jg(url,options){return useQuery({...options,queryFn:()=>globalThis.__memoryFixture.read()});}`}));
 }}]});
 const dom=new JSDOM('<div id="root"></div>',{url:'https://inert.invalid/'});
 const old={window:globalThis.window,document:globalThis.document};Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 const mod=await import(pathToFileURL(file).href);let reads=0,fail=!generation;
 const data={claudex_memory:{version:1,available:false,reason:'server',allowed:{generate:false,searchChats:false},preferences:{generate:true,searchChats:true},surface:'read-only',generation_action:'consent_and_budget_not_established',generation_disable_action:'unavailable',reset_action:'unavailable',search_action:'unavailable',snapshot:{state:'present',memory:'Last known inert note',controls:[],updated_at:new Date(1000).toISOString()}}};
 if(generation){data.claudex_memory.available=true;data.claudex_memory.reason=null as any;data.claudex_memory.allowed.generate=true;data.claudex_memory.surface='native';data.claudex_memory.generation_disable_action='existing_native_policy';data.claudex_memory.reset_action='available';}
 let legacy=0;
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>{throw Error('The switch must only open the original confirmation');};
 (globalThis as any).__memoryErrors=[];(globalThis as any).__memoryFixture={read:async()=>{reads++;if(fail)throw Error('inert read failure');return data;}};
 const client=new mod.QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 const root=createRoot(document.getElementById('root')!);
 function Control(props:any){return React.createElement('input',{type:'checkbox',checked:generation,readOnly:true,disabled:props.disabled,onClick:()=>props.onCheckedChange(false)});}
 function Parent(){return React.createElement(React.Fragment,null,React.createElement(mod.HostMemorySwitch,{control:Control,kind:generation?'generate':'search',checked:generation,onCheckedChange:()=>legacy++}),React.createElement(mod.HostMemoryStatus));}
 t.after(async()=>{await act(async()=>root.unmount());client.clear();dom.window.close();Object.assign(globalThis,old);globalThis.fetch=oldFetch;delete (globalThis as any).__memoryFixture;delete (globalThis as any).__memoryErrors;fs.rmSync(file,{force:true});});
 await act(async()=>root.render(React.createElement(mod.Provider,{client},React.createElement(Parent))));
 const tick=async()=>act(async()=>{await new Promise(r=>setTimeout(r,15));});
 return { legacy:()=>legacy,clickSwitch:async()=>act(async()=>document.querySelector('input')!.click()),tick,reads:()=>reads,text:()=>document.body.textContent??'',disabled:()=>document.querySelector('input')!.disabled,refresh:async(value:boolean)=>act(async()=>{fail=value;await client.refetchQueries({queryKey:['memory_settings',{orgUuid:'org'}],exact:true});}) };
}
test('stable actual memory components do not remount query observers across error, success, or stale-error transitions',async t=>{
 const f=await fixture(t);for(let i=0;i<8;i++)await f.tick();assert.equal(f.reads(),1);assert.equal(f.disabled(),true);assert.match(f.text(),/could not be verified/);
 await f.refresh(false);for(let i=0;i<8;i++)await f.tick();assert.equal(f.reads(),2);assert.match(f.text(),/Last known inert note/);assert.match(f.text(),/Last-known/);assert.equal(f.disabled(),true);
 await f.refresh(true);for(let i=0;i<8;i++)await f.tick();assert.equal(f.reads(),3);assert.match(f.text(),/could not be verified/);assert.match(f.text(),/Last known inert note/);assert.equal(f.disabled(),true);
});

test('the active generation switch delegates to the original confirmation without writing',async t=>{
 const f=await fixture(t,true);
 for(let i=0;i<4;i++)await f.tick();
 assert.equal(f.disabled(),false);
 await f.clickSwitch();
 assert.equal(f.legacy(),1);
 assert.equal(f.disabled(),false);
});
