import { ensureThread, branchFrom } from "../../electron/engine/engine-turn-setup";
/** Real exported send, inert object only: no Engine constructor, SDK, filesystem or sockets. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {send} from '../../electron/engine/engine-send';
import {CodeSendCancelled} from '../../electron/engine/code-send-start';
function deferred(){let resolve!:()=>void;return{promise:new Promise<void>(r=>resolve=r),resolve:()=>resolve()};}
function fixture(){
 let current=true;const calls:string[]=[];
 const c:any={id:'c',mode:'chat',cwd:'/never-read',threadId:'thread',turns:[{id:'t',prompt:'old',attachments:[],items:[],status:'completed',createdAt:1}]};
 const engine:any={store:{conversation:()=>c,settings:{providers:[{id:'p',model:'m'}]},projects:[],flush(){}},environment:{kind:'space'},launcher:{},intentionalStop:false,pendingSend:false,safeguardModels:new Map(),routes:new Map(),firstOutput:new Map(),elsewhereFor:()=>undefined,assertMcpAvailable(){},policy:()=>({webSearch:true}),assertSendable(){},assertIdle(){},sendCwd:()=>'/never-read',assertExtensions(){},dropWebSearch:async()=>{},canQueue:()=>false,
 ensure:async()=>{calls.push('ensure');},syncRequestOptions:async()=>{calls.push('sync');},windowsSandbox:{ensureReady:async()=>{calls.push('sandbox');}},sandboxSetupFolder(){},threadOptions:()=>({developerInstructions:'',config:{}}),
 branchFrom:async()=>{calls.push('branch');c.turns=[];return{};},ensureThread:async()=>{calls.push('thread');},changed(){calls.push('changed');},turnContext:()=>({}),extensions:{prepareTurn:async()=>{calls.push('extensions');}},turnExtras:()=>({}),
 rpc:{connected:true,call:async(method:string)=>{calls.push(method);return{turn:{id:'owned-turn'}};}},queue(){calls.push('queue');throw Error('Must not queue retired request');},options:{},
 };
 return{engine,c,calls,retire(){current=false;engine.intentionalStop=true;},run:(bound=true)=>send.call(engine,{conversationId:'c',text:'edited',attachments:[],mode:'chat',providerId:'p',model:'m'},'t',true,bound?{current:()=>current}:{})};
}
async function until(predicate:()=>boolean){for(let i=0;i<20&&!predicate();i++)await new Promise(r=>setImmediate(r));assert.equal(predicate(),true);}
test('retirement during ensure prevents subsequent configuration, branch and model start',async()=>{
 const f=fixture(),wait=deferred();f.engine.ensure=async()=>{f.calls.push('ensure');await wait.promise;};const p=f.run();await until(()=>f.calls.includes('ensure'));f.retire();wait.resolve();await assert.rejects(p,/account changed/);assert.deepEqual(f.calls,['ensure']);assert.equal(f.c.turns[0].id,'t');
});
test('retirement during extension preparation prevents turn start without pretending branch rollback',async()=>{
 const f=fixture(),wait=deferred();f.engine.extensions.prepareTurn=async()=>{f.calls.push('extensions');await wait.promise;};const p=f.run();await until(()=>f.calls.includes('extensions'));f.retire();wait.resolve();await assert.rejects(p,/account changed/);assert.equal(f.calls.includes('turn/start'),false);assert.equal(f.calls.includes('branch'),true);assert.equal(f.calls.includes('queue'),false);
});
test('retirement after dispatched RPC never queues or silently replays an unknown outcome',async()=>{
 const f=fixture(),wait=deferred();f.engine.rpc.call=async(name:string)=>{f.calls.push(name);await wait.promise;throw Error('inert transport failure');};f.engine.canQueue=()=>true;f.engine.launcher.waiting=()=>false;
 const p=f.run();await until(()=>f.calls.includes('turn/start'));f.retire();f.engine.rpc.connected=false;wait.resolve();await assert.rejects(p,/account changed/);assert.equal(f.calls.filter(x=>x==='turn/start').length,1);assert.equal(f.calls.includes('queue'),false);
});
test('legacy unbound and valid bound callers retain successful single send semantics',async()=>{
 for(const bound of [false,true]){const f=fixture();const c=await f.run(bound);assert.equal(c.turns.at(-1)?.id,'owned-turn');assert.equal(f.calls.filter(x=>x==='turn/start').length,1);}
});

test('ensureThread refuses post-trust thread creation after retirement',async()=>{
 const wait=deferred();let current=true;const calls:string[]=[];
 const e:any={rpc:{call:async(name:string)=>{calls.push(name);return{thread:{id:'new'}};}},trustEveryWorkspace:true,trustCodexProject:async()=>{calls.push('trust');await wait.promise;},loaded:new Set(),threadLimits:new Map(),store:{settings:{}}};const c:any={};
 const p=ensureThread.call(e,c,{cwd:'/not-read',config:{}} as any,()=>current);await until(()=>calls.includes('trust'));current=false;wait.resolve();await assert.rejects(p,/account|agent/);assert.deepEqual(calls,['trust']);assert.equal(c.threadId,undefined);assert.equal(e.loaded.size,0);
});
test('ensureThread cannot resume or alter loaded state after retired unsubscribe completion',async()=>{
 const wait=deferred();let current=true;const calls:string[]=[];
 const e:any={rpc:{call:async(name:string)=>{calls.push(name);if(name==='thread/unsubscribe')await wait.promise;}},loaded:new Set(['thread']),threadLimits:new Map([['thread','old-limits']]),store:{settings:{}}};const c:any={threadId:'thread'};
 const p=ensureThread.call(e,c,{config:{}} as any,()=>current);await until(()=>calls.includes('thread/unsubscribe'));current=false;wait.resolve();await assert.rejects(p,/account|agent/);assert.deepEqual(calls,['thread/unsubscribe']);assert.equal(e.loaded.has('thread'),true);assert.equal(e.threadLimits.get('thread'),'old-limits');
});
test('bound request cannot start on a replacement RPC after extension await even when account stays current',async()=>{
 const f=fixture(),wait=deferred();f.engine.extensions.prepareTurn=async()=>{f.calls.push('extensions');await wait.promise;};
 const p=f.run();await until(()=>f.calls.includes('extensions'));
 let replacementCalls=0;f.engine.rpc={connected:true,call:async()=>{replacementCalls++;return{turn:{id:'wrong-rpc'}};}};
 wait.resolve();await assert.rejects(p,/account|agent|connection/);assert.equal(replacementCalls,0);assert.equal(f.calls.includes('queue'),false);
});

test('branchFrom late successful RPC after retirement does not commit local source branch or metadata',async()=>{
 const wait=deferred();let current=true;const calls:string[]=[];
 const c:any={id:'c',threadId:'old-thread',turns:[{id:'t',prompt:'original',attachments:[],items:[],status:'completed',createdAt:1}]};
 const original=structuredClone(c);const e:any={rpc:{call:async(name:string)=>{calls.push(name);await wait.promise;return{thread:{id:'upstream-may-exist'}};}},loaded:new Set(),threadLimits:new Map()};
 const p=branchFrom.call(e,c,'t',true,{config:{}} as any,()=>current);await until(()=>calls.includes('thread/start'));current=false;wait.resolve();await assert.rejects(p,/account|agent/);
 assert.deepEqual(c,original);assert.equal(e.loaded.size,0);assert.equal(e.threadLimits.size,0);assert.deepEqual(calls,['thread/start']);
});
test('bound request captures RPC before request-options and sandbox awaits',async()=>{
 for(const stage of ['sync','sandbox']){
  const f=fixture(),wait=deferred();let entered=false,replacementCalls=0;
  const pause=async()=>{entered=true;await wait.promise;};
  if(stage==='sync')f.engine.syncRequestOptions=pause;else f.engine.windowsSandbox.ensureReady=pause;
  const p=f.run();await until(()=>entered);f.engine.rpc={connected:true,call:async()=>{replacementCalls++;return{turn:{id:'replacement'}};}};
  wait.resolve();await assert.rejects(p,/account|agent|connection/);assert.equal(replacementCalls,0);assert.equal(f.calls.includes('branch'),false);
 }
});
test('early send retirement releases only its own draft lock and never a replacement early turn',async()=>{
 for(const replacement of [false,true]){
  const f=fixture(),wait=deferred();f.engine.ensure=async()=>{f.calls.push('ensure');await wait.promise;};
  const p=send.call(f.engine,{conversationId:'c',text:'new prompt',attachments:[],mode:'chat',providerId:'p',model:'m'},undefined,false,{current:()=>!f.engine.intentionalStop});
  await until(()=>f.calls.includes('ensure'));assert.equal(f.engine.pendingSend,true);const newer={id:'new-owner'};if(replacement)f.engine.earlyTurn=newer;
  f.retire();wait.resolve();await assert.rejects(p,/account changed/);
  assert.equal(f.engine.pendingSend,replacement);assert.equal(f.engine.earlyTurn,replacement?newer:undefined);
 }
});
test('non-early edit never clears another early owner while waiting for ensure',async()=>{
 for(const retire of [false,true]){
  const f=fixture(),wait=deferred();f.engine.ensure=async()=>{f.calls.push('ensure');await wait.promise;};const p=f.run();await until(()=>f.calls.includes('ensure'));
  const newer={id:'other-early-owner'};f.engine.earlyTurn=newer;f.engine.pendingSend=true;if(retire)f.retire();wait.resolve();
  await assert.rejects(p,retire?/account changed/:/task is being created/);assert.equal(f.engine.earlyTurn,newer);assert.equal(f.engine.pendingSend,true);
 }
});

function codeFixture() {
  const f = fixture();
  f.c.mode = "code";
  f.engine.newTaskChecks = new Set();
  f.engine.gatewayEndpoint = () => true;
  f.engine.assertRemoteTrust = async () => {};

  f.engine.sessionAssistance = { unrelatedTask: async () => false };
  return f;
}
test('stop during preparation persists interruption and prevents turn start', async () => {
 const {interruptExpectedTurn}=await import('../../electron/conversations/interrupt-target');
 const f=codeFixture(), wait=deferred(); f.c.createdAt=1; f.engine.extensions.prepareTurn=async()=>{f.calls.push('extensions');await wait.promise;};
 const p=send.call(f.engine,{conversationId:'c',text:'new',attachments:[],mode:'code',providerId:'p',model:'m'});
 await until(()=>f.calls.includes('extensions')); const t=f.c.turns.at(-1); const ctx:any={store:f.engine.store,engine:f.engine,accountGeneration:()=>1};
 assert.deepEqual(await interruptExpectedTurn(ctx,'c',{kind:'starting',turnId:t.id,turnCreatedAt:t.createdAt,conversationCreatedAt:1}),{status:'accepted'});
 const cancelled=assert.rejects(p,CodeSendCancelled); wait.resolve(); await cancelled; assert.equal(t.status,'interrupted'); assert.equal(t.userStopped,true); assert.equal(f.calls.includes('turn/start'),false);
});
test('stop during delayed start waits for the real turn and coalesces duplicates', async () => {
 const {interruptExpectedTurn}=await import('../../electron/conversations/interrupt-target');
 const f=codeFixture(), wait=deferred(); f.c.createdAt=1; let stops=0;
 f.engine.rpc.call=async(name:string,params:any)=>{f.calls.push(name);if(name==='turn/interrupt'){stops++;assert.equal(params.turnId,'real');return {}; } await wait.promise;return {turn:{id:'real'}};};
 const p=send.call(f.engine,{conversationId:'c',text:'new',attachments:[],mode:'code',providerId:'p',model:'m'});
 await until(()=>f.calls.includes('turn/start')); const t=f.c.turns.at(-1), ctx:any={store:f.engine.store,engine:f.engine,accountGeneration:()=>1};
 const target={kind:'starting',turnId:t.id,turnCreatedAt:t.createdAt,conversationCreatedAt:1};
 const a=interruptExpectedTurn(ctx,'c',target), b=interruptExpectedTurn(ctx,'c',target); assert.equal(stops,0);
 wait.resolve(); await p; assert.deepEqual(await a,{status:'accepted'}); assert.deepEqual(await b,{status:'accepted'}); assert.equal(stops,1);
});

test('stop before engine preparation prevents extension and turn dispatch', async () => {
 const {interruptExpectedTurn}=await import('../../electron/conversations/interrupt-target');
 const f=codeFixture(), wait=deferred(); f.c.createdAt=1; f.engine.ensure=async()=>{f.calls.push('ensure');await wait.promise;};
 const p=send.call(f.engine,{conversationId:'c',text:'new',attachments:[],mode:'code',providerId:'p',model:'m'});
 await until(()=>f.calls.includes('ensure')); const t=f.c.turns.at(-1), ctx:any={store:f.engine.store,engine:f.engine,accountGeneration:()=>1};
 await interruptExpectedTurn(ctx,'c',{kind:'starting',turnId:t.id,turnCreatedAt:t.createdAt,conversationCreatedAt:1});
 const cancelled=assert.rejects(p,CodeSendCancelled); wait.resolve(); await cancelled; assert.equal(t.status,'interrupted'); assert.equal(f.calls.includes('extensions'),false); assert.equal(f.calls.includes('turn/start'),false);
});
test('a delayed provisional target stops its promoted turn after acknowledgement', async () => {
 const {interruptExpectedTurn}=await import('../../electron/conversations/interrupt-target');
 const f=codeFixture(), wait=deferred(); f.c.createdAt=1; f.c.threadId=undefined; let stops=0;
 f.engine.ensure=async()=>{f.calls.push('ensure');await wait.promise;};
 f.engine.ensureThread=async()=>{f.c.threadId='thread';};
 f.engine.rpc.call=async(name:string,params:any)=>{f.calls.push(name);if(name==='turn/interrupt'){stops++;assert.equal(params.turnId,'owned-turn');return {}; } return {turn:{id:'owned-turn'}};};
 const p=send.call(f.engine,{conversationId:'c',text:'new',attachments:[],mode:'code',providerId:'p',model:'m'});
 await until(()=>f.calls.includes('ensure')); const t=f.c.turns.at(-1), target={kind:'starting',turnId:t.id,turnCreatedAt:t.createdAt,conversationCreatedAt:1};
 wait.resolve(); await p; const ctx:any={store:f.engine.store,engine:f.engine,accountGeneration:()=>1};
 assert.deepEqual(await interruptExpectedTurn(ctx,'c',target),{status:'accepted'}); assert.equal(stops,1);
});

test('a delayed startup stop cannot interrupt or mark a replacement turn', async () => {
 const {interruptExpectedTurn}=await import('../../electron/conversations/interrupt-target');
 const f=codeFixture(), wait=deferred(); f.c.createdAt=1; let stops=0;
 f.engine.rpc.call=async(name:string)=>{f.calls.push(name);if(name==='turn/interrupt'){stops++;return {}; } await wait.promise;return {turn:{id:'real'}};};
 const p=send.call(f.engine,{conversationId:'c',text:'new',attachments:[],mode:'code',providerId:'p',model:'m'});
 await until(()=>f.calls.includes('turn/start')); const t=f.c.turns.at(-1), ctx:any={store:f.engine.store,engine:f.engine,accountGeneration:()=>1};
 const stop=interruptExpectedTurn(ctx,'c',{kind:'starting',turnId:t.id,turnCreatedAt:t.createdAt,conversationCreatedAt:1});
 const replacement={id:'new',status:'inProgress',createdAt:9,items:[]}; f.c.turns.push(replacement); wait.resolve();
 await assert.rejects(p,/session changed/i); assert.deepEqual(await stop,{status:'mismatch'}); assert.equal(stops,0); assert.equal(replacement.status,'inProgress');
});

for (const stopBeforeEvent of [true, false]) test(`startup stop dispatches on turn started ${stopBeforeEvent ? 'after' : 'before'} stop and never repeats on acknowledgement`, async () => {
 const {interruptExpectedTurn}=await import('../../electron/conversations/interrupt-target');
 const {applyTurnEvent}=await import('../../electron/engine/engine-events');
 const f=codeFixture(), wait=deferred(); f.c.createdAt=1; let stops=0;
 f.engine.rpc.call=async(name:string,params:any)=>{f.calls.push(name);if(name==='turn/interrupt'){stops++;assert.equal(params.turnId,'real');return {}; } await wait.promise;return {turn:{id:'real'}};};
 const sending=send.call(f.engine,{conversationId:'c',text:'new',attachments:[],mode:'code',providerId:'p',model:'m'});
 await until(()=>f.calls.includes('turn/start')); const t=f.c.turns.at(-1), ctx:any={store:f.engine.store,engine:f.engine,accountGeneration:()=>1};
 const target={kind:'starting',turnId:t.id,turnCreatedAt:t.createdAt,conversationCreatedAt:1};
 const stop=()=>interruptExpectedTurn(ctx,'c',target); let pending:Promise<any>;
 if(stopBeforeEvent) pending=stop();
 applyTurnEvent.call(f.engine,f.c,t,'turn/started',{turn:{id:'real'}});
 if(!stopBeforeEvent) pending=stop();
 await until(()=>stops===1); assert.deepEqual(await pending!,{status:'accepted'}); wait.resolve(); await sending; assert.equal(stops,1);
});
