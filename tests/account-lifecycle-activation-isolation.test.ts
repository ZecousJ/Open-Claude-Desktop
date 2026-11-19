/** Real lifecycle functions and settings storage with inert engines and services. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {registerHooks} from 'node:module';
import {AccountRetirement} from '../electron/account/account-retirement';
import {desktopPreferences, readDesktopPreferences, writeDesktopPreferences} from '../electron/store/desktop-preferences';
import {Store} from '../electron/store/store';
import {notificationLevels} from '../shared/notification-levels';
import {preference} from '../shared/settings-extras';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lifecycle-inert-'));
let deviceRoot=root;
const source=fs.readFileSync(new URL('../electron/app/account-lifecycle.ts',import.meta.url),'utf8');
const mocks:Record<string,Record<string,any>>={};
for(const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)){
 const[,names,spec]=m;if(spec==='./account-transition-events'||spec==='../account/activation-failure')continue;
 mocks[spec]=Object.fromEntries(names.split(',').map(n=>n.trim()).filter(n=>n&&!n.startsWith('type ')).map(n=>[n,()=>{}]));
}
// These isolation tests stub unrelated cleanup; actual disk/registry coverage is in app/incognito-retirement.test.ts.
Object.assign(mocks['./incognito-retirement'],{createIncognitoRetirement:(options:any)=>({run:()=>options.stop()})});
const noop=()=>{};let sharesWait:Promise<void>|undefined,credentialsWait:Promise<void>|undefined,deactivateWait:Promise<void>|undefined,extensionWait:Promise<void>|undefined;
let prepares=0,engines=0,notifications=0,events=0,shareStops=0,credentialClears=0,engineStops=0;
let engineStopWait:Promise<void>|undefined;
const state:any={accountRetirement:new AccountRetirement(),accounts:{profileRoot:()=>root,ownsLegacyData:()=>false}};
class InertCredentials{vaultKey='inert';async initialize(){prepares++;await credentialsWait;}async importAccountVault(){}clear(){credentialClears++;}}
const engineInstances:any[]=[];
class InertEngine{onEvent:any;extensions={add:noop};constructor(_store:any,_runtime:any,_key:any,onEvent:any){engines++;this.onEvent=onEvent;engineInstances.push(this);}ensure(){return Promise.resolve();}async stop(){engineStops++;await engineStopWait;}isBusy(){return false;}}
class InertScheduler{start(){}stop(){}observeConversation(){}isUnattendedConversation(){return false;}holdForConnection(){}allowedFor(){}allow(){}}
Object.assign(mocks.electron,{app:{getPath:()=>root,isPackaged:false},safeStorage:{},nativeTheme:{}});
Object.assign(mocks['../store/store'],{Store});Object.assign(mocks['../engine/provider-credentials'],{ProviderCredentials:InertCredentials});
Object.assign(mocks['../store/desktop-preferences'],{desktopPreferences});
Object.assign(mocks['../../shared/notification-levels'],{notificationLevels});
Object.assign(mocks['../../shared/settings-extras'],{preference});
Object.assign(mocks['../official-ui/api/state'],{readState:(_key:string,fallback:unknown)=>fallback});
Object.assign(mocks['../official-ui/api/scope'],{inAdapterScope:(_scope:unknown,read:()=>unknown)=>read()});
Object.assign(mocks['../connectors/remote-skills'],{registerRemoteConnectorSkills:()=>({resolve:noop})});
Object.assign(mocks['../artifacts/artifact-shares'],{ArtifactShares:class{async start(){await sharesWait;}async stop(){shareStops++;}}});
for(const [spec,name] of [['../artifacts/artifact-library','ArtifactLibrary'],['../conversations/background-history','BackgroundHistory'],['../conversations/reply-feedback','ReplyFeedback']])mocks[spec][name]=class{};
Object.assign(mocks['../engine/engine'],{Engine:InertEngine});Object.assign(mocks['../routines/scheduler'],{Scheduler:InertScheduler});Object.assign(mocks['../terminal/terminal-controller'],{TerminalController:class{reset(){}}});
Object.assign(mocks['./main-state'],{mainState:state});Object.assign(mocks['../remote/host-wiring'],{createPolicyHost:()=>({start:noop,stop:noop}),handleRefusal:noop});
Object.assign(mocks['../main'],{artifactPopouts:{closeAll:noop},artifactPreviews:{clear:noop},selectedAttachments:new Map(),selectedFolders:new Map(),remoteFolders:new Map(),cloudSync:{stop:noop},deviceLink:{disconnect:noop,refresh:noop},usageTurns:{clear:noop,observe:noop},integration:{reset:noop,apply:noop,observeConversation:noop},appWindows:{closeConversationWindows:noop},accountDevices:{current:noop},deactivatingListeners:{emitAsync:async()=>{await deactivateWait;}},activatedListeners:{emit:()=>{notifications++;}},nativeExtensions:{activate:async()=>{await extensionWait;}},push:()=>{events++;}});
Object.assign(mocks['../main'],{
 getDeviceDesktopPreferences:()=>readDesktopPreferences(deviceRoot),
 saveDeviceDesktopPreferences:(value:Parameters<typeof writeDesktopPreferences>[1])=>writeDesktopPreferences(deviceRoot,value),
});
(globalThis as any).__lifecycleMocks=mocks;
registerHooks({resolve(spec,context,next){if(context.parentURL?.endsWith('/electron/app/account-lifecycle.ts')&&mocks[spec])return{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`const m=globalThis.__lifecycleMocks[${JSON.stringify(spec)}];`+Object.keys(mocks[spec]).map(n=>`export const ${n}=m.${n};`).join(''))};return next(spec,context);}});
const{activateAccount,deactivateAccount}=await import('../electron/app/account-lifecycle');
function deferred(){let resolve!:()=>void;return{promise:new Promise<void>(r=>resolve=r),resolve:()=>resolve()};}
function reset(){sharesWait=credentialsWait=deactivateWait=extensionWait=undefined;state.accountRetirement=new AccountRetirement();state.store=undefined;state.activeAccount=undefined;state.remote=undefined;prepares=engines=notifications=events=shareStops=credentialClears=engineStops=0;engineStopWait=undefined;}
function replace(){const store={root:'replacement',flush(){throw Error('wrong store flush');}};state.accountRetirement.beginActivation();state.store=store;state.activeAccount={id:'winner'};return store;}
const account:any={id:'a',name:'Inert'};
test('activation cannot prepare credentials or write replacement store after artifact service await',async()=>{reset();const wait=deferred();sharesWait=wait.promise;const p=activateAccount(account,'inert');const winner=replace();wait.resolve();await assert.rejects(p,/superseded/);assert.equal(state.store,winner);assert.equal(prepares,0);assert.equal(engines,0);assert.equal(shareStops,1);});
test('activation credential completion cannot create engine for replacement account',async()=>{reset();const wait=deferred();credentialsWait=wait.promise;const p=activateAccount(account,'inert');await new Promise(r=>setImmediate(r));const winner=replace();wait.resolve();await assert.rejects(p,/superseded/);assert.equal(state.store,winner);assert.equal(engines,0);assert.equal(credentialClears,1);assert.equal(shareStops,1);});
test('deactivation listener wait cannot stop or clear replacement resources',async()=>{reset();state.store={};state.activeAccount=account;const wait=deferred();deactivateWait=wait.promise;const p=deactivateAccount();const winner=replace();state.engine={stop(){throw Error('wrong engine');}};wait.resolve();await assert.rejects(p,/superseded/);assert.equal(state.store,winner);assert.equal(state.activeAccount.id,'winner');});
test('late old engine events and extension completion cannot publish to replacement activation',async()=>{reset();const wait=deferred();extensionWait=wait.promise;const p=activateAccount(account,'inert');await new Promise(r=>setImmediate(r));assert.equal(engines,1);const old=engineInstances.at(-1);replace();old.onEvent({type:'conversation',conversation:{}});assert.equal(events,0);wait.resolve();await assert.rejects(p,/superseded/);assert.equal(notifications,0);});
test('current activation still publishes its own ready account and intent retirement prevents startup',async()=>{
 reset();await activateAccount(account,'inert');assert.equal(state.activeAccount.id,'a');assert.equal(notifications,1);assert.equal(state.accountRetirement.accountRetiring,false);
 reset();await assert.rejects(activateAccount(account,'inert',undefined,()=>false),/superseded/);assert.equal(engines,0);assert.equal(state.store,undefined);
});
test('deactivation engine stop await cannot flush or release replacement account',async()=>{
 reset();state.store={flush(){throw Error('old flush must not continue after replacement');}};state.activeAccount=account;
 const wait=deferred();state.engine={stop:()=>wait.promise};const p=deactivateAccount();await new Promise(r=>setImmediate(r));
 const winner=replace();state.remote={release(){throw Error('wrong remote');}};wait.resolve();await assert.rejects(p,/superseded/);assert.equal(state.store,winner);
});
test('host prepare receives live intent and activation ownership guard before engine creation',async()=>{
 reset();const wait=deferred();let valid:(()=>boolean)|undefined;
 const host:any={requestLimits:()=>({}),profileRoot:()=>root,prepare:async(_credentials:any,current:()=>boolean)=>{valid=current;await wait.promise;}};
 const p=activateAccount(account,'inert',host);await new Promise(r=>setImmediate(r));assert.equal(valid?.(),true);replace();assert.equal(valid?.(),false);
 wait.resolve();await assert.rejects(p,/superseded/);assert.equal(engines,0);
});
test('activation listener reentry cannot finish old shape or refresh replacement device',async()=>{
 reset();const listeners=mocks['../main'].activatedListeners;const original=listeners.emit;let refreshed=0;
 const refresh=mocks['../main'].deviceLink.refresh;mocks['../main'].deviceLink.refresh=()=>{refreshed++;};listeners.emit=()=>{replace();};
 try{await assert.rejects(activateAccount(account,'inert'),/superseded/);assert.equal(refreshed,0);assert.equal(state.activeAccount.id,'winner');}
 finally{listeners.emit=original;mocks['../main'].deviceLink.refresh=refresh;}
});
test('activation failure cleanup shares in-flight captured engine stop with concurrent deactivation',async()=>{
 reset();const extensions=deferred(),stopping=deferred();extensionWait=extensions.promise;engineStopWait=stopping.promise;
 const activation=activateAccount(account,'inert');await new Promise(r=>setImmediate(r));const deactivation=deactivateAccount();await new Promise(r=>setImmediate(r));assert.equal(engineStops,1);
 extensions.resolve();const refusal=assert.rejects(activation,/superseded/);await new Promise(r=>setImmediate(r));assert.equal(engineStops,1);
 stopping.resolve();await Promise.all([refusal,deactivation]);assert.equal(engineStops,1);
});
test('captured cleanup failure is diagnosed without replacing the original superseded result',async(t)=>{
 reset();const wait=deferred();extensionWait=wait.promise;const p=activateAccount(account,'inert');await new Promise(r=>setImmediate(r));
 engineInstances.at(-1).stop=async()=>{throw Error('private inert cleanup detail');};const log=t.mock.method(console,'error',()=>{});replace();wait.resolve();await assert.rejects(p,/superseded/);
 assert.deepEqual(log.mock.calls.map(call=>call.arguments),[['Superseded account resource cleanup was not confirmed.']]);assert.equal(credentialClears,1);assert.equal(shareStops,1);
});
test('hung captured cleanup has bounded wait and preserves original transition error without stopping winner',async(t)=>{
 reset();const wait=deferred(),hung=deferred();extensionWait=wait.promise;engineStopWait=hung.promise;
 const p=activateAccount(account,'inert');await new Promise(r=>setImmediate(r));const winner=replace();
 const log=t.mock.method(console,'error',()=>{});t.mock.timers.enable({apis:['setTimeout']});
 const rejected=assert.rejects(p,/superseded/);wait.resolve();await new Promise(r=>setImmediate(r));
 t.mock.timers.tick(5000);await rejected;assert.equal(state.store,winner);
 assert.deepEqual(log.mock.calls.map(call=>call.arguments),[['Superseded account resource cleanup was not confirmed.']]);
 hung.resolve();await new Promise(r=>setImmediate(r));assert.equal(state.store,winner);assert.equal(log.mock.calls.length,1);
});
test('activation adopts missing keep-awake preferences once and keeps device values across accounts', async (t) => {
  reset();
  const profileRoot = state.accounts.profileRoot;
  deviceRoot = fs.mkdtempSync(path.join(root, 'desktop-'));
  state.accounts.profileRoot = (id: string) => path.join(deviceRoot, id);
  t.after(() => {
    deviceRoot = root;
    state.accounts.profileRoot = profileRoot;
  });
  fs.writeFileSync(path.join(deviceRoot, 'desktop-keybindings.json'), JSON.stringify({
    menuBar: false,
    keepAwake: false,
  }));
  const first = new Store(state.accounts.profileRoot(account.id));
  Object.assign(first.settings, { keepAwake: true, keepAwakeWhileCoding: false });
  first.flush();
  const second = new Store(state.accounts.profileRoot('b'));
  Object.assign(second.settings, {
    keepAwake: true, keepAwakeWhileCoding: true, keepAwakeOnBattery: false,
    notificationSound: 'none', drawAttention: true, notifyResponses: false, notifyCode: false,
  });
  second.flush();

  await activateAccount(account, 'inert');
  assert.deepEqual(readDesktopPreferences(deviceRoot), {
    menuBar: false,
    keepAwake: false,
    keepAwakeWhileCoding: false,
    keepAwakeOnBattery: true,
    notificationLevels: {},
    notificationSound: 'system',
    drawAttention: false,
  });
  await deactivateAccount();
  await activateAccount({ ...account, id: 'b' }, 'inert');
  assert.equal(state.store.settings.keepAwake, false);
  assert.equal(state.store.settings.keepAwakeWhileCoding, false);
  assert.equal(state.store.settings.keepAwakeOnBattery, true);
  assert.deepEqual(state.store.settings.notificationLevels, {});
  assert.equal(state.store.settings.notificationSound, 'system');
  assert.equal(state.store.settings.drawAttention, false);
  assert.equal(state.store.settings.notifyResponses, false);
  assert.equal(state.store.settings.notifyCode, false);
});

test('activation carries legacy notification choices and explicit device levels across accounts', async (t) => {
  reset();
  const profileRoot = state.accounts.profileRoot;
  deviceRoot = fs.mkdtempSync(path.join(root, 'desktop-'));
  state.accounts.profileRoot = (id: string) => path.join(deviceRoot, id);
  t.after(() => {
    deviceRoot = root;
    state.accounts.profileRoot = profileRoot;
  });
  const first = new Store(state.accounts.profileRoot(account.id));
  Object.assign(first.settings, { notifyCode: false, notifyResponses: false, notificationSound: 'none', drawAttention: true });
  first.flush();
  const second = new Store(state.accounts.profileRoot('b'));
  Object.assign(second.settings, { notifyResponses: true, notificationLevels: { idle: 'banner' } });
  second.flush();

  await activateAccount(account, 'inert');
  const desktop = readDesktopPreferences(deviceRoot);
  assert.ok(desktop);
  assert.deepEqual(desktop.notificationLevels, { permission: 'off', question: 'off', idle: 'off' });
  assert.equal(desktop.notificationSound, 'none');
  assert.equal(desktop.drawAttention, true);
  await deactivateAccount();
  await activateAccount({ ...account, id: 'b' }, 'inert');
  assert.deepEqual(state.store.settings.notificationLevels, desktop.notificationLevels);
  assert.equal(state.store.settings.notificationSound, 'none');
  assert.equal(state.store.settings.drawAttention, true);
  assert.equal(state.store.settings.notifyResponses, true);

  await deactivateAccount();
  writeDesktopPreferences(deviceRoot, { ...desktop, notificationLevels: {} });
  await activateAccount(account, 'inert');
  assert.deepEqual(state.store.settings.notificationLevels, {});
  assert.equal(state.store.settings.notifyResponses, false);
});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
