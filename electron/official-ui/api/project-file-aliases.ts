/** Account-activation-local identities advertised by project lists and uploads.
 * No paths, disk reads, persistence, attachment grants, or renderer registrations. */
import type http from 'node:http';
import {organizationUuid,reply,type AdapterContext} from './context';
import {knownFile} from './files';
export type ProjectFileExpectation=ProjectFileIdentity&{variant:'original'|'xls-preview';isCurrent():boolean};
export type ProjectFileIdentity={id:string;name:string;bytes:number;addedAt:number};
type Registry={owner:string;root:unknown;activation:unknown;lists:Map<string,symbol>;rows:Map<string,ProjectFileIdentity&{projectId:string}>};
const registries=new WeakMap<AdapterContext,Registry>();
const limit=4096;
function identity(ctx:AdapterContext){
 if(ctx.isCurrent?.()===false)throw Error('Retired');
 const owner=ctx.account()?.id,root=ctx.stateDirectory?.(),activation=ctx.sessionIdentity?.();
 if(!owner||typeof root!=='string'||!root||activation===undefined||activation===null||activation==='')throw Error('Retired');
 return {owner,root,activation};
}
function registry(ctx:AdapterContext){const key=identity(ctx);let r=registries.get(ctx);if(!r||r.owner!==key.owner||r.root!==key.root||r.activation!==key.activation){r={...key,lists:new Map(),rows:new Map()};registries.set(ctx,r);}return r;}
/** The original uploader inserts its response into the query cache without relisting. */
export function rememberProjectUploadFile(ctx:AdapterContext,projectId:string,file:ProjectFileIdentity){
 const r=registry(ctx),prior=r.rows.get(file.id);
 if(knownFile(file.id)||prior&&prior.projectId!==projectId)throw Error('Ambiguous project file');
 if(!prior&&r.rows.size>=limit)throw Error('Project file identity capacity exceeded');
 r.rows.set(file.id,{...file,projectId});
}
/** Clear this project's previous advertised aliases before attempting a new list. */
export function beginProjectFileList(ctx:AdapterContext,projectId:string){
 // Legacy list-only hosts may lack a durable account root or activation identity.
 // Preserve their list behavior, without granting any new alias read capability.
 const activation=ctx.sessionIdentity?.(),root=ctx.stateDirectory?.();if(activation===undefined||activation===null||activation===''||typeof root!=='string'||!root){registries.delete(ctx);return (_files:ProjectFileIdentity[])=>{};}
 const r=registry(ctx);for(const [id,row]of r.rows)if(row.projectId===projectId)r.rows.delete(id);
 if(!r.lists.has(projectId)&&r.lists.size>=limit)throw Error('Project identity capacity exceeded');const token=Symbol();r.lists.set(projectId,token);
 return (files:ProjectFileIdentity[])=>{if(registry(ctx)!==r||r.lists.get(projectId)!==token)throw Error('Retired');const ids=new Set<string>();for(const f of files){if(!/^[a-f0-9-]{36}$/.test(f.id)||typeof f.name!=='string'||!f.name||!Number.isSafeInteger(f.bytes)||f.bytes<0||!Number.isFinite(f.addedAt)||ids.has(f.id)||knownFile(f.id)||r.rows.has(f.id))throw Error('Ambiguous project file');ids.add(f.id);}if(r.rows.size+files.length>limit)throw Error('Project file identity capacity exceeded');for(const f of files)r.rows.set(f.id,{...f,projectId});};
}
export async function projectFileAliasRoute(req:http.IncomingMessage,res:http.ServerResponse,p:string,url:URL,ctx:AdapterContext,read:(path:string,url:URL,expected:ProjectFileExpectation)=>Promise<boolean>){
 const match=/^\/api\/organizations\/([^/]+)\/files\/([a-f0-9-]{36})\/(contents|preview)$/.exec(p);
 if(!match||req.method!=='GET')return false;
 const prior=registries.get(ctx),row=prior?.rows.get(match[2]);if(!prior||!row)return false;
 const variant=match[3]==='preview'?'xls-preview':'original';
 if(variant==='xls-preview'&&!/\.xls$/i.test(row.name))return false;
 try{
  const r=registry(ctx);if(r!==prior) return reply(res,{error:'Project file identity expired. Reopen project files.'},409);
  if(match[1]!==organizationUuid(r.owner))return reply(res,{error:'Project file not found.'},404);
  if(url.search)return reply(res,{error:'Unexpected file query.'},400);
  if(knownFile(match[2]))return reply(res,{error:'File identity is ambiguous.'},409);
  const current=()=>{if(registry(ctx)!==r||r.rows.get(match[2])!==row||knownFile(match[2]))throw Error('Retired');};
  current();const snapshot=await ctx.snapshot(true);current();
  const matches=(snapshot.projects??[]).filter(x=>x.id===row.projectId&&(x.kind??'chat')==='chat');
  if(matches.length!==1)return reply(res,{error:'Project file not found.'},404);
  const target=`/api/organizations/${match[1]}/projects/${row.projectId}/knowledge/${row.id}`;
  return await read(target,new URL(target,url.origin),{...row,variant,isCurrent:()=>{try{current();return true;}catch{return false;}}});
 }catch{return reply(res,{error:'The project file could not be read for this account. Reopen the project.'},409);}
}
