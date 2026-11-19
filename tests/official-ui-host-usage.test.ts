import test from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { hostUsageRoute } from "../electron/official-ui/api/host-usage";
import {
  organizationUuid,
  type AdapterContext,
} from "../electron/official-ui/api/context";

const window = (kind = "session") => ({
  id: kind,
  kind,
  label: `Actual ${kind}`,
  windowSeconds: null,
  usedUsd: 0,
  limitUsd: 10,
  percent: 0,
  resetsAt: null,
  active: false,
  exceeded: false,
  models: null,
});
function fixture() {
  let owner: string | undefined = "owner",
    activation = 1,
    current = true;
  const calls: [string, unknown[]][] = [];
  const values: Record<string, unknown> = {
    billingInfo: {
      plan: null,
      planExpiresAt: null,
      balance: 0,
      subscriptions: [],
    },
    planUsage: {
      plan: "Actual service label",
      expiresAt: null,
      windows: [
        "session",
        "all_models",
        "models",
        "daily",
        "monthly",
        "key",
      ].map(window),
      updatedAt: 1793635200000,
      warnPercent: 80,
      learnMoreUrl: null,
      balanceUsd: null,
    },
    spendLimit: {
      limitUsd: null,
      usedUsd: 0,
      resetsAt: "2026-12-01T00:00:00.000Z",
    },
  };
  let onCall: ((name: string) => void) | undefined;
  // Intentionally minimal mocked route context; no network or authenticated service.
  const ctx = {
    account: () => (owner ? { id: owner } : undefined),
    sessionIdentity: () => activation,
    isCurrent: () => current,
    call: async (name: string, ...args: unknown[]) => {
      calls.push([name, args]);
      onCall?.(name);
      const value = values[name];
      if (value instanceof Error) throw value;
      return value;
    },
  } as unknown as AdapterContext;
  async function request(
    options: {
      method?: string;
      org?: string;
      query?: string;
      path?: string;
    } = {},
  ) {
    const path =
      options.path ??
      `/api/organizations/${options.org ?? organizationUuid("owner")}/claudex_usage_summary`;
    let status = 0,
      body: any,
      headers: any;
    const res = {
      writeHead(code: number, value: unknown) {
        status = code;
        headers = value;
      },
      end(value: string) {
        body = JSON.parse(value);
      },
    } as unknown as http.ServerResponse;
    const matched = await hostUsageRoute(
      { method: options.method ?? "GET" } as http.IncomingMessage,
      res,
      path,
      new URL(`http://local${path}${options.query ?? ""}`),
      ctx,
    );
    return { status, body, headers, matched };
  }
  return {
    values,
    calls,
    request,
    change: () => activation++,
    signOut: () => (owner = undefined),
    switchOwner: () => (owner = "foreign"),
    retire: () => (current = false),
    onCall: (fn: (name: string) => void) => (onCall = fn),
  };
}

