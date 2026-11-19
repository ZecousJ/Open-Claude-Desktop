/** Actual pinned picker callback + account route + native saveSettings body. Inert services, temporary Store. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import ts from 'typescript';import {Readable} from 'node:stream';
import {isDeepStrictEqual} from 'node:util';import * as preferences from '../../shared/settings-extras';import * as shortcuts from '../../electron/app/desktop-shortcut-error';
import {z} from 'zod';import {Store} from '../../electron/store/store';import {settingsSchema} from '../../electron/store/settings-schema';import {mergeSavedSettings} from '../../electron/store/settings-merge';import {withoutPreferences} from '../../electron/store/settings-preferences';import {settingsRefusal,openPolicy} from '../../shared/client-policy';import {preference} from '../../shared/settings-extras';import {accountRoute} from '../../electron/official-ui/api/account';
import {saveOfficialChatFont} from '../../electron/official-ui/api/appearance';
import {localeSaveStage,localeSaveFailure} from '../../electron/official-ui/api/locale-save-diagnostics';
import {desktopPreferences} from '../../electron/store/desktop-preferences';
import * as accelerator from '../../shared/accelerator';
const assets=path.resolve('build/official-ui');
function pickerCallback(){const p=path.join(assets,'ui/assets/v1/c12f1cf7e-DOCPUsm5.js'),s=fs.readFileSync(p,'utf8'),ast=ts.createSourceFile(p,s,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let found='';function walk(n:ts.Node){if(ts.isArrowFunction(n)&&n.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)&&n.parameters[0]?.name.getText(ast)==='c')found=n.getText(ast);ts.forEachChild(n,walk);}walk(ast);assert.ok(found.includes('await y({ locale: c })'));return found;}
test('actual picker and native handler save locale despite unrelated denied shortcut; shortcut changes and tray failures stay failures',async(t)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'actual-locale-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir);store.settings={...store.settings,locale:'en-US'} as any;store.flush();
 let applyFailure=false,save:any;const calls:string[]=[],statuses:number[]=[],bodies:any[]=[],toasts:any[]=[],selected:string[]=[];
 let shortcutAttempts=0;
 function load(file:string,deps:Record<string,any>){const exports:any={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:(key:string)=>deps[key]??{},process:{platform:'linux'},setTimeout,clearTimeout});return exports;}
 const tray=load('electron/app/desktop-tray-dock.ts',{'./desktop-shortcut-error':shortcuts,'../../shared/settings-extras':preferences,'../../shared/accelerator':accelerator,electron:{globalShortcut:{register:()=>{shortcutAttempts++;return false},unregister(){}}}});
 const desktop=load('electron/app/desktop-integration.ts',{'./install-methods':{installMethods:(p:any,m:any)=>Object.assign(p,m)},'./desktop-tray-dock':tray,'./quick-access':{quickEntryDictationSupported:()=>false},'../../shared/settings-extras':preferences});
 const integration=Object.create(desktop.DesktopIntegration.prototype);Object.assign(integration,{ready:true,shortcuts:new Set(),options:{settings:()=>store.settings},updateKeepAwake(){calls.push('keepawake')},refreshNotificationSignals(){},updateTray(){calls.push('tray');if(applyFailure)throw Error('inert tray error')},accessMonitor:{setEnabled(){calls.push('monitor')}}});
 const source=fs.readFileSync('electron/app/ipc-register.ts','utf8');const body=source.slice(source.indexOf('  handle("saveSettings"'),source.indexOf('  handle("windowAction"'));
 const mainState={store,engine:{stop:async()=>{throw Error('Unexpected engine call')},ensure:async()=>{throw Error('Unexpected engine call')}}};
 vm.runInNewContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{isDeepStrictEqual,localeSaveStage,localeSaveFailure,handle:(_n:string,fn:any)=>save=fn,desktopShortcuts:desktop.desktopShortcuts,desktopPreferences,mainState,settingsSchema,mergeSavedSettings,z,structuredClone,settingsRefusal,policy:()=>openPolicy,withoutPreferences,preference,noActive:()=>{throw Error('Unexpected engine check')},integration,nativeTheme:{},settingsListeners:{emit:()=>{}},deviceLink:{refresh:()=>calls.push('device.refresh')},rendererSettings:()=>store.settings,fs});
 const logLines:unknown[][]=[];const identity={},ctx:any={log:(...args:unknown[])=>logLines.push(args),root:assets,account:()=>({id:'fixture-owner'}),settings:()=>store.settings,sessionIdentity:()=>identity,isCurrent:()=>true,localCall:async(method:string,next:any)=>{assert.equal(method,'saveSettings');return save(next)},call:async()=>{throw Error('No remote calls')}};
 const put=async(value:any)=>{bodies.push(value);const req:any=Readable.from([JSON.stringify(value)]);req.method='PUT';req.headers={'content-type':'application/json'};let status=0;await accountRoute(req,{writeHead:(s:number)=>status=s,end:()=>{}} as any,'/api/account_profile',ctx);statuses.push(status);if(status!==200)throw Error('inert HTTP failure');};
 const sandbox:any={P:()=>1,s:{getState:()=>({localePickCount:0,localeChoice:'en-US',localeSwitchSeq:1})},n:()=> 'account',z:'en-US',I:{getQueryData:()=>({locale:'en-US'})},L:[],t:()=>{},w:{locale:'en-US'},g:'language_menu',M:'en-US',A:put,D:put,F:()=>true,j:(s:string)=>selected.push(s),N:()=>{},r:()=>false,i:()=>false,T:(...args:any[])=>toasts.push(args),f:(o:any)=>o.defaultMessage,v:()=>{}};
 const select=vm.runInNewContext('('+pickerCallback()+')',sandbox);
 await select('fr-FR');assert.deepEqual(JSON.parse(JSON.stringify(bodies)),[{locale:'fr-FR'}]);assert.deepEqual(statuses,[200]);assert.equal((new Store(dir).settings as any).locale,'fr-FR');assert.deepEqual(selected,['fr-FR']);assert.equal(shortcutAttempts,0);assert.match(JSON.stringify(logLines),/integration-shortcuts-preserved/);assert.deepEqual(calls,['keepawake','tray','monitor','device.refresh']);
 // Actual response-font producer calls the same native saveSettings path through its adapter.
 const fontSource=fs.readFileSync(path.join(assets,'ui/assets/v1/shared-l-p-m-w-5-BDZb5dJN.js'),'utf8');
 const fontAst=ts.createSourceFile('font.js',fontSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const fontFunction=fontAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='Tr');
 assert.ok(fontFunction);
 let chosen='sans',synced=false,pick=0;const requests:any[]=[],pending:Promise<void>[]=[];
 const fontContext:any={...ctx,call:async(method:string,next:any)=>{assert.equal(method,'saveSettings');return save(next)}};
 const fontVm:any={J9:()=>[],J5:()=>true,K5:(...args:any[])=>args.at(-1),J2:()=>true,K2:(...args:any[])=>args.at(-1),RQ:()=>({chatFontSetting:chosen,setChatFontSetting:(f:string)=>chosen=f}),NF:()=>({account:{settings:{chat_font:chosen}}}),a8:()=>[synced,(v:boolean)=>synced=v],bP:()=>({mutateAsync:(body:any)=>{requests.push(body);const task=saveOfficialChatFont(fontContext,body).then(result=>{if(result.status!==200)throw Error('inert font save failed')});pending.push(task);return task}}),iB:()=>{},$t:()=>{},Jft:{getState:()=>({interfaceFont:'anthropic'})},zH:()=>++pick,Cg:(v:number)=>pick=v,cX:()=>chosen,jq:(key:string,value:any)=>{if(key==='font')chosen=value;else synced=value},G9:'font',Ic:'synced'};
 Object.defineProperty(fontVm,'iG',{get:()=>pick});
 const fontHook=vm.runInNewContext(fontFunction.getText(fontAst)+';Tr',fontVm);
 const choose=async(font:string)=>{fontHook().setChatFontSetting(font);await Promise.allSettled(pending);await Promise.resolve();};
 await choose('serif');assert.equal(chosen,'serif');assert.equal(new Store(dir).settings.chatFont,'serif');assert.equal(shortcutAttempts,0);assert.deepEqual(JSON.parse(JSON.stringify(requests)),[{chat_font:'serif'}]);
 await choose('sans');assert.equal(new Store(dir).settings.chatFont,'sans');assert.equal(chosen,'sans');assert.equal(shortcutAttempts,0);
 await save({...store.settings,chatFont:'serif',theme:'light',codeBranchPrefix:'fixture-team',ccPromptSuggestions:false});
 const mixed = new Store(dir).settings;
 assert.equal(mixed.chatFont,'serif');
 assert.equal(mixed.codeBranchPrefix,'fixture-team');
 assert.equal(mixed.ccPromptSuggestions,false);
 assert.equal(shortcutAttempts,0);
 await save({...store.settings,chatFont:'sans'});
 await assert.rejects(save({...store.settings,locale:'de-DE',quickAccessShortcut:'Control+Shift+Space'}),e=>shortcuts.isShortcutRegistrationFailure(e));
 assert.equal(new Store(dir).settings.locale,'fr-FR');
 assert.equal(shortcutAttempts,2);
 await assert.rejects(save({...store.settings,instructions:'inert actual engine change'}),/Unexpected engine check/);
 calls.length=0;applyFailure=true;await choose('serif');assert.equal(chosen,'sans');assert.equal(new Store(dir).settings.chatFont,'sans');calls.length=0;await select('de-DE');assert.deepEqual(statuses,[200,400]);assert.equal((new Store(dir).settings as any).locale,'fr-FR');assert.deepEqual(selected,['fr-FR']);assert.equal(toasts.length,1);assert.match(toasts[0][0],/isn’t working right now/);assert.deepEqual(calls,['keepawake','tray','keepawake','tray']);assert.equal(shortcutAttempts,2);
});

test('native engine projection ignores JSON key order while retaining actual model/provider/config differences and old undefined omission',()=>{
 const source=fs.readFileSync('electron/app/ipc-register.ts','utf8');
 const ast=ts.createSourceFile('ipc-register.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);let initializer='';
 const visit=(n:ts.Node)=>{if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='engineSettings')initializer=n.initializer!.getText(ast);ts.forEachChild(n,visit)};visit(ast);assert.ok(initializer);
 const compiled=ts.transpileModule('const projection='+initializer+';',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const projection=vm.runInNewContext(compiled+'projection',{withoutPreferences,preference,JSON});
 const base:any={providers:[{id:'inert',model:'model-a',models:['model-a']}],activeProviderId:'inert',instructions:'',sandbox:'workspace-write'};
 const normalized=(value:any)=>JSON.parse(projection(value));
 assert.deepEqual(normalized(base),normalized({...base,chatFont:'serif'}));
 assert.deepEqual(normalized(base),normalized(Object.fromEntries(Object.entries(base).reverse())));
 assert.deepEqual(normalized(base),normalized({...base,unknownOptional:undefined}));
 for(const changed of [{...base,providers:[{id:'inert',model:'model-b',models:['model-b']}]},{...base,activeProviderId:'other'},{...base,instructions:'changed'},{...base,sandbox:'read-only'}])assert.notDeepEqual(normalized(base),normalized(changed));
});
