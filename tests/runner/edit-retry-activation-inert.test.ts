/** Actual runner prototype/getters + real version IPC; no runner/Engine constructor/open. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {useElectronShim} from './runner-core-support.test';import {registerConversationTurnHandlers} from '../../electron/ipc/conversation-turn-handlers';
useElectronShim();const {WebAppContext}=await import('../../runner/src/web-app-context');
test('runner version handler preserves real signedOut/ABA identity and can accept a fresh activation',async()=>{
 const host=Object.create(WebAppContext.prototype);host.closedFlag=false;host.signedOutValue=false;host.officialActivation={};host.activeAccount={id:'fixture'};host.store={root:'/inert-activation',conversation:()=>({id:'c',mode:'chat'})};host.selectedAttachments=new Map();
 let resolve!:(v:any)=>void,first=true,calls=0,captured:any;
 host.engine={retryResponse:async(...args:any[])=>{calls++;captured=args.at(-1);if(first){first=false;return new Promise(r=>resolve=r);}return {id:'c'};}};
 const context:any={get accountActivationIdentity(){return host.accountActivationIdentity;},get accountRetiring(){return host.accountRetiring;},get activeAccount(){return host.activeAccount;},get store(){return host.store;},get engine(){return host.engine;},selectedAttachments:host.selectedAttachments};const handlers=new Map<string,any>();registerConversationTurnHandlers({context,handle:(n: string,f: (...args: any[]) => any)=>handlers.set(n,f),cli:{},resumable:{}} as any);
 const pending=handlers.get('retryResponse')('c','t','p','m');const rejected=assert.rejects(pending,/account changed/i);assert.equal(captured.current(),true);host.signedOut=true;assert.equal(captured.current(),false);host.signedOut=false;assert.equal(captured.current(),false);resolve({id:'c'});await rejected;
 await handlers.get('retryResponse')('c','t','p','m');assert.equal(captured.current(),true);assert.equal(calls,2);
});
test('production desktop and runner registration both use the shared live authority getters',()=>{
 const source=fs.readFileSync('electron/ipc/index.ts','utf8');for(const field of ['accountActivationIdentity','accountRetiring','activeAccount'])assert.match(source,new RegExp('get '+field+'\\(\\) \\{ return ctx\\.'+field+'; \\}'));
 const runner=fs.readFileSync('runner/src/web-app-context.ts','utf8');assert.match(runner,/export function registerWebHandlers[\s\S]*registerIpc\(/);
});
