import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { brandedModule } from "../../scripts/official-web-assets.mjs";
import { deriveOfficialUiHostIncognitoLifecycleModule } from "../../scripts/official-ui-host-incognito-lifecycle.mjs";
import { deriveOfficialUiHostProjectMoveModule } from "../../scripts/official-ui-host-project-move.mjs";
import {
  deriveOfficialUiHostConnectorLimitModule,
  hostConnectorLimitRules,
} from "../../scripts/official-ui-host-connector-limit.mjs";

const root = path.join(
  process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? ".restore/archive-extracted",
  "claude-frontend-4.4212.0/src/cloud/assets/v1",
);
const { file, before, after } = hostConnectorLimitRules.find(
  (rule) => rule.name === "custom-connector-creation-grant",
);
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const input = deriveOfficialUiHostProjectMoveModule(file,
  deriveOfficialUiHostIncognitoLifecycleModule(file, brandedModule(read(file))));
const derived = deriveOfficialUiHostConnectorLimitModule(file, input);
const entry = read("c6a2a31c4-Ctc4FG8F.js");
const granted = {
  uuid: "account",
  claudex_host_authentication: { version: 1, status: "authenticated", account_uuid: "account" },
  claudex_custom_connector_creation: true,
};
const web = { accountUuid: "account", orgUuid: "org" };
const remote = (directory = false) => ({
  type: "remote",
  ...(directory ? { directoryMetadata: { id: "catalog" } } : {}),
});

function extract(source, name, after) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\n${after}`, start);
  assert.ok(start >= 0 && end > start, `Missing original ${name}`);
  return source.slice(start, end);
}

function run({
  account, organization = { uuid: "org" }, frame, tier = "free", servers = [],
  manage = true, mcp = true, pending = false, shouldCheck = true, source = derived,
}) {
  const use = (_cache, _slot, ...args) => args.at(-1);
  const jsx = (tag, props) => ({ tag, props });
  let opened = false;
  const box = {
    window: { __claudexOfficialAccountContext: frame },
    E_: () => ({ account, activeOrganization: organization }),
    rq: () => tier,
    $C: () => servers,
    An: (select) => select({ catalogAttribution: pending ? "pending" : "ready" }),
    J9: () => [],
    J0: () => true, J1: () => true, J2: () => true, J3: () => true,
    K0: use, K1: use, K2: use, K3: use, K4: use, K5: use, J4: () => true, J5: () => true,
    zI: () => false, YP: () => false, Aj: () => false,
    nt: () => box.limit({ shouldCheck }), rt: () => mcp, it: () => true,
    qr: () => ({ manageFromPersonal: manage, manageFromOrg: false }),
    Pa: () => false, Ut: () => false, ir: () => false,
    Na: ({ mayAdd }) => mayAdd, La: () => false,
    wn: () => ({ formatMessage: ({ defaultMessage }) => defaultMessage }),
    Ir: () => "Free plan allows 1 custom connector. Upgrade for more.",
    Bt: () => false,
    p: jsx, o: jsx, _: { GroupLabel: "label", Group: "group", Item: "item" },
    Q: "message", Nr: { needs_org_owner: { defaultMessage: "Ask an organization owner" } },
    onAdd: () => { opened = true; },
  };
  vm.createContext(box);
  vm.runInContext([
    'var s$ = { type: "local" };',
    extract(source, "Kl", "var Rg ="),
    extract(entry, "Wu", "var Gu ="),
    extract(entry, "Ju", "function Yu("),
    "this.limit = Kl; this.access = Wu(); this.menu = Ju({ onAdd });",
  ].join("\n"), box);
  const button = box.menu?.props.children[1].props;
  button?.onClick?.();
  return {
    label: button?.children.props.defaultMessage,
    disabled: button?.disabled,
    reason: button?.disabledReason,
    dialogAllowed: box.access.opensDialog,
    loading: box.access.isLimitLoading,
    opened,
  };
}

test("authorized Web and native users can open the original add connector dialog after their first custom connector", () => {
  for (const frame of [web, undefined]) {
    assert.deepEqual(run({ account: granted, frame, servers: [remote(), remote(), remote(true)], pending: true }), {
      label: "Add custom connector", disabled: false, reason: undefined,
      dialogAllowed: true, loading: false, opened: true,
    });
  }
});

test("missing grant, stale Web account and missing active organization close the original entry", () => {
  for (const overrides of [
    { account: undefined },
    { account: { ...granted, claudex_custom_connector_creation: undefined } },
    { account: { ...granted, claudex_custom_connector_creation: undefined }, frame: undefined },
    { account: { ...granted, claudex_host_authentication: undefined } },
    { frame: { ...web, accountUuid: "other" } },
    { frame: { ...web, orgUuid: "other" } },
    { organization: null },
    { shouldCheck: false },
    { mcp: false },
  ]) {
    assert.deepEqual(run({ account: granted, frame: web, ...overrides }), {
      label: undefined, disabled: undefined, reason: undefined,
      dialogAllowed: false, loading: false, opened: false,
    });
  }
  const member = run({ account: granted, frame: web, manage: false });
  assert.equal(member.disabled, true);
  assert.equal(member.opened, false);
});

test("the original Free quota still governs vendor accounts", () => {
  for (const tier of ["free", "pro"]) {
    for (const servers of [[], [remote()], [remote(true)], [remote(), remote(true)]]) {
      for (const pending of [false, true]) {
        const args = { account: { uuid: "account" }, tier, servers, pending };
        assert.deepEqual(run(args), run({ ...args, source: input }));
      }
    }
  }
  const limited = run({ servers: [remote()] });
  assert.equal(limited.label, "Add custom connector");
  assert.equal(limited.disabled, true);
  assert.equal(limited.opened, false);
});

test("the approved renderer rule changes only original connector access", async () => {
  assert.equal(derived.replace(after, before), input);
  assert.throws(() => deriveOfficialUiHostConnectorLimitModule(file, derived), /input mismatch/);
  const { transformSync } = await import("esbuild");
  transformSync(derived, { loader: "js" });
});
