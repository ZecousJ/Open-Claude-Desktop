import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  deriveOfficialUiHostInstalledPluginsModule as derive,
  hostInstalledPluginsInputHashes as hashes,
  installedSummaryHostSource,
  installedSummaryDetailSource,
} from "../../scripts/official-ui-host-installed-plugins.mjs";
import { brandedModule } from "../../scripts/official-web-assets.mjs";
import { deriveOfficialUiHostCapabilityModule } from "../../scripts/official-ui-host-capabilities.mjs";
import { installedPluginLibrary } from "../../electron/official-ui/api/library-plugins.ts";
const raw = (file) =>
  deriveOfficialUiHostCapabilityModule(file, brandedModule(
    fs.readFileSync(
      ".restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1/" +
        file,
      "utf8",
    ),
  ));
function fn(source, name) {
  const a = source.indexOf(`function ${name}(`),
    b = source.indexOf("\nfunction ", a + 1);
  assert.ok(a >= 0);
  return source
    .slice(a, b < 0 ? undefined : b)
    .replace(/\nvar [\s\S]*$/, "")
    .replace(/\nexport [\s\S]*$/, "");
}
function memo(c) {
  c.__claudexPluginMemo = (factory) => factory();
  c.J9 = () => [];
  for (let i = 0; i <= 5; i++) {
    c["J" + i] = () => true;
    c["K" + i] = (...a) => a.at(-1);
    c["I" + i] = (_s, _n, value) => value;
    c["Z" + i] = (_s, _n, value) => value;
  }
  return c;
}
const account = {
    uuid: "inert-account",
    claudex_host_authentication: {
      version: 1,
      status: "authenticated",
      account_uuid: "inert-account",
    },
  },
  context = { account, activeOrganization: { uuid: "inert-org" } };
