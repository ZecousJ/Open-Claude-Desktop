/** Pure trusted-metadata tests only; not actual Electron callback ordering proof. */
import test from 'node:test';import assert from 'node:assert/strict';
import {createFixtureRequestGate,fixtureOrigin,tagHeader} from './support/opaque-preview-fixture/request-gate';
import {shellDocument,inertArtifact,hostHtml,hostCsp} from './support/opaque-preview-fixture/documents';
function setup(){const frame={};let epoch:unknown={},time=0,current=true;const url=fixtureOrigin+'/shell/fixed-resource';const gate=createFixtureRequestGate({webContentsId:1,frame,url,epoch,currentEpoch:()=>epoch,current:()=>current,now:()=>time,lifetimeMs:100});const request={id:1,url,method:'GET',webContentsId:1,frame,resourceType:'subFrame',requestHeaders:{[tagHeader]:'renderer-forgery','X-ClAuDeX-InErT-ReQuEsT-TaG':'another-forgery'}};return{gate,request,url,change(){epoch={};},expire(){time=101;},close(){current=false;}};}
test('only exact trusted contents/frame/subFrame mints one request tag; renderer headers are replaced',()=>{const f=setup(),answer=f.gate.authorize(f.request);assert.equal(answer.cancel,false);const names=Object.keys(answer.requestHeaders).filter(k=>k.toLowerCase()===tagHeader);assert.deepEqual(names,[tagHeader]);const tag=answer.requestHeaders[tagHeader];assert.match(tag,/^[a-f0-9]{64}$/);assert.notEqual(tag,'renderer-forgery');assert.equal(f.gate.consume('GET',f.url,new Headers(answer.requestHeaders)),true);assert.equal(f.gate.consume('GET',f.url,new Headers(answer.requestHeaders)),false);assert.equal(f.gate.authorize(f.request).cancel,true);});
test('main/XHR/foreign/frame swap/method/query never gets a tag or proof permission',()=>{for(const patch of [{resourceType:'mainFrame'},{resourceType:'xhr'},{webContentsId:2},{frame:{}},{method:'POST'},{url:fixtureOrigin+'/shell/other'},{id:-1}]){const f=setup(),answer=f.gate.authorize({...f.request,...patch});assert.equal(answer.cancel,true);assert.ok(!Object.keys(answer.requestHeaders).some(k=>k.toLowerCase()===tagHeader));assert.equal(f.gate.consume('GET',f.url,new Headers({[tagHeader]:'renderer-forgery'})),false);}});
test('navigation epoch, close, expiry and explicit revoke invalidate already-minted tags',()=>{for(const action of ['change','expire','close','retire']as const){const f=setup(),answer=f.gate.authorize(f.request);if(action==='retire')f.gate.retire();else f[action]();assert.equal(f.gate.consume('GET',f.url,new Headers(answer.requestHeaders)),false);}});
test('private proof is only in shell document; parent and inert nested content have no proof or active script',()=>{const proof='a'.repeat(64),shell=shellDocument(proof);assert.ok(shell.html.includes(proof));assert.ok(!hostHtml.includes(proof));assert.ok(!inertArtifact.includes(proof));assert.match(shell.html,/setAttribute\('sandbox',''\)/);assert.doesNotMatch(inertArtifact,/<script|onload=|onclick=|https?:/i);assert.match(shell.csp,/connect-src 'none'/);assert.match(hostCsp,/script-src 'none'/);assert.doesNotMatch(shell.csp,/unsafe-inline|allow-same-origin/);assert.throws(()=>shellDocument('bad'));});

test('actual fixed preload ignores old-frame delayed load after a new frame is created',async()=>{
 const {JSDOM}=await import('jsdom'),{readFileSync}=await import('node:fs'),{runInNewContext}=await import('node:vm');
 const dom=new JSDOM(hostHtml,{url:fixtureOrigin+'/host'});await new Promise(r=>setImmediate(r));
 const sent:any[]=[], handlers=new Map<string,Function>();let resource=0;
 const ipcRenderer={on:(name:string,fn:Function)=>handlers.set(name,fn),send:(...args:any[])=>sent.push(args),invoke:async(name:string)=>name==='inert-fixture-bind'?fixtureOrigin+'/shell/'+String(++resource).padStart(8,'0'):fixtureOrigin+'/blank'};
 runInNewContext(readFileSync('tests/support/opaque-preview-fixture/preload.cjs','utf8'),{require:(name:string)=>{assert.equal(name,'electron');return{ipcRenderer};},window:dom.window,document:dom.window.document});
 dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
 dom.window.document.getElementById('open')!.click();await new Promise(r=>setImmediate(r));const old=dom.window.document.querySelector('iframe')!;assert.ok(old);
 dom.window.document.getElementById('open')!.click();await new Promise(r=>setImmediate(r));const fresh=dom.window.document.querySelector('iframe')!;assert.notEqual(fresh,old);sent.length=0;
 old.dispatchEvent(new dom.window.Event('load'));assert.equal(sent.length,0);
 fresh.dispatchEvent(new dom.window.Event('load'));assert.deepEqual(sent.map(x=>x[0]),['inert-fixture-loaded']);
 const forwarded:any[]=[];fresh.contentWindow!.postMessage=((...args:any[])=>forwarded.push(args)) as any;let closed=0;
 const port={close(){closed++;}},bootstrap={type:'claudex-preview-bootstrap',version:1};
 handlers.get('inert-fixture-bootstrap')!({ports:[port]},{resourceURL:old.src,bootstrap});assert.equal(closed,1);assert.equal(forwarded.length,0);
 // jsdom replaces contentWindow on src assignment rather than modeling Chromium's
 // retained WindowProxy. Positive transfer requires the separately gated native run.
 dom.window.close();
});

test('late old navigate reply cannot navigate a newly opened fixture frame',async()=>{
 const {JSDOM}=await import('jsdom'),{readFileSync}=await import('node:fs'),{runInNewContext}=await import('node:vm');
 const dom=new JSDOM(hostHtml,{url:fixtureOrigin+'/host'});await new Promise(r=>setImmediate(r));let resource=0,release:any;
 const ipcRenderer={on:()=>{},send:()=>{},invoke:async(name:string,mode?:string)=>{if(mode==='navigate')return new Promise(resolve=>release=resolve);return name==='inert-fixture-bind'?fixtureOrigin+'/shell/'+String(++resource).padStart(8,'0'):fixtureOrigin+'/blank';}};
 runInNewContext(readFileSync('tests/support/opaque-preview-fixture/preload.cjs','utf8'),{require:()=>({ipcRenderer}),window:dom.window,document:dom.window.document});dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
 dom.window.document.getElementById('open')!.click();await new Promise(r=>setImmediate(r));const old=dom.window.document.querySelector('iframe')!;
 dom.window.document.getElementById('navigate')!.click();assert.ok(release);dom.window.document.getElementById('open')!.click();await new Promise(r=>setImmediate(r));const fresh=dom.window.document.querySelector('iframe')!;assert.notEqual(fresh,old);const nextURL=fresh.src;
 release(fixtureOrigin+'/blank');await new Promise(r=>setImmediate(r));assert.equal(fresh.src,nextURL);dom.window.close();
});
