import test from 'node:test';import assert from 'node:assert/strict';import {acceptanceTransportRecord} from '../electron/sub2api/acceptance-diagnostics';
test('public transport diagnostic has bounded classifications only, never raw error or credential details',()=>{
 const result=acceptanceTransportRecord({stage:'failure',globalFetch:true,expectedService:true,envProxy:true,hasProxy:true,hasExtraCa:true,dispatcher:'Agent',error:{name:'TypeError',message:'PASSWORD SECRET URL',cause:{code:'ECONNREFUSED',message:'TOKEN SECRET'}}});
 assert.equal(result.causeCode,'ECONNREFUSED');assert.equal(result.dispatcher,'Agent');assert.doesNotMatch(JSON.stringify(result),/SECRET|PASSWORD|TOKEN|URL/);
 const other=acceptanceTransportRecord({stage:'failure',globalFetch:false,expectedService:false,envProxy:false,hasProxy:false,hasExtraCa:false,dispatcher:'SECRET',error:{name:'SECRET',cause:{code:'SECRET https://bad'}}});assert.doesNotMatch(JSON.stringify(other),/SECRET|https/);
});
test('actual transport diagnostic is opt-in and excluded from authenticated, body, query and other endpoints',async()=>{
 const {requestJsonResult}=await import('../electron/sub2api/http');
 const old=process.env.CLAUDEX_ACCEPTANCE_NETWORK_DIAGNOSTICS,info=console.info;const seen:unknown[][]=[];
 const fake:any=async()=>new Response(JSON.stringify({code:0,data:{}}),{status:200});
 try {
  console.info=(...args:unknown[])=>{seen.push(args);};delete process.env.CLAUDEX_ACCEPTANCE_NETWORK_DIAGNOSTICS;
  await requestJsonResult(fake,'https://fixture.invalid/api/v1/settings/public');assert.equal(seen.length,0);
  process.env.CLAUDEX_ACCEPTANCE_NETWORK_DIAGNOSTICS='1';
  for(const [url,opts] of [['https://fixture.invalid/api/v1/settings/public',{token:'inert-fixture'}],['https://fixture.invalid/api/v1/settings/public',{body:{sample:true}}],['https://fixture.invalid/api/v1/settings/public?q=inert',{}],['https://fixture.invalid/api/v1/auth/login',{}]] as const)await requestJsonResult(fake,url,opts);
  assert.equal(seen.length,0);
  await requestJsonResult(fake,'https://fixture.invalid/api/v1/settings/public');assert.equal(seen.length,2);assert.doesNotMatch(JSON.stringify(seen),/fixture\.invalid|inert-fixture/);
 } finally {console.info=info;if(old===undefined)delete process.env.CLAUDEX_ACCEPTANCE_NETWORK_DIAGNOSTICS;else process.env.CLAUDEX_ACCEPTANCE_NETWORK_DIAGNOSTICS=old;}
});
