/** Actual signOut prototype method, no RemoteHost/backend constructor or external service. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {registerHooks} from 'node:module';
import {onAccountTransition} from '../../electron/app/account-transition-events';
const source=fs.readFileSync(new URL('../../electron/remote/host.ts',import.meta.url),'utf8');const mocks:Record<string,Record<string,unknown>>={};
for(const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)){const[,names,spec]=m;if(spec==='../app/account-transition-events')continue;mocks[spec]=Object.fromEntries(names.split(',').map(n=>n.trim()).filter(n=>n&&!n.startsWith('type ')).map(n=>[n,()=>{throw Error('Unexpected inert dependency');}]));}
(globalThis as any).__signoutMocks=mocks;registerHooks({resolve(s,c,n){if(c.parentURL?.endsWith('/electron/remote/host.ts')&&mocks[s])return{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`const m=globalThis.__signoutMocks[${JSON.stringify(s)}];`+Object.keys(mocks[s]).map(k=>`export const ${k}=m.${k};`).join(''))};return n(s,c);}});
const {RemoteHost}=await import('../../electron/remote/host');
function deferred(){let resolve!:()=>void,reject!:(e:Error)=>void;return{promise:new Promise<void>((r,j)=>{resolve=r;reject=j;}),resolve:()=>resolve(),reject:(e:Error)=>reject(e)};}
function fixture(){const wait=deferred(),events:unknown[]=[],store={};const ctx:any={store,accountActivationIdentity:1,push:(event:unknown)=>events.push(event),deactivate:()=>{ctx.accountActivationIdentity++;return wait.promise;}};
 const host:any=Object.create(RemoteHost.prototype);host.ctx=ctx;host.ready=true;host.backend={session:{accountId:'a',end(){}},accounts:{markEnded(){}}};ctx.remote=host;return{ctx,host,wait,events,store};}
test('old forced signout completion cannot broadcast to replacement or same-account new activation',async()=>{
 for(const sameStore of [false,true]){const f=fixture(),notices:any[]=[];const off=onAccountTransition(e=>notices.push(e));try{const p=f.host.signOut('session-expired');f.ctx.accountActivationIdentity++;if(!sameStore)f.ctx.store={};f.ctx.remote={};f.wait.resolve();await p;assert.deepEqual(f.events,[]);assert.equal(notices.length,1);assert.equal(notices[0].store,f.store);assert.equal(notices[0].generation,1);}finally{off();}}
});
test('current successful deactivation preserves signed-out delivery after store and remote clear',async()=>{const f=fixture();const p=f.host.signOut('session-expired');f.ctx.store=undefined;f.ctx.remote=undefined;f.wait.resolve();await p;assert.equal((f.events[0] as any).type,'signed-out');assert.equal(f.events.length,1);});
test('same-phase failure preserves original error and legitimate notification without exposing push failure',async(t)=>{const f=fixture(),failure=Error('inert deactivation failed');f.ctx.push=()=>{throw Error('private event detail');};const log=t.mock.method(console,'error',()=>{});const p=f.host.signOut('session-expired');f.wait.reject(failure);await assert.rejects(p,e=>e===failure);assert.deepEqual(log.mock.calls.map(c=>c.arguments),[['Account sign-out notification was not delivered.']]);});

test('detached watch callback handles rejected sign-out with fixed diagnostic, while direct method still rejects',async(t)=>{
 const f=fixture();f.host.backend.bootstrap={onChange(){}};f.host.watch();
 const callback=f.host.backend.session.onSignedOut;assert.equal(typeof callback,'function');
 const log=t.mock.method(console,'error',()=>{});callback('session-expired');f.ctx.accountActivationIdentity++;f.ctx.store={winner:true};f.ctx.remote={};
 f.wait.reject(Error('private old deactivation failure'));await new Promise(r=>setImmediate(r));
 assert.deepEqual(f.events,[]);assert.deepEqual(log.mock.calls.map(c=>c.arguments),[['Account sign-out could not be confirmed.']]);
});
