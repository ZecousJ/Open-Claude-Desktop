import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppearanceAuthority} from '../../runner/src/official-ui-appearance-authority';
import {negotiatedAppearanceSettings} from '../../src-web/official/negotiated-appearance-action';
import {isOfficialAppearanceAction,validAppearanceBody,officialAppearanceCapabilitiesPath} from '../../shared/official-appearance-capability';
import {isOfficialUiAction,isOfficialUiQuery} from '../../shared/official-ui-web';
const json=(v:unknown,status=200)=>({status,contentType:'application/json',body:new TextEncoder().encode(JSON.stringify(v))});
const request={method:'PATCH' as const,path:'/api/account/settings',contentType:'application/json',body:json({chat_font:'sans'}).body};
function setup(enabled=true){let owner='a',identity:unknown={},root='/synthetic/a',active=true;const authority=createAppearanceAuthority({accountId:()=>owner,identity:()=>identity,root:()=>root,current:()=>active,enabled:()=>enabled});return{authority,retire:()=>{identity={}},switch:()=>{owner='b'},nullIdentity:()=>{identity=null},stop:()=>{active=false}};}
test('appearance exact path/body allowlist does not authorize other settings or query suffixes',()=>{
 assert(isOfficialUiAction('PATCH','/api/account/settings'));assert(isOfficialUiQuery('GET',officialAppearanceCapabilitiesPath));
 for(const value of [{chat_font:'sans',enabled_mcp_tools:{}},{chat_font:'default'},{chat_font:'atkinson'},{chat_font:null},[],null,{}, {chatFont:'sans'}])assert.equal(validAppearanceBody(value),false);
 for(const font of ['serif','sans','system','dyslexia'])assert(validAppearanceBody({chat_font:font}));
 assert(!isOfficialAppearanceAction('POST',request.path));assert(!isOfficialAppearanceAction('PATCH',request.path+'?x=1'));
});
test('authority is default unavailable and activation/account retirement invalidates leases including ABA',()=>{
 const off=setup(false);assert.equal(off.authority.describe().appearance.state,'unavailable');assert.throws(()=>off.authority.assertAppearance());
 for(const change of ['retire','switch','nullIdentity','stop'] as const){const x=setup();const lease=x.authority.describe().activationLease;assert(x.authority.accepts(lease));x[change]();assert(!x.authority.accepts(lease));assert.throws(()=>x.authority.assertAppearance());}
});
test('negotiation preserves read-only and rejects malformed/foreign descriptors without dispatch',async()=>{
 for(const enabled of [false,true]){let calls=0;const messages:string[]=[];const a=setup();const run=negotiatedAppearanceSettings({enabled,accountId:'a',current:()=>true,read:async()=>json({...a.authority.describe(),accountId:'foreign'}),action:async()=>{calls++;return json({})},onStatus:m=>messages.push(m)});assert.equal((await run(request)).status,501);assert.equal(calls,0);assert(messages.length);}
});
test('negotiation uses a fresh lease on each request and emits actual success/failure, no retries',async()=>{
 const a=setup();let reads=0,calls=0;const messages:string[]=[];const run=negotiatedAppearanceSettings({enabled:true,accountId:'a',current:()=>a.authority.current(),read:async()=>{reads++;return json(a.authority.describe())},action:async r=>{calls++;assert(a.authority.accepts(r.capabilityLease));return json({},calls===1?200:503)},onStatus:m=>messages.push(m)});
 assert.equal((await run(request)).status,200);assert.equal((await run(request)).status,503);assert.equal(reads,2);assert.equal(calls,2);assert.match(messages[0],/saved/);assert.match(messages[1],/could not be confirmed/);
});
test('pending negotiation retirement prevents saving and pending delivery retirement is unknown',async()=>{
 const a=setup();let calls=0;const run=negotiatedAppearanceSettings({enabled:true,accountId:'a',current:()=>a.authority.current(),read:async()=>{const d=a.authority.describe();a.retire();return json(d)},action:async()=>{calls++;return json({})}});assert.equal((await run(request)).status,409);assert.equal(calls,0);
 const b=setup();const delivered=negotiatedAppearanceSettings({enabled:true,accountId:'a',current:()=>b.authority.current(),read:async()=>json(b.authority.describe()),action:async()=>{b.retire();return json({})}});assert.equal((await delivered(request)).status,409);
});
test('older failure cannot overwrite latest appearance status',async()=>{
 const a=setup();let release!:(v:ReturnType<typeof json>)=>void,calls=0;const messages:string[]=[];
 const run=negotiatedAppearanceSettings({enabled:true,accountId:'a',current:()=>true,read:async()=>json(a.authority.describe()),action:async()=>++calls===1?new Promise(r=>release=r):json({}),onStatus:m=>messages.push(m)});
 const first=run(request);await new Promise(r=>setImmediate(r));await run(request);release(json({},503));await first;assert.deepEqual(messages,['Response font saved.']);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {officialUiRead} from '../../runner/src/official-ui-read';
import {encodeWireValue} from '../../shared/web-wire';
import {defaultGuardOptions} from '../../runner/src/method-guard';
import {openPolicy} from '../../shared/client-policy';
import {saveAppearanceFont} from '../../runner/src/official-ui-appearance-save';
function runner(t:any){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'appearance-capability-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let identity:unknown={};let flushes=0,events=0;
 const ctx:any={userId:1,activeAccount:{id:'owner'},officialSessionIdentity:()=>identity,setAccessToken(){},onEvent:()=>()=>{},appVersion:'inert',log(){},policy:()=>openPolicy,
  store:{root,settings:{providers:[],chatFont:'serif',theme:'dark',instructions:'KEEP'},async persistAppearancePreference(){flushes++;fs.writeFileSync(path.join(root,'appearance.json'),JSON.stringify(ctx.store.settings));}},settingsListeners:{emit(){events++;}}};
 const dispatcher:any={options:{officialUiRoot:path.resolve('build/official-ui'),officialUiActions:false,officialUiAppearanceSettings:true},guard:defaultGuardOptions,context:()=>ctx,contextFor:async()=>ctx,now:()=>1,run:async()=>{throw Error('No general dispatcher call is permitted.');}};
 const run=(r:any)=>officialUiRead(dispatcher,{t:'call',id:'local',user:{id:1,accessToken:'inert-not-a-credential'},method:r.method==='GET'?'officialUiRead':'officialUiAction',args:encodeWireValue([r])} as any) as Promise<any>;
 const cap=async()=>JSON.parse(Buffer.from((await run({method:'GET',path:officialAppearanceCapabilitiesPath})).body).toString());
 return{ctx,dispatcher,run,cap,counts:()=>({flushes,events}),retire:()=>identity={}};
}
test('actual runner route persists only font without general dispatcher or changing unrelated settings',async t=>{
 const f=runner(t);const cap=await f.cap();assert.equal(cap.appearance.state,'ready');
 const answer=await f.run({...request,capabilityLease:cap.activationLease});assert.equal(answer.status,200,Buffer.from(answer.body).toString());assert.equal(f.ctx.store.settings.chatFont,'sans');assert.equal(f.ctx.store.settings.instructions,'KEEP');assert.equal(f.ctx.store.settings.theme,'dark');assert.deepEqual(f.counts(),{flushes:1,events:1});assert.equal(JSON.parse(fs.readFileSync(path.join(f.ctx.store.root,'appearance.json'),'utf8')).chatFont,'sans');
 const bad=await f.run({...request,body:json({chat_font:'sans',instructions:'FORBIDDEN'}).body,capabilityLease:cap.activationLease});assert.equal(bad.status,400);assert.deepEqual(f.counts(),{flushes:1,events:1});
});
test('actual runner rejects stale leases and default-off capability without any flush',async t=>{
 const f=runner(t);const c=await f.cap();f.retire();assert.equal((await f.run({...request,capabilityLease:c.activationLease})).status,409);f.dispatcher.options.officialUiAppearanceSettings=false;assert.equal((await f.cap()).appearance.state,'unavailable');await assert.rejects(f.run({...request,capabilityLease:c.activationLease}));assert.deepEqual(f.counts(),{flushes:0,events:0});
});
test('atomic appearance save merges latest settings and never commits after retirement',async()=>{
 const store:any={settings:{providers:[],chatFont:'serif',instructions:'LATEST'},async persistAppearancePreference(){}};let current=true;let emitted=0;
 await saveAppearanceFont({font:'sans',store,policy:openPolicy,current:()=>current,changed(){emitted++}});assert.equal(store.settings.instructions,'LATEST');assert.equal(emitted,1);
 const saved=store.settings;current=false;await assert.rejects(()=>saveAppearanceFont({font:'system',store,policy:openPolicy,current:()=>current,changed(){emitted++}}));assert.equal(store.settings,saved);assert.equal(emitted,1);
});

test('persist failure restores only own in-memory assignment, preserves unknown disk outcome and does not resend',async()=>{
 let calls=0,events=0;const previous:any={providers:[],chatFont:'serif'};const store:any={settings:previous,async persistAppearancePreference(){calls++;throw Error('simulated failure')}};
 await assert.rejects(()=>saveAppearanceFont({font:'sans',store,policy:openPolicy,current:()=>true,changed(){events++}}));assert.equal(store.settings,previous);assert.equal(calls,1);assert.equal(events,0);
 const other:any={providers:[],chatFont:'system'};store.persistAppearancePreference=async()=>{calls++;store.settings=other;throw Error('unknown')};await assert.rejects(()=>saveAppearanceFont({font:'sans',store,policy:openPolicy,current:()=>true,changed(){events++}}));assert.equal(store.settings,other);assert.equal(calls,2);
});

import {CloudStore} from '../../runner/src/cloud-store';
test('real CloudStore confirmation waits for settlement and rejects recorded background failures',async()=>{
 let release!:()=>void;let settled=false,finished=false;const fake:any={failures:0,settings:{chatFont:'serif'},synced:{settings:createHash('sha1').update(JSON.stringify({chatFont:'serif'})).digest('base64')},sync:()=>new Promise<void>(r=>release=r),settled:async()=>{settled=true}};
 const pending=CloudStore.prototype.persistAppearancePreference.call(fake).then(()=>{finished=true});await new Promise(r=>setImmediate(r));assert.equal(finished,false);release();await pending;assert.equal(settled,true);assert.equal(finished,true);
 fake.sync=async()=>{};fake.failures=1;await assert.rejects(CloudStore.prototype.persistAppearancePreference.call(fake),/could not be confirmed/);
});
test('pending persistence keeps a concurrent unrelated settings update and retired activation reports unknown',async()=>{
 let release!:()=>void;let current=true;let emitted=0;const original:any={providers:[],chatFont:'serif',instructions:'old'};
 const store:any={settings:original,persistAppearancePreference:()=>new Promise<void>(r=>release=r)};
 const pending=saveAppearanceFont({font:'sans',store,policy:openPolicy,current:()=>current,changed(){emitted++}});const concurrent={...store.settings,instructions:'new'};store.settings=concurrent;current=false;release();await assert.rejects(pending,/activation changed/);assert.equal(store.settings,concurrent);assert.equal(store.settings.instructions,'new');assert.equal(emitted,0);
});

test('a superseded font cannot be acknowledged as current after async persistence',async()=>{
 let release!:()=>void,events=0;const store:any={settings:{providers:[],chatFont:'serif'},persistAppearancePreference:()=>new Promise<void>(r=>release=r)};
 const first=saveAppearanceFont({font:'sans',store,policy:openPolicy,current:()=>true,changed(){events++}});store.settings={...store.settings,chatFont:'system'};release();await assert.rejects(first,/superseded/);assert.equal(store.settings.chatFont,'system');assert.equal(events,0);
});

import {setLocale,t as translate} from '../../src/i18n';
test('existing locale selection renders appearance refusal and failure in Chinese or English',async()=>{
 const refusal='Response font cannot be saved in this read-only Web entry. The previous font is retained.';
 const failure='The response font save could not be confirmed. Reload settings to check its value; the frontend did not resend the change.';
 await setLocale('zh-CN');assert.match(translate(refusal),/只读/);assert.match(translate(failure),/无法确认/);
 await setLocale('en-US');assert.equal(translate(refusal),refusal);assert.equal(translate(failure),failure);
});

test('real CloudStore failed full write followed by successful partial batch cannot falsely acknowledge font',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'appearance-ack-'));let rejectSettings!:(error:Error)=>void;let allow=false;let puts=0;
 const store=new CloudStore({root,userId:1,log(){},transport:{request:async(op:string)=>{if(op==='store.settings.put'){puts++;if(!allow)return await new Promise((_resolve,reject)=>rejectSettings=reject);}return {};}} as any});
 t.after(async()=>{allow=true;await store.close();fs.rmSync(root,{recursive:true,force:true});});
 store.settings={...store.settings,chatFont:'sans'};
 const saving=store.persistAppearancePreference();
 assert.equal(puts,1);const partial=store.sync('partial');rejectSettings(Error('Explicit synthetic full settings failure'));
 await assert.rejects(saving,/could not be confirmed/);await partial;assert.equal(store.failedWrites,0);assert.equal(puts,1);
 allow=true;await store.persistAppearancePreference();assert.equal(puts,2);
});
