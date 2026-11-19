/** Explicit native-only static preview entry. Never accepts source text, paths or windows. */
import type http from 'node:http';
import {z} from 'zod';
import {reply,organizationUuid,type AdapterContext} from './context';
import {readBoundedJson,RequestBodyError} from './request-body';
export const staticArtifactSelectionSchema=z.object({conversationId:z.string().uuid(),artifactId:z.string().uuid(),versionId:z.string().uuid()}).strict();
export type StaticArtifactSelection=z.infer<typeof staticArtifactSelectionSchema>;
export async function staticArtifactPreviewRoute(req:http.IncomingMessage,res:http.ServerResponse,p:string,ctx:AdapterContext):Promise<boolean>{
 const match=/^\/api\/organizations\/([^/]+)\/__claudex\/static-artifact-preview$/.exec(p);
 if(!match)return false;
 const fail=(status:number,message:string)=>reply(res,{error:{type:'api_error',message}},status,{'Cache-Control':'private, no-store'});
 const owner=ctx.account()?.id,activation=ctx.sessionIdentity?.(),root=ctx.stateDirectory?.(),open=ctx.openStaticArtifactPreview;
 const current=()=>!!owner&&activation!==undefined&&activation!==null&&activation!==''&&ctx.account()?.id===owner&&ctx.sessionIdentity?.()===activation&&ctx.stateDirectory?.()===root&&ctx.isCurrent?.()!==false;
 if(!owner)return fail(401,'Sign in to preview this artifact.');
 if(match[1]!==organizationUuid(owner))return fail(404,'Artifact not found.');
 if(req.method!=='POST')return fail(405,'Use the static preview action.');
 if(!current())return fail(409,'The account changed. Reopen this artifact.');
 if(!open)return fail(501,'Static preview is unavailable in this host. Interactive artifact preview is not substituted.');
 let selection:StaticArtifactSelection;
 try{selection=staticArtifactSelectionSchema.parse(await readBoundedJson(req,4096));}
 catch(error){return fail(error instanceof RequestBodyError&&error.status===413?413:400,'Choose an existing artifact and its exact version.');}
 if(!current())return fail(409,'The account changed. Reopen this artifact.');
 try{
  const result=await open(selection);
  if(!current())return fail(409,'The preview was retired after the account changed.');
  if(!result||result.opened!==true)throw Error('Preview not opened');
  return reply(res,{opened:true,mode:'static-isolated',interactive:false},202,{'Cache-Control':'private, no-store'});
 }catch{return fail(current()?503:409,current()?'Static preview could not open. This artifact may be unsupported or changed. Check the preview window before retrying.':'The account changed. Reopen this artifact.');}
}
