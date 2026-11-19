/** Actual project detail route with in-memory sources; no service or filesystem. */
import test from 'node:test';import assert from 'node:assert/strict';
import {projectsRoute} from '../electron/official-ui/api/projects';
import {organizationUuid} from '../electron/official-ui/api/context';
async function run(mode:string,readOnly=false){
 let owner='A',activation=1,status=0,body:any,calls=0;
 const ctx:any={readOnly,account:()=>({id:owner,email:'fixture@example.invalid'}),sessionIdentity:()=>activation,isCurrent:()=>true,snapshot:async()=>({projects:[{id:'p',kind:'chat',name:'P',createdAt:1}]}),call:async()=>{calls++;if(mode==='fail')throw Error('secret /private/path upstream failure');if(mode==='retire')activation++;if(mode==='switch')owner='B';return mode==='malformed'?{files:null}:{files:[{name:'note.txt',bytes:2,addedAt:1}]};}};
 const p=`/api/organizations/${organizationUuid('A')}/projects/p`;
 await projectsRoute({method:'GET'} as any,{writeHead:(s:number)=>{status=s},end:(x:any)=>{body=JSON.parse(String(x))}} as any,p,new URL(p,'http://fixture.invalid'),ctx);
 return{status,body,calls};
}
test('detail knowledge failure is a retryable error, not a successful unknown inventory',async()=>{
 for(const readonly of [false,true]){const r=await run('fail',readonly);assert.equal(r.status,503);assert.match(r.body.error.message,/knowledge.*unavailable/i);assert.doesNotMatch(JSON.stringify(r.body),/secret|private.path/);assert.equal(r.calls,1);}
});
test('invalid knowledge inventory is explicit unavailable',async()=>{const r=await run('malformed');assert.equal(r.status,503);assert.doesNotMatch(JSON.stringify(r.body),/TypeError|null.*length/);});
test('detail does not return inventory after ownership changes',async()=>{for(const m of ['retire','switch']){const r=await run(m);assert.equal(r.status,409);assert.equal(r.body.docs_count,undefined);}});
test('normal detail retains actual knowledge counts',async()=>{const r=await run('ok');assert.equal(r.status,200);assert.equal(r.body.docs_count,1);assert.equal(r.body.files_count,0);});