const rows = installedPluginLibrary({
  marketplaces: [{ name: "inert", path: "/not-exposed", plugins: 2 }],
  loadErrors: [],
  plugins: [true, false].map((enabled, i) => ({
    id: `plugin${i}@inert`,
    name: `plugin${i}`,
    title: `Plugin ${i}`,
    marketplace: "inert",
    marketplacePath: "/not-exposed",
    installed: true,
    enabled,
    installable: false,
    source: "other",
  })),
});
function mergeVM() {
  const c = {
    Set,
    P: new Set(),
    ie: new Set(),
    h: (v) => (typeof v === "string" ? v : undefined),
    W: () => undefined,
    p: ({ name, marketplaceName }) => `${name}@${marketplaceName}`,
    m: (x) => x,
    a: () => false,
    w: () => false,
    d: (x) => x,
    l: () => ({}),
    e: (x) => x,
    u: (v) => typeof v === "string",
    T: (x) => x.display_name,
    g: (x) => x,
    s: () => null,
    A: () => null,
    O: (x) => x.display_name ?? x.name,
    n: () => null,
    te: () => null,
    j: () => null,
    M: () => null,
    Q: () => false,
    t: () => "plugin",
    b: () => false,
    c: () => false,
    y: () => false,
  };
  vm.createContext(c);
  const source = derive("c08f249ae-5qhemGT7.js", raw("c08f249ae-5qhemGT7.js"));
  for (const name of ["z", "L", "G", "F", "q", "ae"])
    vm.runInContext(fn(source, name), c);
  return c;
}
function hookVM({
  host = true,
  error = false,
  loading = false,
  routing = "cowork",
} = {}) {
  const nativeCalls = [],
    syncCalls = [],
    catalogCalls = [],
    merge = mergeVM();
  const noNative = (key) => (options) => {
    nativeCalls.push([key, options.enabled]);
    return {
      data: undefined,
      isError: true,
      isLoading: false,
      isFetching: false,
      refetch() {},
    };
  };
  const c = memo({
    Set,
    ve: [],
    ye: new Set(),
    be: new Set(),
    __claudexPluginAccount: () =>
      host
        ? context
        : {
            account: { uuid: "vendor" },
            activeOrganization: { uuid: "inert-org" },
          },
    re: () => ({ coworkIpcRoute: routing }),
    ee: () => false,
    le: () => ({ isVisible: true }),
    ce: () => false,
    pe: () => ({ desktop: true, web: false }),
    ne: () => true,
    se: (...a) => syncCalls.push(a),
    de: (a) => syncCalls.push(a),
    te: noNative("remote"),
    ae: noNative("local"),
    e: () => "plugin",
    t: { plugin: { kind: ["plugin"] }, skill: { kind: ["skill"] } },
    n: (kind, options) => {
      catalogCalls.push([kind.kind[0], options.enabled]);
      return {
        data: error ? undefined : kind.kind[0] === "plugin" ? rows : [],
        isError: error,
        isLoading: loading,
        isFetching: loading,
        refetch() {},
      };
    },
    ue: () => ({ ids: new Set(), isLoading: false }),
    _e: () => ({ attestedPluginIds: new Set() }),
    ie: () => ({ data: [] }),
    he: () => false,
    fe: () => true,
    ge: (...a) =>
      a[2].hostInstalledSummary
        ? merge.ae(...a)
        : { rows: [], projectKeys: new Set(), offListRows: [] },
    Ee: (x) => x,
    Te: () => true,
    we: (x) => x.name,
    Ce: (x) => x,
    Se: (x) => x.client,
    xe: (x) => x.client,
    oe: () => false,
    me: () => false,
  });
  vm.createContext(c);
  vm.runInContext(
    installedSummaryHostSource +
      fn(derive("cf0e8a0d3-DUFBw2XT.js", raw("cf0e8a0d3-DUFBw2XT.js")), "i"),
    c,
  );
  return { c, nativeCalls, syncCalls, catalogCalls };
}
test("host predicate is exact account-bound and leaves unmarked/foreign/unknown contexts unchanged", () => {
  const c = {};
  vm.createContext(c);
  vm.runInContext(installedSummaryHostSource, c);
  assert.equal(c.__claudexInstalledSummaryHost(context), true);
  for (const ctx of [
    null,
    {},
    { account },
    { ...context, account: { ...account, uuid: "other" } },
    {
      ...context,
      account: {
        ...account,
        claudex_host_authentication: {
          ...account.claudex_host_authentication,
          version: 2,
        },
      },
    },
  ])
    assert.equal(c.__claudexInstalledSummaryHost(ctx), false);
});
test("original merge uses real server membership, retains disabled and unknown components without native paths", () => {
  const c = mergeVM();
  const result = c.ae(rows, [], {
    platform: "desktop",
    hostInstalledSummary: true,
    systemInternalIds: new Set(),
  });
  assert.deepEqual(
    Array.from(result.rows, (x) => [x.client.name, x.enabled]),
    [
      ["plugin0", true],
      ["plugin1", false],
    ],
  );
  for (const row of result.rows) {
    assert.equal(row.origin, "server");
    assert.equal(row.componentTypes, null);
    assert.equal(row.client.installPath, undefined);
    assert.equal(row.client.notOnThisComputer, undefined);
    assert.equal(row.wire.viewer.installed.can_toggle, false);
  }
  const upstream = c.ae(rows, [], {
    platform: "web",
    systemInternalIds: new Set(),
  });
  assert.equal(
    upstream.rows.length,
    1,
    "unmarked vendor disabled filtering remains original",
  );
});
test("actual original list hook disables only inapplicable native reads while preserving real catalog errors and platform", () => {
  for (const error of [false, true]) {
    const { c, nativeCalls, syncCalls, catalogCalls } = hookVM({ error });
    const result = c.i();
    assert.equal(result.platform, "desktop");
    assert.equal(result.bridgeError, null);
    assert.equal(result.error !== null, error);
    assert.equal(result.hasData, !error);
    assert.equal(result.rows.length, error ? 0 : 2);
    assert.deepEqual(nativeCalls, [
      ["remote", false],
      ["local", false],
    ]);
    assert.deepEqual(syncCalls, [[false, true], false]);
    assert.ok(
      catalogCalls.some(
        ([kind, enabled]) => kind === "plugin" && enabled === true,
      ),
    );
  }
  const vendor = hookVM({ host: false });
  assert.notEqual(vendor.c.i().bridgeError, null);
  assert.ok(
    vendor.nativeCalls.some(([, enabled]) => enabled === true),
    "unmarked native reads retain original enablement",
  );
});
test("pinned derivation rejects drift and is byte-stable after esbuild bundling", async (t) => {
  for (const file of Object.keys(hashes)) {
    assert.throws(() => derive(file, raw(file) + " "));
    assert.ok(
      derive(file, raw(file)).includes(
        file === "shared-m-4-CbJwwS_m.js"
          ? "__claudexVendorPluginDetail"
          : file === "c3bb81cd1-BeTk7zYW.js"
            ? "r.claudexLocalMarketplace"
            : file === "c24c8737b-5PJBZo1Q.js"
              ? "Y.claudex_local_marketplace"
              : file === "ccea1f474-B2jbjvXx.js"
                ? "__claudexMarketplaceCards"
                : file === "c6a2a31c4-Ctc4FG8F.js"
                  ? "useClaudexRegisteredRepositories"
                  : file === "c979ed9d0-C-llIJ0y.js"
                    ? "claudex_organization_catalog_only"
                    : file === "c2e144342-BPmQtTD1.js" || file === "c27f32a39-pQdcmpai.js"
                      ? "claudexOrganizationPlugin"
                      : "hostInstalledSummary",
      ),
    );
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-transform-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const minify of [false, true]) {
    const out = path.join(dir, `${minify}.mjs`);
    await build({
      entryPoints: ["scripts/official-ui-host-installed-plugins.mjs"],
      outfile: out,
      bundle: true,
      platform: "node",
      format: "esm",
      minify,
      logLevel: "silent",
    });
    const bundled = await import(pathToFileURL(out).href);
    for (const file of Object.keys(hashes))
      assert.equal(
        bundled.deriveOfficialUiHostInstalledPluginsModule(file, raw(file)),
        derive(file, raw(file)),
      );
  }
});

