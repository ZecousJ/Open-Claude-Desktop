/** Inert UI fixture only. No Engine, IPC, scheduler, model, or real account. */
import {Readable, Writable} from 'node:stream';
import type http from 'node:http';
import {createApiAdapter} from '../../electron/official-ui/api';
import {organizationUuid, type AdapterContext} from '../../electron/official-ui/api/context';
import type {MemoryDocView, MemoryStatus} from '../../shared/memory-api';
import type {OfficialUiReadRequest, OfficialUiReadResponse} from '../../shared/official-ui-web';

export function nativeMemoryAdapterSynthetic(options:{root:string; stateDirectory:string; doc:MemoryDocView; delayMs?:number}) {
  const owner='cloud-ui-fixture', identity={}; let active=true, enabled=true, pending=false;
  const counts={reads:0, attempts:0, committed:0};
  const prefix=`/api/organizations/${organizationUuid(owner)}/memory`;
  const status=():MemoryStatus=>({available:true,allowed:{generate:true,searchChats:false},prefs:{generate:enabled,searchChats:false},synthesizing:false,global:structuredClone(options.doc)});
  const ctx:AdapterContext={root:options.root,readOnly:false,account:()=>active?{id:owner,email:'fixture@example.invalid',name:'SYNTHETIC native-memory adapter — no generation'}:undefined,
    settings:()=>{throw Error('Synthetic memory fixture has no settings source');},stateDirectory:()=>options.stateDirectory,sessionIdentity:()=>identity,isCurrent:()=>active,
    onEvent:()=>()=>{},appVersion:'0.0.0-fixture',log:()=>{},listConversations:async()=>[],loadConversation:async()=>undefined,
    snapshot:async()=>{throw Error('Synthetic memory fixture has no snapshot source');},modelCatalog:async()=>null,
    call:async(name,...args)=>{
      if(!active)throw Error('Synthetic fixture retired');
      if(name==='memoryStatus'&&JSON.stringify(args)==='[{"snapshotOnly":true}]'){counts.reads++;return status();}
      if(name!=='setMemoryPrefs'||JSON.stringify(args)!=='[{"generate":false},{"disableOnly":true}]')throw Error('Synthetic fixture rejects this operation');
      counts.attempts++;
      if(pending)throw Error('Synthetic disable already pending');
      pending=true;
      try{await new Promise(r=>setTimeout(r,options.delayMs??1200));if(!active)throw Error('Synthetic fixture retired');enabled=false;counts.committed++;return status();}
      finally{pending=false;}
    }};
  const adapter=createApiAdapter(ctx,{scoped:true,migrateLegacy:false});
  const matches=(p:string)=>/^\/api\/organizations\/[^/]+\/memory\/(settings|disable-generation)(?:\?.*)?$/.test(p);
  async function run(input:OfficialUiReadRequest):Promise<OfficialUiReadResponse>{
    const deny=(status:number,message:string)=>({status,contentType:'application/json',body:Buffer.from(JSON.stringify({error:message}))});
    if(!matches(input.path))return deny(501,'Outside synthetic memory fixture scope');
    const u=new URL(input.path,'http://localhost');
    if(u.search||u.hash)return deny(400,'Synthetic fixture does not accept query or fragment');
    if(!((input.method==='GET'&&u.pathname.endsWith('/settings'))||(input.method==='POST'&&u.pathname.endsWith('/disable-generation'))))return deny(405,'Synthetic fixture method unsupported');
    if((input.body?.byteLength??0)>1024)return deny(413,'Synthetic fixture request too large');
    const req=Readable.from(input.body?[Buffer.from(input.body)]:[]) as unknown as http.IncomingMessage;
    req.method=input.method;req.url=input.path;req.headers={'content-type':input.contentType??'application/json'};
    const chunks:Buffer[]=[];let code=200,headers:Record<string,string>={};
    const res=new Writable({write(chunk,_encoding,done){chunks.push(Buffer.from(chunk));done();}}) as Writable & {writeHead:(n:number,h:Record<string,string>)=>unknown};
    res.writeHead=(n,h)=>{code=n;headers=h;return res;};
    await adapter(req,res as unknown as http.ServerResponse);
    return {status:code,contentType:headers['Content-Type']??'application/json',body:Buffer.concat(chunks)};
  }
  return {run,matches,prefix,counts,retire:()=>{active=false;},status};
}
