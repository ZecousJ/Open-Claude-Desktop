/** Actual registration/wiring/RemoteHost + main deactivation, all services inert. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';import {z} from 'zod';import {AccountRetirement} from '../../electron/account/account-retirement';import * as lease from '../../electron/account/operation-lease';import * as failure from '../../electron/account/activation-failure';import {inspect} from 'node:util';
function load(file:string,deps:Record<string,any>){const source=fs.readFileSync(file,'utf8'),exports:any={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:(key:string)=>{if(key in deps)return deps[key];if(key==='../account/activation-failure')return failure;return{};},console:{error(){}},setTimeout,clearTimeout,URL},{filename:file});return exports;}
function fixture(failCleanup=false, pauseCleanup=false){
 const phase=new AccountRetirement(),state:any={accountRetirement:phase},calls:string[]=[];const noop=()=>{};let finishCleanup!:()=>void;const cleanupWait=new Promise<void>(r=>finishCleanup=r);
 const account={id:'11111111-1111-4111-8111-111111111111',name:'Inert'},session={persist:()=>true,logout:async()=>calls.push('logout')};
 const ctx:any={dataRoot:'/inert',get store(){return state.store},get activeAccount(){return state.activeAccount},get remote(){return state.remote},get accountActivationIdentity(){return phase.accountActivationIdentity},get accountRetiring(){return phase.accountRetiring},push:noop};
 const main:any={deactivatingListeners:{emitAsync:async()=>{}},appWindows:{closeConversationWindows:noop},cloudSync:{stop:noop},deviceLink:{disconnect:noop},usageTurns:{clear:noop},artifactPopouts:{closeAll:noop},artifactPreviews:new Map(),selectedAttachments:new Map(),selectedFolders:new Map(),remoteFolders:new Map(),accountDevices:{current:noop},integration:{reset:noop,apply:noop}};
 const actual=load('electron/app/account-lifecycle.ts',{'./main-state':{mainState:state},'../main':main,'./main-window':{shapeMainWindow:noop},'./account-transition-events':{accountDeactivated:noop}});
 const host=load('electron/remote/host.ts',{'../account/operation-lease':lease,'../sub2api/backend':{RemoteBackend:class{bootstrap={onChange:noop};constructor(public accounts:any,public session:any){}}},'../sub2api/identity-support':{signInError:(e:any)=>e}});
 const auth=load('electron/ipc/remote-auth.ts',{'zod':{z},'../account/operation-lease':lease,'../account/google-sign-in':{}});
 const wiring=load('electron/remote/host-wiring.ts',{'../ipc/remote-auth':auth,'./host':host});
 let release!:()=>void;const wait=new Promise<void>(r=>release=r);
 const lifecycle={activate:async(a:any,_token:any,remote:any,current:()=>boolean)=>{assert.equal(current(),true);const generation=phase.beginActivation();state.store={flush(){if(failCleanup)throw Error('Inert cleanup failure');}};if(pauseCleanup)state.engine={stop:()=>cleanupWait};await wait;assert.equal(current(),true);if(failCleanup)throw Error('Inert setup failure');state.activeAccount=a;state.remote=remote;phase.finishActivation(generation);},deactivate:actual.deactivateAccount,ready:()=>calls.push('ready')};
 const accounts={canHoldAccounts:true,resume:async()=>({session,account}),park:async()=>calls.push('park'),loginWithCode:async()=>({kind:'signedIn',session,account}),finishAdding:()=>calls.push('finishAdding'),dropParked:async()=>calls.push('dropParked')};const handlers=new Map<string,Function>();wiring.registerRemoteAccounts((name:string,fn:Function)=>handlers.set(name,fn),ctx,accounts,lifecycle);
 return{finishCleanup,runSwitch:()=>handlers.get('switchAccount')!(account.id),run:()=>handlers.get('loginWithCode')!('inert@example.invalid','123456'),release,calls,state,phase,account};
}
test('actual registration phase callback accepts its own activation and completes once',async()=>{const f=fixture();const p=f.run();await new Promise(r=>setImmediate(r));f.release();assert.equal(await p,f.account);assert.deepEqual(f.calls,['ready','finishAdding','dropParked']);});
test('partial actual main cleanup failure must not claim an unrelated account change or log out unknown state',async()=>{const f=fixture(true);const p=f.run();await new Promise(r=>setImmediate(r));f.release();await assert.rejects(p,/cleanup.*not.*confirmed|could not.*open/i);assert.equal(f.calls.includes('logout'),false);assert.ok(f.state.store);});

test('late main cleanup failure after replacement or same-ID reactivation retains stale denial and never logs out winner',async()=>{
 for(const same of [false,true]){const f=fixture(true,true);const p=f.run();await new Promise(r=>setImmediate(r));f.release();await new Promise(r=>setImmediate(r));const generation=f.phase.beginActivation();const winner={flush(){throw Error('winner must not flush')}};f.state.store=winner;f.state.activeAccount={id:same?f.account.id:'replacement'};f.phase.finishActivation(generation);f.finishCleanup();await assert.rejects(p,/account changed/);assert.equal(f.state.store,winner);assert.equal(f.calls.includes('logout'),false);}
});

test('partial failure never exposes original service details through Error inspect/cause/JSON',()=>{
 const original=Error('SECRET SERVICE TOKEN'),cleanup=Error('SECRET CLEANUP PATH');const error=new failure.ActivationCleanupUnconfirmed('artifact_shares',()=>true,original,cleanup);
 assert.equal(error.cause,undefined);assert.doesNotMatch(inspect(error,{depth:10})+JSON.stringify(error),/SECRET/);assert.equal(error.isCurrent(),true);
});

test('switch outer recovery preserves owned partial-cleanup error without parking or restoring another account',async()=>{
 const f=fixture(true);const p=f.runSwitch();await new Promise(r=>setImmediate(r));f.release();await assert.rejects(p,/cleanup was not confirmed/);assert.equal(f.calls.includes('park'),false);assert.equal(f.calls.includes('logout'),false);assert.ok(f.state.store);
});
