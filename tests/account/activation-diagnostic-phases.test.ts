/** Actual source methods with inert dependencies. No native services or accounts. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
import * as diagnostic from '../../electron/account/activation-failure';
import * as shortcutErrors from '../../electron/app/desktop-shortcut-error';
function load(file:string,deps:Record<string,any>){const exports:any={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:(key:string)=>key==='../account/activation-failure'?diagnostic:key==='./desktop-shortcut-error'?shortcutErrors:deps[key]??{},console:{error(){}},setTimeout,clearTimeout});return exports;}
test('every main cleanup service boundary preserves exact error identity and fixed phase',async()=>{
 const cases=['quick_entry','listeners','conversation_windows','cloud_sync','device_link','usage','scheduler','terminals','engine','store_flush','shares','popouts','remote_release','credentials','mcp','account_devices','window_shape','integration_reset','integration_apply','policy','notify'];
 for(const target of cases){const error=Error('SECRET');const call=(key:string)=>()=>{if(key===target)throw error};let generation=1;
 const state:any={activeAccount:{id:'inert'},accountRetirement:{get accountActivationIdentity(){return generation},beginDeactivation(){generation++}},store:{flush:call('store_flush')},quickEntry:{hide:call('quick_entry')},scheduler:{stop:call('scheduler')},terminals:{reset:call('terminals')},engine:{stop:call('engine')},artifactShares:{stop:call('shares')},remote:{release:call('remote_release')},credentials:{clear:call('credentials')},mcpConfig:{close:call('mcp')},policyHost:{stop:call('policy')}};
 const main={deactivatingListeners:{emitAsync:call('listeners')},appWindows:{closeConversationWindows:call('conversation_windows')},cloudSync:{stop:call('cloud_sync')},deviceLink:{disconnect:call('device_link')},usageTurns:{clear:call('usage')},artifactPopouts:{closeAll:call('popouts')},artifactPreviews:new Map(),selectedAttachments:new Map(),selectedFolders:new Map(),remoteFolders:new Map(),accountDevices:{current:call('account_devices')},integration:{reset:call('integration_reset'),apply:call('integration_apply')}};
 const actual=load('electron/app/account-lifecycle.ts',{'./main-state':{mainState:state},'../main':main,'./main-window':{shapeMainWindow:call('window_shape')},'./account-transition-events':{accountDeactivated:call('notify')}});
 await assert.rejects(actual.deactivateAccount(),e=>e===error,target);assert.deepEqual(diagnostic.activationFailureTrail(error),['cleanup.'+target],target);assert.doesNotMatch(JSON.stringify(diagnostic.activationFailureTrail(error)),/SECRET/);
 }
});
test('actual host prepare records each awaited or synchronous preparation boundary without replacing errors',async()=>{
 for(const target of ['credentials_initialize','groups_in_use','backend_prepare','follow_group','store_flush']){const error=Error('SECRET');const fail=(key:string)=>{if(key===target)throw error};const ctx:any={store:{settings:{},flush(){fail('store_flush')}},accountActivationIdentity:1};
 const actual=load('electron/remote/host.ts',{'../account/operation-lease':{assertAccountOperationCurrent(){}},'../account/remote-mode':{placeholderProvider:()=>({})}});const host=new actual.RemoteHost(ctx,{prepare:async()=>{fail('backend_prepare');return{id:'inert'}},preferGroups(){}});host.groupsInUse=()=>{fail('groups_in_use');return[]};host.followGroup=()=>fail('follow_group');
 await assert.rejects(host.prepare({initialize:async()=>fail('credentials_initialize')}),e=>e===error);assert.deepEqual(diagnostic.activationFailureTrail(error),['host.'+target]);}
});
test('backend load pinpoints serviceKind/bootstrap/register/storeKeys and models failures',async()=>{
 const actual=load('electron/sub2api/backend-models.ts',{'../account/operation-lease':{assertAccountOperationCurrent(){}},'./backend-support':{offline:()=>false,planChoice:(x:any)=>x,protocolFor:()=> 'chat',sub2apiProviderId:'inert',otherGroups:()=>[]},'./provision':{planChoice:(x:any)=>x}});
 for(const target of ['service_kind','bootstrap','register','store_keys']){const error=Error('SECRET');const hit=(key:string)=>{if(key===target)throw error};const owner:any={accounts:{serviceKind:async()=>{hit('service_kind');return'claudex'},baseUrl:'https://inert.invalid'},bootstrap:{fetch:async()=>{hit('bootstrap');return{server:{siteName:"Inert"},features:{deviceKeys:true}}}},registered:false,register:async()=>{hit('register');return{plan:{groupId:1},apiKey:{key:'inert'}}},storeKeys:async()=>hit('store_keys'),readModels:async()=>({id:'inert'})};await assert.rejects(actual.load.call(owner,{canPersist:false}),e=>e===error);assert.deepEqual(diagnostic.activationFailureTrail(error),['backend.'+target]);}
 const error=Error('SECRET');await assert.rejects(actual.readModels.call({}, {remote:async()=>{throw error}}, {},null),e=>e===error);assert.deepEqual(diagnostic.activationFailureTrail(error),['backend.remote_models']);
});
test('metadata is bounded, copied, fixed vocabulary and cannot leak arbitrary payloads',()=>{
 const error=Error('SECRET');diagnostic.noteActivationPhase(error,'SECRET');assert.deepEqual(diagnostic.activationFailureTrail(error),[]);
 diagnostic.noteActivationPhase(error,'credentials.key_status');diagnostic.noteActivationPhase(error,'host.credentials_initialize');const trail=diagnostic.activationFailureTrail(error);trail.push('SECRET');assert.deepEqual(diagnostic.activationFailureTrail(error),['credentials.key_status','host.credentials_initialize']);
 const known=diagnostic.activationLocalError('credential_unlock_unavailable','SECRET');assert.equal(diagnostic.activationFailureCode(known),'credential_unlock_unavailable');assert.equal(diagnostic.activationFailureCode(Error(known.message)),undefined);assert.equal(diagnostic.activationFailureCode(diagnostic.activationLocalError('SECRET','SECRET')),undefined);assert.equal((known as any).cause,undefined);
});
test('actual credentials distinguish master, key-status and close without labeling successful finally as failure',async()=>{
 for(const target of ['master','key_status','close']){const expected=Error('SECRET');let childCalls=0;
 const Actual=load('electron/engine/provider-credentials.ts',{'../account/operation-lease':{assertAccountOperationCurrent(){}},'./credential-operation-queue':{credentialOperation:(_r:any,_c:any,run:any)=>run(()=>{})},'node:path':{default:{join:(...x:string[])=>x.join('/')}},'node:fs':{default:{existsSync:()=>false}},'./provider-service-client':{ProviderServiceClient:class{constructor(){childCalls++}async keyStatus(){if(target==='key_status')throw expected;return{}}async close(){if(target==='close')throw expected}}}}).ProviderCredentials;
 const instance=new Actual('/inert','never-run',{});instance.master=()=>{if(target==='master')throw expected};
 if(target==='close') {await assert.rejects(instance.initialize([{id:'inert'}]),(e:unknown)=>{assert.equal(diagnostic.activationFailureCode(e),'credential_close_unconfirmed');assert.deepEqual(diagnostic.activationFailureTrail(e),['credentials.close','credentials.queue']);return true});}
 else await assert.rejects(instance.initialize([{id:'inert'}]),(e:unknown)=>{assert.equal(e,expected);assert.deepEqual(diagnostic.activationFailureTrail(e),['credentials.'+target,'credentials.queue']);return true});
 assert.equal(childCalls,target==='master'?0:1);
 }
});
test('primitive failure diagnostic contains only trusted fixed boundary, never thrown value',()=>{
 const calls:unknown[][]=[];const previous=console.error;console.error=(...args:unknown[])=>{calls.push(args)};
 try{diagnostic.noteActivationPhase('SECRET TOKEN URL','host.backend_prepare');diagnostic.noteActivationPhase('SECRET','SECRET');}finally{console.error=previous}
 assert.deepEqual(calls,[['Account operation failed without an error object.',{phase:'host.backend_prepare'}]]);assert.equal(diagnostic.activationFailureCode('SECRET'),undefined);
});
test('registerDevice and legacy provisioning awaited failures carry their exact inner boundary',async()=>{
 for(const target of ['register_device','legacy_provision']){const expected=Error('SECRET');
 const actual=load('electron/sub2api/backend-models.ts',{'../account/operation-lease':{assertAccountOperationCurrent(){}},'./backend-support':{registrationsPerMinute:2},'./provision':{registerDevice:async()=>{throw expected},legacyProvision:async()=>{throw expected}}});
 const owner={now:()=>10,registrations:[],accounts:{publicSettings:async()=>({})},client:{},session:{},deviceId:'inert'};
 await assert.rejects(target==='register_device'?actual.register.call(owner):actual.loadLegacy.call(owner,{}),e=>e===expected);
 assert.deepEqual(diagnostic.activationFailureTrail(expected),['backend.'+target]);
 }
});
test('real master throw site classifies unavailable encryption without reading existing vault contents',()=>{
 let reads=0;
 const Actual=load('electron/engine/provider-credentials.ts',{'node:path':{default:{join:(...x:string[])=>x.join('/')}},'node:fs':{default:{existsSync:()=>true,readFileSync(){reads++;throw Error('must not read')}}}}).ProviderCredentials;
 const instance=new Actual('/inert','never-run',{isEncryptionAvailable:()=>false});
 assert.throws(()=>instance.master(),(e:unknown)=>{assert.equal(diagnostic.activationFailureCode(e),'credential_unlock_unavailable');return true});assert.equal(reads,0);
});
test('double operation/close failures retain only bounded prior phases, including primitive operations',async()=>{
 for(const primitive of [false,true]){const prior=primitive?'SECRET TOKEN':Error('SECRET TOKEN');
 const Actual=load('electron/engine/provider-credentials.ts',{'../account/operation-lease':{assertAccountOperationCurrent(){}},'./credential-operation-queue':{credentialOperation:(_r:any,_c:any,run:any)=>run(()=>{})},'node:path':{default:{join:(...x:string[])=>x.join('/')}},'node:fs':{default:{existsSync:()=>false}},'./provider-service-client':{ProviderServiceClient:class{async keyStatus(){throw prior}async close(){throw Error('SECRET CLOSE')}}}}).ProviderCredentials;
 const instance=new Actual('/inert','never-run',{});instance.master=()=>{};
 await assert.rejects(instance.initialize([{id:'inert'}]),(error:unknown)=>{assert.equal(diagnostic.activationFailureCode(error),'credential_close_unconfirmed');assert.deepEqual(diagnostic.activationPriorFailure(error),{phases:['credentials.key_status']});assert.doesNotMatch(JSON.stringify(diagnostic.activationPriorFailure(error)),/SECRET/);const copied=diagnostic.activationPriorFailure(error)!;copied.phases.push('SECRET');assert.deepEqual(diagnostic.activationPriorFailure(error),{phases:['credentials.key_status']});return true});
 }
});
test('actual lease rejection has trusted identity classification without changing its guard or message',async()=>{
 const {assertAccountOperationCurrent}=await import('../../electron/account/operation-lease');
 for(const current of [()=>false,()=>{throw Error('SECRET')}])assert.throws(()=>assertAccountOperationCurrent(current),(error:unknown)=>{assert.equal(diagnostic.activationFailureCode(error),'account_operation_stale');assert.match((error as Error).message,/account changed/);return true});
 assertAccountOperationCurrent(()=>true);assertAccountOperationCurrent();assert.equal(diagnostic.activationFailureCode(Error('The account changed during this operation.')),undefined);
});
