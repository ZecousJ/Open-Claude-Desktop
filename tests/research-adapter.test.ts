import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import ts from 'typescript';
import {fromBinary,toBinary,clone,create} from '@bufbuild/protobuf';
import {researchTaskId,researchTask,researchStatus,researchBlock,supportedResearchMode} from '../electron/official-ui/api/research-projection';
import {researchStatusRoute} from '../electron/official-ui/api/research-status';
import {researchReportAttachment,researchReportFileRoute} from '../electron/official-ui/api/research-report-files';
import {ResearchReports} from '../electron/ipc/research';
import {conversationUpdate,deepCreate,loadRegistry} from '../electron/official-ui/api/timeline';
import {createActionRpc,PERFORM_ACTION_PATH} from '../electron/official-ui/api/actions';
import {organizationUuid} from '../electron/official-ui/api/context';
import {inAdapterScope,newAdapterScope} from '../electron/official-ui/api/scope';
const checkout=process.cwd();
const registry=loadRegistry(checkout+'/build/official-ui/data/conversation-protocol.json');
const owner='owner-a',org=organizationUuid(owner);
const markdown='# Résumé 中文\n\nA real stored report.\n';
const hash=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex');
function fixture(){
 const turn:any={id:'turn-real',createdAt:10000,status:'inProgress',prompt:'Research',attachments:[],items:[],research:{state:'gathering',title:'Stored research title',startedAt:10001,sourceCount:2}};
 const c:any={id:'conversation',createdAt:9000,updatedAt:10000,mode:'chat',model:'model',providerId:'provider',research:true,turns:[turn]};
 let account:any={id:owner},identity={}; const calls:any[]=[];
 const ctx:any={root:checkout+'/build/official-ui',account:()=>account,sessionIdentity:()=>identity,stateDirectory:()=>'/account/a',isCurrent:()=>true,loadConversation:async(id:string)=>id===c.id?c:undefined,call:async(...args:any[])=>{calls.push(args);return args[0]==='interrupt'?{status:'accepted'}:args[0]==='readResearchReport'?{title:turn.research.report.title,markdown}:structuredClone(c);},log(){},settings:()=>({providers:[{id:'provider',protocol:'responses'}]})};
 return {c,turn,ctx,calls,retire:()=>{account={id:'owner-b'};identity={};}};
}
function response(){return {status:0,headers:{} as any,body:undefined as any,writeHead(status:number,headers:any){this.status=status;this.headers=headers;},end(data:any){this.body=data;}};}
function req(method='GET'){return {method,headers:{}} as any;}
function scoped<T>(f:()=>T){return inAdapterScope(newAdapterScope(owner,undefined,{}),f);}
function report(f:ReturnType<typeof fixture>){f.turn.research.report={title:'Résumé 中文',path:'research/conversation/turn-real.md',bytes:Buffer.byteLength(markdown),sha256:hash(markdown)};f.turn.research.state='done';f.turn.research.completedAt=11000;}
async function fileRead(f:ReturnType<typeof fixture>,attachment:any,variant='contents',method='GET'){
 const p=`/api/organizations/${org}/files/${attachment.id}/${variant}`,res=response();
 await researchReportFileRoute(req(method),res as any,p,new URL('http://localhost'+p),f.ctx);return res;
}
function original(name:string){const p=checkout+'/.restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1/30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js';const ast=ts.createSourceFile(p,fs.readFileSync(p,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const found=ast.statements.filter((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.equal(found.length,1);return '('+found[0].getText(ast)+')';}
test('original producer roundtrips advanced2 and rejects unsupported light/unknown',()=>{
 const f=fixture();const convert=vm.runInNewContext(original('Sz'),{Wu:{ADVANCED:2},bz:[],mz:[],At:()=>false});
 const u=scoped(()=>conversationUpdate(f.c,false,{org}));assert.equal(u.conversation.settings.researchMode,2);assert.equal(convert(u.conversation.settings).compass_mode,'advanced');
 for(const value of [undefined,0,2])assert.equal(supportedResearchMode(value),true);for(const value of [1,3,-1,'2',null])assert.equal(supportedResearchMode(value),false);
});
test('real protocol research launch roundtrip feeds original served converter',()=>scoped(()=>{
 const f=fixture(),u=conversationUpdate(f.c,false,{org});const schema=registry.getMessage('anthropic.bard.api.v1alpha.ConversationUpdate')!;
 const actual:any=fromBinary(schema,toBinary(schema,deepCreate(schema,u)));const block=actual.contentBlocks.find((b:any)=>b.displayContent?.content.case==='research');
 assert.equal(block.state,2);assert.equal(block.isComplete,true);assert.equal(block.displayContent.content.value.status,3);assert.equal(block.displayContent.content.value.agents.length,0);
 const convert=vm.runInNewContext(original('jk'),{Ak:(n:number)=>({3:'searching'}[n]),sj:()=>new Date(10001).toISOString()});const served=convert(block.displayContent.content.value);
 assert.equal(served.status,'searching');assert.equal(served.headline,'Stored research title');assert.equal(served.total_sources,2);
}));
test('stable owner-bound IDs; no pending IDs or foreign task; conflicting branch clones fail closed',()=>{
 const f=fixture(),id=researchTaskId(org,f.c,f.turn)!;assert.equal(researchTaskId(org,structuredClone(f.c),structuredClone(f.turn)),id);assert.notEqual(researchTaskId(organizationUuid('b'),f.c,f.turn),id);
 assert.equal(researchTask(org,f.c,'foreign'),undefined);f.turn.id='pending-abc';assert.equal(researchTaskId(org,f.c,f.turn),undefined);f.turn.id='turn-real';
 f.c.savedBranches=[{turns:[structuredClone(f.turn)]}];assert.equal(researchTask(org,f.c,id),f.turn);delete f.turn.research;assert.equal(researchTask(org,f.c,id),undefined);
});
test('status route original endpoint reads real counts/title and rejects foreign org/task/account changes',async()=>scoped(async()=>{
 const f=fixture(),id=researchTaskId(org,f.c,f.turn)!,p=`/api/organizations/${org}/chat_conversations/${f.c.id}/task/${id}/status`;let res=response();await researchStatusRoute(req(),res as any,p,new URL('http://x'+p),f.ctx);assert.equal(res.status,200);const data=JSON.parse(res.body);assert.equal(data.agents[0].name,f.turn.research.title);assert.deepEqual(data.agents[0].annotated_snippets,[]);assert.equal(data.status,'searching');
 res=response();await researchStatusRoute(req(),res as any,p.replace(org,organizationUuid('b')),new URL('http://x'+p),f.ctx);assert.equal(res.status,404);
 f.ctx.loadConversation=async()=>{f.retire();return f.c;};res=response();await researchStatusRoute(req(),res as any,p,new URL('http://x'+p),f.ctx);assert.equal(res.status,409);
}));
test('original sources consumer receives only stored URLs and the stored plan',()=>{
 const f=fixture();f.turn.research.plan='Compare the evidence';f.turn.research.sourceCount=2;
 f.turn.items=[{type:'webSearch',sources:[{url:'https://example.com/a#section',title:'Evidence',snippet:'A finding'},{url:'javascript:alert(1)',title:'Unsafe'}]},{type:'agentMessage',citations:[{url:'https://example.com/a',title:'Duplicate'},{url:'https://other.example/b',title:'Citation'}],webCitations:['not a URL']}];
 const status=researchStatus(f.turn),snippet=status.agents[0].annotated_snippets[0];
 assert.equal(snippet.thinking_blocks[0].thinking,'Compare the evidence');
 const file=checkout+'/build/official-ui/ui/assets/v1/cf454cdcb-ftQjcteO.js',ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const declaration=ast.statements.find((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text==='Se');assert.ok(declaration);
 const collect=vm.runInNewContext('('+declaration.getText(ast)+')');const calls=collect(status,undefined);
 assert.equal(calls.length,1);assert.deepEqual(calls[0].output.content,[{url:'https://example.com/a',title:'Evidence',subtitles:['A finding']},{url:'https://other.example/b',title:'Citation'}]);
});
async function action(f:ReturnType<typeof fixture>,name:string,value:any,mutationId?:{sessionId:string;version:bigint}){const run=createActionRpc(f.ctx,registry),request:any=new EventEmitter();request.method='POST';request.headers={'content-type':'application/proto'};const res=response();const result=run(request,res as any,PERFORM_ACTION_PATH);const schema=registry.getMessage('anthropic.bard.api.v1alpha.PerformActionRequest')!;request.emit('data',Buffer.from(toBinary(schema,deepCreate(schema,{header:{conversationId:f.c.id,mutationId},action:{case:name,value}}))));request.emit('end');await result;return fromBinary(registry.getMessage('anthropic.bard.api.v1alpha.PerformActionResponse')!,res.body) as any;}
test('exact research Stop calls CAS; foreign/stale/nonresearch/branch-only tasks never interrupt',async()=>scoped(async()=>{
 const f=fixture(),id=researchTaskId(org,f.c,f.turn)!;const stop=await action(f,'stopResearchTask',{taskId:id});assert.equal(stop.ack.outcome.case,'applied',String(stop.ack.outcome.value?.error?.message));assert.deepEqual(f.calls[0],['interrupt',f.c.id,{turnId:'turn-real',turnCreatedAt:10000,conversationCreatedAt:9000}]);
 for(const mode of ['foreign','stale','branch-conflict']){const q=fixture(),task=researchTaskId(org,q.c,q.turn)!;if(mode==='stale')q.c.turns.push({...q.turn,id:'new',createdAt:12000,research:undefined});if(mode==='branch-conflict'){q.c.savedBranches=[{turns:[structuredClone(q.turn)]}];delete q.turn.research;}const out=await action(q,'stopResearchTask',{taskId:mode==='foreign'?'bad':task});assert.equal(out.ack.outcome.case,'error');assert.equal(q.calls.length,0);}
}));
test('bad research settings fail before any write',async()=>scoped(async()=>{const f=fixture();const out=await action(f,'updateConversationSettings',{settings:{researchMode:1,enabledWebSearch:true}});assert.equal(out.ack.outcome.case,'error');assert.equal(f.calls.length,0);}));
test('new report Unicode bytes digest + original attachment content and preview; deterministic reopen',async()=>scoped(async()=>{
 const f=fixture();report(f);const a=researchReportAttachment(org,f.c,f.turn)!;assert.equal(a.mediaType,'text/markdown');assert.equal('unavailable' in a ? a.unavailable : undefined,undefined);assert.equal(a.id,researchReportAttachment(org,structuredClone(f.c),structuredClone(f.turn))!.id);assert.equal(a.path.includes('research/'),false);
 const res=await fileRead(f,a);assert.equal(res.status,200);assert.equal(res.body.toString('utf8'),markdown);assert.equal(res.headers['Content-Length'],String(Buffer.byteLength(markdown)));
 const preview=await fileRead(f,a,'content_preview');assert.deepEqual(JSON.parse(preview.body),{content:markdown});const head=await fileRead(f,a,'contents','HEAD');assert.equal(head.status,200);assert.equal(head.body,undefined);
}));
test('legacy/malformed/missing digest report is explicitly unavailable without report read',()=>scoped(()=>{
 for(const digest of [undefined,'wrong','a'.repeat(64)]){const f=fixture();report(f);f.turn.research.report.sha256=digest;const a=researchReportAttachment(org,f.c,f.turn)!;assert.equal('unavailable' in a ? a.unavailable : undefined,digest==='a'.repeat(64)?undefined:true);assert.equal(f.calls.length,0);}
}));
test('missing/corrupt/same-size replacement and midread mutation/account switch fail closed',async()=>scoped(async()=>{
 for(const mode of ['missing','same-size','digest-mutation','account','metadata']){const f=fixture();report(f);const a=researchReportAttachment(org,f.c,f.turn)!;f.ctx.call=async()=>{if(mode==='missing')throw Error('missing');if(mode==='account')f.retire();if(mode==='metadata')f.turn.research.report.title='changed';if(mode==='digest-mutation')f.turn.research.report.sha256='b'.repeat(64);return {title:'Résumé 中文',markdown:mode==='same-size'?markdown.replace('real','fake'):markdown};};const res=await fileRead(f,a);assert.equal(res.status>=400,true,mode);assert.equal(String(res.body).includes('A real'),false);}
}));
test('native report writer records digest; read rejects intermediate/final symlinks and overlimit',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'f017-report-'));try{const reports=new ResearchReports(root),saved=reports.write('conversation','turn',markdown);assert.equal(saved.sha256,hash(markdown));assert.equal(reports.read(saved.path),markdown);
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'f017-outside-'));try{fs.writeFileSync(path.join(outside,'secret.md'),'PRIVATE');fs.symlinkSync(outside,path.join(root,'research','linked'));assert.throws(()=>reports.read('research/linked/secret.md'));fs.symlinkSync(path.join(outside,'secret.md'),path.join(root,'research','conversation','link.md'));assert.throws(()=>reports.read('research/conversation/link.md'));fs.writeFileSync(path.join(root,'research','conversation','big.md'),Buffer.alloc(400*1024+1));assert.throws(()=>reports.read('research/conversation/big.md'));}finally{fs.rmSync(outside,{recursive:true,force:true});}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('actual original wz combined Research/search producer uses one transaction even when persistence fails',async()=>scoped(async()=>{
 const produce=vm.runInNewContext(original('wz'),{K:(_:unknown,v:any)=>v??{},$l:{},Wu:{ADVANCED:2,UNSPECIFIED:0},bz:[['enabledWebSearch','enabled_web_search']],mz:[]});
 const f=fixture();delete f.c.research;delete f.c.webSearch;const settings=produce({compass_mode:'advanced',enabled_web_search:true});
 f.ctx.call=async(...args:any[])=>{f.calls.push(args);throw Error('durable save failed');};
 const out=await action(f,'updateConversationSettings',{settings});assert.equal(out.ack.outcome.case,'error');assert.deepEqual(f.calls,[['setConversationResearch',f.c.id,true,{webSearch:true}]]);assert.equal(f.c.webSearch,undefined);assert.equal(f.c.research,undefined);
}));
test('Research-off with explicit search is also one transaction',async()=>scoped(async()=>{const f=fixture();const out=await action(f,'updateConversationSettings',{settings:{researchMode:0,enabledWebSearch:false}});assert.equal(out.ack.outcome.case,'applied');assert.deepEqual(f.calls,[['setConversationResearch',f.c.id,false,{webSearch:false}]]);}));
async function restStop(f:ReturnType<typeof fixture>,task:string,body='{}') {const p=`/api/organizations/${org}/chat_conversations/${f.c.id}/task/${task}/stop`,request:any=new EventEmitter();request.method='POST';request.headers={'content-type':'application/json'};const res=response();const run=researchStatusRoute(request,res as any,p,new URL('http://x'+p),f.ctx);request.emit('data',Buffer.from(body));request.emit('end');await run;return res;}
test('original REST Stop accepts empty JSON and shares exact task CAS',async()=>scoped(async()=>{const f=fixture(),id=researchTaskId(org,f.c,f.turn)!;const res=await restStop(f,id);assert.equal(res.status,200);assert.deepEqual(JSON.parse(res.body),{status:'accepted'});assert.equal(f.calls[0][2].turnId,f.turn.id);}));
test('REST Stop rejects extra/oversized bodies, finished/stale tasks, and absent activation',async()=>scoped(async()=>{
 for(const mode of ['extra','large','completed','stale','activation']){const f=fixture(),id=researchTaskId(org,f.c,f.turn)!;if(mode==='completed'){f.turn.status='completed';f.turn.research.state='done';}if(mode==='stale')f.c.turns.push({...f.turn,id:'new',createdAt:12000,research:undefined});if(mode==='activation')f.ctx.sessionIdentity=()=>undefined;const res=await restStop(f,id,mode==='extra'?'{"latest":true}':mode==='large'?' '.repeat(129):'{}');assert.equal(res.status>=400,true,mode);assert.equal(f.calls.length,0,mode);}
}));
test('Stop race: new current turn after load invokes no interrupt; unknown CAS and retired await never claim success',async()=>scoped(async()=>{
 for(const mode of ['new','unknown','retired']){const f=fixture(),id=researchTaskId(org,f.c,f.turn)!;if(mode==='new')f.ctx.loadConversation=async()=>{f.c.turns.push({...f.turn,id:'new',createdAt:12000,research:undefined});return f.c;};else f.ctx.call=async(...args:any[])=>{f.calls.push(args);if(mode==='retired')f.retire();return mode==='unknown'?{status:'mismatch'}:{status:'accepted'};};const res=await restStop(f,id);assert.equal(res.status,409);assert.equal(f.calls.length,mode==='new'?0:1);}
}));
test('new read routes require activation and reject report metadata disappearing after advertisement',async()=>scoped(async()=>{
 const f=fixture();report(f);const a=researchReportAttachment(org,f.c,f.turn)!;delete f.turn.research.report.sha256;assert.equal((await fileRead(f,a)).status,409);const q=fixture();report(q);const b=researchReportAttachment(org,q.c,q.turn)!;q.ctx.sessionIdentity=()=>undefined;assert.equal((await fileRead(q,b)).status,409);assert.equal(q.calls.length,0);
}));
test('task lookup bounded before scans and report terminal research state preserved even when summary fails',()=>{
 const f=fixture(),id=researchTaskId(org,f.c,f.turn)!;f.c.savedBranches=Array.from({length:200},()=>({turns:[]}));assert.equal(researchTask(org,f.c,id),undefined);delete f.c.savedBranches;report(f);f.turn.status='failed';assert.equal(researchStatus(f.turn).status,'completed');
});

// Execute unchanged methods from the original hub's optimistic-settings consumer.
// The small state fixture supplies no replacement settling or rollback logic.
function originalSettingsConsumer(version=1n,session='session-a') {
 const filename=checkout+'/.restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1/30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js';
 const ast=ts.createSourceFile(filename,fs.readFileSync(filename,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const names=['ownsSession','ownsMark','foreignSeenOnce','isSuperseded','settleError','processPendingFailures','disposeFailures','advanceAck','drainFailureNotices','composeConversation'];
 const members:string[]=[];
 for(const name of names){const matches:ts.MethodDeclaration[]=[];const walk=(n:ts.Node)=>{if(ts.isMethodDeclaration(n)&&n.name.getText(ast)===name)matches.push(n);ts.forEachChild(n,walk);};walk(ast);assert.equal(matches.length,1,name);members.push(matches[0].getText(ast));}
 const variables:ts.VariableDeclaration[]=[];const visit=(n:ts.Node)=>{if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='jle')variables.push(n);ts.forEachChild(n,visit);};visit(ast);assert.equal(variables.length,1);
 const context=vm.createContext({K:create,Kf:clone,fu:registry.getMessage('anthropic.bard.api.v1alpha.Conversation'),$l:registry.getMessage('anthropic.bard.api.v1alpha.ConversationSettings'),bz:[['enabledWebSearch','enabled_web_search']],Tz:[],mz:[],Wu:{UNSPECIFIED:0,ADVANCED:2},pv:new Set(),e:{FOREIGN_SEEN_CAP:512}});
 for(const name of ['Az','jz','Q$'])vm.runInContext(`globalThis[${JSON.stringify(name)}]=${original(name)}`,context);
 const consumer=vm.runInContext('({'+members.join(',')+'})',context);
 const overlay=vm.runInContext('Q$()',context);
 overlay.pendingSettingsVersion=version;overlay.pendingSettingsDelta={researchMode:2,enabledWebSearch:true};
 Object.assign(consumer,{overlay,session:{ownedSessionIds:new Set([session])},floorVersion:0n,latestVersion:version,ackedVersion:0n,explicitAppliedThrough:0n,packedResolvedThrough:0n,dropAtOwnVerdict:false,outcomeAcks:true,
  shadow:{authoritativeReady:true,conversation:deepCreate(registry.getMessage('anthropic.bard.api.v1alpha.Conversation')!,{id:'conversation',settings:{enabledWebSearch:false}})},
  retryStubByVersion:new Map(),failedVersions:new Map(),sentByVersion:new Map(),markedByVersion:new Map(),rowsByVersion:new Map(),acceptedVersions:new Set(),responseCovered:new Set(),foreignSeen:new Set(),pendingFailures:[],noticeQueue:[]});
 const acceptsNotice=vm.runInContext('('+variables[0].initializer!.getText(ast)+')',context) as Set<string>;
 return {consumer,acceptsNotice};
}
async function refusedSettings(mark={sessionId:'session-a',version:1n}){
 const f=fixture();delete f.c.research;delete f.c.webSearch;f.ctx.call=async()=>{throw Error('Local preference save failed.');};
 return action(f,'updateConversationSettings',{settings:{researchMode:2,enabledWebSearch:true}},mark);
}
test('settings save refusal preserves issued mutation and original snake-case notice contract',async()=>scoped(async()=>{
 const out=await refusedSettings();assert.equal(out.ack.highWaterMark.sessionId,'session-a');assert.equal(out.ack.highWaterMark.version,1n);assert.equal(out.ack.outcome.case,'error');
 assert.equal(out.ack.outcome.value.action,'update_conversation_settings');assert.equal(out.ack.outcome.value.error.displayMessage,'Local preference save failed.');assert.equal(out.ack.outcome.value.error.retryable,false);
 assert.equal(originalSettingsConsumer().acceptsNotice.has(out.ack.outcome.value.action),true);
}));
test('unchanged original reducer removes both optimistic settings for matching refusal in either snapshot order',async()=>scoped(async()=>{
 const out=await refusedSettings();
 for(const order of ['snapshot-before','snapshot-after']){
  const {consumer}=originalSettingsConsumer();assert.equal(consumer.composeConversation().settings.researchMode,2);assert.equal(consumer.composeConversation().settings.enabledWebSearch,true);
  const authoritative=()=>{consumer.shadow.conversation=deepCreate(registry.getMessage('anthropic.bard.api.v1alpha.Conversation')!,{id:'conversation',settings:{enabledWebSearch:false}});};
  if(order==='snapshot-before')authoritative();consumer.advanceAck(out.ack,true);assert.equal(consumer.processPendingFailures(),true);if(order==='snapshot-after')authoritative();
  assert.equal(consumer.overlay.pendingSettingsDelta,undefined);assert.equal(consumer.composeConversation().settings.researchMode,undefined);assert.equal(consumer.composeConversation().settings.enabledWebSearch,false);
  const notices=consumer.drainFailureNotices();assert.equal(notices.length,1);assert.equal(notices[0].foreign,false);assert.equal(notices[0].failure.action,'update_conversation_settings');
  consumer.advanceAck(out.ack,true);assert.equal(consumer.processPendingFailures(),false);assert.equal(consumer.drainFailureNotices().length,0);
 }
}));
test('original settings reducer keeps newer mutation and retired-session settings on stale refusal',async()=>scoped(async()=>{
 const out=await refusedSettings();
 for(const config of [{version:2n,session:'session-a',foreign:false},{version:1n,session:'session-new',foreign:true}]){
  const {consumer}=originalSettingsConsumer(config.version,config.session);consumer.advanceAck(out.ack,true);assert.equal(consumer.processPendingFailures(),false);assert.equal(consumer.overlay.pendingSettingsVersion,config.version);assert.equal(consumer.composeConversation().settings.researchMode,2);assert.equal(consumer.composeConversation().settings.enabledWebSearch,true);assert.equal(consumer.drainFailureNotices()[0].foreign,config.foreign);
 }
}));
test('settings no-op uses applied correlated ack; unsupported settings refusal correlates without mutation',async()=>scoped(async()=>{
 const f=fixture();const mark={sessionId:'session-a',version:7n};const noop=await action(f,'updateConversationSettings',{settings:{researchMode:2}},mark);assert.equal(noop.ack.outcome.case,'applied');assert.equal(noop.ack.highWaterMark.version,7n);assert.equal(f.calls.length,0);
 const bad=await action(f,'updateConversationSettings',{settings:{researchMode:1,enabledWebSearch:true}},mark);assert.equal(bad.ack.outcome.case,'error');assert.equal(bad.ack.outcome.value.action,'update_conversation_settings');assert.equal(bad.ack.highWaterMark.version,7n);assert.equal(f.calls.length,0);
 const other=await action(f,'warmTurn',{},mark);assert.equal(other.ack.outcome.case,'applied');assert.equal(f.calls.length,0);
}));

test('pre-fix missing mark cannot clear original optimistic settings; unrelated refusal remains unchanged',async()=>scoped(async()=>{
 const out=await refusedSettings(),legacy=structuredClone(out.ack);delete legacy.highWaterMark;legacy.outcome.value.action='updateConversationSettings';
 const {consumer,acceptsNotice}=originalSettingsConsumer();consumer.advanceAck(legacy,true);assert.equal(consumer.processPendingFailures(),false);assert.equal(consumer.composeConversation().settings.researchMode,2);assert.equal(consumer.composeConversation().settings.enabledWebSearch,true);assert.equal(acceptsNotice.has(legacy.outcome.value.action),false);
 const f=fixture();f.ctx.call=async()=>{throw Error('model save failed');};const other=await action(f,'setConversationModel',{model:{id:{case:'identifier',value:'another'}}},{sessionId:'session-a',version:3n});assert.equal(other.ack.outcome.case,'error');assert.equal(other.ack.outcome.value.action,'setConversationModel');assert.equal(other.ack.highWaterMark,undefined);
}));
