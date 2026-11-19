import test from 'node:test';import assert from 'node:assert/strict';import{negotiatedMemoryAction}from'../../src-web/official/negotiated-memory-action';
const path='/api/organizations/11111111-1111-4111-8111-111111111111/memory/controls';
function fixture(){let current=true,reads=0,writes=0;const status:string[]=[];let cap:any={version:1,accountId:'owner',activationLease:'inert',controls:{state:'ready',reason:'ready'},generation:'unavailable',settings:'unavailable',reset:'unavailable'};const input={enabled:true,accountId:'owner',current:()=>current,read:async()=>{reads++;return{status:200,contentType:'application/json',body:new TextEncoder().encode(JSON.stringify(cap))}},action:async(_request:any)=>{writes++;return{status:200,contentType:'application/json',body:new TextEncoder().encode('{}')}},onStatus:(s:string):void=>{status.push(s)}};return{input,status,run:()=>negotiatedMemoryAction(input)({method:'PUT',path,body:new Uint8Array(),contentType:'application/json'}),counts:()=>({reads,writes}),retire:()=>current=false,cap:(v:any)=>cap=v}}
test('browser memory action default off sends no discovery/write; enabled rechecks every operation',async()=>{const f=fixture();f.input.enabled=false;assert.equal((await f.run()).status,501);assert.deepEqual(f.counts(),{reads:0,writes:0});f.input.enabled=true;await f.run();await f.run();assert.deepEqual(f.counts(),{reads:2,writes:2});assert.match(f.status[0],/does not enable generation/);});
test('wrong account/unavailable/malformed capability and unsupported operation do not send',async()=>{for(const cap of [{},{version:1,accountId:'other'},{version:1,accountId:'owner',activationLease:'x',controls:{state:'denied'},generation:'unavailable',settings:'unavailable',reset:'unavailable'}]){const f=fixture();f.cap(cap);assert.equal((await f.run()).status,501);assert.equal(f.counts().writes,0);}const f=fixture();assert.equal((await negotiatedMemoryAction(f.input)({method:'POST',path:path.replace('controls','unknown')})).status,501);assert.equal(f.counts().reads,0);});
test('retirement during discovery or status callback never writes; unknown write is never retried',async()=>{for(const stage of ['read','status']){const f=fixture();if(stage==='read'){const original=f.input.read;f.input.read=async()=>{const r=await original();f.retire();return r}}else f.input.onStatus=()=>f.retire();assert.equal((await f.run()).status,409);assert.equal(f.counts().writes,0);}const f=fixture();let calls=0;f.input.action=async()=>{calls++;throw Error('inert unknown')};await assert.rejects(f.run(),/inert unknown/);assert.equal(calls,1);});

test("explicit synthesis requires advertised support and keeps controls compatible", async () => {
  const f = fixture();
  const capability = JSON.parse(new TextDecoder().decode((await f.input.read()).body));
  const run = negotiatedMemoryAction(f.input);
  const synthesis = { method: "POST", path: path.replace("controls", "synthesize") } as const;
  assert.equal((await run(synthesis)).status, 501);
  assert.equal(f.counts().writes, 0);
  f.cap({ ...capability, synthesis: true });
  assert.equal((await run(synthesis)).status, 501);
  assert.equal(f.counts().writes, 0);
  f.cap({ ...capability, synthesis: "ready" });
  assert.equal((await f.run()).status, 200);
  f.input.enabled = false;
  assert.equal((await run(synthesis)).status, 200);
  assert.equal((await run({ ...synthesis, path: synthesis.path + "?project_uuid=1" })).status, 501);
  assert.equal(f.counts().writes, 2);
});
