/** Offline F068 product UI harness. Never imports an engine/provider or calls a service. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { officialUiRead } from '../../runner/src/official-ui-read';
import { organizationUuid } from '../../electron/official-ui/api/context';
import { openPolicy } from '../../shared/client-policy';
import { defaultGuardOptions } from '../../runner/src/method-guard';
import { encodeWireValue, decodeWireValue } from '../../shared/web-wire';
import type { Conversation } from '../../shared/types';
import { verifyOfficialWebAssets } from '../../scripts/official-web-assets.mjs';
const root=process.cwd(), state=path.join(root,'.runtime','official-appearance-fixture');
fs.mkdirSync(state,{recursive:true});
const settingsPath=path.join(state,'cosmetic-settings.json');
let chatFont='serif';
if(fs.existsSync(settingsPath)) {
 const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
 if(!['serif','sans','system','dyslexia'].includes(saved.chatFont)||Object.keys(saved).join()!=='chatFont')throw Error('Invalid synthetic settings.');
 chatFont=saved.chatFont;
}
let failSave=false;
const account={id:'appearance-local-fixture',email:'appearance@example.invalid',name:'INERT Appearance Fixture'};
const identity={};
const conversation:Conversation={id:'33333333-3333-4333-8333-333333333333',mode:'chat',title:'F068 local typography sample',providerId:'inert',model:'no-model',pinned:false,archived:false,createdAt:1793635200000,updatedAt:1793635200000,turns:[{id:'inert-turn',prompt:'Local typography sample only. No model was called.',attachments:[],status:'completed',createdAt:1793635200000,items:[{id:'inert-assistant',type:'agentMessage',text:'Appearance sample: The quick brown fox jumps over the lazy dog. 中文字号与字体测试。\n\nSecond paragraph for readable line height and transcript width. This is fixed local content, not a generated response.\n\n```javascript\nconst localFixture = 42;\n```'}]}]};
const ctx:any={userId:7,activeAccount:account,officialSessionIdentity:()=>identity,setAccessToken(){},onEvent:()=>()=>{},store:{root:state,settings:{providers:[],chatFont},projects:[],async persistAppearancePreference(){
 const value=ctx.store.settings;
 if(!['serif','sans','system','dyslexia'].includes(value.chatFont)||Object.keys(value).some(key=>!['providers','chatFont'].includes(key))||JSON.stringify(value.providers)!=='[]')throw Error('Fixture only persists cosmetic settings.');
 if(failSave)throw Error('Explicit synthetic appearance save failure before persistence.');
 fs.writeFileSync(settingsPath,JSON.stringify({chatFont:value.chatFont})+'\n',{mode:0o600});
 }},policy:()=>openPolicy,settingsListeners:{emit(){}},services:{},appVersion:'inert-appearance',log(){}};
const dispatcher:any={options:{officialUiRoot:path.join(root,'build/official-ui'),officialUiActions:false,officialUiAppearanceSettings:true},guard:defaultGuardOptions,context:()=>ctx,contextFor:async()=>ctx,now:()=>Date.now(),run:async(frame:any)=>{
 const args=decodeWireValue(frame.args) as unknown[];
 switch(frame.method){
  case 'snapshot':return {conversations:[{...conversation,turns:[]}],projects:[],providers:[],settings:ctx.store.settings,approvals:[],artifactLibrary:{version:1,copies:[],pinned:[]}};
  case 'conversationTurns':if(args[0]!==conversation.id)throw Error('Unknown fixture conversation.');return{turns:conversation.turns,savedBranches:[]};
  case 'saveSettings':throw Error('General settings dispatcher is not authorized by this harness.');
  case 'modelCatalog':return null;
  case 'artifactNotes':return {};
  case 'mcpServers':return {servers:[]};
  case 'listSkills':return [];
  case 'listPlugins':return {marketplaces:[],plugins:[],loadErrors:[]};
  case 'activeSessions':return [];
  case 'memoryStatus':return {available:false,reason:'unsupported',synthesizing:false,prefs:{generate:false,searchChats:false},allowed:{generate:false,searchChats:false}};
  default:throw Error('Inert fixture does not implement '+frame.method);
 }
}};
const verified=verifyOfficialWebAssets();
const files=new Map(verified.files.map(row=>['/'+row.path,row] as const));
const bundles=await Promise.all([
 build({entryPoints:[path.join(root,'tests/support/official-appearance-host-entry.tsx')],bundle:true,write:false,outdir:'out',platform:'browser',format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'}}),
 build({stdin:{resolveDir:root,loader:'ts',contents:"import {startOfficialFrame} from './src-web/official/frame-entry';startOfficialFrame().catch(()=>{document.body.textContent='The actual product frame failed to initialize.'});"},bundle:true,write:false,platform:'browser',format:'esm',define:{__OFFICIAL_ENTRY__:JSON.stringify(verified.entry)}}),
]);
const hostJs=bundles[0].outputFiles.find(f=>f.path.endsWith('.js'))!.contents;
const hostCss=bundles[0].outputFiles.find(f=>f.path.endsWith('.css'))?.contents??new Uint8Array();
const frameJs=bundles[1].outputFiles[0].contents;
const mime:Record<string,string>={'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.woff':'font/woff','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.gif':'image/gif','.wasm':'application/wasm'};
const answer=(res:http.ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
const server=http.createServer(async(req,res)=>{try{
 res.setHeader('Cache-Control','no-store');
 res.setHeader('Content-Security-Policy',"connect-src 'self'; frame-src 'self'; object-src 'none'");
 const url=new URL(req.url??'/', 'http://127.0.0.1:5199');
 if(req.method==='POST'&&['/__appearance/bridge','/__appearance/failure'].includes(url.pathname)){
  if(req.headers['x-appearance-fixture']!=='1'||req.headers.origin&&!['http://127.0.0.1:5199','http://localhost:5199'].includes(req.headers.origin))return answer(res,403,{error:'Local fixture origin required.'});
  let body=Buffer.alloc(0);for await(const chunk of req){body=Buffer.concat([body,chunk]);if(body.length>1024*1024)return answer(res,413,{error:'Fixture request too large.'});}
  const value=JSON.parse(body.toString());
  if(url.pathname==='/__appearance/failure'){
   if(Object.keys(value).join()!=='enabled'||typeof value.enabled!=='boolean')return answer(res,400,{error:'Invalid local control.'});
   failSave=value.enabled;return answer(res,200,{enabled:failSave});
  }
  if(!['read','action'].includes(value.kind))return answer(res,400,{error:'Unknown fixture channel.'});
  const request=value.request;if(request.body)request.body=new Uint8Array(request.body);
  const result:any=await officialUiRead(dispatcher,{t:'call',id:'appearance-fixture',user:{id:7,accessToken:'inert-not-a-credential'},method:value.kind==='read'?'officialUiRead':'officialUiAction',args:encodeWireValue([request])} as any);
  fs.appendFileSync(path.join(state,'requests.jsonl'),JSON.stringify({at:new Date().toISOString(),kind:value.kind,method:request.method,path:request.path,status:result.status})+'\n');
  return answer(res,200,{...result,body:Array.from(result.body)});
 }
 if(req.method!=='GET')return answer(res,405,{error:'Not supported.'});
 const literal:Record<string,[string,Uint8Array|string]>={
  '/__appearance/host.js':['text/javascript',hostJs],'/__appearance/host.css':['text/css',hostCss],'/__appearance/frame.js':['text/javascript',frameJs],
  '/official-frame.html':['text/html',verified.document.replace("</body>", '<script type="module" src="/__appearance/frame.js"></script></body>')],
 };
 if(literal[url.pathname]){const [type,content]=literal[url.pathname];res.setHeader('Content-Type',type);res.end(content);return;}
 const file=files.get(url.pathname);if(file){res.setHeader('Content-Type',mime[path.extname(file.file)]??'application/octet-stream');res.end(file.content??fs.readFileSync(file.file));return;}
 if(/^\/(?:assets|api|edge-api|claudeai-rpc)\//.test(url.pathname))return answer(res,404,{error:'No external fallback exists.'});
 res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>INERT F068 product harness</title><link rel="stylesheet" href="/__appearance/host.css"><style>html,body{margin:0;height:100%}#root{height:100%;display:flex;flex-direction:column}.official-web-host{height:auto;flex:1;min-height:0}</style></head><body><div id="root"></div><script type="module" src="/__appearance/host.js"></script></body></html>');
 }catch(error){answer(res,500,{error:error instanceof Error?error.message:'Local fixture failure.'});}});
if(process.argv.includes('--inspect-history')) {
 const call=async(path:string)=>officialUiRead(dispatcher,{t:'call',id:'appearance-read-smoke',user:{id:7,accessToken:'inert-not-a-credential'},method:'officialUiRead',args:encodeWireValue([{method:'GET',path}])} as any) as Promise<any>;
 for(const suffix of ['/chat_conversations_v2?limit=30&offset=0&archived=false&consistency=eventual','/chat_conversations/'+conversation.id]){
  const result=await call('/api/organizations/'+organizationUuid(account.id)+suffix),body=JSON.parse(Buffer.from(result.body).toString());
  console.log(JSON.stringify({path:suffix,status:result.status,keys:Object.keys(body),rows:body.data?.map((v:any)=>({uuid:v.uuid,name:v.name})),id:body.uuid,messages:body.chat_messages?.map((v:any)=>({sender:v.sender,text:v.text,content:v.content}))}));
 }
} else if(process.argv.includes('--smoke')) {
 const run=async(kind:string,request:any)=>officialUiRead(dispatcher,{t:'call',id:'appearance-smoke',user:{id:7,accessToken:'inert-not-a-credential'},method:kind==='read'?'officialUiRead':'officialUiAction',args:encodeWireValue([request])} as any) as Promise<any>;
 const cap=await run('read',{method:'GET',path:'/api/claudex/appearance-capabilities/version1'});
 const descriptor=JSON.parse(Buffer.from(cap.body).toString());
 const selected=chatFont==='sans'?'serif':'sans';
 const patch={method:'PATCH',path:'/api/account/settings',contentType:'application/json',body:new TextEncoder().encode(JSON.stringify({chat_font:selected})),capabilityLease:descriptor.activationLease};
 const saved=await run('action',patch);
 const bootstrap=await run('read',{method:'GET',path:'/api/bootstrap'});
 console.log(JSON.stringify({capabilityStatus:cap.status,appearance:descriptor.appearance,saveStatus:saved.status,savedFont:ctx.store.settings.chatFont,bootstrapStatus:bootstrap.status}));
 if(saved.status!==200||ctx.store.settings.chatFont!==selected)throw Error('Appearance product save failed: '+Buffer.from(saved.body).toString());
 failSave=true;const failed=await run('action',{...patch,body:new TextEncoder().encode(JSON.stringify({chat_font:selected==='sans'?'serif':'sans'}))});
 console.log(JSON.stringify({failureStatus:failed.status,inMemoryFont:ctx.store.settings.chatFont,durableFont:JSON.parse(fs.readFileSync(settingsPath,'utf8')).chatFont}));
 if(failed.status<400||ctx.store.settings.chatFont!==selected)throw Error('Failure simulation did not preserve settings.');
 failSave=false;await run('action',{...patch,body:new TextEncoder().encode(JSON.stringify({chat_font:chatFont}))});
} else if(process.argv.includes('--check')) console.log('INERT F068 harness compiled; verified assets: '+verified.files.length);
else server.listen(5199,'127.0.0.1',()=>console.log('INERT F068 product harness http://127.0.0.1:5199/new#settings/general; cosmetic state only: '+state));
