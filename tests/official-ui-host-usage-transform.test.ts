import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  deriveOfficialUiHostUsageModule,
  hostUsageInputHashes,
  // @ts-expect-error Build-time pinned JavaScript helper intentionally has no declaration file.
} from "../scripts/official-ui-host-usage.mjs";
// @ts-expect-error Build-time pinned JavaScript helper intentionally has no declaration file.
import { deriveOfficialUiHostAuthModule } from "../scripts/official-ui-host-auth.mjs";
import { brandedModule } from "../scripts/official-web-assets.mjs";
import { cost } from "../src/settings/usage-activity/format";
const root = process.cwd();
const source = fs.readFileSync(
  path.join(root, "scripts/official-host/usage-panel.mjs"),
  "utf8",
);
function panel(overrides: any = {}) {
  const hooks = {
    HostUsageActivity: "OriginalClaudexUsageActivity",
    useUsageLocale: () => ({
      ready: true,
      text: (value: string) => value,
      money: (value: number) => cost(value, "en-US"),
      date: (value: number | string) => new Date(value).toLocaleString("en-US"),
    }),
    SettingsSection: "OriginalSettingsSection",
    Button: "OriginalButton",
    Skeleton: "OriginalSkeleton",
    UsageMeter: "OriginalUsageMeter",
    Progress: {
      Root: "OriginalProgress",
      Track: "OriginalTrack",
      Indicator: "OriginalIndicator",
    },
    Dialog: {
      Root: "DialogRoot",
      Trigger: "DialogTrigger",
      Popup: "DialogPopup",
      Header: "DialogHeader",
      CloseButton: "DialogCloseButton",
      Footer: "DialogFooter",
    },
    useId: () => "amount-help",
    useIntl: () => ({
      locale: "en-US",
      formatMessage: (
        { defaultMessage }: { defaultMessage: string },
        values: Record<string, string> = {},
      ) => defaultMessage.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? ""),
    }),
    useSpendAmount: ({ valueMinor }: { valueMinor: number | null }) => ({
      error: null,
      inputProps: { value: valueMinor },
      reset: () => {},
    }),
    useSpendAmountErrors: () => ({}),
    formatSpendAmount: (
      cents: number,
      _currency: string,
      options: { preferWholeNumber?: boolean } = {},
    ) =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits:
          options.preferWholeNumber && cents % 100 === 0 ? 0 : 2,
      }).format(cents / 100),
    useState: () => [null, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: 0 }),
    jsx: (tag: any, props: any) => ({ tag, props }),
    jsxs: (tag: any, props: any) => ({ tag, props }),
    fetch: () => {
      throw Error("Unexpected fetch");
    },
    ...overrides,
  };
  return new Function(
    ...Object.keys(hooks),
    source
      .replace(/^import \{[^}]*\} from "\.\/[^"]+\.js";$/gm, "")
      .replace(/export (?=(?:async )?function)/g, "") +
      "\nreturn {hasHostUsage,HostUsagePanel,validateUsageSummary,readUsageSummary};",
  )(...Object.values(hooks));
}
const account = {
  uuid: "owner",
  claudex_host_authentication: {
    version: 1,
    status: "authenticated",
    account_uuid: "owner",
  },
  claudex_usage_summary: {
    version: 1,
    account_uuid: "owner",
    organization_uuid: "org",
    read_only: true,
  },
};
const organization = { uuid: "org" };
test("capability is separately authenticated and exactly account/org bound", () => {
  const { hasHostUsage } = panel();
  assert.equal(hasHostUsage(account, organization), true);
  for (const a of [
    null,
    { uuid: "owner" },
    { ...account, uuid: "other" },
    { ...account, claudex_host_authentication: undefined },
    {
      ...account,
      claudex_usage_summary: {
        ...account.claudex_usage_summary,
        read_only: false,
      },
    },
  ])
    assert.equal(hasHostUsage(a, organization), false);
  assert.equal(hasHostUsage(account, { uuid: "other" }), false);
});
test("pinned modules derive with exact pane/nav scope and fail on changed input", () => {
  for (const name of Object.keys(hostUsageInputHashes)) {
    const input = brandedModule(
      deriveOfficialUiHostAuthModule(
        name,
        fs.readFileSync(
          path.join(
            root,
            ".restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1",
            name,
          ),
          "utf8",
        ),
      ),
    );
    const output = deriveOfficialUiHostUsageModule(name, input);
    assert.match(output, /claudex-host-usage\.js/);
    assert.notEqual(input, output);
    assert.throws(
      () => deriveOfficialUiHostUsageModule(name, input + " "),
      /checksum/,
    );
  }
  assert.equal(
    deriveOfficialUiHostUsageModule("unlisted.js", "original"),
    "original",
  );
});
test("owner mismatch cannot flash earlier account balances", () => {
  let index = 0;
  const { HostUsagePanel } = panel({
    useState: () =>
      index++ === 0
        ? [0, () => {}]
        : [
            { owner: "previous", org: "org", data: { balance: 987654 } },
            () => {},
          ],
  });
  const output = JSON.stringify(HostUsagePanel({ account, organization }));
  assert.match(output, /Loading account usage/);
  assert.doesNotMatch(output, /987654/);
});
test("late read after account cleanup cannot set account data", async () => {
  let effect: any,
    resolve: any,
    updates: any[] = [];
  const waiting = new Promise((r) => (resolve = r));
  const { HostUsagePanel } = panel({
    useEffect: (fn: any) => (effect = fn),
    useState: () => [0, (v: any) => updates.push(v)],
    fetch: () => waiting,
  });
  HostUsagePanel({ account, organization });
  const cleanup = effect();
  cleanup();
  resolve(
    new Response(
      JSON.stringify({
        version: 1,
        account_uuid: "owner",
        organization_uuid: "org",
        currency: "USD",
        observed_at: new Date().toISOString(),
        billing: { state: "unavailable" },
        plan_usage: { state: "unavailable" },
        spend_limit: { state: "unavailable" },
      }),
    ),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].loading, true);
});
test("current source errors are visible and no spend editor is shown", () => {
  let index = 0;
  const { HostUsagePanel } = panel({
    useState: () =>
      index++ === 0
        ? [0, () => {}]
        : [{ owner: "owner", org: "org", error: true }, () => {}],
  });
  const output = JSON.stringify(HostUsagePanel({ account, organization }));
  assert.match(output, /could not be loaded/);
  assert.match(output, /Refresh/);
  assert.doesNotMatch(output, /Manage|Set spend limit/);
});

