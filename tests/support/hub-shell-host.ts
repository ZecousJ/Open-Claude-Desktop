/** Offline top-level official-shell harness. No real login, provider, engine or entitlement override. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {createRunnerOfficialAdapter} from '../../runner/src/official-ui-adapter';
import {organizationUuid} from '../../electron/official-ui/api/context';
import {defaultGuardOptions} from '../../runner/src/method-guard';
import {storeUpload} from '../../electron/official-ui/api/files';
import {inAdapterScope,newAdapterScope} from '../../electron/official-ui/api/scope';
import type {Conversation, Project} from '../../shared/types';

const arg=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const candidate=arg('--candidate-root');
if(!candidate)throw Error('Specify --candidate-root pointing to the independently verified assembled official-ui root.');
const root=fs.realpathSync(candidate), ui=fs.realpathSync(path.join(root,'ui'));
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const document=fs.readFileSync(path.join(ui,'index.html'),'utf8');
if(!document.includes('src="/app.js"'))throw Error('Unexpected candidate document entry.');
const entry='/assets/v1/index-BJJTYFi2.js';
if(!fs.existsSync(path.join(ui,entry)))throw Error('Pinned entry is absent.');
const state=fs.mkdtempSync(path.join(os.tmpdir(),'claudex-hub-shell-inert-'));
const account={id:'hub-shell-synthetic',email:'hub-shell@example.invalid',name:'SYNTHETIC OFFLINE SHELL'};
const identity={};
const conversation:Conversation={id:'33333333-3333-4333-8333-333333333333',mode:'chat',title:'Synthetic stored conversation',providerId:'inert',model:'inert-no-model',pinned:false,archived:false,createdAt:1793635200000,updatedAt:1793635200000,turns:[{id:'synthetic-turn',prompt:'Stored fixture question. No model call.',attachments:[],status:'completed',createdAt:1793635200000,items:[{id:'synthetic-answer',type:'agentMessage',text:'Stored fixture answer. 中文显示样本。 No account or provider is connected.'}]}]};
const historyCase=arg('--history-case')??'plain';
if(!['plain','rich'].includes(historyCase))throw Error('Unknown synthetic history case.');
const fixedAttachmentText='Synthetic local attachment. 中文固定文本。 No model, account upload or external network.\n';
let storedAttachment:any;
if(historyCase==='rich'){
 const scope=newAdapterScope(account.id,state,identity);
 await inAdapterScope(scope,()=>storeUpload({account:()=>account,sessionIdentity:()=>identity,stateDirectory:()=>state,isCurrent:()=>true,call:async(method:string,name:string,data:Uint8Array)=>{
  if(method!=='addAttachmentData'||name!=='synthetic-note.txt'||Buffer.from(data).toString()!==fixedAttachmentText)throw Error('Only the fixed inert attachment can be stored.');
  const id='55555555-5555-4555-8555-555555555555',file=path.join(state,'attachments',id,name);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data,{mode:0o600});
  storedAttachment={id,name,path:file,size:data.byteLength,kind:'text'};return storedAttachment;
 }} as never,'synthetic-note.txt',new TextEncoder().encode(fixedAttachmentText),'text/plain'));
 conversation.title='Synthetic rich history + attachment';
 conversation.turns[0].attachments=[storedAttachment];
 conversation.turns[0].items=[
  {id:'synthetic-thinking',type:'reasoning',text:'Fixed synthetic reasoning body. No model generated this.',summary:['Fixed synthetic reasoning summary.'],lifecycleStatus:'completed'},
  {id:'synthetic-tool',type:'mcpToolCall',tool:'fixture.lookup',input:{query:'inert local sample'},result:{content:[{type:'text',text:'Fixed synthetic tool result. No tool was executed.'}]},status:'completed'},
  {id:'synthetic-answer',type:'agentMessage',text:'😀 cited 中文正文。 Fixed local answer; no model call.',citations:[{url:'https://example.invalid/inert-citation',title:'Synthetic citation — not fetched',start:3,end:8}],lifecycleStatus:'completed'},
 ];
}
const project:Project={id:'44444444-4444-4444-8444-444444444444',kind:'chat',visibility:'private',name:'Synthetic local project',description:'Offline navigation fixture; no folder access.',instructions:'',createdAt:1793635200000};
const catalog={defaultModel:'inert-no-model',items:[{id:'inert-no-model',displayName:'Synthetic model — cannot run',description:'Menu fixture only. No provider implementation exists.',badges:[],sort:0,hidden:false,isDefault:true,efforts:['low','high','ultra'],defaultEffort:'high',usageHint:'Offline fixture; no calls'}]};
const hubPins=JSON.parse(fs.readFileSync(path.resolve('scripts/official-host/hub-resources.json'),'utf8'));
const observedHubAssets=new Set(['/assets/v1/'+hubPins.localEntry,'/assets/v1/'+hubPins.body]);
const settings={providers:[]};
const run=createRunnerOfficialAdapter({account:()=>account,settings:()=>settings,sessionIdentity:()=>identity,stateDirectory:()=>state,onEvent:()=>()=>{},appVersion:'inert-hub-shell',log:()=>{} } as never,async(method,args)=>{
 switch(method){
 case 'snapshot':return {conversations:[{...conversation,turns:[]}],projects:[project],providers:[],settings,approvals:[],artifactLibrary:{version:1,copies:[],pinned:[]}};
 case 'conversationTurns':if(args[0]!==conversation.id)throw Error('Unknown synthetic conversation.');return {turns:conversation.turns,savedBranches:[]};
 case 'modelCatalog':return catalog;
 case 'turnAttachment':if(!storedAttachment||args[0]!==conversation.id||args[1]!==storedAttachment.id)throw Error('Unknown synthetic attachment.');return {data:fs.readFileSync(storedAttachment.path)};
 case 'artifactNotes':return {};
 case 'mcpServers':return {servers:[]};
 case 'listSkills':return [];
 case 'listPlugins':return {marketplaces:[],plugins:[],loadErrors:[]};
 case 'listProjectKnowledge':if(args[0]!==project.id)throw Error('Unknown synthetic project.');return {files:[],bytes:0,limit:1000000,fileLimit:1000000};
 case 'memoryStatus':return {available:false,reason:'unsupported',synthesizing:false,prefs:{generate:false,searchChats:false},allowed:{generate:false,searchChats:false}};
 default:throw Error('Offline shell fixture does not implement '+method);
 }
},root,defaultGuardOptions);
const bundle=await build({bundle:true,write:false,format:'esm',platform:'browser',stdin:{resolveDir:process.cwd(),loader:'js',contents:`
import {createOfficialReadFetch} from './src-web/official/read-fetch';
import {createOfficialEventSource} from './src-web/official/event-source';
const native=window.fetch.bind(window);
const local=async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input),location.origin);if(url.origin!==location.origin)throw Error('External request blocked by inert harness');return native(input,init)};
const bridge=async request=>{const response=await local('/__hub/bridge',{method:'POST',headers:{'content-type':'application/json','x-hub-fixture':'1'},body:JSON.stringify({...request,body:request.body?Array.from(request.body):undefined})});const value=await response.json();if(!response.ok)throw Error(value.error??'Fixture bridge rejected request');return {...value,body:new Uint8Array(value.body)}};
// Immutable stored fixtures have no mutation events, but the actual timeline bridge
// still needs its subscription hook to open the initial read-only Connect stream.
const subscribe=listener=>()=>{};
window.fetch=createOfficialReadFetch(location.origin,bridge,local,subscribe);
window.EventSource=createOfficialEventSource(location.origin,bridge,window.EventSource,subscribe);
import(${JSON.stringify(entry)}).catch(error=>{console.error('[inert-hub-load]',error);document.querySelector('#hub-fixture-state').textContent='Synthetic offline shell: official entry failed. Inspect console.'});
`},external:['/assets/*']});
if(process.argv.includes('--probe-bootstrap')){
 for(const org of [organizationUuid(account.id),'aa445bd1-c392-42a7-8e67-167b3145c42e']){
 const result=await run({method:'GET',path:'/edge-api/bootstrap/'+org+'/app_start?staging_hashing_algorithm=djb2&growthbook_formats=sdk&include_system_prompts=false'});
 console.log(JSON.stringify({probe:'synthetic-bootstrap',organization:org,expected:org===organizationUuid(account.id)?200:404,status:result.status}));
 if(result.status!==(org===organizationUuid(account.id)?200:404))throw Error('Bootstrap probe failed');
 }
}
if(process.argv.includes('--probe-history')){
 const result=await run({method:'GET',path:'/api/organizations/'+organizationUuid(account.id)+'/chat_conversations/'+conversation.id});
 const value=JSON.parse(Buffer.from(result.body).toString());
 console.log(JSON.stringify({probe:'synthetic-history',status:result.status,messages:value.chat_messages?.map((m:any)=>({sender:m.sender,blocks:m.content?.map((b:any)=>b.type),files:m.files_v2?.map((f:any)=>({id:f.file_uuid,name:f.file_name}))}))}));
 if(result.status!==200)throw Error('Synthetic history read failed.');
 if(storedAttachment){
 // Text uploadAnswer returns file_kind:blob and no preview URL. The actual
 // pinned shared-m-w-0 r$ text consumer constructs the organizations form;
 // also probe files.ts fileUrl form used by native timeline attachments.
 for(const prefix of ['/api/organizations/','/api/']){
 const path=prefix+organizationUuid(account.id)+'/files/'+storedAttachment.id+'/contents';
 const file=await run({method:'GET',path});
 console.log(JSON.stringify({probe:'synthetic-file-read',path,status:file.status,bytes:file.body.length,limitation:file.status===501?'Actual Runner Web file-read route is unavailable; preview is NOT accepted.':undefined}));
 if(file.status!==501&&(file.status!==200||Buffer.from(file.body).toString()!==fixedAttachmentText))throw Error('Unexpected synthetic attachment read outcome.');
 }
 }

}
const report={candidateRoot:root,historyCase,conversationId:conversation.id,attachmentId:storedAttachment?.id,syntheticOrganization:organizationUuid(account.id),documentSha256:hash(document),entrySha256:hash(fs.readFileSync(path.join(ui,entry))),fixture:'synthetic; no provider, account, folder or write authority',integrity:'Fingerprints only. Candidate must separately pass its production verifier.'};
if(!process.argv.includes('--serve')){console.log(JSON.stringify({...report,listening:false}));}else{
 const port=Number(arg('--port'));
 if(!Number.isInteger(port)||port<1024||port>65535||[5199,5201,5174,3966].includes(port))throw Error('Explicit unused --port required; existing service ports are protected.');
 // Dedicated loopback address isolates host-only cookies from other local apps.
 const hostname=arg('--hostname')??'127.0.0.2';
 if(!['127.0.0.1','127.0.0.2'].includes(hostname))throw Error('Only explicit loopback addresses are supported.');
 const host=`${hostname}:${port}`, origin=`http://${host}`;
 const mime:Record<string,string>={'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.woff':'font/woff'};
 const json=(res:http.ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 const server=http.createServer(async(req,res)=>{try{
 res.setHeader('Cache-Control','no-store');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'");
 if(req.headers.host!==host)return json(res,403,{error:'Exact loopback host required.'});
 const url=new URL(req.url??'/',origin);
 if(url.pathname==='/__hub/bridge'&&req.method==='POST'){
 if(req.headers.origin!==origin||req.headers['x-hub-fixture']!=='1')return json(res,403,{error:'Exact synthetic origin required.'});
 let body=Buffer.alloc(0);for await(const chunk of req){body=Buffer.concat([body,chunk]);if(body.length>1024*1024)return json(res,413,{error:'Too large.'});}
 const request=JSON.parse(body.toString());if(request.body)request.body=new Uint8Array(request.body);
 const result=await run(request);
 console.log(JSON.stringify({fixture:'hub-shell',method:request.method,path:request.path,status:result.status}));
 return json(res,200,{...result,body:Array.from(result.body)});
 }
 if(req.method!=='GET')return json(res,405,{error:'No writes supported.'});
 if(url.pathname==='/__hub/entry.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);return;}
 if(url.pathname!=='/'&&!url.pathname.endsWith('.html')){
 const file=path.resolve(ui,'.'+decodeURIComponent(url.pathname));
 if(file!==ui&&!file.startsWith(ui+path.sep))return json(res,403,{error:'Invalid path.'});
 if(fs.existsSync(file)&&fs.statSync(file).isFile()){
 const real=fs.realpathSync(file);if(!real.startsWith(ui+path.sep))return json(res,403,{error:'Outside candidate UI.'});
 const bytes=fs.readFileSync(real);
 if(observedHubAssets.has(url.pathname))console.log(JSON.stringify({fixture:'hub-shell-static',method:'GET',path:url.pathname,status:200,bytes:bytes.length,sha256:hash(bytes)}));
 res.setHeader('Content-Type',mime[path.extname(real)]??'application/octet-stream');res.end(bytes);return;
 }
 }
 if(/^\/(?:assets|api|edge-api|claudeai-rpc|v1)\//.test(url.pathname))return json(res,404,{error:'No external fallback.'});
 res.setHeader('Content-Type','text/html');
 res.end(document.replace('src="/app.js"','src="/__hub/entry.js"').replace('</body>','<aside id="hub-fixture-state" role="status" style="position:fixed;bottom:0;right:0;z-index:2147483647;background:#fff4c2;color:#222;padding:4px;font:12px sans-serif;pointer-events:none">SYNTHETIC OFFLINE SHELL · fixed local fixtures only · no real account / models / tools / external network · visual checks not yet accepted</aside></body>'));
 }catch{json(res,500,{error:'Synthetic shell request failed; no external fallback.'});}});
 server.listen(port,hostname,()=>console.log(JSON.stringify({...report,url:origin+'/new'})));
}
