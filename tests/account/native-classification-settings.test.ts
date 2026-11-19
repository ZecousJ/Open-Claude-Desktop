import {saveOfficialClassification} from '../../electron/official-ui/api/classification-settings';
/** Actual native saveSettings and desktop integrations; inert Electron, temporary Store. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import ts from 'typescript';
import {isDeepStrictEqual} from 'node:util';import * as preferences from '../../shared/settings-extras';import * as shortcuts from '../../electron/app/desktop-shortcut-error';
import {z} from 'zod';import {Store} from '../../electron/store/store';import {settingsSchema} from '../../electron/store/settings-schema';import {mergeSavedSettings} from '../../electron/store/settings-merge';import {withoutPreferences} from '../../electron/store/settings-preferences';import {settingsRefusal,openPolicy} from '../../shared/client-policy';import {preference} from '../../shared/settings-extras';
import {localeSaveStage,localeSaveFailure} from '../../electron/official-ui/api/locale-save-diagnostics';
const assets=path.resolve('build/official-ui');
test('classification-only real handler persists without retrying unrelated shortcuts; mixed writes and tray errors remain failures',async(t)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'actual-classification-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir);store.settings={...store.settings,locale:'en-US'} as any;store.flush();
 let applyFailure=false,save:any;const calls:string[]=[];
 let shortcutAttempts=0;
 function load(file:string,deps:Record<string,any>){const exports:any={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:(key:string)=>deps[key]??{},process:{platform:'linux'},setTimeout,clearTimeout});return exports;}
 const tray=load('electron/app/desktop-tray-dock.ts',{'./desktop-shortcut-error':shortcuts,'../../shared/settings-extras':preferences,electron:{globalShortcut:{register:()=>{shortcutAttempts++;return false},unregister(){}}}});
 const desktop=load('electron/app/desktop-integration.ts',{'./install-methods':{installMethods:(p:any,m:any)=>Object.assign(p,m)},'./desktop-tray-dock':tray,'./quick-access':{quickEntryDictationSupported:()=>false},'../../shared/settings-extras':preferences});
 const integration=Object.create(desktop.DesktopIntegration.prototype);Object.assign(integration,{ready:true,shortcuts:new Set(),options:{settings:()=>store.settings},updateKeepAwake(){calls.push('keepawake')},updateTray(){calls.push('tray');if(applyFailure)throw Error('inert tray error')},accessMonitor:{setEnabled(){calls.push('monitor')}}});
 const source=fs.readFileSync('electron/app/ipc-register.ts','utf8');const body=source.slice(source.indexOf('  handle("saveSettings"'),source.indexOf('  handle("windowAction"'));
 const mainState={store,engine:{stop:async()=>{throw Error('Unexpected engine call')},ensure:async()=>{throw Error('Unexpected engine call')}}};
 vm.runInNewContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{isDeepStrictEqual,localeSaveStage,localeSaveFailure,handle:(_n:string,fn:any)=>save=fn,mainState,settingsSchema,mergeSavedSettings,z,structuredClone,settingsRefusal,policy:()=>openPolicy,withoutPreferences,preference,noActive:()=>{throw Error('Unexpected engine check')},integration,nativeTheme:{},settingsListeners:{emit:()=>{}},deviceLink:{refresh:()=>calls.push('device.refresh')},rendererSettings:()=>store.settings,fs});
 const logLines:unknown[][]=[];const identity={},ctx:any={log:(...args:unknown[])=>logLines.push(args),root:assets,account:()=>({id:'fixture-owner'}),settings:()=>store.settings,sessionIdentity:()=>identity,isCurrent:()=>true,localCall:async(method:string,next:any)=>{assert.equal(method,'saveSettings');return save(next)},call:async()=>{throw Error('No remote calls')}};

 assert.equal((await saveOfficialClassification(ctx,{ccr_session_state_buckets:true})).status,200);
 assert.equal(shortcutAttempts,0);assert.equal(calls.length,0);assert.equal(store.settings.classifySessionStates,undefined);
 for(const enabled of [false,true]) {
  calls.length=0;
  const result=await saveOfficialClassification(ctx,{ccr_session_state_buckets:enabled});
  assert.equal(result.status,200);assert.equal(shortcutAttempts,0);
  assert.equal(new Store(dir).settings.classifySessionStates,enabled);
  const count=calls.length;assert.equal((await saveOfficialClassification(ctx,{ccr_session_state_buckets:enabled})).status,200);assert.equal(calls.length,count);assert.equal(shortcutAttempts,0);
  assert.ok(calls.includes('tray'));assert.ok(calls.includes('keepawake'));assert.ok(calls.includes('monitor'));
 }
 for(const patch of [{classifySessionStates:false,theme:'light'},{classifySessionStates:false,quickAccessShortcut:'Control+Shift+Space'}]) {
  await assert.rejects(save({...store.settings,...patch}), e=>shortcuts.isShortcutRegistrationFailure(e));
  assert.equal(new Store(dir).settings.classifySessionStates,true);
 }
 assert.equal(shortcutAttempts,4);
 applyFailure=true;
 assert.equal((await saveOfficialClassification(ctx,{ccr_session_state_buckets:false})).status,503);
 assert.equal(store.settings.classifySessionStates,true);
 assert.equal(new Store(dir).settings.classifySessionStates,true);
 assert.equal(shortcutAttempts,4);
});
test('pinned official classification producer reads explicit false and emits the exact boolean field',()=>{
 const source=fs.readFileSync(path.join(assets,'ui/assets/v1/shared-19-DSOWNXOA.js'),'utf8');
 const start=source.indexOf('function rrT() {'),end=source.indexOf('function pE(',start);assert.ok(start>=0&&end>start);
 const calls:any[]=[];const scope:any={w_:()=>({account:{settings:{ccr_session_state_buckets:false}}}),_O:()=>({mutate:(body:any)=>calls.push(body)}),J9:()=>[],J1:()=>true,J2:()=>true,K1:(_s:any,_i:any,_n:any,value:any)=>value,K2:(_s:any,_i:any,_t:any,_r:any,value:any)=>value};
 vm.runInNewContext(source.slice(start,end)+';this.producer=rrT;',scope);
 const [value,set]=scope.producer();assert.equal(value,false);set(true);set(false);
 assert.equal(JSON.stringify(calls),'[{"ccr_session_state_buckets":true},{"ccr_session_state_buckets":false}]');
});
