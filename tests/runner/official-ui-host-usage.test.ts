/** Real runner adapter with inert dispatcher and temp state; no service/account I/O. */
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createRunnerOfficialAdapter} from '../../runner/src/official-ui-adapter';
import {organizationUuid} from '../../electron/official-ui/api/context';
const org=organizationUuid('owner'), route=`/api/organizations/${org}/claudex_usage_summary`;
function setup(t:any){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'claudex-usage-runner-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let activation=1,hook:(method:string)=>void=()=>{};const calls:any[]=[];
 const run=createRunnerOfficialAdapter({account:()=>({id:'owner',email:'fixture@example.invalid',name:'Fixture'}),settings:()=>({}),sessionIdentity:()=>activation,stateDirectory:()=>root,onEvent:()=>()=>{},appVersion:'test',log() {}} as never,async(method,args)=>{
 calls.push([method,args]);hook(method);
 if(method==='billingInfo')return {plan:null,planExpiresAt:null,balance:12.34,subscriptions:[]};
 if(method==='planUsage')return null;
 if(method==='spendLimit')return {limitUsd:null,usedUsd:0,resetsAt:'2026-12-01T00:00:00Z'};
 throw Error('Unexpected method '+method);
 },root,{modes:['chat']});
 return {run,calls,setHook(fn:typeof hook){hook=fn;},reactivate(){activation++;}};
}
const json=(r:any)=>JSON.parse(Buffer.from(r.body).toString());
test('runner readonly dispatcher permits exact usage reads and fresh plan flag',async t=>{
 const f=setup(t),response=await f.run({method:'GET',path:route+'?fresh=1'});assert.equal(response.status,200);const body=json(response);
 assert.equal(body.billing.data.balanceUsd,12.34);assert.equal(body.plan_usage.state,'unavailable');assert.equal(body.spend_limit.data.limitUsd,null);
 assert.deepEqual(f.calls,[['billingInfo',[]],['planUsage',[true]],['spendLimit',[]]]);
});
test('runner wrong-org/query and write attempts never invoke financial sources',async t=>{
 const f=setup(t);
 assert.equal((await f.run({method:'GET',path:route.replace(org,organizationUuid('other'))})).status,404);
 assert.equal((await f.run({method:'GET',path:route+'?fresh=1&fresh=1'})).status,400);
 for(const method of ['POST','PUT','DELETE','PATCH'] as const)assert.equal((await f.run({method,path:route})).status,501);
 assert.equal(f.calls.length,0);
});
test('runner activation replacement suppresses all accumulated usage',async t=>{
 const f=setup(t);f.setHook(method=>{if(method==='planUsage')f.reactivate();});
 const response=await f.run({method:'GET',path:route});assert.notEqual(response.status,200);assert.equal(json(response).billing,undefined);assert.equal(f.calls.some(([name])=>name==='spendLimit'),false);
});
