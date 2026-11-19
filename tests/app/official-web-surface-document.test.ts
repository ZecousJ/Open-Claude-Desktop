/** Actual React host lifecycle with inert jsdom documents; no network or official bundle execution. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';import {JSDOM} from 'jsdom';import React,{act} from 'react';import {createRoot} from 'react-dom/client';
function addBillingTrigger(document: Document) {
 const root=document.documentElement ?? document.appendChild(document.createElement('html'));
 const body=document.body ?? root.appendChild(document.createElement('body'));
 return body.appendChild(document.createElement('button'));
}
const unusedServices = {
 dispatch: {},
 officialAnnouncements: {},
 officialZecousMigration: {},
};
test('host keeps first load, replaces pagehidden document, and old exit cannot revoke new mount',async t=>{
 const file=path.resolve('.runtime/official-surface-doc-'+process.pid+'.mjs');t.after(()=>fs.rmSync(file,{force:true}));
 await build({entryPoints:[path.resolve('src-web/official/OfficialWebSurface.tsx')],outfile:file,bundle:true,platform:'node',format:'esm',external:['react'],loader:{'.css':'empty','.svg':'text'}});
 const {OfficialWebSurface}=await import(pathToFileURL(file).href);
 const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid/chat/owned'});
 const previous={window:globalThis.window,document:globalThis.document,history:globalThis.history,location:globalThis.location};Object.assign(globalThis,{window:dom.window,document:dom.window.document,history:dom.window.history,location:dom.window.location,IS_REACT_ACT_ENVIRONMENT:true});

 const authListeners=new Set<any>(),eventListeners=new Set<any>();let release:any,releaseGithub:any,releaseBranches:any,releaseRepos:any,releaseEnvs:any;
 const bridge:any={...unusedServices,api:{githubStatus:()=>new Promise(resolve=>releaseGithub=resolve),githubBranches:()=>new Promise(resolve=>releaseBranches=resolve),githubRepositories:()=>new Promise(resolve=>releaseRepos=resolve),listCloudEnvironments:()=>new Promise(resolve=>releaseEnvs=resolve)},auth:{current:{account:{id:'owner'}},activationIdentity:{},onChange:(fn:any)=>{authListeners.add(fn);return()=>authListeners.delete(fn);}},officialUiRead:()=>new Promise(resolve=>release=resolve),officialUiEvents:(fn:any)=>{eventListeners.add(fn);return()=>eventListeners.delete(fn);}};
 const root=createRoot(document.getElementById('root')!);t.after(async()=>{try{await act(async()=>root.unmount());}finally{Object.assign(globalThis,previous);dom.window.close();}});
 let signedOut=0, signedOutAll=0;
 await act(async()=>root.render(React.createElement(OfficialWebSurface,{bridge,accountId:'owner',onSignOut:async()=>{signedOut++;},onSignOutEverywhere:async()=>{signedOutAll++;}})));
 const first=document.querySelector('iframe')!;const firstWindow=first.contentWindow!, firstDocument=first.contentDocument!;
 const binding=(window as any).__claudexOfficialFrameBindings(firstWindow,firstDocument);assert.ok(binding?.isCurrent());assert.equal(binding.route,'/chat/owned');
 assert.equal((window as any).__claudexOfficialFrameBindings(firstWindow,firstDocument),undefined);
 assert.equal(typeof binding.openBilling,'function');
 const foreignTrigger=document.body.appendChild(document.createElement('button'));
 assert.equal(binding.openBilling(foreignTrigger),false);
 foreignTrigger.remove();
 const oldBillingTrigger=addBillingTrigger(firstDocument);
 await act(async()=>first.dispatchEvent(new dom.window.Event('load')));assert.equal(document.querySelector('iframe'),first);assert.equal(binding.isCurrent(),true);
 const pending=binding.read({method:'GET',path:'/api/account'});const rejected=assert.rejects(pending,{name:'AbortError'});
 await act(async()=>firstWindow.dispatchEvent(new dom.window.Event('pagehide')));
 await assert.rejects(()=>binding.account.signOut("current"),{name:'AbortError'});assert.equal(signedOut,0);
 assert.equal(binding.openBilling(oldBillingTrigger),false);
 const next=document.querySelector('iframe')!;assert.notEqual(next,first);assert.equal(next.src,'https://fixture.invalid/official-frame.html');
 release({status:200,contentType:'application/json',body:new Uint8Array()});await rejected;
 const fresh=(window as any).__claudexOfficialFrameBindings(next.contentWindow,next.contentDocument);assert.ok(fresh?.isCurrent());assert.equal(fresh.route,'/chat/owned');
 await act(async()=>binding.onDocumentExit());assert.equal(document.querySelector('iframe'),next);assert.equal(fresh.isCurrent(),true);
 const newBillingTrigger=addBillingTrigger(next.contentDocument!);
 fresh.onNavigate("/share/public-share",true);
 assert.equal(fresh.openBilling(newBillingTrigger),false);
 fresh.onNavigate("/chat/owned",true);
 await act(async()=>fresh.onNavigate("/logout",false));assert.equal(signedOut,1);assert.equal(location.pathname,"/chat/owned");
 await act(async()=>fresh.account.signOut("current"));assert.equal(signedOut,2);
 await act(async()=>fresh.onNavigate("/logout/all-sessions",false));assert.equal(signedOutAll,1);assert.equal(signedOut,2);assert.equal(location.pathname,"/chat/owned");
 const pendingGithub=fresh.githubStatus();const rejectedGithub=assert.rejects(pendingGithub,{name:'AbortError'});
 const pendingBranches=fresh.githubBranches({repository:'owner/repo'});const rejectedBranches=assert.rejects(pendingBranches,{name:'AbortError'});
 const pendingRepos=fresh.githubRepositories();const rejectedRepos=assert.rejects(pendingRepos,{name:'AbortError'});
 const pendingEnvs=fresh.cloudEnvironments.listCloudEnvironments();const rejectedEnvs=assert.rejects(pendingEnvs,{name:'AbortError'});
 await act(async()=>{bridge.auth.activationIdentity={};for(const fn of [...authListeners])fn(bridge.auth.current);});
 releaseGithub({configured:true,connected:true});await rejectedGithub;
 releaseBranches({items:[],nextPage:null});await rejectedBranches;
 releaseRepos({items:[],nextPage:null});await rejectedRepos;
 releaseEnvs([]);await rejectedEnvs;
 const renewed=document.querySelector('iframe')!;assert.notEqual(renewed,next);assert.equal(fresh.isCurrent(),false);
 const renewedBinding=(window as any).__claudexOfficialFrameBindings(renewed.contentWindow,renewed.contentDocument);assert.ok(renewedBinding?.isCurrent());assert.doesNotMatch(document.body.textContent??'',/account session changed/i);
 await act(async()=>{bridge.auth.current=undefined;for(const fn of [...authListeners])fn(undefined);});assert.equal(document.querySelector('iframe'),null);assert.equal(renewedBinding.isCurrent(),false);assert.doesNotMatch(document.body.textContent??'',/account session changed/i);
});

test('frame startup failure uses the original boot error surface', async t => {
 const file=path.resolve('.runtime/official-surface-error-'+process.pid+'.mjs');t.after(()=>fs.rmSync(file,{force:true}));
 await build({entryPoints:[path.resolve('src-web/official/OfficialWebSurface.tsx')],outfile:file,bundle:true,platform:'node',format:'esm',external:['react'],loader:{'.css':'empty','.svg':'text'}});
 const {OfficialWebSurface}=await import(pathToFileURL(file).href);
 const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid/new'});
 const keys=['window','document','history','location','addEventListener','removeEventListener'] as const;
 const previous=Object.fromEntries(keys.map(k=>[k,(globalThis as any)[k]]));
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,history:dom.window.history,location:dom.window.location,addEventListener:dom.window.addEventListener.bind(dom.window),removeEventListener:dom.window.removeEventListener.bind(dom.window),IS_REACT_ACT_ENVIRONMENT:true});
 const bridge:any={...unusedServices,api:{},auth:{current:{account:{id:'owner'}},activationIdentity:{},onChange:()=>()=>{}},officialUiRead:async()=>({status:200,contentType:'application/json',body:new Uint8Array()}),officialUiEvents:()=>()=>{}};
 const root=createRoot(document.getElementById('root')!);t.after(async()=>{try{await act(async()=>root.unmount());}finally{Object.assign(globalThis,previous);dom.window.close();}});
 await act(async()=>root.render(React.createElement(OfficialWebSurface,{bridge,accountId:'owner'})));
 const frame=document.querySelector('iframe')!;
 const binding=(window as any).__claudexOfficialFrameBindings(frame.contentWindow,frame.contentDocument);assert.ok(binding?.isCurrent());
 await act(async()=>window.dispatchEvent(new dom.window.MessageEvent('message',{origin:'https://other.invalid',source:frame.contentWindow,data:'claudex:official-frame-load-failed'})));
 assert.ok(document.querySelector('iframe'));
 await act(async()=>window.dispatchEvent(new dom.window.MessageEvent('message',{origin:'https://fixture.invalid',source:frame.contentWindow,data:'claudex:official-frame-load-failed'})));
 assert.ok(document.querySelector('[data-testid="bootstrap-connection-error"]'));
 assert.equal(binding.isCurrent(),false);assert.equal((window as any).__claudexOfficialFrameBindings,undefined);
 assert.match(document.body.textContent??'',/Can.t reach Claudex|You.re offline/);
 assert.doesNotMatch(document.body.textContent??'',/could not be loaded|account session changed/i);
});
