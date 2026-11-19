/** Real registered export handler, inert Electron/archive/fs. Never opens a dialog or reads/writes a profile. */
import test from 'node:test';import assert from 'node:assert/strict';import {registerHooks} from 'node:module';
const captures:any[]=[],writes:any[]=[],dialogs:any[]=[];let result:Promise<any>=Promise.resolve({canceled:true}),onArchive=()=>{};
const mocks:any={electron:{dialog:{showSaveDialog:async(...args:any[])=>{dialogs.push(args);return result;}}},'../conversations/data-export':{exportArchive:(input:any)=>{captures.push(input);onArchive();return Buffer.from('inert archive');}},'../conversations/claude-ai-import':{ClaudeAiImport:class{dispose(){}}}};
(globalThis as any).__exportLeaseMocks=mocks;(globalThis as any).__exportLeaseFs={writeFileSync:(...args:any[])=>writes.push(args)};
registerHooks({resolve(spec,context,next){if(context.parentURL?.endsWith('/electron/ipc/settings-account.ts')){if(spec==='node:fs')return{shortCircuit:true,url:'data:text/javascript,export default globalThis.__exportLeaseFs;'};if(mocks[spec])return{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`const m=globalThis.__exportLeaseMocks[${JSON.stringify(spec)}];`+Object.keys(mocks[spec]).map(k=>`export const ${k}=m.${k};`).join(''))};}return next(spec,context);}});
const{registerSettingsAccountHandlers}=await import('../../electron/ipc/settings-account');
function deferred(){let resolve!:(value:any)=>void;return{promise:new Promise<any>(r=>resolve=r),resolve};}
async function until(predicate:()=>boolean){for(let i=0;i<20&&!predicate();i++)await new Promise(r=>setImmediate(r));assert.equal(predicate(),true);}
function fixture(){captures.length=writes.length=dialogs.length=0;onArchive=()=>{};result=Promise.resolve({canceled:true});let settingsReads=0;
 const store={root:'inert-A-root',conversations:[{id:'A'}],projects:[{id:'A-project'}]},window={isDestroyed:()=>false};
 const ctx:any={store,window,activeAccount:{id:'A'},accountActivationIdentity:1,accountRetiring:false,remote:undefined,onAccountDeactivating:()=>()=>{},onAccountActivated:()=>()=>{},publicSettings:()=>{settingsReads++;return{owner:ctx.activeAccount.id};}};
 const handlers=new Map<string,any>();registerSettingsAccountHandlers((name,fn)=>handlers.set(name,fn),ctx);return{ctx,store,window,run:handlers.get('exportData'),settingsReads:()=>settingsReads};
}
test('A save dialog cannot export B data after account switch',async()=>{const f=fixture(),wait=deferred();result=wait.promise;const p=f.run();await until(()=>dialogs.length===1);f.ctx.store={root:'inert-B-root',conversations:[{id:'B'}],projects:[]};f.ctx.activeAccount={id:'B'};f.ctx.accountActivationIdentity++;wait.resolve({canceled:false,filePath:'/not-written/export.zip'});await assert.rejects(p,/account|window|export/i);assert.equal(captures.length,0);assert.equal(writes.length,0);assert.equal(f.settingsReads(),0);});
test('same-account reactivation and window replacement invalidate pending export',async()=>{for(const change of ['generation','window','destroyed']){const f=fixture(),wait=deferred();result=wait.promise;const p=f.run();await until(()=>dialogs.length===1);if(change==='generation')f.ctx.accountActivationIdentity++;else if(change==='window')f.ctx.window={isDestroyed:()=>false};else f.window.isDestroyed=()=>true;wait.resolve({filePath:'/not-written/export.zip'});await assert.rejects(p,/account|window|export/i);assert.equal(writes.length,0);assert.equal(captures.length,0);}});
test('cancel remains null with no data read, including account change while dialog was open',async()=>{const f=fixture(),wait=deferred();result=wait.promise;const p=f.run();await until(()=>dialogs.length===1);f.ctx.accountActivationIdentity++;wait.resolve({canceled:true});assert.equal(await p,null);assert.equal(captures.length,0);assert.equal(writes.length,0);assert.equal(f.settingsReads(),0);});
test('unchanged export uses captured legitimate store and OS-selected destination exactly once',async()=>{const f=fixture();result=Promise.resolve({canceled:false,filePath:'/not-written/export.zip'});assert.equal(await f.run(),'/not-written/export.zip');assert.equal(dialogs[0][0],f.window);assert.equal(captures[0].root,f.store.root);assert.equal(captures[0].conversations,f.store.conversations);assert.equal(writes.length,1);assert.deepEqual(writes[0][2],{mode:0o600});assert.equal(f.settingsReads(),1);});
test('retirement while Electron import yields prevents showing an obsolete dialog',async()=>{const f=fixture();const p=f.run();f.ctx.accountActivationIdentity++;await assert.rejects(p,/account|window|export/i);assert.equal(dialogs.length,0);assert.equal(writes.length,0);});
test('reentrant archive preparation cannot write after the chosen window is replaced',async()=>{const f=fixture();result=Promise.resolve({filePath:'/not-written/export.zip'});onArchive=()=>{f.ctx.window={isDestroyed:()=>false};};await assert.rejects(f.run(),/account|window|export/i);assert.equal(captures.length,1);assert.equal(writes.length,0);});
test('retirement-start and same-store root replacement reject before reading export contents',async()=>{
 for(const change of ['retiring','root']){const f=fixture(),wait=deferred();result=wait.promise;const p=f.run();await until(()=>dialogs.length===1);if(change==='retiring')f.ctx.accountRetiring=true;else f.store.root='other-inert-root';wait.resolve({filePath:'/not-written/export.zip'});await assert.rejects(p,/account|window|export/i);assert.equal(f.settingsReads(),0);assert.equal(captures.length,0);assert.equal(writes.length,0);}
});
test('canceled dialog never exports even if an Electron result also contains a path',async()=>{const f=fixture();result=Promise.resolve({canceled:true,filePath:'/not-written/export.zip'});assert.equal(await f.run(),null);assert.equal(captures.length,0);assert.equal(writes.length,0);});
test('the export range is validated before the dialog and reaches the archive', async () => {
  const f = fixture();
  const start = "2026-09-01T00:00:00.000Z";
  const end = "2026-09-27T00:00:00.000Z";
  await assert.rejects(
    f.run({ conversations_start_date: end, conversations_end_date: start }),
    /start date/,
  );
  assert.equal(dialogs.length, 0);
  result = Promise.resolve({ canceled: false, filePath: "/not-written/ranged.zip" });
  await f.run({ conversations_start_date: start, conversations_end_date: end });
  assert.deepEqual(captures[0].conversationRange, {
    start: Date.parse(start),
    end: Date.parse(end),
  });
});
