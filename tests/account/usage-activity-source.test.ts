import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedUsageRecords, confirmedUsageOverview, confirmedUsageBreakdown } from '../../shared/usage-stats-confirmed';
import { registerUsageStatsHandlers } from '../../electron/ipc/usage-stats';
const row = { id: 1, model: 'fixture', created_at: '2026-11-03T00:00:00Z', actual_cost: .115772, total_cost: .2, input_cost: .01, output_cost: .1, cache_read_cost: .005772, cache_creation_cost: 0, rate_multiplier: .5 };
const page = () => ({ items: [{...row}], total: 1, page: 1, pages: 1 });
test('real billed amounts and empty page survive; unknown or malformed money never becomes zero', () => {
  assert.equal(confirmedUsageRecords(page()).items[0].cost, .115772);
  assert.deepEqual(confirmedUsageRecords({items:[],total:0,page:1,pages:1}).items, []);
  for(const value of [undefined, null, '0', NaN, Infinity, -1]) {
    const p = page(); (p.items[0] as any).actual_cost = value;
    assert.throws(() => confirmedUsageRecords(p));
  }
  assert.throws(() => confirmedUsageRecords({items:[],total:0}));
  assert.throws(() => confirmedUsageOverview({}, {}));
  assert.throws(() => confirmedUsageBreakdown({trend:[{cost:0}]},{models:[]}));
});
function fixture() {
  let retire!:()=>void;
  let callback: ((token:string)=>Promise<unknown>) | undefined;
  let release!: (v: unknown)=>void;
  const ctx:any = {activeAccount:{id:'A'}, store:{}, accountActivationIdentity:{}, accountRetiring:false,
    onAccountDeactivating(fn:any){retire=fn;}, onAccountActivated(){},
    remote:{ready:true,backend:{accounts:{baseUrl:'https://fixture.invalid'},session:{authorized(fn:any){callback=fn;return new Promise(resolve=>{release=resolve;});}}}}};
  const handlers = new Map<string, any>();
  registerUsageStatsHandlers(((name:string,fn:any)=>handlers.set(name,fn)) as any,ctx);
  return {ctx,handlers,retire:()=>{ctx.accountRetiring=true;retire();}, callback:()=>callback!,release:(v:unknown)=>release(v)};
}
test('actual registered read captures activation, rejects ABA before authorized transport and late result', async () => {
  const f=fixture();
  const pending=f.handlers.get('usageRecords')({page:1,pageSize:10});
  f.retire(); f.ctx.accountRetiring=false; f.ctx.accountActivationIdentity={};
  assert.throws(()=>f.callback()('inert-not-a-secret'), /account changed/);
  f.release(page());
  await assert.rejects(pending,/account changed/);
});
test('strict queries and absent service fail before any authorized transport',async()=>{
  const f=fixture();
  await assert.rejects(f.handlers.get('usageRecords')({page:1,pageSize:101}));
  assert.equal(f.callback(),undefined);
  f.ctx.remote=undefined;
  await assert.rejects(f.handlers.get('usageRecords')({page:1,pageSize:10}));
});

test('finite quota limits never turn missing or invalid usage into a displayed zero', () => {
  const stats={total_actual_cost:1,today_actual_cost:1,total_cost:1,today_cost:1,by_platform:[]};
  for(const window of ['daily','weekly','monthly']) {
    for(const value of [undefined,null,'bad',NaN,Infinity,-1]) {
      assert.throws(()=>confirmedUsageOverview(stats,{platform_quotas:[{platform:'inert',[`${window}_limit_usd`]:10,[`${window}_usage_usd`]:value}]}));
    }
    const valid=confirmedUsageOverview(stats,{platform_quotas:[{platform:'inert',[`${window}_limit_usd`]:10,[`${window}_usage_usd`]:0}]});
    assert.equal(valid.providers[0].quota[0].used,0);
  }
});

test('hourly breakdown keeps every bucket across the 90-day preset', () => {
  const hour = 60 * 60 * 1000;
  const start = Date.UTC(2026, 0, 1);
  const rows = Array.from({ length: 90 * 24 }, (_, index) => ({
    date: new Date(start + index * hour).toISOString().slice(0, 16).replace('T', ' '),
    cost: 0.5,
    actual_cost: 0.2,
  }));
  const { trend } = confirmedUsageBreakdown({ trend: rows }, { models: [] });
  assert.equal(trend.length, 2160);
  assert.equal(trend.at(-1)?.date, '2026-03-31 23:00');
  assert.equal(trend.at(-1)?.cost, 0.2);
});

test('actual usage handler passes its lease into real RemoteSession refresh persistence and signout checks',async t=>{
  const originalFetch=globalThis.fetch;let fetches=0;
  globalThis.fetch=async()=>{fetches++;throw Error('No network permitted in this inert test');};
  t.after(()=>{globalThis.fetch=originalFetch;});
  const {RemoteSession,SessionFile}=await import('../../electron/sub2api/session');
  const {Sub2ApiError}=await import('../../electron/sub2api/http');
  const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
  for(const failure of [false,true]) {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'usage-refresh-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const cipher={isEncryptionAvailable:()=>true,encryptString:(v:string)=>Buffer.from(v),decryptString:(v:Buffer)=>v.toString()};
    const record={version:1 as const,baseUrl:'https://fixture.invalid',accountId:'11111111-1111-4111-8111-111111111111',userId:1,email:'fixture@example.invalid',refreshToken:'inert-old'};
    const file=new SessionFile(root,cipher);file.save(record);
    let resolve!:(v:any)=>void,reject!:(v:any)=>void,refreshes=0,signedOut=0;
    const wait=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});
    const session=new RemoteSession({refresh:async()=>{refreshes++;return wait;}} as any,file,record);
    session.onSignedOut=()=>signedOut++;
    const ctx:any={activeAccount:{id:record.accountId},store:{},accountActivationIdentity:{},accountRetiring:false,onAccountDeactivating(){},onAccountActivated(){},remote:{ready:true,backend:{accounts:{baseUrl:record.baseUrl},session}}};
    const handlers=new Map<string,any>();registerUsageStatsHandlers(((name:string,fn:any)=>handlers.set(name,fn)) as any,ctx);
    const pending=handlers.get('usageRecords')({page:1,pageSize:10});
    await new Promise(r=>setImmediate(r));assert.equal(refreshes,1);
    ctx.accountActivationIdentity={};file.save({...record,refreshToken:'inert-replacement'});
    if(failure)reject(new Sub2ApiError(401,'SESSION_REVOKED','inert refusal'));
    else resolve({accessToken:'inert-late',refreshToken:'inert-late',expiresIn:3600});
    await assert.rejects(pending,/account changed/i);
    assert.equal(file.load()?.refreshToken,'inert-replacement');assert.equal(signedOut,0);assert.equal(fetches,0);
  }
});
