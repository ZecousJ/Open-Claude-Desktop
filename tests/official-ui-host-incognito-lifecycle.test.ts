import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import * as crypto from "node:crypto";
import { build } from "esbuild";
import ts from "typescript";
import { brandedModule } from "../scripts/official-web-assets.mjs";
import {
  deriveOfficialUiHostIncognitoLifecycleModule as derive,
  applyOfficialUiHostIncognitoLifecycle as apply,
  hostIncognitoLifecycleSource,
  hostIncognitoLifecycleRules,
  hostIncognitoLifecycleInputHashes,
  hostIncognitoLifecycleOriginalHashes,
} from "../scripts/official-ui-host-incognito-lifecycle.mjs";
const archive = path.resolve(
  process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? ".restore/archive-extracted",
);
const resources = path.join(archive, "claude-frontend-4.4212.0/dist/assets/v1");
const file = "shared-m-2-DfdOu-fU.js";
const raw = fs.readFileSync(path.join(resources, file), "utf8");
const input = brandedModule(raw),
  source = derive(file, input);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function extract(s: string, start: string, end: string) {
  const a = s.indexOf(start),
    b = s.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return s.slice(a, b);
}
function deferred() {
  let resolve!: (value: any) => void, reject!: (reason: any) => void;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function fixture(transformed = true) {
  const memo = Array(54).fill(Symbol.for("react.memo_cache_sentinel")),
    refs: any[] = [],
    states: any[] = [],
    effects: any[] = [],
    calls: any[] = [],
    transitions: any[] = [],
    errors: any[] = [],
    descriptors: any[] = [];
  let refIndex = 0,
    stateIndex = 0,
    effectIndex = 0,
    eventIndex = 0;
  const events: any[] = [];
  const knownTemporary = new Set<string>();
  const value: any = {
    account: { uuid: "account-a" },
    activeOrganization: { uuid: "organization-a" },
  };
  let stored: any = { uuid: "temporary-a", orgUuid: "organization-a" };
  const mode: any = { blocked: false, entryBlocked: false, special: false };
  const router = {
    push: (...args: any[]) => transitions.push(["push", ...args]),
  };
  const next = deferred();
  let fetchImpl = () => next.promise;
  const c: any = {
    J8: Symbol.for("react.memo_cache_sentinel"),
    J9: () => memo,
    E_: () => value,
    nu: (initial: any) =>
      refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
    bw: (initial: any) => {
      const i = stateIndex++;
      if (!(i in states)) states[i] = initial;
      return [
        states[i],
        (v: any) => {
          states[i] = v;
          transitions.push(["state", i, v]);
        },
      ];
    },
    sQ: (effect: any, deps: any[]) => {
      const i = effectIndex++,
        old = effects[i];
      if (!old || deps.some((v, i) => old.deps[i] !== v)) {
        old?.cleanup?.();
        effects[i] = { deps: [...deps], cleanup: effect() };
      }
    },
    Re: () => ({ addError: (message: any) => errors.push(message) }),
    gy: () => ({
      formatMessage: (descriptor: any) => {
        descriptors.push(descriptor);
        return "localized-original-error";
      },
    }),
    H5: () => stored,
    pY: () => ({
      setItem: (_k: any, v: any) => {
        stored = JSON.parse(v);
      },
      removeItem: () => {
        stored = null;
      },
      getItem: () => stored && JSON.stringify(stored),
    }),
    gB: "incognito_temporary_conversation_uuid",
    vs: () => router,
    Vi: () => new URLSearchParams("incognito"),
    jk: () => true,
    RZ: (query: URLSearchParams) => query.has("incognito"),
    gj: (uuid: string) => knownTemporary.has(uuid),
    KJ: (value: string) => value,
    yz: (read: any) => read(),
    rI: (v: any) => v,
    sZ: () => false,
    TM: (fn: any) => {
      const i = eventIndex++;
      if (!events[i])
        events[i] = { fn, stable: (...args: any[]) => events[i].fn(...args) };
      events[i].fn = fn;
      return events[i].stable;
    },
    Mm: () => mode.blocked,
    eZ: (v: any) => v,
    _a: () => mode.entryBlocked,
    q8: () => false,
    $M: () => false,
    pg: () => transitions.push(["enter"]),
    window: {
      location: { pathname: "/new", search: "?incognito" },
      electronWindowControl: { setIncognitoMode: () => {} },
    },
    N3: () => "/new",
    QQ: () => mode.special,
    wK: (_r: any, ...args: any[]) => transitions.push(["replace", ...args]),
    JI: "incognito",
    URLSearchParams,
    ln: () => false,
    P2: { read: () => false },
    us: () => {},
    Or: () => {},
    tw: () => {},
    mb: () => {},
    Is: () => {},
    b9: () => {},
    QE: () => {},
    gl: (type: any, props: any) => ({ type, ...props }),
    xW: { Provider: "draft" },
    li: { Provider: "incognito" },
    fetch: (url: any, options: any) => {
      calls.push({ url, options });
      return fetchImpl();
    },
    encodeURIComponent,
  };
  vm.createContext(c);
  const frame = fs.readFileSync(
    path.join(resources, "shared-frame-DH1u5uQk.js"),
    "utf8",
  );
  vm.runInContext(extract(frame, "function J0(", "function I3("), c);
  const routing = fs.readFileSync(
    path.join(resources, "shared-l-p-m-w-4-BkeeGGW7.js"),
    "utf8",
  );
  vm.runInContext(
    extract(routing, "function UU(", "function QE(") +
      "\nvar __claudexIncognitoRouteUuid = o8;",
    c,
  );
  c.QQ = () => mode.special;

  vm.runInContext(
    (transformed ? hostIncognitoLifecycleSource : "") +
      extract(transformed ? source : input, "function zv(e)", "function Is()"),
    c,
  );
  function render() {
    refIndex = stateIndex = effectIndex = eventIndex = 0;
    return c.zv({ children: null }).value;
  }
  const result = render();
  transitions.length = 0;
  return {
    calls,
    transitions,
    errors,
    descriptors,
    result,
    next,
    value,
    mode,
    render,
    route: (pathname: string, search = "?incognito", known = true) => {
      c.window.location.pathname = pathname;
      c.window.location.search = search;
      const uuid = c.o8(pathname);
      if (known && uuid) knownTemporary.add(uuid);
    },
    read: () => stored,
    set: (target: any) => (stored = target),
    respond: (impl: any) => (fetchImpl = impl),
    unmount: () => effects.forEach((e) => e.cleanup?.()),
  };
}
test("pins the unmodified archive and exact branded input, reverses only four rules, and parses the whole module", () => {
  assert.equal(sha(raw), hostIncognitoLifecycleOriginalHashes[file]);
  assert.equal(sha(input), hostIncognitoLifecycleInputHashes[file]);
  let reversed = source.slice(hostIncognitoLifecycleSource.length);
  for (const r of [...hostIncognitoLifecycleRules].reverse())
    reversed = reversed.replace(r.after, r.before);
  assert.equal(reversed, input);
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  ) as any;
  assert.deepEqual(parsed.parseDiagnostics, []);
  assert.throws(() => derive(file, input + " "), /input mismatch/);
  assert.throws(() => derive(file, source), /input mismatch/);
  assert.equal(derive("unrelated.js", "untouched"), "untouched");
});
test("original F exits without cleanup; transformed original F waits for exact POST 204 before same transition", async () => {
  const baseline = fixture(false);
  baseline.result.setIncognitoModeEnabled(false);
  assert.equal(baseline.calls.length, 0);
  assert.equal(baseline.read(), null);
  const f = fixture(),
    p = f.result.setIncognitoModeEnabled(false);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), {
    url: "/api/organizations/organization-a/chat_conversations/temporary-a/discard_incognito",
    options: { method: "POST" },
  });
  assert.equal(f.transitions.length, 0);
  assert.equal(f.read().uuid, "temporary-a");
  f.next.resolve({ status: 204 });
  await p;
  assert.equal(f.read(), null);
  assert.deepEqual(f.transitions, baseline.transitions);
  assert.deepEqual(f.errors, []);
});
test("original special-path exit is also delayed and still uses its existing navigation", async () => {
  const f = fixture();
  f.mode.special = true;
  const p = f.result.setIncognitoModeEnabled(false);
  assert.equal(f.transitions.length, 0);
  f.next.resolve({ status: 204 });
  await p;
  assert.deepEqual(f.transitions, [
    ["state", 1, null],
    ["replace", "/new", "page_control"],
  ]);
});
test("entry, blank temporary draft, and original navigation guards keep existing behavior without cleanup", async () => {
  const enter = fixture();
  await enter.result.setIncognitoModeEnabled(true);
  assert.equal(enter.calls.length, 0);
  assert.equal(enter.read(), null);
  const blank = fixture();
  blank.set(null);
  await blank.result.setIncognitoModeEnabled(false);
  assert.equal(blank.calls.length, 0);
  assert.ok(blank.transitions.length > 0);
  const guard = fixture();
  guard.mode.blocked = true;
  await guard.result.setIncognitoModeEnabled(false);
  assert.equal(guard.calls.length, 0);
  assert.equal(guard.transitions.length, 0);
  const entryGuard = fixture();
  entryGuard.mode.entryBlocked = true;
  await entryGuard.result.setIncognitoModeEnabled(true);
  assert.equal(entryGuard.calls.length, 0);
  assert.equal(entryGuard.transitions.length, 0);
});
test("HTTP or network failure retains temporary UI and uses the existing localized generic error; retry works", async () => {
  for (const failure of [409, 500, 200, "network"]) {
    const f = fixture(),
      p = f.result.setIncognitoModeEnabled(false);
    failure === "network"
      ? f.next.reject(Error("inert failure"))
      : f.next.resolve({ status: failure });
    await p;
    assert.equal(f.read().uuid, "temporary-a");
    assert.equal(f.transitions.length, 0);
    assert.deepEqual(f.errors, ["localized-original-error"]);
    assert.deepEqual(JSON.parse(JSON.stringify(f.descriptors)), [
      { defaultMessage: "Something went wrong", id: "JqiqNj0Ooi" },
    ]);
    f.respond(() => Promise.resolve({ status: 204 }));
    await f.result.setIncognitoModeEnabled(false);
    assert.equal(f.calls.length, 2);
    assert.equal(f.read(), null);
  }
});
test("double click shares only the pending wait and performs one request and one original exit", async () => {
  const f = fixture(),
    one = f.result.setIncognitoModeEnabled(false),
    two = f.result.setIncognitoModeEnabled(false);
  assert.equal(f.calls.length, 1);
  f.next.resolve({ status: 204 });
  await Promise.all([one, two]);
  assert.equal(f.transitions.filter((x) => x[0] === "push").length, 1);
});
test("foreign or unbound temporary organization never requests or clears that session", async () => {
  for (const orgUuid of ["foreign", undefined]) {
    const f = fixture();
    f.set({ uuid: "temporary-a", orgUuid });
    await f.result.setIncognitoModeEnabled(false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.transitions.length, 0);
    assert.equal(f.errors.length, 0);
  }
});
test("cached original callback sees live account/org changes and suppresses stale success or errors, including switching back", async () => {
  for (const change of ["account", "organization", "return-account"])
    for (const success of [true, false]) {
      const f = fixture(),
        pending = f.result.setIncognitoModeEnabled(false);
      const originalCallback = f.result.setIncognitoModeEnabled;
      if (change === "organization")
        f.value.activeOrganization = { uuid: "organization-b" };
      else f.value.account = { uuid: "account-b" };
      f.render();
      if (change === "return-account") {
        f.value.account = { uuid: "account-a" };
        f.render();
      }
      assert.equal(f.render().setIncognitoModeEnabled, originalCallback);
      f.transitions.length = 0;
      success
        ? f.next.resolve({ status: 204 })
        : f.next.reject(Error("inert failure"));
      await pending;
      assert.equal(f.transitions.length, 0);
      assert.equal(f.errors.length, 0);
    }
});
test("new temporary identity or provider unmount cannot be cleared by an earlier pending result", async () => {
  for (const change of ["temporary", "unmount"])
    for (const success of [true, false]) {
      const f = fixture(),
        pending = f.result.setIncognitoModeEnabled(false);
      if (change === "temporary")
        f.set({ uuid: "temporary-b", orgUuid: "organization-a" });
      else f.unmount();
      success
        ? f.next.resolve({ status: 204 })
        : f.next.reject(Error("inert failure"));
      await pending;
      assert.equal(f.transitions.length, 0);
      assert.equal(f.errors.length, 0);
    }
});
test("identifiers are path-encoded and no message/body or ordinary DELETE is emitted", async () => {
  const f = fixture();
  f.set({ uuid: "temporary/one?", orgUuid: "organization-a" });
  const pending = f.result.setIncognitoModeEnabled(false);
  assert.match(f.calls[0].url, /temporary%2Fone%3F\/discard_incognito$/);
  assert.deepEqual(Object.keys(f.calls[0].options), ["method"]);
  f.next.resolve({ status: 204 });
  await pending;
});
test("canonical transform is byte-identical when bundled", async () => {
  const result = await build({
    entryPoints: ["scripts/official-ui-host-incognito-lifecycle.mjs"],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    minify: true,
  });
  const exports: any = {},
    module = { exports };
  vm.runInNewContext(result.outputFiles[0].text, {
    exports,
    module,
    require: (id: string) => {
      if (id === "node:fs") return fs;
      if (id === "node:path") return path;
      if (id === "node:crypto") return crypto;
      throw Error(id);
    },
  });
  assert.equal(
    module.exports.deriveOfficialUiHostIncognitoLifecycleModule(file, input),
    source,
  );
});
test("apply manifests exact output, rejects repeated transform, immutable archive and output symlink", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-incognito-transform-"),
  );
  try {
    fs.writeFileSync(path.join(dir, file), input);
    const manifest = apply(dir);
    assert.equal(manifest.modules[0].outputSha256, sha(source));
    assert.equal(fs.readFileSync(path.join(dir, file), "utf8"), source);
    assert.throws(() => apply(dir), /input mismatch/);
    fs.unlinkSync(path.join(dir, file));
    fs.symlinkSync(path.join(resources, file), path.join(dir, file));
    assert.throws(() => apply(dir), /symlink rejected/);
    fs.mkdirSync(path.join(dir, ".restore"));
    assert.throws(() => apply(path.join(dir, ".restore")), /immutable/);
    assert.equal(
      sha(fs.readFileSync(path.join(resources, file), "utf8")),
      hostIncognitoLifecycleOriginalHashes[file],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Hub original route parser with registered temporary verdict cleans a sent chat when H5 is empty", async () => {
  const f = fixture();
  f.set(null);
  f.route("/chat/temporary-a");
  const pending = f.result.setIncognitoModeEnabled(false);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /temporary-a\/discard_incognito$/);
  assert.equal(f.transitions.length, 0);
  f.next.resolve({ status: 204 });
  await pending;
  assert.ok(f.transitions.length > 0);
});
test("Hub fallback requires both original temporary verdict and incognito query and never infers an ordinary route", async () => {
  for (const [route, search, known] of [
    ["/chat/ordinary-a", "?incognito", false],
    ["/chat/temporary-a", "", true],
    ["/new", "?incognito", true],
  ] as const) {
    const f = fixture();
    f.set(null);
    f.route(route, search, known);
    await f.result.setIncognitoModeEnabled(false);
    assert.equal(f.calls.length, 0);
  }
});
test("Hub route failure keeps the original page; navigation during the wait suppresses stale success and errors", async () => {
  const f = fixture();
  f.set(null);
  f.route("/chat/temporary-a");
  const pending = f.result.setIncognitoModeEnabled(false);
  f.next.resolve({ status: 500 });
  await pending;
  assert.equal(f.transitions.length, 0);
  assert.deepEqual(f.errors, ["localized-original-error"]);
  for (const success of [true, false]) {
    const f = fixture();
    f.set(null);
    f.route("/chat/temporary-a");
    const pending = f.result.setIncognitoModeEnabled(false);
    f.route("/chat/temporary-b");
    success ? f.next.resolve({ status: 204 }) : f.next.reject(Error("inert"));
    await pending;
    assert.equal(f.transitions.length, 0);
    assert.equal(f.errors.length, 0);
  }
});