test("actual zero, unlimited and every service window preserved without vendor inference", async () => {
  const f = fixture(),
    r = await f.request();
  assert.equal(r.status, 200);
  assert.equal(r.body.account_uuid, "owner");
  assert.equal(r.body.organization_uuid, organizationUuid("owner"));
  assert.equal(r.body.currency, "USD");
  assert.ok(Number.isFinite(Date.parse(r.body.observed_at)));
  assert.deepEqual(r.body.billing, {
    state: "available",
    data: { plan: null, planExpiresAt: null, balanceUsd: 0 },
  });
  assert.deepEqual(r.body.plan_usage.data, f.values.planUsage);
  assert.deepEqual(r.body.spend_limit.data, f.values.spendLimit);
  assert.equal(r.headers["Cache-Control"], "no-store");
  assert.deepEqual(f.calls, [
    ["billingInfo", []],
    ["planUsage", [false]],
    ["spendLimit", []],
  ]);
  assert.equal(JSON.stringify(r.body).includes("subscriptions"), false);
});
test("null sources unavailable, never synthesized zero", async () => {
  const f = fixture();
  Object.keys(f.values).forEach((k) => (f.values[k] = null));
  const r = await f.request();
  for (const key of ["billing", "plan_usage", "spend_limit"])
    assert.deepEqual(r.body[key], { state: "unavailable" });
});
test("source failures sanitized independently and remain retryable", async () => {
  const f = fixture();
  f.values.billingInfo = Error("credential=secret");
  f.values.spendLimit = undefined;
  const r = await f.request();
  assert.equal(r.status, 200);
  assert.equal(r.body.billing.state, "error");
  assert.equal(r.body.plan_usage.state, "available");
  assert.equal(r.body.spend_limit.state, "error");
  assert.equal(JSON.stringify(r.body).includes("secret"), false);
  f.values.billingInfo = {
    plan: "Paid by service",
    planExpiresAt: 0,
    balance: 1.25,
  };
  assert.equal((await f.request()).body.billing.data.balanceUsd, 1.25);
});
test("wrong org, method, query and unrelated path never call sources", async () => {
  const f = fixture();
  assert.equal(
    (await f.request({ org: organizationUuid("foreign") })).status,
    404,
  );
  assert.equal((await f.request({ method: "POST" })).status, 405);
  assert.equal((await f.request({ method: "HEAD" })).status, 405);
  assert.equal((await f.request({ query: "?fresh=true" })).status, 400);
  assert.equal((await f.request({ path: "/unrelated" })).matched, false);
  assert.deepEqual(f.calls, []);
  f.signOut();
  assert.equal((await f.request()).status, 401);
});
for (const method of ["billingInfo", "planUsage", "spendLimit"]) {
  test(`same-account activation change after ${method} rejects all accumulated data`, async () => {
    const f = fixture();
    f.onCall((name) => {
      if (name === method) f.change();
    });
    const r = await f.request();
    assert.equal(r.status, 409);
    assert.equal(r.body.billing, undefined);
    assert.equal(f.calls.at(-1)?.[0], method);
  });
}
test("retired request rejected before any service read; owner switch rejected", async () => {
  const f = fixture();
  f.retire();
  assert.equal((await f.request()).status, 409);
  assert.equal(f.calls.length, 0);
  const g = fixture();
  g.onCall(() => g.switchOwner());
  assert.equal((await g.request()).status, 409);
  assert.equal(g.calls.length, 1);
});
test("malformed financial numbers, dates, enums, strings and arrays fail closed per source", async () => {
  const invalidPlans = [
    { windows: Array.from({ length: 257 }, () => window()) },
    { windows: [window("unknown")] },
    { windows: [window(), window()] },
    { windows: [{ ...window(), models: [23] }] },
    { windows: [{ ...window(), usedUsd: Infinity }] },
    { windows: [{ ...window(), percent: 101 }] },
    { windows: [{ ...window(), active: "yes" }] },
    { plan: "x".repeat(1025) },
    { updatedAt: NaN },
    { learnMoreUrl: "javascript:alert(1)" },
    { learnMoreUrl: "https://user:secret@example.com" },
  ];
  for (const patch of invalidPlans) {
    const f = fixture();
    f.values.planUsage = { ...(f.values.planUsage as object), ...patch };
    assert.equal((await f.request()).body.plan_usage.state, "error");
  }
  for (const balance of [NaN, Infinity, Number.MAX_VALUE, "0"]) {
    const f = fixture();
    f.values.billingInfo = { plan: null, planExpiresAt: null, balance };
    assert.equal((await f.request()).body.billing.state, "error");
  }
  for (const resetsAt of ["not date", 0, null]) {
    const f = fixture();
    f.values.spendLimit = { limitUsd: 0, usedUsd: 0, resetsAt };
    assert.equal((await f.request()).body.spend_limit.state, "error");
  }
});
test("bounded output rejects oversized valid-shaped source instead of truncating windows", async () => {
  const f = fixture();
  const windows = Array.from({ length: 256 }, (_, i) => ({
    ...window(),
    id: String(i),
    models: Array.from({ length: 128 }, () => "m".repeat(256)),
  }));
  f.values.planUsage = { ...(f.values.planUsage as object), windows };
  const r = await f.request();
  assert.equal(r.body.plan_usage.state, "error");
  assert.equal(r.body.billing.state, "available");
});

