/** Original component with injected inert read client; no browser/network/account calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { recordsFrom } from '../shared/usage-stats-api';
const require=createRequire(import.meta.url);
test('original Activity preserves row expansion/pagination and discards old account response', async () => {
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
 const prior:any={};
 for(const key of ['window','document','navigator','MutationObserver','IS_REACT_ACT_ENVIRONMENT']) {
  prior[key]=Object.getOwnPropertyDescriptor(globalThis,key);
  Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='IS_REACT_ACT_ENVIRONMENT'?true:(dom.window as any)[key]});
 }
 const bundle=await build({entryPoints:['src/settings/usage-activity/UsageActivity.tsx'],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',define:{'import.meta.url':'"http://localhost/assets/activity.js"'},external:['react','react/jsx-runtime'],loader:{'.css':'empty','.woff2':'empty','.svg':'empty'},logLevel:'silent'});
 const exports:any={}, module={exports};vm.runInNewContext(bundle.outputFiles[0].text,{exports,module,require,console,URL,window:dom.window,document:dom.window.document,MutationObserver:dom.window.MutationObserver,Intl,Date,setTimeout,clearTimeout});
 const Component=module.exports.default; const root=createRoot(document.getElementById('root')!);
 const summary:any={totals:{requests:1,todayRequests:1,cost:.115772,todayCost:.115772,standardCost:.2,todayStandardCost:.2,apiKeys:0,activeApiKeys:0,inputTokens:1,outputTokens:1,cacheTokens:0,tokens:2,todayInputTokens:1,todayOutputTokens:1,todayCacheTokens:0,todayTokens:2,averageDurationMs:1,rpm:0,tpm:0},providers:[]};
 let resolveOld!:(v:any)=>void;let calls=0;
 const client:any={usageOverview:async()=>summary,usageBreakdown:async()=>({trend:[{date:'2026-11-03',requests:1,tokens:100,inputTokens:60,outputTokens:30,cacheTokens:10,cost:.1,standardCost:.2}],models:[{model:'fixture-model',tokens:60,requests:1,cost:.1,standardCost:.2},{model:'fixture-model-2',tokens:40,requests:1,cost:.1,standardCost:.2}]}),usageRecords:async(query:any)=>{calls++;if(query.page===1)return recordsFrom({items:[{id:1,model:'fixture-model',created_at:'2026-11-03T00:00:00Z',actual_cost:.115772,total_cost:.2,input_cost:.01,output_cost:.1,request_id:'fixture-request-1'}],total:11,page:1,pages:2});return new Promise(r=>resolveOld=r);}};
 const errors:any[]=[];const onError=(e:any)=>errors.push(e);
 try {
  await act(async()=>{root.render(React.createElement(Component,{client,accountKey:'A:1',onError}));});
  assert.equal(calls,1);
  assert.deepEqual([...document.querySelectorAll('select[aria-label="Model"] option')].map(x=>[x.getAttribute('value'),x.textContent]),[['','All models'],['fixture-model','fixture-model'],['fixture-model-2','fixture-model-2']]);
  assert.deepEqual([...document.querySelectorAll('.ua-model .usage-bar span')].map(x=>(x as HTMLElement).style.width),['60%','40%']);
  assert.deepEqual([...document.querySelectorAll('.ua-bar span')].map(x=>(x as HTMLElement).style.height),['10%','30%','60%']);
  assert.ok(document.body.textContent?.includes('fixture-model'));
  assert.ok(document.body.textContent?.includes('$0.1158'));
  const details=document.querySelector('details')!;
  await act(async()=>{(details.querySelector('summary') as HTMLElement).click();});
  assert.equal(details.open,true);
  assert.ok(details.textContent?.includes('fixture-request-1'));
  await act(async()=>{(document.querySelector('[aria-label="Next page"]') as HTMLButtonElement).click();});
  assert.equal(calls,2);
  const other={...client,usageOverview:async()=>null};
  await act(async()=>{root.render(React.createElement(Component,{client:other,accountKey:'B:2',onError}));});
  await act(async()=>{resolveOld({items:[{model:'PRIVATE_OLD_ACCOUNT'}],total:1,page:1,pages:1});});
  assert.equal(document.body.textContent?.includes('PRIVATE_OLD_ACCOUNT'),false);
  assert.equal(errors.length,0);
 } finally {
  await act(async()=>root.unmount());dom.window.close();
  for(const key of Object.keys(prior)) if(prior[key]) Object.defineProperty(globalThis,key,prior[key]);else delete (globalThis as any)[key];
 }
});
