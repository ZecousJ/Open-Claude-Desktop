/** Original producer/consumer + native router; synthetic files, no SDK or UI. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createNativeAccountApi } from "../electron/official-ui/api/native-account-api";
import { organizationUuid } from "../electron/official-ui/api/context";
import { brandedModule } from "../scripts/official-web-assets.mjs";
import {
  deriveOfficialUiHostSkillSearchModule as derive,
  hostSkillSearchModeSource,
  hostSkillSearchInputHashes,
} from "../scripts/official-ui-host-skill-search.mjs";
const rawRoot = path.resolve(
  process.env.CLAUDEX_ORIGINAL_SKILL_ASSETS ??
    ".restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1",
);
const file = "c5e558aae-38ebsbqD.js";
const raw = (name: string) => fs.readFileSync(path.join(rawRoot, name), "utf8");
function fn(name: string, symbol: string) {
  const s = raw(name),
    a = s.indexOf(`function ${symbol}(`),
    b = s.indexOf("\nfunction ", a + 1);
  assert.ok(a >= 0);
  return s
    .slice(a, b < 0 ? undefined : b)
    .replace(/\nvar [\s\S]*$/, "")
    .replace(/\nexport [\s\S]*$/, "");
}
function memo(c: any) {
  c.J9 = () => [];
  for (let i = 0; i <= 5; i++) {
    c["J" + i] = () => true;
    c["K" + i] = (...a: any[]) => a.at(-1);
    c["I" + i] = (_s: any, _n: any, v: any) => v;
    c["Z" + i] = (_s: any, _n: any, v: any) => v;
  }
  return c;
}
function host() {
  return {
    account: {
      uuid: "synthetic",
      claudex_host_authentication: {
        version: 1,
        status: "authenticated",
        account_uuid: "synthetic",
      },
    },
    activeOrganization: { uuid: "synthetic-org" },
  };
}
test("host Yours alone selects existing library path; other tabs, unknown markers and original false unchanged", () => {
  const c: any = {};
  vm.createContext(c);
  vm.runInContext(hostSkillSearchModeSource, c);
  const mode = c.__claudexInstalledSkillSearchMode;
  assert.equal(mode(true, host(), "mine"), false);
  for (const tab of ["shared", "discover", undefined, ""])
    assert.equal(mode(true, host(), tab), true);
  for (const context of [
    {},
    { activeOrganization: { uuid: "x" } },
    { ...host(), activeOrganization: null },
    { ...host(), account: { ...host().account, uuid: "other" } },
    {
      ...host(),
      account: {
        ...host().account,
        claudex_host_authentication: {
          version: 2,
          status: "authenticated",
          account_uuid: "synthetic",
        },
      },
    },
  ])
    assert.equal(mode(true, context, "mine"), true);
  assert.equal(mode(false, host(), "mine"), false);
  assert.equal(mode(false, {}, "shared"), false);
  const source = derive(file, brandedModule(raw(file)));
  assert.match(
    source,
    /M = __claudexInstalledSkillSearchMode\(ze\(\), __claudexSkillSearchContext, D\)/,
  );
  assert.ok(source.includes("Ae = J1($, 3, M)"));
  assert.ok(source.includes("pt = M ? je.yoursToMatch : void 0"));
  assert.ok(source.includes("else if (N && !M)"));
  assert.throws(
    () => derive(file, brandedModule(raw(file)) + " "),
    /input mismatch/,
  );
});
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-skill-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let identity: unknown = {},
    active = true,
    fail = false,
    hook: (() => void) | undefined;
  const calls: string[] = [];
  const names = ["openai-docs", "中文技能", "alpha", "beta", "gamma", "delta"];
  const skills = names.map((name, i) => {
    const p = path.join(root, String(i), "SKILL.md");
    fs.mkdirSync(path.dirname(p));
    fs.writeFileSync(p, "Inert synthetic instructions.");
    return {
      path: p,
      name,
      description: "Synthetic",
      scope: i === 0 ? "system" : "user",
      enabled: i !== 2,
    };
  });
  const api = createNativeAccountApi({
    root: path.resolve("build/official-ui"),
    account: () => ({ id: "synthetic" }),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    isCurrent: () => active,
    log() {},
    call: async (method: string) => {
      calls.push(method);
      hook?.();
      if (fail) throw Error("PRIVATE_SOURCE_ERROR");
      if (method === "listPlugins")
        return { marketplaces: [], plugins: [], loadErrors: [] };
      assert.equal(method, "listSkills");
      return [{ skills }];
    },
  } as any);
  return {
    skills,
    calls,
    retire() {
      identity = {};
    },
    fail() {
      fail = true;
    },
    hook(fn: () => void) {
      hook = fn;
    },
    async get(url: string) {
      let status = 0,
        body: any;
      const req: any = Readable.from([]);
      req.method = "GET";
      req.url = url;
      req.headers = {};
      try {
        assert.equal(
          await api(req, {
            writeHead(n: number) {
              status = n;
            },
            end(v: any) {
              body = JSON.parse(String(v));
            },
          } as any),
          true,
        );
      } catch {
        status = 409;
      }
      return { status, body };
    },
  };
}
function consumer() {
  const c: any = memo({
    URLSearchParams,
    lN: (e: any) => typeof e === "object" && !!e && !Array.isArray(e),
  });
  vm.createContext(c);
  for (const symbol of ["bf", "UX", "Ri"])
    vm.runInContext(fn("shared-m-0-DnMCTYBX.js", symbol), c);
  vm.runInContext(fn("cc59ba715-ft7xO3rX.js", "C"), c);
  c.ae = c.UX;
  vm.runInContext(fn("c979ed9d0-C-llIJ0y.js", "Pa"), c);
  vm.runInContext(
    fn("shared-m-1-Nm0kn4Ee.js", "Tz") +
      "\n" +
      fn("shared-m-1-Nm0kn4Ee.js", "im"),
    c,
  );
  Object.assign(c, {
    Y: c.im,
    S1: () => false,
    QN: () => false,
    ue: c.Ri,
    Jt: () => ({
      builtInSkills: [],
      isLoading: false,
      isRemoteModeLoading: false,
    }),
    sc: () => [],
    wc: () => false,
    Cc: () => "",
    Sc: (e: any) => ({ kind: "skill", skill: e }),
    xc: () => null,
    bc: () => null,
    yc: (e: any) => e.kind === "skill",
    vc: (e: any) => e.kind === "plugin",
  });
  for (const symbol of ["Tc", "cc", "_c"])
    vm.runInContext(fn("ccea1f474-B2jbjvXx.js", symbol), c);
  return c;
}
test("actual original directory query reproduces false empty; selected original library query and matcher find same listed skill", async (t) => {
  const f = fixture(t),
    c = consumer(),
    org = organizationUuid("synthetic");
  const listed = await f.get(c.bf(org, { kind: ["skill"], limit: 1000 }));
  assert.equal(listed.body.items.length, 6);
  const skillRows = listed.body.items.map((r: any) => ({
    skillId: r.skill.skill_id,
    skillName: r.name,
    creatorType: r.provenance.creator_type,
    partitionBy: r.skill.partition_by,
    enabled: r.viewer.installed.enabled,
  }));
  const old = await f.get(
    c.C(org, {
      q: "openai-docs",
      filter: "installation.state in ['enabled', 'disabled']",
      limit: 50,
    }),
  );
  assert.equal(old.status, 200);
  assert.equal(old.body.data.length, 0); // legacy compatibility endpoint is NOT genuine discovery
  for (const [q, expected] of [
    ["openai-docs", "openai-docs"],
    [" OPENAI-DOCS ", "openai-docs"],
    ["中文", "中文技能"],
    ["alpha", "alpha"],
    ["no such skill", undefined],
  ]) {
    const response = await f.get(c.bf(org, { q, limit: 50 }));
    assert.equal(response.status, 200);
    c.y = () => ({
      data: { pages: [response.body] },
      isLoading: false,
      isError: false,
      isFetching: false,
      hasNextPage: false,
      refetch() {},
    });
    const parsed = c.Pa("synthetic", [], true);
    c.Hr = () => parsed;
    const result = c._c({
      search: { searching: true, serverQ: q },
      skills: skillRows,
      pluginRows: [],
      populationsError: null,
    });
    assert.equal(result.isError, false);
    assert.equal(result.count, expected ? 1 : 0);
    assert.equal(result.rows[0]?.skill.skillName, expected);
  }
});
test("source failure and account retirement remain errors, not successful empty search", async (t) => {
  const f = fixture(t),
    c = consumer(),
    org = organizationUuid("synthetic");
  f.fail();
  const r = await f.get(c.bf(org, { q: "openai-docs", limit: 50 }));
  assert.equal(r.status, 503);
  assert.ok(!r.body.items);
  assert.ok(!JSON.stringify(r.body).includes("PRIVATE_SOURCE_ERROR"));
  c.Hr = () => ({
    items: [],
    isLoading: false,
    isError: true,
    isFetching: false,
    refetch() {},
  });
  const state = c._c({
    search: { searching: true, serverQ: "openai-docs" },
    skills: [],
    pluginRows: [],
    populationsError: null,
  });
  assert.equal(state.isError, true);
  const other = fixture(t);
  other.hook(() => other.retire());
  assert.equal(
    (await other.get(c.bf(org, { q: "openai-docs", limit: 50 }))).status,
    409,
  );
});
test("direct and bundled canonical transforms produce identical bytes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-search-derive-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const minify of [false, true]) {
    const out = path.join(dir, `derive-${minify}.mjs`);
    await build({
      entryPoints: ["scripts/official-ui-host-skill-search.mjs"],
      bundle: true,
      platform: "node",
      format: "esm",
      minify,
      outfile: out,
      logLevel: "silent",
    });
    const b = await import(pathToFileURL(out).href);
    assert.equal(
      b.deriveOfficialUiHostSkillSearchModule(file, brandedModule(raw(file))),
      derive(file, brandedModule(raw(file))),
    );
  }
});
test("actual Skills module ESM graph links new account import without evaluating any UI", () => {
  const code = `import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {deriveOfficialUiHostSkillSearchModule as derive} from './scripts/official-ui-host-skill-search.mjs';import{brandedModule}from'./scripts/official-web-assets.mjs';const root=${JSON.stringify(rawRoot)},cache=new Map();function get(p){if(cache.has(p))return cache.get(p);let source=fs.readFileSync(p,'utf8');source=derive(path.basename(p),brandedModule(source));const m=new vm.SourceTextModule(source,{identifier:p});cache.set(p,m);return m;}await get(path.join(root,'c5e558aae-38ebsbqD.js')).link((s,m)=>get(path.resolve(path.dirname(m.identifier),s)));if(!cache.has(path.join(root,${JSON.stringify(file)})))throw Error('Missing target');console.log('linked');`;
  const result = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", "--input-type=module", "-e", code],
    { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /linked/);
});

test("actual legacy search effect does not navigate host Yours to Discover; other branches retain original reset", () => {
  const source = derive(file, brandedModule(raw(file)));
  const call = source.match(/    kt\(N && !M[^\n]+;/)?.[0];
  assert.ok(call);
  const run = (context: unknown, tab: string, unified: boolean, patched: boolean) => {
    const effects: Function[] = [], routes: unknown[][] = [];
    const c: any = memo({
      t: (value: unknown) => ({current:value}),
      r: (value: unknown) => [value,()=>{}],
      l: (effect: Function) => effects.push(effect),
      wn: () => ({}),
      to: {kind:"home"},
      Me: (section: string,pages: unknown[]) => [section,pages],
      context, D:tab, unified, N:true,
    });
    vm.createContext(c);
    vm.runInContext(hostSkillSearchModeSource + "\n" +
      fn("c979ed9d0-C-llIJ0y.js","Na") + "\n" +
      fn("c6a2a31c4-Ctc4FG8F.js","em") + "\n" +
      fn("c6a2a31c4-Ctc4FG8F.js","Xp"),c);
    const [,setDiscover] = c.em({section:"skills",listPages:null,listsHanded:false,
      drillInto:(...args:unknown[])=>routes.push(args)});
    // Exact original km::X producer; em performs the real address-writing callback.
    c.L=()=>setDiscover(c.to); c.kt=c.Na;
    c.__claudexSkillSearchContext=context;
    c.M=c.__claudexInstalledSkillSearchMode(unified,context,tab);
    vm.runInContext(patched ? call! : "kt(N && !M, L);",c);
    effects.forEach(effect=>effect());
    return routes;
  };
  // Negative control reproduces installed v1: valid host marker still navigates.
  const old = run(host(),"mine",true,false);
  assert.equal(old.length,1);
  assert.equal(old[0][0],"skills");
  assert.equal((old[0][1] as unknown[]).length,0);
  // Original Th classifies home/no Yours page as shared (Discover).
  assert.match(fn("c6a2a31c4-Ctc4FG8F.js","Th"), /tab: c \? "mine" : "shared"/);
  assert.equal(run(host(),"mine",true,true).length,0);
  for(const [context,tab,unified] of [[{},"mine",false],[host(),"shared",false],[{},"shared",false],[{},"mine",true]] as const)
    assert.equal(run(context,tab,unified,true).length,run(context,tab,unified,false).length);
});

function panelSection(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

function skillsPanel(
  source: string,
  account: unknown,
  tab: string,
  frame?: { accountUuid: string; orgUuid: string },
) {
  const element = (type: unknown, props: unknown) => ({ type, props });
  const c = memo({
    Tn: true,
    D: tab,
    __claudexSkillSearchAccount: () => account,
    ze: () => true,
    window: { __claudexOfficialAccountContext: frame },
    $: [],
    J8: undefined,
    i: element,
    s: element,
    r: element,
  });
  vm.createContext(c);
  if (source.includes("      __claudexSkillSearchContext = "))
    vm.runInContext(
      hostSkillSearchModeSource +
        "const " +
        panelSection(source, "      __claudexSkillSearchContext = ", "\n      Ae =")
          .trimEnd()
          .slice(0, -1) +
        ";",
      c,
    );
  return c;
}

test("original search makes no catalog request and displays its no-match message on host Yours", () => {
  const original = brandedModule(raw(file));
  const derived = derive(file, original);
  function search(source: string, account: unknown, tab: string) {
    const requests: string[] = [];
    const c = skillsPanel(source, account, tab);
    Object.assign(c, {
      Dt: {}, O() {}, Ke: {}, qe: false, Fe: {},
      j: { query: "unknown", serverQ: "unknown", settledQ: "unknown", unsettled: false },
      P: { count: 0, isLoading: false, isError: false },
      H: (_organization: string, request: { q: string }) => request,
      ue: () => host(),
      ne: () => [],
      Pa: (request: { q: string }, _cache: unknown, enabled: boolean) => {
        if (enabled) requests.push(request.q);
        return { items: [], isLoading: false, isError: enabled };
      },
      Oe: () => false, pe: () => false,
      Wi: () => ({ deps: {}, pending: {} }),
      Cr: () => [], Ba() {},
      m: "warning", h: "button", Z: "message",
      xe: "illustration", se: "results", dn: "query",
    });
    vm.runInContext(
      fn("c979ed9d0-C-llIJ0y.js", "Fa") + "\n" +
        fn("c979ed9d0-C-llIJ0y.js", "La") + "\n" +
        "const jt = La; const render = i; i = (component, props) => component === jt ? jt(props) : render(component, props);",
      c,
    );
    const result = vm.runInContext(
      "let e = null, Dr; " +
        panelSection(source, "      Dr = J5($, 210,", '    } else if (D === "mine")') +
        "Dr;",
      c,
    );
    return { requests, output: JSON.stringify(result) };
  }
  const stock = search(original, host(), "mine");
  assert.deepEqual(stock.requests, ["unknown"]);
  assert.match(stock.output, /finish searching/);

  const yours = search(derived, host(), "mine");
  assert.deepEqual(yours.requests, []);
  assert.match(yours.output, /No skills match your search/);
  for (const [account, tab] of [[host(), "shared"], [{}, "mine"]] as const)
    assert.deepEqual(search(derived, account, tab), stock);
});

test("original empty card and toolbar omit unavailable actions only on bound Web Yours", () => {
  const original = brandedModule(raw(file));
  const derived = derive(file, original);
  function render(source: string, tab: string, frame?: { accountUuid: string; orgUuid: string }, canCreate = false, canUpload = false) {
    const context = host();
    const c = skillsPanel(source, { ...context, account: {
      ...context.account, claudex_skill_creation: canCreate, claudex_skill_upload: canUpload,
    } }, tab, frame);
    Object.assign(c, {
      A: "message", lr: "off", Xt: "video", ot: "original-empty-card", vn: "original-art",
      nr: "discover-action", Ne: () => ({ isAvailable: true }), ke: () => true,
      Y: { kept: true }, wn: "original-add-skill", ee() {}, te() {},
    });
    return JSON.stringify(vm.runInContext(
      "let dr, fr; " +
        panelSection(source, "    $[151] === J8", "      yr = !he().onThisDevice,")
          .replace(/,\s*$/, ";") +
        "const " + panelSection(source, "      jr =", "      Mr =").replace(/,\s*$/, ";") +
        "({ card: gr, toolbar: jr });",
      c,
    ));
  }
  const frame = { accountUuid: host().account.uuid, orgUuid: host().activeOrganization.uuid };
  const stock = render(original, "mine", frame);
  assert.match(stock, /Add them from Discover, or create your own/);
  assert.match(stock, /original-add-skill/);
  assert.match(stock, /onBrowseShared/);

  const yours = render(derived, "mine", frame);
  assert.match(yours, /original-empty-card/);
  assert.match(yours, /original-art/);
  assert.match(yours, /No skills found/);
  assert.doesNotMatch(yours, /Add them from Discover|original-add-skill|onBrowseShared/);
  assert.match(render(derived, "mine", frame, true), /original-add-skill/);
  assert.match(render(derived, "mine", frame, false, true), /original-add-skill/);
  for (const [tab, binding] of [
    ["shared", frame],
    ["mine", undefined],
    ["mine", { ...frame, accountUuid: "other" }],
    ["mine", { ...frame, orgUuid: "other" }],
  ] as const)
    assert.equal(render(derived, tab, binding), stock);
});

test("the original Add skill menu and upload page follow the bound Web account's permissions", () => {
  const source = derive(file, brandedModule(raw(file)));
  const auth = host();
  const binding = { accountUuid: auth.account.uuid, orgUuid: auth.activeOrganization.uuid };
  const calls: string[] = [];
  const item = (type: unknown, props: object) => ({ type, ...props });
  const render = (canUpload: boolean, canCreate: boolean, frame?: typeof binding) => {
    const context = vm.createContext(memo({
      __claudexSkillSearchAccount: () => ({
        ...auth, account: { ...auth.account, claudex_skill_upload: canUpload, claudex_skill_creation: canCreate },
      }),
      window: { __claudexOfficialAccountContext: frame },
      i: item, n: item, r: "fragment", s: { Item: "menuitem" }, A: "message",
      upload: () => calls.push("upload"),
      create: () => calls.push("create"),
    }));
    return vm.runInContext(
      hostSkillSearchModeSource +
      panelSection(source, "function Sn(e) {", "\nvar Cn =") +
      "\nconst menu = Sn({onQuickCreate: create, onUpload: upload});" +
      'const g = {kind: "upload"}, nt = true, it = true, at = true; const ' +
      panelSection(source, "    __claudexSkillUploadAccount =", "\n    Gt =").replace(/,\s*$/, ";") +
      "({ menu: menu.children.filter(Boolean), uploadPage: Wt });",
      context,
    );
  };
  const upload = render(true, false, binding);
  assert.equal(upload.uploadPage, true);
  assert.equal(upload.menu.length, 1);
  assert.equal(upload.menu[0].children.defaultMessage, "Upload skill");
  upload.menu[0].onClick();
  assert.deepEqual(calls, ["upload"]);
  const create = render(false, true, binding);
  assert.equal(create.uploadPage, false);
  assert.equal(create.menu.length, 1);
  assert.equal(create.menu[0].children.defaultMessage, "Create a skill");
  for (const frame of [{ ...binding, accountUuid: "stale" }, { ...binding, orgUuid: "stale" }]) {
    const stale = render(true, true, frame);
    assert.equal(stale.uploadPage, false);
    assert.equal(stale.menu.length, 0);
  }
  const desktop = render(false, false);
  assert.equal(desktop.uploadPage, true);
  assert.deepEqual(Array.from(desktop.menu, (entry: { children: { defaultMessage: string } }) => entry.children.defaultMessage), [
    "Upload skill", "Create a skill",
  ]);
});