test("actual signed balance is preserved, while negative spend and limits are invalid", async () => {
  const f = fixture();
  f.values.billingInfo = { plan: null, planExpiresAt: null, balance: -1.25 };
  f.values.planUsage = { ...(f.values.planUsage as object), balanceUsd: -2.5 };
  f.values.spendLimit = {
    limitUsd: -1,
    usedUsd: 0,
    resetsAt: "2026-12-01T00:00:00.000Z",
  };
  const r = await f.request();
  assert.equal(r.body.billing.data.balanceUsd, -1.25);
  assert.equal(r.body.plan_usage.data.balanceUsd, -2.5);
  assert.equal(r.body.spend_limit.state, "error");
});

test('explicit fresh=1 refreshes real plan source; every other query is rejected',async()=>{
 const f=fixture();const result=await f.request({query:'?fresh=1'});assert.equal(result.status,200);assert.deepEqual(f.calls,[['billingInfo',[]],['planUsage',[true]],['spendLimit',[]]]);
 for(const query of ['?fresh=0','?fresh=true','?fresh=1&fresh=1','?fresh=1&extra=1','?fresh=%31','?other=1']){const x=fixture();assert.equal((await x.request({query})).status,400);assert.equal(x.calls.length,0);}
});

test('browser read bridge forwards only exact readonly summary refresh query',async()=>{
 const {createOfficialReadFetch}=await import('../src-web/official/read-fetch');const calls:string[]=[];
 const path=`/api/organizations/${organizationUuid('owner')}/claudex_usage_summary`;
 const fetcher=createOfficialReadFetch('http://fixture.invalid',async req=>{calls.push(req.path);assert.equal(req.method,'GET');return {status:200,contentType:'application/json',body:new TextEncoder().encode('{}')};},async()=>{throw Error('No native network expected');});
 assert.equal((await fetcher('http://fixture.invalid'+path+'?fresh=1')).status,200);
 for(const query of ['?fresh=true','?fresh=1&fresh=1','?fresh=0','?x=1'])assert.equal((await fetcher('http://fixture.invalid'+path+query)).status,501);
 assert.deepEqual(calls,[path+'?fresh=1']);
});

test('malformed actual legacy progress reaches summary as a source error, never empty success',async()=>{
 const {Sub2ApiClient}=await import('../electron/sub2api/client');
 const {SubscriptionUsage}=await import('../electron/sub2api/usage-source');
 const client=new Sub2ApiClient('https://fixture.invalid',async(url,init)=>{
   assert.equal(String(url),'https://fixture.invalid/api/v1/subscriptions/progress');assert.ok(!init?.method||init.method==='GET');
   return new Response(JSON.stringify({code:0,data:[{id:1,weekly:{limit_usd:5,percentage:0,resets_at:'2026-12-01T00:00:00Z'}}]}));
 });
 const usage=new SubscriptionUsage({client,session:{authorized:(read:any)=>read('fixture-not-real')},plan:()=>({groupId:2,name:'Fixture'}),publicSettings:async()=>({})} as any);
 const owner='owner',path=`/api/organizations/${organizationUuid(owner)}/claudex_usage_summary`;let body:any;
 const ctx:any={account:()=>({id:owner}),sessionIdentity:()=>1,isCurrent:()=>true,call:async(method:string)=>method==='planUsage'?usage.planUsage(80,true):null};
 const res:any={writeHead:(status:number)=>assert.equal(status,200),end:(value:string)=>body=JSON.parse(value)};
 await hostUsageRoute({method:'GET'} as any,res,path,new URL('http://fixture.invalid'+path+'?fresh=1'),ctx);
 assert.deepEqual(body.plan_usage,{state:'error',message:'Plan usage could not be read.'});assert.equal(body.billing.state,'unavailable');assert.equal(body.spend_limit.state,'unavailable');assert.equal(Object.hasOwn(body.plan_usage,'data'),false);assert.doesNotMatch(JSON.stringify(body),/fixture-not-real|windows|usedUsd/);
});
