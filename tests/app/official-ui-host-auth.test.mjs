/** Pure pinned-source derivation and isolated branch evaluation; no module execution/network/auth session. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import {
  deriveOfficialUiHostAuthModule,
  applyOfficialUiHostAuth,
  hostAuthSourceHashes,
  hostAuthRules,
  hostAuthenticatedExpression,
} from "../../scripts/official-ui-host-auth.mjs";
const root = path.resolve(
  ".restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1",
);
const source = (name) => fs.readFileSync(path.join(root, name), "utf8");
const account = (extra = {}) => ({
  uuid: "fixture",
  memberships: [{}],
  settings: {},
  invites: [],
  ...extra,
});
const marker = { version: 1, status: "authenticated", account_uuid: "fixture" };
function authFunctions() {
  const original = source("shared-l-p-m-w-1-O9prfPUL.js"),
    derived = deriveOfficialUiHostAuthModule(
      "shared-l-p-m-w-1-O9prfPUL.js",
      original,
    );
  const extract = (s, start, end) =>
    s.slice(s.indexOf(start), s.indexOf(end, s.indexOf(start)));
  return vm.runInNewContext(
    `${extract(derived, "function NZ(e)", "function Wj(")}${extract(derived, "function vM(e)", "var Zy =")}${extract(derived, "function DL(e)", "var n2 =")};({vM,DL,NZ,g7})`,
    { Wj: () => undefined, s$: "raven" },
  );
}
test("only pinned originals derive; unrelated source unchanged and hashes/reapplication fail closed", () => {
  for (const name of Object.keys(hostAuthSourceHashes)) {
    const original = source(name),
      derived = deriveOfficialUiHostAuthModule(name, original);
    assert.notEqual(derived, original);
    assert.throws(
      () => deriveOfficialUiHostAuthModule(name, original + "\n"),
      /hash mismatch/,
    );
    assert.throws(
      () => deriveOfficialUiHostAuthModule(name, derived),
      /hash mismatch/,
    );
  }
  assert.equal(
    deriveOfficialUiHostAuthModule("unrelated.js", "untouched"),
    "untouched",
  );
});
test("Compare page opens for the supported host while retaining the original voting gate", () => {
  const name = "cf6c0e3a1-Y4ypZkpd.js";
  const original = source(name);
  const derived = deriveOfficialUiHostAuthModule(name, original);
  const start = derived.indexOf("function Ui()");
  const end = derived.indexOf("var Wi", start);
  assert.ok(start >= 0 && end > start);
  const page = derived.slice(start, end);
  assert.ok(derived.includes('f = M("__gb__2366236732")'));
  const render = (vendor, selected) => vm.runInNewContext(page + "\nUi()", {
    F: () => vendor,
    ke: () => ({ account: selected }),
    J9: () => [],
    J0: () => true,
    K0: (_state, _key, value) => value,
    p: () => "compare",
    g: (component) => component,
    m: "",
    ht: "",
    Ei: "",
    ne: "not-found",
  });
  const supported = account({ claudex_host_authentication: marker, claudex_comparison_supported: true });
  assert.equal(render(false, supported), "compare");
  assert.equal(render(true, undefined), "compare");
  assert.equal(render(false, account({ claudex_comparison_supported: true })), "not-found");
  assert.equal(render(false, account({ claudex_host_authentication: marker })), "not-found");
});
test("host routing mode never changes vendor identity/age facts, unmarked vendor path unchanged", () => {
  const { vM, DL, NZ, g7 } = authFunctions();
  const unmarked = account();
  assert.equal(DL(vM(unmarked)), "identity_verification");
  const marked = Object.freeze(
    account({ claudex_host_authentication: marker }),
  );
  const model = vM(marked);
  assert.equal(model.hostAuthenticated, true);
  assert.equal(model.is_verified, false);
  assert.equal(model.age_verified, false);
  assert.equal(NZ(marked), true);
  assert.equal(g7(marked), true);
  assert.equal(DL(model), undefined);
  assert.equal(DL(vM(account({ is_verified: true }))), "age_verification");
  assert.equal(
    DL(vM(account({ is_verified: true, age_is_verified: true }))),
    undefined,
  );
  assert.equal(Object.hasOwn(marked, "is_verified"), false);
  assert.equal(Object.hasOwn(marked, "age_is_verified"), false);
});
test("host marker must bind exact account/version/state; missing/unknown/signedout does not activate", () => {
  for (const e of [
    undefined,
    null,
    {},
    account(),
    account({ uuid: "" }),
    account({
      claudex_host_authentication: { ...marker, account_uuid: "other" },
    }),
    account({ claudex_host_authentication: { ...marker, version: 2 } }),
    account({
      claudex_host_authentication: { ...marker, status: "signed_out" },
    }),
  ])
    assert.equal(vm.runInNewContext(hostAuthenticatedExpression, { e }), false);
});
test("host route preserves membership, onboarding and pending invite requirements", () => {
  const { vM, DL } = authFunctions();
  assert.equal(
    DL(vM(account({ claudex_host_authentication: marker, memberships: [] }))),
    "organization_membership",
  );
  assert.equal(
    DL(
      vM(
        account({
          claudex_host_authentication: marker,
          settings: { has_finished_claudeai_onboarding: false },
        }),
      ),
    ),
    "onboarding",
  );
  assert.equal(
    DL({
      hostAuthenticated: true,
      has_membership: true,
      onboarding_complete: true,
      pending_invite: true,
    }),
    "pending_invites",
  );
});
test("direct route helpers only skip vendor-specific requests for bound host marker", () => {
  const rules = hostAuthRules.filter((r) => r.name.startsWith("scope-"));
  const { dF, c3 } = vm.runInNewContext(
    rules.map((r) => r.after).join("\n") + ";({dF,c3})",
    { jo: (e) => !e.is_verified, g7: (e) => !e.age_is_verified },
  );
  assert.equal(dF(account(), true), true);
  assert.equal(c3(account(), true, true), true);
  assert.equal(
    dF(account({ claudex_host_authentication: marker }), true),
    false,
  );
  assert.equal(
    c3(account({ claudex_host_authentication: marker }), true, true),
    false,
  );
  const raw = source("shared-l-p-m-w-4-BkeeGGW7.js"),
    derived = deriveOfficialUiHostAuthModule(
      "shared-l-p-m-w-4-BkeeGGW7.js",
      raw,
    );
  const start = derived.indexOf("function Bx({"),
    end = derived.indexOf("function Ce(", start);
  const { vM, DL } = authFunctions();
  const Bx = vm.runInNewContext(derived.slice(start, end) + ";Bx", {
    Ih: vM,
    s$: DL,
    Zy: {
      identity_verification: "/onboarding",
      organization_membership: "/onboarding",
      onboarding: "/onboarding",
      age_verification: "/age-verification",
    },
  });
  assert.equal(Bx({ account: account(), isClaudeDot: true }), "/onboarding");
  assert.equal(
    Bx({
      account: account({ claudex_host_authentication: marker }),
      isClaudeDot: true,
    }),
    "/new",
  );
});
test("assembly validates every original before first write and refuses immutable originals", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-host-auth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of Object.keys(hostAuthSourceHashes))
    fs.writeFileSync(path.join(dir, name), source(name));
  const name = Object.keys(hostAuthSourceHashes)[2];
  fs.appendFileSync(path.join(dir, name), "\nchanged");
  assert.throws(() => applyOfficialUiHostAuth(dir), /hash mismatch/);
  assert.equal(
    fs.readFileSync(
      path.join(dir, Object.keys(hostAuthSourceHashes)[0]),
      "utf8",
    ),
    source(Object.keys(hostAuthSourceHashes)[0]),
  );
  const immutable = path.join(dir, ".restore");
  fs.mkdirSync(immutable);
  assert.throws(() => applyOfficialUiHostAuth(immutable), /immutable/);
  fs.writeFileSync(path.join(dir, name), source(name));
  const manifest = applyOfficialUiHostAuth(dir);
  assert.deepEqual(manifest.modules.map((module) => module.file), Object.keys(hostAuthSourceHashes));
  assert.ok(manifest.modules.every((m) => m.originalSha256 !== m.outputSha256));
});

test("each read predicate accepts only bound host or original verified vendor and preserves capability conditions", () => {
  const contexts = {
    "host-authenticated-history-page-read": {
      account: "l",
      base: { u: {}, c: true, d: { isAvailable: true } },
      blocked: { c: false },
    },
    "host-authenticated-history-infinite-read": {
      account: "p",
      base: { m: {}, d: true, h: { isAvailable: true } },
      blocked: { d: false },
    },
    "host-authenticated-recents-live-read": {
      account: "o",
      base: { t: true, s: {}, c: { isAvailable: true }, n: "live", h: false },
      blocked: { t: false },
    },
    "host-authenticated-transcript-freshness-read": {
      account: "w",
      base: { x: { enabled: true }, r: true, n: {}, E: "org" },
      blocked: { r: false },
    },
  };
  for (const [name, context] of Object.entries(contexts)) {
    const rule = hostAuthRules.find((r) => r.name === name),
      expression = rule.after
        .slice(rule.after.indexOf("=") + 1)
        .trim()
        .replace(/,$/, "");
    const evaluate = (value, blocked = {}) =>
      vm.runInNewContext(expression, {
        ...context.base,
        [context.account]: value,
        ...blocked,
      });
    for (const value of [
      undefined,
      null,
      account(),
      account({ claudex_host_authentication: { ...marker, version: 0 } }),
      account({
        claudex_host_authentication: { ...marker, account_uuid: "other" },
      }),
      account({
        claudex_host_authentication: { ...marker, status: "unknown" },
      }),
    ])
      assert.equal(evaluate(value), false, name);
    for (const value of [
      account({ is_verified: true }),
      account({ claudex_host_authentication: marker }),
    ]) {
      assert.equal(evaluate(value), true, name);
      assert.equal(evaluate(value, context.blocked), false, name);
    }
  }
});
