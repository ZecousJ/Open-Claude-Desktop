/** Real exported lifecycle with inert direct dependencies: no Engine, process, SDK, sockets or profile files. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {EventEmitter} from 'node:events';import {registerHooks} from 'node:module';
const source=fs.readFileSync(new URL('../electron/engine/engine-lifecycle.ts',import.meta.url),'utf8');
const mocks:Record<string,Record<string,any>>={};
for(const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)){const[,names,spec]=m;mocks[spec]=Object.fromEntries(names.split(',').map(n=>n.trim()).filter(n=>n&&!n.startsWith('type ')).map(n=>[n,()=>{}]));}
let nextGatewayWait:Promise<void>|undefined,nextLaunchWait:Promise<void>|undefined,nextRpcWait:Promise<void>|undefined;
let fileWrites=0;const inertFs={writeFileSync(){fileWrites++;}};(globalThis as any).__startupInertFs=inertFs;
const gateways:Gateway[]=[],rpcs:Rpc[]=[];
class Gateway{url='http://fixture.invalid';token='inert';closed=0;wait=nextGatewayWait;constructor(...publicArgs:any[]){this.args=publicArgs;gateways.push(this);}args:any[]=[];async start(){await this.wait;}async close(){this.closed++;}}
class Rpc extends EventEmitter{stopped=0;started=0;wait=nextRpcWait;constructor(){super();rpcs.push(this);}async startWith(){this.started++;await this.wait;return{userAgent:'inert'};}async start(){return this.startWith();}async call(){return{data:[]};}async stop(){this.stopped++;}}
Object.assign(mocks['./provider-service-client'],{ProviderServiceClient:Gateway});Object.assign(mocks['./rpc'],{CodexRPC:Rpc});Object.assign(mocks['../app/start-timing'],{StepClock:class{steps:string[]=[];mark(){}}});Object.assign(mocks['../../shared/provider-routes'],{allResponses:()=>true});Object.assign(mocks['../workspace/workspace-trust'],{readCodexProjects:()=>({})});Object.assign(mocks['../skills/api-image'],{writeImageProviderFiles:()=>({}),builtinImagegenSkill:()=>'/inert/skill'});
(globalThis as any).__startupLeaseMocks=mocks;registerHooks({resolve(spec,c,next){if(c.parentURL?.endsWith('/electron/engine/engine-lifecycle.ts')&&spec==='node:fs')return{shortCircuit:true,url:'data:text/javascript,export default globalThis.__startupInertFs'};if(c.parentURL?.endsWith('/electron/engine/engine-lifecycle.ts')&&mocks[spec])return{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`const m=globalThis.__startupLeaseMocks[${JSON.stringify(spec)}];`+Object.keys(mocks[spec]).map(n=>`export const ${n}=m.${n};`).join(''))};return next(spec,c);}});
Object.assign(mocks['./codex-model-catalog'],{codexCatalogEfforts:()=>[]});
const{ensure,start,stop}=await import('../electron/engine/engine-lifecycle');
function deferred(){let resolve!:()=>void;return{promise:new Promise<void>(r=>resolve=r),resolve:()=>resolve()};}
async function until(check:()=>boolean){for(let i=0;i<30&&!check();i++)await new Promise(r=>setImmediate(r));assert.equal(check(),true);}
const provider:any={id:'p',model:'fixture',models:[]};
function fixture(){nextGatewayWait=nextLaunchWait=nextRpcWait=undefined;const statuses:any[]=[];let current=true;
 const launcher:any={disposed:0,launched:0,started(){},failed(){},async dispose(){this.disposed++;},async launch(){this.launched++;await nextLaunchWait;return{spawn(){throw Error('never spawn');},preamble:''};}};
 const e:any={store:{root:'/never-read',settings:{providers:[provider]},conversations:[]},spaceRoot:'/never-read',serviceScript:'never-run',vaultRoot:'/never-read',limits:{},options:{},windowsSandbox:{check:async()=>true,setup:async()=>{}},sandboxSetupFolder:()=>'/never-read',state:{state:'stopped'},loaded:new Set(),threadLimits:new Map(),steers:new Map(),routes:new Map(),sides:{dropAll(){}},agentRoutes:new Map(),pendingAgentPrompts:new Map(),pendingPatches:new Map(),clearApprovals(){},notificationTimer:new Map(),environment:{kind:'local'},launcher,mcpStartup:new Map(),extensions:{prepareAppServer:async()=>{},appServerConfig:()=>({}),processEnv:()=>({})},signals:{clearImageRequests(){}},stop:async()=>{},secret:()=>'',requestOptions:()=>({}),groupKeys:()=>[],runtimeKey:()=>'',mcpConfig:()=>'{}',egress:()=>({kind:'none'}),status:(value:any)=>{statuses.push(value);e.state=value;},notification(){},request(){},assertMcpAvailable(){},ownBusy:()=>false};e.start=start.bind(e);e.ensure=ensure.bind(e);
 e.startedModelEfforts=[];
 e.threadOrganizationPlugins=new Map();
 e.workflowThreads=new Map();
 return{e,launcher,statuses,current:()=>current,retire:()=>{current=false;}};
}
test('ensure waiting for previous startup checks caller retirement before any new startup',async()=>{const f=fixture(),d=deferred();f.e.starting=d.promise;let calls=0;f.e.start=async()=>{calls++;};const p=ensure.call(f.e,provider,{current:f.current});f.retire();d.resolve();await assert.rejects(p,/account|startup/);assert.equal(calls,0);});
test('start retired during initial stop never constructs a provider gateway or RPC',async()=>{const f=fixture(),d=deferred();f.e.stop=()=>d.promise;const before=gateways.length,p=start.call(f.e,provider,f.current);f.retire();d.resolve();await assert.rejects(p,/account|startup/);assert.equal(gateways.length,before);});
test('gateway await retirement closes only captured gateway, not replacement fields',async()=>{const f=fixture(),d=deferred();nextGatewayWait=d.promise;const before=gateways.length,p=start.call(f.e,provider,f.current);await until(()=>gateways.length>before);const own=gateways.at(-1)!;let closed=0;const replacement={close(){closed++;}};f.e.gateway=replacement;f.retire();d.resolve();await assert.rejects(p,/account|startup/);assert.equal(own.closed,1);assert.equal(closed,0);assert.equal(f.e.gateway,replacement);assert.equal(f.launcher.launched,0);});
test('retired launcher result never starts its RPC and cleanup cannot stop replacement RPC',async()=>{const f=fixture(),d=deferred();nextLaunchWait=d.promise;const p=start.call(f.e,provider,f.current);await until(()=>f.launcher.launched===1);const own=rpcs.at(-1)!;let stopped=0;const replacement={stop(){stopped++;}};f.e.rpc=replacement;f.retire();d.resolve();await assert.rejects(p,/account|startup/);assert.equal(own.started,0);assert.equal(own.stopped,1);assert.equal(stopped,0);assert.equal(f.e.rpc,replacement);});
test('valid bound waiter can start after another bound startup retires without being poisoned',async()=>{const f=fixture(),d=deferred();let a=true,stops=0;f.e.stop=async()=>{if(++stops===1)await d.promise;};const first=ensure.call(f.e,provider,{current:()=>a});const firstRejected=assert.rejects(first,/account|startup/);const second=ensure.call(f.e,provider,{current:()=>true});a=false;d.resolve();await firstRejected;await second;assert.equal(f.e.state.state,'ready');assert.equal(stops,2);assert.equal(f.e.starting,undefined);});
test('unbound legacy startup still completes with its original successful lifecycle',async()=>{const f=fixture();await ensure.call(f.e,provider);assert.equal(f.e.state.state,'ready');assert.equal(f.launcher.launched,1);assert.equal(f.e.starting,undefined);});
test('guarded stop does not clear or close replacement resources after its captured RPC wait',async()=>{const f=fixture(),d=deferred();let closes=0;const oldRpc={stop:()=>d.promise},newRpc={};f.e.rpc=oldRpc;f.e.gateway={close(){closes++;}};Object.assign(f.e,{capabilityTips:{stop(){}},titleOffers:{stop(){}},sessionAssistance:{stop(){}},safeguardModels:new Map(),windowsSandbox:{reset(){}}});const p=stop.call(f.e,f.current);f.e.rpc=newRpc;f.retire();d.resolve();await assert.rejects(p,/account|startup/);assert.equal(f.e.rpc,newRpc);assert.equal(closes,0);});

test('late captured gateway and RPC callbacks cannot publish into replacement startup',async()=>{
 const f=fixture();let delivered=0;f.e.captureAgentPrompt=f.e.onRefusal=f.e.notification=f.e.request=()=>{delivered++;};f.e.signals={toolStart:()=>{delivered++;}};
 await start.call(f.e,provider,f.current);const gateway=gateways.at(-1)!,rpc=rpcs.at(-1)!;
 gateway.args[7]({});gateway.args[8]({});gateway.args[9].onToolStart({});rpc.emit('notification',{});rpc.emit('request',{});assert.equal(delivered,5);
 await start.call(f.e,provider,()=>true);
 gateway.args[7]({});gateway.args[8]({});gateway.args[9].onToolStart({});rpc.emit('notification',{});rpc.emit('request',{});assert.equal(delivered,5);
});
test('published runtime accepts child events after the launching operation ends', async () => {
 const f=fixture();let delivered=0;
 f.e.captureAgentPrompt=f.e.onRefusal=f.e.notification=f.e.request=()=>{delivered++;};
 f.e.signals={toolStart:()=>{delivered++;}};
 await start.call(f.e,provider,f.current);
 const gateway=gateways.at(-1)!,rpc=rpcs.at(-1)!;
 const emit=()=>{gateway.args[7]({});gateway.args[8]({});gateway.args[9].onToolStart({});rpc.emit('notification',{});rpc.emit('request',{});};
 f.retire();
 emit();
 assert.equal(delivered,5);
 f.e.store={...f.e.store};
 emit();
 assert.equal(delivered,5);
});
test('throwing retired startup predicate is classified as retirement, not an arbitrary shared waiter failure',async()=>{
 const f=fixture(),d=deferred();let broken=false;f.e.stop=async()=>{await d.promise;};
 const a=ensure.call(f.e,provider,{current:()=>{if(broken)throw Error('private guard fault');return true;}});const rejected=assert.rejects(a,/account or engine startup changed/);
 const b=ensure.call(f.e,provider,{current:()=>true});broken=true;d.resolve();await rejected;await b;assert.equal(f.e.state.state,'ready');
});

test('local RPC startup and sandbox awaits recheck retirement before configuration and readiness',async()=>{
 for(const phase of ['rpc','sandbox']){
  const f=fixture(),d=deferred();f.e.launcher=undefined;let sandbox=0,skills=0;
  if(phase==='rpc')nextRpcWait=d.promise;
  f.e.windowsSandbox.check=async()=>{sandbox++;if(phase==='sandbox')await d.promise;return true;};
  const original=Rpc.prototype.call;Rpc.prototype.call=async()=>{skills++;return{data:[]};};
  try{const count=rpcs.length,p=start.call(f.e,provider,f.current);await until(()=>rpcs.length>count&&(phase==='rpc'?rpcs.at(-1)!.started===1:sandbox===1));f.retire();d.resolve();await assert.rejects(p,/account|startup/);assert.equal(skills,0);assert.equal(f.e.state.state,'starting');assert.equal(rpcs.at(-1)!.stopped,1);}
  finally{Rpc.prototype.call=original;}
 }
});
test('startup cleanup deadline preserves retirement error and leaves replacement resources untouched',async(t)=>{
 const f=fixture(),d=deferred(),hung=deferred();nextGatewayWait=d.promise;const count=gateways.length,p=start.call(f.e,provider,f.current);await until(()=>gateways.length>count);
 const own=gateways.at(-1)!;own.close=async()=>{own.closed++;await hung.promise;};const replacement={};f.e.gateway=replacement;f.retire();const log=t.mock.method(console,'error',()=>{});t.mock.timers.enable({apis:['setTimeout']});const rejected=assert.rejects(p,/account|startup/);d.resolve();await new Promise(r=>setImmediate(r));t.mock.timers.tick(5000);await rejected;
 assert.equal(f.e.gateway,replacement);assert.deepEqual(log.mock.calls.map(c=>c.arguments),[['Retired engine startup cleanup was not confirmed.']]);hung.resolve();await new Promise(r=>setImmediate(r));assert.equal(f.e.gateway,replacement);
});

test('late raw initial-stop rejection is retirement and does not poison a valid shared waiter',async()=>{
 const f=fixture();let reject!:(error:Error)=>void;const wait=new Promise<void>((_,no)=>{reject=no;});let first=true,a=true;
 f.e.stop=async()=>{if(first){first=false;await wait;}};
 const p=ensure.call(f.e,provider,{current:()=>a});const rejection=assert.rejects(p,/account or engine startup changed/);const q=ensure.call(f.e,provider,{current:()=>true});a=false;reject(Error('private old stop failure'));await rejection;await q;assert.equal(f.e.state.state,'ready');
});
test('same-account guarded stop cannot clear new runtime maps after RPC identity replacement',async()=>{
 const f=fixture(),d=deferred();let gatewayCloses=0;const newRpc={};Object.assign(f.e,{rpc:{stop:()=>d.promise},gateway:{close(){gatewayCloses++;}},capabilityTips:{stop(){}},titleOffers:{stop(){}},sessionAssistance:{stop(){}},safeguardModels:new Map(),windowsSandbox:{reset(){}}});
 const p=stop.call(f.e,()=>true);f.e.rpc=newRpc;d.resolve();await assert.rejects(p,/account|startup/);assert.equal(f.e.rpc,newRpc);assert.equal(gatewayCloses,0);
});
test('default stop late launcher disposal cannot clear replacement startup maps',async()=>{
 const f=fixture(),d=deferred();let disposed=false;Object.assign(f.e,{rpc:undefined,gateway:undefined,capabilityTips:{stop(){}},titleOffers:{stop(){}},sessionAssistance:{stop(){}},safeguardModels:new Map(),windowsSandbox:{reset(){}},loaded:new Set(['old']),threadLimits:new Map(),steers:new Map(),routes:new Map(),sides:{dropAll(){}},agentRoutes:new Map(),pendingAgentPrompts:new Map(),pendingPatches:new Map(),clearApprovals(){},notificationTimer:new Map(),environment:{kind:'local'}});
 f.launcher.dispose=async()=>{disposed=true;await d.promise;};const p=stop.call(f.e);await until(()=>disposed);
 f.e.rpc={newOwner:true};f.e.loaded.add('new-owner');d.resolve();await assert.rejects(p,/account|startup/);assert.equal(f.e.loaded.has('new-owner'),true);assert.equal(f.e.rpc.newOwner,true);
});
test('unchanged default stop still closes captured resources and clears its own state',async()=>{
 const f=fixture();let stopped=0,closed=0;Object.assign(f.e,{rpc:{async stop(){stopped++;}},gateway:{async close(){closed++;}},capabilityTips:{stop(){}},titleOffers:{stop(){}},sessionAssistance:{stop(){}},safeguardModels:new Map(),windowsSandbox:{reset(){}}});f.e.loaded.add('own');
 await stop.call(f.e);assert.equal(stopped,1);assert.equal(closed,1);assert.equal(f.launcher.disposed,1);assert.equal(f.e.loaded.size,0);assert.equal(f.e.rpc,undefined);assert.equal(f.e.gateway,undefined);assert.equal(f.e.state.state,'stopped');
});
