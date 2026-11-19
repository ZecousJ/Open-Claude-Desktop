/** Private in-memory project contracts only; no files, network or account calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {projectRow, projectsRoute} from '../electron/official-ui/api/projects';
import {organizationUuid} from '../electron/official-ui/api/context';
const project:any={id:'private-project',kind:'chat',name:'Private',createdAt:1};
const supported=['chat_project:chat:create','chat_project:chat:view','chat_project:delete','chat_project:knowledge:edit','chat_project:knowledge:view'];
test('private Claudex project does not advertise nonexistent member management',()=>{
 const row=projectRow(project,{id:'owner',name:'Owner'});
 assert.equal(row.is_private,true);
 assert.deepEqual(row.permissions,supported);
 assert.equal(row.permissions.includes('chat_project:members:manage'),false);
});
test('each project response owns its permission list',()=>{
 const a=projectRow(project,undefined);a.permissions.push('chat_project:members:manage');
 assert.deepEqual(projectRow(project,undefined).permissions,supported);
});
async function route(readOnly:boolean,detail:boolean){
 let body:any,status=0,calls=0;
 const ctx:any={readOnly,account:()=>({id:'owner',name:'Owner',email:'owner@example.invalid'}),snapshot:async()=>({projects:[project]}),call:async(method:string)=>{calls++;assert.equal(method,'listProjectKnowledge');return{files:[]};}};
 const p=`/api/organizations/${organizationUuid('owner')}/projects${detail?'/private-project':''}`;
 await projectsRoute({method:'GET'} as any,{writeHead:(s:number)=>{status=s;},end:(v:any)=>{body=JSON.parse(String(v));}} as any,p,new URL(p,'http://fixture.invalid'),ctx);
 assert.equal(status,200);assert.equal(calls,detail?1:0);return detail?body:body[0];
}
test('list/detail keep real private permissions and readonly keeps view only',async()=>{
 for(const detail of [false,true]){
  assert.deepEqual((await route(false,detail)).permissions,supported);
  assert.deepEqual((await route(true,detail)).permissions,['chat_project:chat:view','chat_project:knowledge:view']);
 }
});