test("host detail uses original server hook with stable hook order, explicit errors and original retry; unmarked IDs stay vendor", async () => {
  const calls = [],
    record = { id: "plugin_" + "a".repeat(24), name: "inert", mcp_servers: {} };
  let active = context,
    error = false,
    retries = 0;
  const c = {
    LO: () => active,
    __claudexVendorPluginDetail: (id) => {
      calls.push(["vendor", id]);
      return { data: "vendor", error: null };
    },
    qb: (id, options) => {
      calls.push(["server", id, options.enabled]);
      return {
        data: error ? undefined : record,
        isError: error,
        isLoading: false,
        error: error ? new Error("inert") : null,
        refetch: async () => {
          retries++;
        },
      };
    },
    Ho: (row) => ({ backendId: row.id, name: row.name }),
  };
  vm.createContext(c);
  vm.runInContext(installedSummaryHostSource + installedSummaryDetailSource, c);
  const ok = c.DN(record.id);
  assert.equal(ok.data.backendId, record.id);
  assert.deepEqual(calls, [
    ["vendor", null],
    ["server", record.id, true],
  ]);
  calls.length = 0;
  error = true;
  const failed = c.DN(record.id);
  assert.equal(failed.data, null);
  assert.equal(failed.linkVerdict, "failed");
  await failed.retryLink();
  assert.equal(retries, 1);
  active = { account: { uuid: "vendor" } };
  calls.length = 0;
  assert.equal(c.DN(record.id).data, "vendor");
  assert.deepEqual(calls, [
    ["vendor", record.id],
    ["server", undefined, false],
  ]);
  active = context;
  calls.length = 0;
  assert.equal(c.DN("local@inert").data, "vendor");
  assert.deepEqual(calls, [
    ["vendor", "local@inert"],
    ["server", undefined, false],
  ]);
});

test("real compiled memo preserves host/vendor transitions and ignores only native routing loading in host summary mode", () => {
  const { c, nativeCalls } = hookVM({ routing: "loading" });
  const cache = [];
  c.J8 = Symbol.for("react.memo_cache_sentinel");
  c.J9 = (size) => {
    if (!cache.length) cache.push(...Array(size).fill(c.J8));
    return cache;
  };
  const compiler = raw("shared-frame-DH1u5uQk.js");
  for (const prefix of ["J", "K", "I", "Z"])
    for (let n = 0; n <= 5; n++) {
      if (compiler.includes(`function ${prefix}${n}(`))
        vm.runInContext(fn(compiler, `${prefix}${n}`), c);
    }
  for (const host of [true, true, false, true]) {
    c.__claudexPluginAccount = () =>
      host
        ? context
        : {
            account: { uuid: "vendor" },
            activeOrganization: { uuid: "inert-org" },
          };
    const result = c.i();
    assert.equal(result.platform, "desktop");
    if (host) {
      assert.equal(result.isLoading, false);
      assert.equal(result.bridgeError, null);
      assert.equal(result.rows.length, 2);
    } else assert.notEqual(result.bridgeError, null);
  }
  assert.ok(nativeCalls.some(([, enabled]) => enabled === true));
});
test("actual original list-card selection resolves summary backend ID rather than name key", () => {
  const c = { Pw: (id) => ({ marketplace: id.split("@")[1] }), hE: (id) => id };
  vm.createContext(c);
  const shared = raw("shared-l-p-m-w-3-B5uNmf7O.js");
  for (const name of ["Gq", "YH"]) vm.runInContext(fn(shared, name), c);
  const source = raw("c6a2a31c4-Ctc4FG8F.js"),
    anchor =
      "(e) => {\n            let t = we(e.client);\n            n(t) && ye.setState({ mineRowOrigin: { itemId: Be(t), origin: e.origin } });\n          }";
  assert.ok(source.includes(anchor));
  let selected;
  Object.assign(c, {
    we: c.Gq,
    n: (target) => {
      selected = c.YH(target);
      return true;
    },
    ye: { setState() {} },
    Be: c.YH,
  });
  const click = vm.runInContext("(" + anchor + ")", c);
  const merge = mergeVM();
  for (const marketplace of ["inert", "anthropic-plugin-directory"]) {
    const wire = {
      ...rows[0],
      provenance: { ...rows[0].provenance, marketplace_name: marketplace },
    };
    const row = merge.ae([wire], [], {
      platform: "desktop",
      hostInstalledSummary: true,
      systemInternalIds: new Set(),
    }).rows[0];
    assert.equal(row.key, row.client.backendId);
    assert.equal(row.client.marketplaceName, marketplace);
    click(row);
    assert.equal(selected, row.client.backendId);
    assert.match(selected, /^plugin_[a-f0-9]{24}$/);
  }
});

