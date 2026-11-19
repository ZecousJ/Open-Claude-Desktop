/** Actual lifecycle module, transpiled with every dependency replaced by inert exports.
 * No Electron, SDK, filesystem mutation, account or network service executes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { AccountRetirement } from '../../electron/account/account-retirement';
import * as activationDiagnostic from '../../electron/account/activation-failure';
const source=fs.readFileSync('electron/app/account-lifecycle.ts','utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(boundary:'listeners'|'engine'|'shares'|'release', unfencedControl=false) {
 let release!:()=>void; const waiting=new Promise<void>(r=>release=r);
 const calls:string[]=[];const fn=(name:string)=>()=>{calls.push(name);return Promise.resolve();};
 const resources=(owner:string)=>({store:{flush:fn(owner+'.flush')},engine:{stop:()=>{calls.push(owner+'.engine.stop');return owner==='A'&&boundary==='engine'?waiting:Promise.resolve();}},activeAccount:{id:owner},remote:{ready:true,release:()=>{calls.push(owner+'.release');return owner==='A'&&boundary==='release'?waiting:Promise.resolve();}},credentials:{clear:fn(owner+'.credentials.clear')},artifactShares:{stop:()=>{calls.push(owner+'.shares.stop');return owner==='A'&&boundary==='shares'?waiting:Promise.resolve();}},scheduler:{stop:fn(owner+'.scheduler.stop')},terminals:{reset:fn(owner+'.terminals.reset')},policyHost:{stop:fn(owner+'.policy.stop')},mcpConfig:{close:fn(owner+'.mcp.close')}});
 const accountRetirement=new AccountRetirement(); accountRetirement.finishActivation(accountRetirement.beginActivation());
 const mainState:any={...resources('A'),accountRetirement};
 const main:any={deactivatingListeners:{emitAsync:()=>{calls.push('listeners');return boundary==='listeners'?waiting:Promise.resolve();}},accountDevices:{current:fn('devices.current')},appWindows:{closeConversationWindows:fn('windows.close')},cloudSync:{stop:fn('sync.stop')},deviceLink:{disconnect:fn('link.disconnect')},usageTurns:{clear:fn('usage.clear')},artifactPopouts:{closeAll:fn('popouts.close')},integration:{reset:fn('integration.reset'),apply:fn('integration.apply')}};
 for(const key of ['artifactPreviews','selectedAttachments','selectedFolders','remoteFolders'])main[key]={clear:fn(key+'.clear')};
 const exports:any={};
 const require=(name:string)=>name==='../account/activation-failure'?activationDiagnostic:name==='./main-state'?{mainState}:name==='../main'?main:name==='./main-window'?{shapeMainWindow:fn('shape')}:name==='./account-transition-events'?{accountDeactivated:fn('deactivated')} : {};
 const context=vm.createContext({exports,require,console:{error:fn('diagnostic')},clearTimeout(){},setTimeout(){throw Error('Unexpected timer');}});
 const code=unfencedControl?ts.transpileModule(source.replace(/^  check\(\);$/gm,''),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText:compiled;
 vm.runInContext(code,context,{filename:'actual-account-lifecycle-inert.cjs'});
 const run=exports.deactivateAccount();
 return {calls,mainState,release,run,async replace(){
   // Await until exactly the selected actual await boundary has been entered.
   const marker=boundary==='listeners'?'listeners':boundary==='engine'?'A.engine.stop':boundary==='shares'?'A.shares.stop':'A.release';
   for(let i=0;i<20&&!calls.includes(marker);i++)await Promise.resolve();
   assert.ok(calls.includes(marker),marker);
   Object.assign(mainState,resources('B'));accountRetirement.finishActivation(accountRetirement.beginActivation());
 }};
}
for(const boundary of ['listeners','engine','shares','release'] as const)test(`late actual deactivation after ${boundary} cannot clear or stop replacement account`,async()=>{
 const f=fixture(boundary);const result=assert.rejects(Promise.resolve(f.run),/transition was superseded/);await f.replace();f.release();await result;
 assert.equal(f.mainState.activeAccount?.id,'B');assert.equal(f.mainState.store!==undefined,true);
 assert.deepEqual(f.calls.filter(x=>x.startsWith('B.')),[]);
});

test('actual deactivation still completes for its unchanged account',async()=>{
 const f=fixture('listeners');f.release();await f.run;assert.equal(f.mainState.activeAccount,undefined);assert.equal(f.calls.filter(x=>x==='deactivated').length,1);
});
test('in-memory unfenced negative control demonstrates the replacement-account assertion detects stale cleanup',async()=>{
 const f=fixture('listeners',true);await f.replace();f.release();await f.run;assert.equal(f.mainState.activeAccount,undefined);assert.ok(f.calls.includes('B.scheduler.stop'));
});
