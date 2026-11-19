/** Actual React surface -> scoped action -> fetch Response; no official bundle/network execution. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {build} from 'esbuild';import {JSDOM} from 'jsdom';import React,{act} from 'react';import {createRoot} from 'react-dom/client';import {createOfficialReadFetch} from '../../src-web/official/read-fetch';
test('removed result strips do not swallow any of the three consumer error responses or add mount discovery',async t=>{
 const file=path.resolve(`.runtime/result-strip-${process.pid}.mjs`);t.after(()=>fs.rmSync(file,{force:true}));await build({entryPoints:[path.resolve('src-web/official/OfficialWebSurface.tsx')],outfile:file,bundle:true,platform:'node',format:'esm',external:['react'],loader:{'.css':'empty','.svg':'text'}});const {OfficialWebSurface}=await import(pathToFileURL(file).href);
 const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid/new'});const previous={window:globalThis.window,document:globalThis.document,history:globalThis.history,location:globalThis.location};Object.assign(globalThis,{window:dom.window,document:dom.window.document,history:dom.window.history,location:dom.window.location,IS_REACT_ACT_ENVIRONMENT:true});let reads=0,writes=0;
 const bridge:any={auth:{activationIdentity:{},current:{account:{id:'owner'}},onChange:()=>()=>{}},officialUiRead:async()=>{reads++;return{status:503,contentType:'application/json',body:new TextEncoder().encode('{"error":"inert unavailable"}')}},officialUiAction:async()=>{writes++;throw Error('must not dispatch')},officialUiEvents:()=>()=>{}};
 const root=createRoot(document.getElementById('root')!);t.after(async()=>{try{await act(async()=>root.unmount())}finally{Object.assign(globalThis,previous);dom.window.close()}});
 await act(async()=>root.render(React.createElement(OfficialWebSurface,{bridge,accountId:'owner',chatActionMode:'strict-text',appearanceSettingsOptIn:true,memoryControlsOptIn:true})));
 const frame=document.querySelector('iframe')!;const bindings=(window as any).__claudexOfficialFrameBindings(frame.contentWindow,frame.contentDocument);assert.equal(reads,0);
 const request=createOfficialReadFetch('https://fixture.invalid',bindings.read,async()=>{throw Error('network forbidden')},bridge.officialUiEvents,bindings.action);
 for(const [method,url,body,expected] of [
  ['PATCH','/api/account/settings','{"chat_font":"sans"}','Appearance permission could not be verified'],
  ['PUT','/api/organizations/11111111-1111-4111-8111-111111111111/memory/controls','{}','Memory controls could not be verified'],
  ['POST','/api/organizations/11111111-1111-4111-8111-111111111111/chat_conversations/22222222-2222-4222-8222-222222222222/completion','{"tools":[]}','Strict text capabilities are unavailable'],
 ]){const response=await request(url,{method,body,headers:{'content-type':'application/json'}});assert.equal(response.status,501);assert.match(await response.text(),new RegExp(expected));}
 assert.equal(reads,3);assert.equal(writes,0);assert.equal(document.querySelector('.official-appearance-status'),null);assert.equal(document.querySelectorAll('[aria-live="polite"]').length,0);
 assert.equal(document.querySelectorAll('.official-web-host > p').length,0);assert.equal(document.querySelector('.official-web-warning'),null);assert.doesNotMatch(document.body.textContent??'',/Experimental|unverified|Sign out/);
});
