/** Executes the shared production registration's account-generation wiring. No app/SDK startup. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
test('desktop and runner both use the same event-driven conversation generation provider',()=>{
 const index=fs.readFileSync('electron/ipc/index.ts','utf8');
 const start=index.indexOf('  let conversationAccountGeneration = 0;');
 const end=index.indexOf('    get accountActivationIdentity()',start);
 assert.ok(start>=0&&end>start);
 const activated:Function[]=[],deactivating:Function[]=[];let captured:any;
 const scope={ctx:{onAccountActivated:(fn:Function)=>activated.push(fn),onAccountDeactivating:(fn:Function)=>deactivating.push(fn)},handle(){},registerConversationHandlers:(_handle:any,context:any)=>captured=context};
 vm.runInNewContext(index.slice(start,end)+'});',scope);
 assert.equal(captured.accountGeneration(),0);activated[0]();assert.equal(captured.accountGeneration(),1);deactivating[0]();activated[0]();assert.equal(captured.accountGeneration(),3);
 const desktop=fs.readFileSync('electron/app/ipc-register.ts','utf8'),runner=fs.readFileSync('runner/src/web-app-context.ts','utf8');
 assert.match(desktop,/registerIpc\(handle, ctx,/);assert.match(runner,/export function registerWebHandlers\(ctx: WebAppContext, handle: IpcHandle\)[\s\S]*registerIpc\(/);
 assert.match(runner,/onAccountActivated\(cb:[\s\S]*?this\.activatedListeners\.add\(cb\)/);
 assert.match(runner,/onAccountDeactivating\(cb:[\s\S]*?this\.deactivatingListeners\.add\(cb\)/);
});