test("Settings and plugin detail ESM graphs link the transformed modules", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = `
    import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
    import {deriveOfficialUiHostInstalledPluginsModule as derive,hostInstalledPluginsInputHashes as hashes} from './scripts/official-ui-host-installed-plugins.mjs';
    import {brandedModule} from './scripts/official-web-assets.mjs';
    import {deriveOfficialUiHostCapabilityModule} from './scripts/official-ui-host-capabilities.mjs';
    const root=path.resolve('.restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1');
    async function link(broken) {
      const cache=new Map();
      function get(p) {
        if(cache.has(p))return cache.get(p);
        let source=fs.readFileSync(p,'utf8'), file=path.basename(p);
        if(Object.hasOwn(hashes,file)){
          source=brandedModule(source);
          source=deriveOfficialUiHostCapabilityModule(file,source);
          source=derive(file,source);
        }
        if(broken && file==='cf0e8a0d3-DUFBw2XT.js')source=source.replace('import {ce as __claudexPluginAccount} from "./shared-l-p-m-w-2-BMCa56Vr.js";', 'import {ce as __claudexPluginAccount} from "./shared-l-p-m-w-1-O9prfPUL.js";');
        const module=new vm.SourceTextModule(source,{identifier:p});cache.set(p,module);return module;
      }
      await get(path.join(root,'cc011544b-Pr8E2gr7.js')).link((s,m)=>get(path.resolve(path.dirname(m.identifier),s)));
      const detail=get(path.join(root,'c3bb81cd1-BeTk7zYW.js'));
      if (detail.status === 'unlinked') await detail.link((s,m)=>get(path.resolve(path.dirname(m.identifier),s)));
      const library=get(path.join(root,'c24c8737b-5PJBZo1Q.js'));
      if (library.status === 'unlinked') await library.link((s,m)=>get(path.resolve(path.dirname(m.identifier),s)));
      const search=get(path.join(root,'ccea1f474-B2jbjvXx.js'));
      if (search.status === 'unlinked') await search.link((s,m)=>get(path.resolve(path.dirname(m.identifier),s)));
      const customize=get(path.join(root,'c6a2a31c4-Ctc4FG8F.js'));
      if (customize.status === 'unlinked') await customize.link((s,m)=>get(path.resolve(path.dirname(m.identifier),s)));
      for(const file of Object.keys(hashes))if(!cache.has(path.join(root,file)))throw Error('Graph omitted transformed module '+file);
      return cache.size;
    }
    let rejected=false;try{await link(true);}catch(e){if(!String(e).includes("does not provide an export named 'ce'"))throw e;rejected=true;}
    if(!rejected)throw Error('Previous wrong import unexpectedly linked');
    console.log('fixed graph linked',await link(false),'modules; no evaluate');
  `;
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", script], {cwd: process.cwd(),encoding:"utf8",timeout:30000,maxBuffer:1024*1024});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixed graph linked \d+ modules; no evaluate/);
});

test("the desktop repository form does not apply the Cowork sandbox domain list to a local Git clone", async () => {
  const file = "shared-m-4-CbJwwS_m.js";
  const calls = [];
  const url = "https://github.com/example/plugins.git";
  const sandboxDomains = ["registry.npmjs.org"];
  const vendor = async (input) => {
    calls.push(["account", input]);
    return { name: "cloud" };
  };
  const runtime = memo({
    LO: () => context,
    zom: () => ({}),
    vl: () => ({ validEgressAllowedDomains: sandboxDomains }),
    Dx: () => ({ mode: "cowork" }),
    sQ: () => "off",
    C3: () => true,
    BE: () => vendor,
    ba: {
      addMarketplace: async (input, domains, options) => {
        calls.push(["desktop", input, Array.from(domains), options.mode]);
        return { name: "local" };
      },
    },
    LV: ({ mutationFn }) => mutationFn,
    Uu: {},
    Nz: new Set(),
  });
  vm.createContext(runtime);
  vm.runInContext(installedSummaryHostSource + fn(derive(file, raw(file)), "M_"), runtime);
  await runtime.M_({})({ input: url });
  runtime.sQ = () => "account";
  await runtime.M_({})({ input: url });
  assert.deepEqual(calls, [
    ["desktop", url, [], "cowork"],
    ["account", url],
  ]);
});