test("bounded UTF8 reader cancels oversized response and malformed available data rejects before render", async () => {
  const { readUsageSummary, validateUsageSummary } = panel();
  let cancelled = false;
  await assert.rejects(
    () =>
      readUsageSummary(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(601 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      ),
    /Oversized/,
  );
  assert.equal(cancelled, true);
  const data = {
    version: 1,
    account_uuid: "owner",
    organization_uuid: "org",
    currency: "USD",
    observed_at: new Date().toISOString(),
    billing: { state: "unavailable" },
    plan_usage: {
      state: "available",
      data: { plan: "actual", expiresAt: null, updatedAt: 0, windows: null },
    },
    spend_limit: { state: "unavailable" },
  };
  assert.throws(
    () => validateUsageSummary(data, "owner", "org"),
    /Invalid usage/,
  );
});

test('pane wrappers keep unmarked vendor component and route only marked host to readonly view', async () => {
  // @ts-expect-error Build-time pinned JavaScript helper intentionally has no declaration file.
  const {hostUsageRules}=await import('../scripts/official-ui-host-usage.mjs');
  const usage=hostUsageRules.find((r:any)=>r.name==='host-readonly-usage-pane')!.after;
  const billing=hostUsageRules.find((r:any)=>r.name==='host-readonly-billing-pane')!.after.split('\nvar Ng')[0];
  const {hasHostUsage}=panel();
  for(const marked of [false,true]){
    const state={account:marked?account:{uuid:'owner'},activeOrganization:organization};
    const jsx=(tag:any,props:any)=>({tag,props});
    const readUsage=new Function('Ne','g','hs','__claudexHasUsage','__claudexUsagePanel',usage+'\nreturn gs();');
    assert.equal(readUsage(()=>state,jsx,'original-usage',hasHostUsage,'host-readonly').tag,marked?'host-readonly':'original-usage');
    const props={retained:'yes'};
    const readBilling=new Function('Er','b','zg','jp','__claudexHasUsage','__claudexUsagePanel','props',billing+'\nreturn __claudexBillingPane(props);');
    const row = () => null;
    const result=readBilling(()=>state,jsx,'original-billing',row,hasHostUsage,'host-readonly',props);
    assert.equal(result.tag,marked?'host-readonly':'original-billing');
    if(marked)assert.equal(result.props.BillingRow,row);
    if(!marked)assert.equal(result.props,props);
  }
});

test('a stalled source times out into a retryable error and aborts the read',()=>{
 let effect:any,timer:any,signal:any;const updates:any[]=[];
 const {HostUsagePanel}=panel({useEffect:(fn:any)=>effect=fn,useState:()=>[0,(v:any)=>updates.push(v)],setTimeout:(fn:any,ms:number)=>{assert.equal(ms,30000);timer=fn;return 1;},clearTimeout:()=>{},fetch:(_url:any,options:any)=>{signal=options.signal;return new Promise(()=>{});}});
 HostUsagePanel({account,organization});const cleanup=effect();timer();assert.equal(signal.aborted,true);assert.equal(updates.at(-1).error,true);cleanup();
});

test('partial unavailable/error sources never display a fabricated zero or unlimited balance',()=>{
 let i=0;
 const data={observed_at:new Date().toISOString(),billing:{state:'unavailable'},plan_usage:{state:'error'},spend_limit:{state:'unavailable'}};
 const {HostUsagePanel}=panel({useState:()=>i++===0?[0,()=>{}]:[{owner:'owner',org:'org',data},()=>{}]});
 const text=JSON.stringify(HostUsagePanel({account,organization}));
 assert.match(text,/Usage is unavailable/);assert.match(text,/could not be loaded/);assert.doesNotMatch(text,/\$0|Unlimited \(reported/);
});

test('all six authoritative windows and negative balance remain visible, without tier inference',()=>{
 let i=0;const kinds=['session','all_models','models','daily','monthly','key'];
 const data={observed_at:new Date().toISOString(),billing:{state:'available',data:{plan:null,planExpiresAt:null,balanceUsd:-3.25}},plan_usage:{state:'available',data:{plan:'Actual service name',expiresAt:null,updatedAt:0,windows:kinds.map((kind,n)=>({id:String(n),kind,label:'Window '+kind,usedUsd:n,limitUsd:10,percent:n*10,resetsAt:null,windowSeconds:null,models:null,active:true,exceeded:false}))}},spend_limit:{state:'available',data:{limitUsd:0,usedUsd:0,resetsAt:'2026-12-01T00:00:00Z'}}};
 const {HostUsagePanel}=panel({useState:()=>i++===0?[0,()=>{}]:[{owner:'owner',org:'org',data},()=>{}]});const text=JSON.stringify(HostUsagePanel({account,organization}));
 for(const kind of kinds)assert.ok(text.includes('Window '+kind));assert.match(text,/-\$3\.25/);assert.doesNotMatch(text,/No plan reported/);assert.doesNotMatch(text,/Unlimited \(reported/);assert.doesNotMatch(text,/Usage snapshot read at/);
});

test('repeat refresh aborts old read; only latest read can publish data',async()=>{
 let effect:any,i=0,revision=0;const updates:any[]=[], pending:any[]=[], ref={current:0};
 const {HostUsagePanel}=panel({useState:()=>i++%2===0?[revision,()=>{}]:[null,(state:any)=>updates.push(state)],useRef:()=>ref,useEffect:(fn:any)=>effect=fn,fetch:(_url:any,options:any)=>new Promise(resolve=>pending.push({resolve,signal:options.signal}))});
 HostUsagePanel({account,organization});const oldCleanup=effect();oldCleanup();revision++;
 HostUsagePanel({account,organization});const newCleanup=effect();
 const summary=(value:number)=>new Response(JSON.stringify({version:1,account_uuid:'owner',organization_uuid:'org',currency:'USD',observed_at:new Date().toISOString(),billing:{state:'available',data:{balanceUsd:value,plan:null,planExpiresAt:null}},plan_usage:{state:'unavailable'},spend_limit:{state:'unavailable'}}));
 pending[0].resolve(summary(111));pending[1].resolve(summary(222));await new Promise(r=>setImmediate(r));
 assert.equal(pending[0].signal.aborted,true);const published=updates.filter(x=>x.data);assert.equal(published.length,1);assert.equal(published[0].data.billing.data.balanceUsd,222);newCleanup();
});

test('A to B to A activation cleanup never revives the first A read',async()=>{
 let effect:any,i=0;const updates:any[]=[],pending:any[]=[],ref={current:0};
 const {HostUsagePanel}=panel({useState:()=>i++%2===0?[0,()=>{}]:[null,(state:any)=>updates.push(state)],useRef:()=>ref,useEffect:(fn:any)=>effect=fn,fetch:(_url:any,options:any)=>new Promise(resolve=>pending.push({resolve,signal:options.signal}))});
 const b={...account,uuid:'second',claudex_host_authentication:{...account.claudex_host_authentication,account_uuid:'second'},claudex_usage_summary:{...account.claudex_usage_summary,account_uuid:'second'}};
 HostUsagePanel({account,organization});effect()();
 HostUsagePanel({account:b,organization});effect()();
 HostUsagePanel({account,organization});const cleanup=effect();
 for(const [index,owner] of ['owner','second','owner'].entries())pending[index].resolve(new Response(JSON.stringify({version:1,account_uuid:owner,organization_uuid:'org',currency:'USD',observed_at:new Date().toISOString(),billing:{state:'available',data:{balanceUsd:index+1,plan:null,planExpiresAt:null}},plan_usage:{state:'unavailable'},spend_limit:{state:'unavailable'}})));
 await new Promise(r=>setImmediate(r));const published=updates.filter(x=>x.data);assert.equal(published.length,1);assert.equal(published[0].owner,'owner');assert.equal(published[0].data.billing.data.balanceUsd,3);assert.equal(pending[0].signal.aborted,true);assert.equal(pending[1].signal.aborted,true);cleanup();
});

test('refresh requests exact fresh=1; initial load remains ordinary readonly GET',()=>{
 let i=0,effect:any;const urls:string[]=[];
 for(const revision of [0,1,2]){
   i=0;const {HostUsagePanel}=panel({useState:()=>i++===0?[revision,()=>{}]:[null,()=>{}],useEffect:(fn:any)=>effect=fn,fetch:(url:string)=>{urls.push(url);return new Promise(()=>{});}});
   HostUsagePanel({account,organization});effect()();
 }
 assert.deepEqual(urls,['/api/organizations/org/claudex_usage_summary','/api/organizations/org/claudex_usage_summary?fresh=1','/api/organizations/org/claudex_usage_summary?fresh=1']);
});

interface Element {
  tag: string;
  props: {
    children?: unknown;
    [property: string]: unknown;
  };
}

function isElement(value: unknown): value is Element {
  return (
    value !== null &&
    typeof value === "object" &&
    "tag" in value &&
    typeof value.tag === "string" &&
    "props" in value &&
    value.props !== null &&
    typeof value.props === "object"
  );
}

function element(
  root: Element,
  tag: string,
  name?: string,
): Element | undefined {
  if (root.tag === tag && (name === undefined || root.props.children === name))
    return root;
  const children = root.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    if (isElement(child)) {
      const match = element(child, tag, name);
      if (match) return match;
    }
  }
}

function spendEditor({
  initial,
  canWrite = true,
  send = () => new Response(null, { status: 503 }),
}: {
  initial: number | null;
  canWrite?: boolean;
  send?: (body: { monthly_credit_limit: number | null }) => Response;
}) {
  let draft: unknown = null;
  let reads = 0;
  let hook = 0;
  let edit = (_cents: number) => {};
  const requests: {
    url: string;
    options: RequestInit;
    body: { monthly_credit_limit: number | null };
  }[] = [];
  const { HostUsagePanel } = panel({
    useState: () => {
      switch (hook++) {
        case 0:
          return [0, () => reads++];
        case 1:
          return [
            {
              owner: "owner",
              org: "org",
              data: {
                billing: { state: "unavailable" },
                plan_usage: { state: "unavailable" },
                spend_limit: {
                  state: "available",
                  data: {
                    limitUsd: initial,
                    usedUsd: 0.0000128,
                    resetsAt: "2026-12-01",
                  },
                },
                spend_limit_write: canWrite ? true : undefined,
                spend_limit_activation_lease: "account-activation",
              },
            },
            () => {},
          ];
        default:
          return [
            draft,
            (next: unknown) => {
              draft = typeof next === "function" ? next(draft) : next;
            },
          ];
      }
    },
    useRef: () => ({ current: null }),
    useSpendAmount: ({
      valueMinor,
      onChangeMinor,
    }: {
      valueMinor: number | null;
      onChangeMinor: (cents: number) => void;
    }) => {
      edit = onChangeMinor;
      return {
        error: null,
        inputProps: { value: valueMinor },
        reset: () => {},
      };
    },
    fetch: async (url: string, options: RequestInit) => {
      if (typeof options.body !== "string") assert.fail("Missing JSON body");
      const body = JSON.parse(options.body);
      requests.push({ url, options, body });
      return send(body);
    },
  });
  const render = (view = "Billing"): Element => {
    hook = 0;
    const output: { props: { children: (Element | false)[] } } = HostUsagePanel({
      account,
      organization,
      view,
    });
    for (const node of output.props.children) {
      const child = node && node.props.children;
      if (
        child !== null &&
        typeof child === "object" &&
        "tag" in child &&
        typeof child.tag === "function" &&
        "props" in child
      )
        return child.tag(child.props);
    }
    assert.fail("Missing spend row");
  };
  const setOpen = (open: boolean) => {
    const { onOpenChange } = render().props;
    if (typeof onOpenChange !== "function")
      assert.fail("Missing dialog action");
    onOpenChange(open);
  };
  const click = async (name: string) => {
    const action = element(render(), "OriginalButton", name);
    assert.ok(action);
    assert.equal(action.props.disabled, false);
    const { onClick } = action.props;
    if (typeof onClick !== "function") assert.fail("Missing button action");
    await onClick();
  };
  return {
    render,
    setOpen,
    click,
    requests,
    edit: (cents: number) => edit(cents),
    reads: () => reads,
  };
}

test("monthly limit shows exact cents or no limit and only offers Manage when writable", () => {
  const readonly = spendEditor({ initial: null, canWrite: false });
  const usage = readonly.render("Usage");
  assert.match(JSON.stringify(usage), /\$0\.0000128 this month · No spend limit/);
  assert.equal(element(usage, "DialogTrigger", "Manage"), undefined);

  const writable = spendEditor({ initial: 20.5 });
  for (const view of ["Billing", "Usage"]) {
    const summary = writable.render(view);
    assert.match(JSON.stringify(summary), /\$0\.0000128 of \$20\.50 this month/);
    assert.ok(element(summary, "DialogTrigger", "Manage"));
  }
});

test("closing the spend editor writes nothing and discards its draft", () => {
  const editor = spendEditor({ initial: 20.5 });
  editor.setOpen(true);
  assert.equal(element(editor.render(), "input")?.props.value, 2050);
  editor.edit(9999);
  editor.setOpen(false);
  assert.equal(editor.render().props.open, false);
  assert.deepEqual(editor.requests, []);
  editor.setOpen(true);
  assert.equal(element(editor.render(), "input")?.props.value, 2050);
});

test("failed and mismatched saves preserve the draft, while exact zero and unlimited refresh", async () => {
  let attempt = 0;
  const editor = spendEditor({
    initial: 20.5,
    send: (body) => {
      attempt++;
      if (attempt === 1) return new Response(null, { status: 503 });
      return Response.json({
        organization_uuid: attempt === 2 ? "different-org" : "org",
        currency: "USD",
        monthly_credit_limit: body.monthly_credit_limit,
      });
    },
  });
  editor.setOpen(true);
  editor.edit(0);
  for (let n = 0; n < 2; n++) {
    await editor.click("Set spend limit");
    const dialog = editor.render();
    assert.equal(dialog.props.open, true);
    assert.equal(element(dialog, "input")?.props.value, 0);
    assert.match(
      JSON.stringify(dialog),
      /There was an error submitting your request/,
    );
    assert.equal(editor.reads(), 0);
  }
  await editor.click("Set spend limit");
  assert.equal(editor.render().props.open, false);
  assert.equal(editor.reads(), 1);
  editor.setOpen(true);
  await editor.click("Set to unlimited");
  assert.equal(editor.render().props.open, false);
  assert.equal(editor.reads(), 2);
  assert.deepEqual(
    editor.requests.map(({ url, options, body }) => ({
      url,
      method: options.method,
      activation: new Headers(options.headers).get(
        "x-claudex-spend-limit-activation",
      ),
      body,
    })),
    [0, 0, 0, null].map((value) => ({
      url: "/api/organizations/org/overage_spend_limit",
      method: "PUT",
      activation: "account-activation",
      body: { monthly_credit_limit: value, currency: "USD", period: "monthly" },
    })),
  );
});
