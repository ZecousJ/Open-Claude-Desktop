import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppContext } from '../electron/app/app-context';
import { registerUsageStatsHandlers } from '../electron/ipc/usage-stats';
import { usageActivityRoute } from '../electron/official-ui/api/usage-activity';
import { organizationUuid } from '../electron/official-ui/api/context';
import { isOfficialUiQuery } from '../shared/official-ui-web';
const org=organizationUuid('owner');
const root=`/api/organizations/${org}/claudex_usage_activity`;
function fixture() {
 let identity:any={}, owner='owner', calls:any[]=[];
 let operation: any=async()=>({items:[],total:0,page:1,pages:1});
 const ctx:any={account:()=>({id:owner}), sessionIdentity:()=>identity,isCurrent:()=>true,call:async(...args:any[])=>{calls.push(args);return operation(...args);}};
 return {calls,set:(fn:any)=>operation=fn,retire:()=>identity={},owner:(v:string)=>owner=v,async read(path:string,method='GET') {
  let status=0,body:any; const res:any={writeHead:(s:number)=>status=s,end:(data:any)=>body=JSON.parse(String(data))};
  const handled=await usageActivityRoute({method} as any,res,new URL(path,'http://localhost').pathname,new URL(path,'http://localhost'),ctx);
  return {status,body,handled};
 }};
}
test('exact read routes preserve page/model and exclude payment/mutation/arbitrary query',async()=>{
 const f=fixture(), query='?page=2&pageSize=10&start=2026-11-01&end=2026-11-03&model=fixture';
 assert.equal(isOfficialUiQuery('GET',`${root}/records`,query),true);
 assert.equal((await f.read(`${root}/records${query}`)).status,200);
 assert.deepEqual(f.calls,[['usageRecords',{page:2,pageSize:10,start:'2026-11-01',end:'2026-11-03',model:'fixture'}]]);
 for(const [path,method] of [[`${root}/overview?token=x`,'GET'],[`${root}/records${query}&page=3`,'GET'],[`${root}/overview`,'POST'],[`${root}/billing`,'GET']]){
  assert.equal(isOfficialUiQuery(method,path.split('?')[0],path.includes('?')?'?'+path.split('?')[1]:''),false);
  await f.read(path,method);
 }
 assert.equal(f.calls.length,1);
});
test('foreign org and late same-account reactivation never return account data',async()=>{
 const f=fixture();
 assert.equal((await f.read(root.replace(org,organizationUuid('foreign'))+'/overview')).status,404);
 assert.equal(f.calls.length,0);
 f.set(async()=>{f.retire();return {private:true};});
 const result=await f.read(root+'/overview');assert.equal(result.status,409);assert.equal(JSON.stringify(result).includes('private'),false);
});
test('service failure is an error not fabricated empty success; no retry',async()=>{
 const f=fixture();f.set(async()=>{throw Error('inert private service body');});
 const result=await f.read(root+'/overview'); assert.equal(result.status,503);assert.equal(f.calls.length,1);assert.equal(JSON.stringify(result).includes('private'),false);
});

test('activity reads carry the browser calendar to every service endpoint', async (t) => {
  const f = fixture();
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  registerUsageStatsHandlers((name, handler) => { handlers.set(name, handler); }, {
    activeAccount: { id: 'owner' },
    store: {},
    accountActivationIdentity: {},
    accountRetiring: false,
    onAccountDeactivating() {},
    onAccountActivated() {},
    remote: {
      ready: true,
      backend: {
        accounts: { baseUrl: 'https://fixture.invalid' },
        session: { authorized: (call: (token: string) => unknown) => call('test-token') },
      },
    },
  } as unknown as AppContext);
  f.set((method: string, ...args: unknown[]) => handlers.get(method)?.(...args));

  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input);
    paths.push(`${url.pathname}${url.search}`);
    const results: Record<string, unknown> = {
      '/api/v1/usage/dashboard/stats': { total_actual_cost: 0, today_actual_cost: 0, total_cost: 0, today_cost: 0 },
      '/api/v1/user/platform-quotas': {},
      '/api/v1/usage/dashboard/trend': { trend: [] },
      '/api/v1/usage/dashboard/models': { models: [] },
      '/api/v1/usage': { items: [], total: 0, page: 1, pages: 1 },
    };
    return Response.json({ code: 0, data: results[url.pathname] });
  });

  const zone = 'timezone=America%2FLos_Angeles';
  const dates = 'start=2026-11-14&end=2026-11-14';
  assert.equal((await f.read(`${root}/overview?${zone}`)).status, 200);
  assert.equal((await f.read(`${root}/breakdown?${zone}&${dates}&granularity=hour`)).status, 200);
  assert.equal((await f.read(`${root}/records?${zone}&${dates}&page=1&pageSize=10`)).status, 200);
  assert.deepEqual(paths, [
    `/api/v1/usage/dashboard/stats?${zone}`,
    '/api/v1/user/platform-quotas',
    `/api/v1/usage/dashboard/trend?start_date=2026-11-14&end_date=2026-11-14&granularity=hour&${zone}`,
    `/api/v1/usage/dashboard/models?start_date=2026-11-14&end_date=2026-11-14&${zone}`,
    `/api/v1/usage?page=1&page_size=10&${zone}&start_date=2026-11-14&end_date=2026-11-14`,
  ]);
  assert.equal((await f.read(`${root}/overview`)).status, 200);
  assert.equal(paths.at(-2), '/api/v1/usage/dashboard/stats');
  for (const value of ['', 'Unknown%2FZone', '%2B05%3A30', 'UTC&timezone=UTC']) {
    const search = `?timezone=${value}`;
    assert.equal(isOfficialUiQuery('GET', `${root}/overview`, search), false);
    assert.equal((await f.read(`${root}/overview${search}`)).status, 400);
  }
  assert.equal(paths.length, 7);
});
