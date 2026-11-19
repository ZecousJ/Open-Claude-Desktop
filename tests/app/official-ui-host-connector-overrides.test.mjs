import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { brandedModule } from "../../scripts/official-web-assets.mjs";
import {
  deriveOfficialUiHostConnectorLimitModule,
  hostConnectorLimitRules,
} from "../../scripts/official-ui-host-connector-limit.mjs";

const root = path.join(
  process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? ".restore/archive-extracted",
  "claude-frontend-4.4212.0/src/cloud/assets/v1",
);
const file = "ce99eb202-OxP5cSN7.js";
const input = brandedModule(fs.readFileSync(path.join(root, file), "utf8"));
const derived = deriveOfficialUiHostConnectorLimitModule(file, input);
const grant = {
  uuid: "account",
  claudex_host_authentication: { version: 1, status: "authenticated", account_uuid: "account" },
  claudex_custom_connector_creation: true,
};
const frame = { accountUuid: "account", orgUuid: "org" };
const rules = hostConnectorLimitRules.filter((rule) => rule.file === file);

function section(source, start, end) {
  const at = source.indexOf(start);
  const to = source.indexOf(end, at);
  assert.ok(at >= 0 && to > at, `Missing original ${start}`);
  return source.slice(at, to);
}

function availability({ account = grant, organization = { uuid: "org" }, context = frame,
  url = "https://mcp.example.com/mcp", upstream = false, posture = "auth_required", initialHeaders } = {}) {
  const box = {
    URL, window: { __claudexOfficialAccountContext: context },
    __claudexConnectorContext: () => ({ account, activeOrganization: organization }),
    initialHeaders,
    J9: () => [], Ot: {}, kt: {}, de: () => ({}), o: () => "ltr",
    Te: () => false, Ce: () => false, we: () => false, xe: () => false,
    ne: () => upstream, v: () => upstream,
    J3: () => true, J4: () => true,
    K3: (_cache, _slot, ...args) => args.at(-1), K5() {},
    me: (url) => URL.parse(url)?.hostname.endsWith(".tunnel.anthropic.com"),
    $: [], U: url, W: undefined, V: false,
    J: { posture, registration: "cimd", provisionedOAuth: { scopes: "read" } },
    Fe: () => true, Ie: () => true,
  };
  vm.createContext(box);
  vm.runInContext([
    section(derived, "function Qe(", "function rt("),
    section(derived, "function bt(e) {", "    mt = J1").trim().replace(/,$/, ";") +
      "return { ut, ft, __claudexConnectorOverrides }; }",
    "var { ut, ft, __claudexConnectorOverrides } = bt({ initialHeaders });",
    "var " + section(derived, "Jn =", "    Z,").trim().replace(/,$/, ";"),
    "var Z, Yn, Xn;",
    section(derived, "  J4($, 81,", "  let Zn ="),
    "this.available = Jn; this.retained = Z.provisionedOAuth;",
  ].join("\n"), box);
  return { available: box.available, retained: box.retained?.scopes };
}

test("authorized native and Web hosts keep overrides for public HTTPS connectors", () => {
  for (const context of [frame, null]) {
    assert.deepEqual(availability({ context }), { available: true, retained: "read" });
    assert.deepEqual(availability({ context, posture: "no_auth" }), { available: true, retained: undefined });
  }
});

test("the original wizard reads account context with prefilled headers", () => {
  for (const initialHeaders of [undefined, [], [{ name: "x-tenant", value: "example" }]]) {
    assert.deepEqual(availability({ initialHeaders }), { available: true, retained: "read" });
  }
});

test("override controls require the current host grant and an HTTPS URL", () => {
  for (const changes of [
    { account: { ...grant, claudex_custom_connector_creation: false } },
    { account: { uuid: "account" } },
    { context: { ...frame, accountUuid: "other" } },
    { context: { ...frame, orgUuid: "other" } },
    { organization: null },
    { url: "http://mcp.example.com/mcp" },
    { url: "mcprelay://device/mcp" },
    { url: "https://user:secret@mcp.example.com/mcp" },
    { url: "https://mcp.example.com/${tenant}" },
  ]) assert.deepEqual(availability(changes), { available: false, retained: undefined });
});

test("vendor accounts retain the original tunnel availability", () => {
  const account = { uuid: "account" };
  assert.equal(availability({ account, context: null, upstream: true }).available, false);
  assert.equal(availability({ account, context: null, upstream: true,
    url: "https://server.tunnel.anthropic.com/mcp" }).available, true);
});

test("the derivation preserves the pinned wizard outside the host availability rules", async () => {
  let restored = derived;
  for (const { before, after } of [...rules].reverse()) restored = restored.replace(after, before);
  assert.equal(restored, input);
  const { transformSync } = await import("esbuild");
  transformSync(derived, { loader: "js" });
  assert.throws(() => deriveOfficialUiHostConnectorLimitModule(file, derived), /input mismatch/);
});
