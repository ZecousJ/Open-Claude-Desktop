import { beforeF014Stop } from "./support/f014-resource-chain.mjs";
/** Local real Store + registered interrupt handler, exact original Stop functions and PB bytes.
 * Only the terminal RPC is inert. No provider, model, account, UI or network operation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import ts from 'typescript';
import {fromBinary,toBinary} from '@bufbuild/protobuf';
import {createActionRpc,PERFORM_ACTION_PATH} from '../electron/official-ui/api/actions';
import {loadRegistry,deepCreate,conversationUpdate} from '../electron/official-ui/api/timeline';
import {newAdapterScope,inAdapterScope} from '../electron/official-ui/api/scope';
import {Store} from '../electron/store/store';
import {registerConversationTurnHandlers} from '../electron/ipc/conversation-turn-handlers';
import {interrupt} from '../electron/engine/engine-handoff';
const assets=process.env.F014_ASSETS_ROOT??path.resolve('build/official-ui');
const registry=loadRegistry(path.join(assets,'data/conversation-protocol.json'));
const input=registry.getMessage('anthropic.bard.api.v1alpha.PerformActionRequest')!;
const output=registry.getMessage('anthropic.bard.api.v1alpha.PerformActionResponse')!;
const mark={sessionId:'f014-self',version:1n};
function original(t:any){
 const file=path.join(assets,'ui/assets/v1/30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js');
 if(!fs.existsSync(file)){t.skip('Pinned original Stop consumer resource required');return;}
 let source=fs.readFileSync(file,'utf8');
 source=beforeF014Stop('30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js',source);
 assert.equal(createHash('sha256').update(source).digest('hex'),'87194090ced9e671d94d8b6dece3bf02e344e23b4f970447ec172c0a6e3ed781');
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const functions=new Map<string,any>();let cls:any,plain:any,named:any,verdict:any;
 function walk(n:ts.Node){
  if(ts.isFunctionDeclaration(n)&&n.name)functions.set(n.name.text,n);
  if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='U$')cls=n.initializer;
  if(ts.isVariableDeclaration(n)&&['Xn','Zn'].includes(n.name.getText(ast))&&n.initializer?.getText(ast).includes('case: "stopGeneration"')){
   if(n.name.getText(ast)==='Xn')plain=(n.initializer as any).arguments[0];else named=(n.initializer as any).arguments[0];
  }
  if(ts.isExpressionStatement(n)&&n.getText(ast)==='o.version !== void 0 && TZ(R, o.version, "refused");')verdict=n;
  ts.forEachChild(n,walk);
 }
 walk(ast);assert.ok(cls&&plain&&named&&verdict);
 const method=(name:string)=>cls.members.find((n:any)=>ts.isMethodDeclaration(n)&&n.name.getText(ast)===name).getText(ast);
 const definitions=['bv','s1','_1','p1','m1','TZ','U9','EZ','wZ'].map(n=>functions.get(n).getText(ast)).join('\n');
 const env:any={Y:{USER:1,ASSISTANT:2},X:{RUNNING:2},J:{UNSPECIFIED:0,TOOL_USE:3,PAUSE_TURN:4},td:{NOTHING_RUNNING:2,TURN_CANCELED:1},Set,Map,e:{FOREIGN_SEEN_CAP:100},pv:new Set()};
 vm.createContext(env);vm.runInContext(definitions,env);
 const methods=['ownsSession','ownsMark','foreignSeenOnce','settleError','disposeFailures','isSuperseded','drainFailureNotices','keepOptimisticSendsLast','repointLeafAtWaitingSends','deepestWaitingSendRow','waitingTailSendIds','tailLinkSendIds','pendingStubOfServedLeafSend','isOptimisticSendRow','stopTurnTarget'].map(method);
 const gate:any={...vm.runInContext(`({${methods.join(',')}})`,env),session:{ownedSessionIds:new Set([mark.sessionId])},floorVersion:0n,latestVersion:1n,foreignSeen:new Set(),pendingFailures:[],failedVersions:new Map(),retryStubByVersion:new Map(),sentByVersion:new Map(),markedByVersion:new Map(),noticeQueue:[],queuedSendIds:[],leafComposedSendIds:new Set(),residualJoinedAt:new Map(),overlay:{messages:new Map(),displayGroups:new Map(),contentBlocks:new Map()},shadow:{messages:new Map(),hasRowFor:()=>false,heldSendFor:()=>undefined},ownSends:{assistantIdForSend:()=>undefined,mintedAssistantId:()=>false}};
 const verdicts:any[]=[],accepted:any[]=[];
 const R:any={gate:{current:gate},pendingStop:{current:undefined},pendingStopTurn:{current:undefined},pendingStopAckTold:{current:undefined},stopVersions:new Set(),stopVerdictCbs:new Set([(v:any)=>verdicts.push(v)]),stopAcceptedCbs:new Set([(v:any)=>accepted.push(v)]),cadence:{},state:{current:{}}};
 const captured:any[]=[];
 Object.assign(env,{R,Fn:()=>({conversationId:'source',existingOnly:true,mutationId:mark}),K:deepCreate,yf:input,D7:{stop:1},pW:()=>()=>{},mW:()=>{},W9:()=>{},Pn:(request:any,options:any)=>{captured.push(request);options.onDispatched(mark.version);return true;}});
 return {gate,R,verdicts,accepted,captured,
  async request(target?:string){
   if(target){const u={id:'new:user',role:1},a={id:target,role:2,parentMessageId:u.id,isComplete:false,index:2};gate.shadow.messages=new Map([[u.id,u],[a.id,a]]);gate.shadow.conversation={status:2,statusUserMessageId:u.id,statusAssistantMessageId:a.id,currentLeafMessageId:a.id};await vm.runInContext(`(${named.getText(ast)})`,env)(target,'stop');}
   else await vm.runInContext(`(${plain.getText(ast)})`,env)({intent:'stop'});
   return captured.at(-1);
  },
  receive(ack:any){if(ack.outcome.case==='applied'){env.EZ(R,[ack]);return [];}
   gate.settleError(ack.highWaterMark,ack.outcome.value);const pending=gate.pendingFailures;gate.pendingFailures=[];gate.disposeFailures(pending);const notices=gate.drainFailureNotices();
   for(const o of notices)vm.runInContext(verdict.getText(ast),Object.assign(env,{o}));return notices;
  }
 };
}
function fixture(t:any){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'f014-stop-'));const store=new Store(dir);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const turn=(id:string,status:string)=>({id,prompt:id,attachments:[],createdAt:id==='old'?2:3,status,items:[{id:id+'-text',type:'agentMessage',text:'Self-authored '+id,lifecycleStatus:status==='inProgress'?'inProgress':'completed'}]});
 const c:any={id:'source',mode:'chat',title:'F014 synthetic',cwd:dir,threadId:'self-thread',createdAt:1,updatedAt:3,turns:[turn('old','completed'),turn('new','inProgress')],savedBranches:[]};store.conversations.push(c);store.flush();
 const calls:any[]=[],rpcCalls:any[]=[],effects:any[]=[];let identity:any={},initial=identity,rpcBehavior:any=async()=>({}),loadBehavior:any;
 const engine:any={store,rpc:{call:async(method:string,params:any)=>{rpcCalls.push({method,params});return rpcBehavior(method,params);}},elsewhereFor:()=>undefined,changed:()=>store.flush(),gateway:{abortThread:(id:string)=>effects.push(['abort',id])}};engine.interrupt=interrupt.bind(engine);
 const context:any={store,engine,get accountActivationIdentity(){return identity;},accountGeneration:()=>identity,activeAccount:{id:'synthetic'},accountRetiring:false,selectedAttachments:new Map(),push(){},allowedFolder(){}};
 const handlers=new Map<string,Function>();registerConversationTurnHandlers({context,handle:(n:string,f:Function)=>handlers.set(n,f),cli:{},resumable:{}} as any);
 const ctx:any={account:()=>({id:'synthetic'}),sessionIdentity:()=>identity,isCurrent:()=>identity===initial,settings:()=>store.settings,modelCatalog:async()=>null,loadConversation:async()=>{const value=structuredClone(c);if(loadBehavior)await loadBehavior(value);return value;},call:async(n:string,...args:any[])=>{calls.push([n,...args]);return handlers.get(n)!(...args);},log(){}};
 const scope=newAdapterScope('synthetic');const route=createActionRpc(ctx,registry);
 const invoke=(request:any)=>inAdapterScope(scope,async()=>{conversationUpdate(c,false,{org:''});const req:any=Readable.from([toBinary(input,request)]);Object.assign(req,{method:'POST',headers:{'content-type':'application/proto'}});let bytes:Buffer|undefined;const res:any={writeHead(){},end(b:any){bytes=Buffer.from(b);}};await route(req,res,PERFORM_ACTION_PATH);return (fromBinary(output,bytes!) as any).ack;});
 return {store,c,ctx,context,engine,calls,rpcCalls,effects,invoke,activate:()=>identity={},load:(fn:any)=>loadBehavior=fn,rpc:(fn:any)=>rpcBehavior=fn,request:(target?:string)=>deepCreate(input,{header:{conversationId:'source',existingOnly:true,mutationId:mark},action:{case:'stopGeneration',value:target?{stoppingMessageId:target,intent:1}:{intent:1}}})};
}
test('original named Stop builder survives PB bytes and selects exact active turn through real registered CAS',async t=>{
 const o=original(t);if(!o)return;const f=fixture(t);const r=await o.request('new:assistant');assert.equal(r.action.value.stoppingMessageId,'new:assistant');const ack=await f.invoke(r);assert.equal(ack.outcome.case,'applied');assert.deepEqual(f.calls,[['interrupt','source',{turnId:'new',turnCreatedAt:3,conversationCreatedAt:1,threadId:'self-thread'}]]);assert.deepEqual(f.rpcCalls,[{method:'turn/interrupt',params:{threadId:'self-thread',turnId:'new'}}]);assert.equal(f.c.turns[1].status,'inProgress','RPC acceptance is not a terminal event');o.receive(ack);assert.deepEqual(o.accepted,['unclassified']);assert.equal(o.R.pendingStop.current,1n);
});
test('explicit old, saved, unknown or foreign targets never stop the newer current stream', async t => {
 const encoded = toBinary(output, deepCreate(output, { ack: { highWaterMark: mark } }));
 const expected = fromBinary(output, encoded) as { ack?: { highWaterMark?: unknown } };
 for (const id of ['old:assistant', 'unknown-message', 'foreign:assistant', 'saved:assistant']) {
  const f = fixture(t);
  f.c.savedBranches = [{ id: 'saved-branch', turns: [{ ...structuredClone(f.c.turns[0]), id: 'saved' }] }];
  const before = JSON.stringify(f.c);
  const ack = await f.invoke(f.request(id));
  assert.equal(ack.outcome.case, 'error', id);
  assert.equal(f.calls.length, 0, id);
  assert.equal(f.rpcCalls.length, 0, id);
  assert.equal(JSON.stringify(f.c), before);
  assert.equal(ack.outcome.value.action, 'stop_generation');
  assert.deepEqual(ack.highWaterMark, expected.ack?.highWaterMark);
 }
});
test('targetless original Stop remains legal on a legacy host without expected-turn generation',async t=>{
 const o=original(t);if(!o)return;const f=fixture(t);delete f.context.accountGeneration;const r=await o.request();assert.equal(r.action.value.stoppingMessageId,undefined);const ack=await f.invoke(r);assert.equal(ack.outcome.case,'applied');assert.deepEqual(f.calls,[['interrupt','source']]);assert.equal(f.rpcCalls.length,1);
 const empty=fixture(t);delete empty.context.accountGeneration;const explicitEmpty=empty.request();explicitEmpty.action.value.stoppingMessageId='';assert.equal((await empty.invoke(explicitEmpty)).outcome.case,'applied');assert.deepEqual(empty.calls,[['interrupt','source']]);
 const user=fixture(t);assert.equal((await user.invoke(user.request('new:user'))).outcome.case,'applied');assert.equal(user.calls[0][2].turnId,'new');assert.equal(user.rpcCalls.length,1);
});
test('explicit Stop rejects activation ABA, target replacement and missing CAS authority without legacy fallback',async t=>{
 for(const kind of ['activation','new-turn','no-generation','unconfirmed']){const f=fixture(t);if(kind==='activation')f.load(f.activate);if(kind==='new-turn')f.load(()=>f.c.turns.push({...structuredClone(f.c.turns[1]),id:'newer',createdAt:4}));if(kind==='no-generation')delete f.context.accountGeneration;if(kind==='unconfirmed')f.ctx.call=async()=>undefined;const ack=await f.invoke(f.request('new:assistant'));assert.equal(ack.outcome.case,'error',kind);assert.equal(f.rpcCalls.length,0,kind);assert.ok(f.calls.every(c=>c.length===3));}
 for(const [field,value] of [['turnCreatedAt',undefined],['turnCreatedAt',NaN],['turnCreatedAt',Infinity],['turnCreatedAt',-1],['conversationCreatedAt',undefined],['conversationCreatedAt','1'],['conversationCreatedAt',Number.MAX_SAFE_INTEGER+1]] as const){const f=fixture(t);f.load((snapshot:any)=>{if(field==='turnCreatedAt')snapshot.turns[1].createdAt=value;else snapshot.createdAt=value;});assert.equal((await f.invoke(f.request('new:assistant'))).outcome.case,'error');assert.equal(f.rpcCalls.length,0);}
});
test('real Stop rejection settles only its original pending version once, without replay or pretend terminal',async t=>{
 const o=original(t);if(!o)return;const f=fixture(t);f.rpc(async()=>{throw Error('Synthetic stop was not confirmed.');});const request=await o.request();const before=JSON.stringify(f.c);const ack=await f.invoke(request);assert.equal(ack.outcome.case,'error');assert.equal(ack.outcome.value.action,'stop_generation');assert.equal(ack.outcome.value.error.retryable,false);const notices=o.receive(ack);assert.equal(notices[0].foreign,false);assert.deepEqual(o.verdicts,['refused']);assert.equal(o.R.pendingStop.current,undefined);assert.equal(o.receive(ack).length,0);assert.deepEqual(o.verdicts,['refused']);assert.equal(f.rpcCalls.length,1);assert.equal(JSON.stringify(f.c),before);assert.deepEqual(f.effects,[['abort','self-thread']]);
 const foreign=original(t)!;await foreign.request();foreign.receive({...ack,highWaterMark:{...ack.highWaterMark,sessionId:'foreign'}});assert.deepEqual(foreign.verdicts,[]);assert.equal(foreign.R.pendingStop.current,1n);
});
test('explicit completed target is an acknowledged no-op and post-dispatch activation cannot claim acceptance',async t=>{
 const o=original(t);if(!o)return;const f=fixture(t);f.c.turns[1].status='completed';const ack=await f.invoke(await o.request('new:assistant'));assert.equal(ack.outcome.case,'applied');assert.equal(ack.stopGenerationEffect,2);assert.equal(f.rpcCalls.length,0);o.receive(ack);assert.deepEqual(o.verdicts,['nothing_running']);assert.equal(o.R.pendingStop.current,undefined);
 const g=fixture(t);g.rpc(async()=>{g.activate();return {};});const other=await g.invoke(g.request('new:assistant'));assert.equal(other.outcome.case,'error');assert.equal(g.rpcCalls.length,1);assert.equal(g.c.turns[1].status,'inProgress');
});
