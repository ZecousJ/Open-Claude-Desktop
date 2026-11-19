/** Actual restricted runner adapter. No authenticated service or account mutation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRunnerOfficialAdapter} from '../../runner/src/official-ui-adapter';
import {isOfficialUiQuery} from '../../shared/official-ui-web';
const reads = {
 '/api/auth/mfa':'mfa_unavailable',
 '/api/auth/trusted_devices':'trusted_devices_unavailable',
 '/api/account/deletion-allowed':'account_deletion_eligibility_unavailable',
};
function fixture(t:any){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'security-read-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let account:any={id:'owner',email:'inert@example.invalid'}, identity:any={};
 const calls:string[]=[];
 const run=createRunnerOfficialAdapter({account:()=>account,sessionIdentity:()=>identity,settings:()=>({}),stateDirectory:()=>root,onEvent:()=>()=>{},appVersion:'inert',log() {}} as never,async method=>{calls.push(method);throw Error('No security backend call is supported');},root,{modes:['chat']});
 return{run,calls,logout(){account=undefined;identity={}},switch(){account={id:'other',email:'other@example.invalid'};identity={}},root};
}
test('default readonly Web reaches specific security unavailable envelopes, no actions or backend calls',async t=>{
 const f=fixture(t);
 for(const [path,code] of Object.entries(reads)){
  assert.equal(isOfficialUiQuery('GET',path),true);
  const result=await f.run({method:'GET',path});
  assert.equal(result.status,503);
  const value=JSON.parse(Buffer.from(result.body).toString());
  assert.equal(value.type,'error');assert.equal(value.error.details.error_code,code);
  for(const key of ['devices','methods','deletable'])assert.equal(Object.hasOwn(value,key),false);
 }
 assert.deepEqual(f.calls,[]);assert.equal(fs.readdirSync(f.root,{recursive:true}).some(name=>/receipts|\.json$/.test(String(name))),false);
});
test('security mutation/enrollment, webauthn, and similar paths remain forbidden',async t=>{
 const f=fixture(t);
 for(const path of [...Object.keys(reads),'/api/auth/mfa/sms/enroll/send','/api/auth/trusted_devices/device','/api/auth/webauthn','/api/account/deletion-allowed/confirm']){
  for(const method of ['POST','PUT','DELETE','PATCH','HEAD']){
   assert.equal(isOfficialUiQuery(method,path),false);
   const result=await f.run({method:method as any,path});
   assert.ok(result.status>=400);
   assert.equal(JSON.parse(Buffer.from(result.body).toString()).error?.details,undefined);
  }
 }
 for(const path of ['/api/auth/mfa/','/api/auth/trusted_devices_extra','/api/account/deletion-allowed/confirm','/api/auth/webauthn']){
  assert.equal(isOfficialUiQuery('GET',path),false);
  assert.ok((await f.run({method:'GET',path})).status>=400);
 }
 assert.deepEqual(f.calls,[]);assert.equal(fs.readdirSync(f.root,{recursive:true}).some(name=>/receipts|\.json$/.test(String(name))),false);
});
test('sign-out rejects reads; new account gets unavailable, not old security facts',async t=>{
 const f=fixture(t);
 assert.equal((await f.run({method:'GET',path:'/api/auth/mfa'})).status,503);
 f.logout();assert.equal((await f.run({method:'GET',path:'/api/auth/mfa'})).status,401);
 f.switch();const r=await f.run({method:'GET',path:'/api/auth/mfa'});
 assert.equal(r.status,503);assert.equal(JSON.parse(Buffer.from(r.body).toString()).error.details.error_code,'mfa_unavailable');
 assert.deepEqual(f.calls,[]);
});
