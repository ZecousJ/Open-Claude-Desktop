import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { hostAuthenticatedExpression } from "./official-ui-host-auth.mjs";

export const hostConnectorLimitRevision = "claudex-custom-connector-lifecycle-v7";
const file = "shared-m-2-DfdOu-fU.js";
const wizard = "ce99eb202-OxP5cSN7.js";
const refresh = "shared-m-8-CVxtIISM.js";
const directoryBrowser = "shared-p-m-0-CY3OVG_x.js";
const directorySchema = "c384c256e-CRkcl2Nm.js";
const directoryWizard = "c68689876-B4vYgAsx.js";
const directoryPage = "c6863c51c-CWe2wIES.js";
const connectorDetail = "c08e79e85-B4RZM5DI.js";
const toolPermissions = "c4ac4d9d6-BEQAxfRe.js";
export const hostConnectorLimitOriginalHashes = {
  [connectorDetail]: "12d9dd87c966d60796638f0a7cdf7c03ccfd56d00a42aa736cf9cdb3cb0cd278",
  [toolPermissions]: "297533af646dec59a822b952844b910d2917e2fe0c743a5caf7433a8b271e799",
  [directoryBrowser]: "d2516d18fe7a55d34c9d10af835560e8246361e8e7b3807176ae23b245624a95",
  [directorySchema]: "60af68e397a9b671345d36edd19a7e2b0d06cb4967ef8db0310814dcfcfd5468",
  [directoryWizard]: "e2f980f1aec9e10c537aeb0b55ef91e07139037586a95369f081a6e808b63033",
  [directoryPage]: "4b54f299378829fe6b79d77e8c4a54c7d7394e69439f73907e6baac4880ceb4a",
  [refresh]: "8ee946fc579607ba9c35aefa106cf387ce1652d1153cf1bfe2ca4b4f509dd557",
  [wizard]: "97f17590bae6c93b955ae476799f1b1ab7097afb4f962dd60fece557ae14c7aa",
  [file]: "4bff05fcf5c76e3ee12e6196f9fce0ed4409e7d560957af0cc48da3a09f29e50",
};
export const hostConnectorLimitInputHashes = {
  [connectorDetail]: "6cd1eda7fecfd2b10796c983b854c302905f3b29c0600acdceecf05cde6f1d75",
  [toolPermissions]: "ea174cb6c559689ab10df2b3af10f1241e0ef199fc3589abf2b21bb516116e81",
  [directoryBrowser]: hostConnectorLimitOriginalHashes[directoryBrowser],
  [directorySchema]: hostConnectorLimitOriginalHashes[directorySchema],
  [directoryWizard]: "f32af7622be78e43d49d3cfe0c125b3e848b185e5e14de1464099b707c2d4151",
  [directoryPage]: "9a9d7b3d625585c029893b63470f06c1d2910c35f32ae43a4ad60eafa81ffdbe",
  [refresh]: "892cddca690934d235e0335eded5f32b9e7267ee0ee56a34e553c2990b818bec",
  [wizard]: "8b15c4b7aa73cab1f143d35e3a7b81f1246051cd1b2b717222eba3a8d0aad59e",
  [file]: "d1f50c6cc5ac1229588928115f9a25d3424dbe586489c7b7f8560e797f0f491b",
};
const hostAuthentication = hostAuthenticatedExpression.replace(/\be\b/g, "__claudexConnectorAccount");
export const hostConnectorLimitRules = [{
  file: directoryBrowser,
  name: "decode-host-connector-description",
  before: '      label: P_().nullable().optional(),\n      owner_account_uuid:',
  after: '      label: P_().nullable().optional(),\n      description: P_().optional(),\n      owner_account_uuid:',
}, {
  file: connectorDetail,
  name: "import-original-connector-detail-query",
  before: '  Ib as ie,\n  Ii as ue,',
  after: '  Dh as useManagedConnectorDetail,\n  Ib as ie,\n  Ii as ue,',
}, {
  file: connectorDetail,
  name: "read-managed-connector-description",
  before: '    { activeOrganization: ee } = pe(),\n    O = T("claudeai_mcp_servers_with_connection"),',
  after: `    { activeOrganization: ee } = pe(),
    managed = t.connector?.cai_flags?.includes("claudex_managed") === true,
    { data: managedDetail } = useManagedConnectorDetail(ee?.uuid, t.connector?.uuid, { enabled: managed }),
    description = managed ? managedDetail?.description : t.description,
    O = T("claudeai_mcp_servers_with_connection"),`,
}, {
  file: connectorDetail,
  name: "managed-connector-detail-display",
  before: `    Dn = J1($, 466, t.description)
      ? I1(
          $,
          466,
          t.description &&
            u(xt, {
              markdown: t.description,
              className: "text-body-regular text-secondary [&>div]:whitespace-normal",
            }),
          t.description,
        )`,
  after: `    Dn = J1($, 466, description)
      ? I1(
          $,
          466,
          description &&
            u(xt, {
              markdown: description,
              className: "text-body-regular text-secondary [&>div]:whitespace-normal",
            }),
          description,
        )`,
}, {
  file: connectorDetail,
  name: "managed-connector-offline-state",
  before: '  let Ot = J1($, 99, t.connector)',
  after: `  if (managed && !t.isConnected) {
    return a("div", {
      className: "px-6 pb-6",
      children: [
        u("h2", { className: "text-heading-semibold text-primary", children: t.name }),
        description && u(xt, { markdown: description, className: "text-body-regular text-secondary" }),
        !t.connector.isConnecting && u(U, { defaultMessage: "Connection issue", id: "YuGYok" }),
      ],
    });
  }
  let Ot = J1($, 99, t.connector)`,
}, {
  file: connectorDetail,
  name: "managed-connector-lifecycle",
  before: '    k = J1($, 16, t) ? K1($, 16, t, !Ze(t) && !(t !== void 0 && Ge(t))) : $[17],',
  after: '    k = J1($, 16, t) ? K1($, 16, t, !t?.cai_flags?.includes("claudex_managed") && !Ze(t) && !(t !== void 0 && Ge(t))) : $[17],',
}, {
  file: connectorDetail,
  name: "managed-connector-disconnect",
  before: '    Cn = J2($, 454, bn, Sn)\n      ? K2($, 454, bn, Sn, a("div", { className: "flex items-center gap-2", children: [bn, Sn] }))',
  after: '    Cn = J2($, 454, managed ? null : bn, Sn)\n      ? K2($, 454, managed ? null : bn, Sn, a("div", { className: "flex items-center gap-2", children: [managed ? null : bn, Sn] }))',
}, {
  file: toolPermissions,
  name: "managed-connector-permission-heading",
  before: '    y = J2($, 10, p, v) ? K2($, 10, p, v, l(Zt, { id: p, lead: v })) : $[12],',
  after: '    y = t.cai_flags?.includes("claudex_managed") ? l("div", { id: p }) : J2($, 10, p, v) ? K2($, 10, p, v, l(Zt, { id: p, lead: v })) : $[12],',
}, {
  file: toolPermissions,
  name: "managed-connector-approval-history",
  before: '    T = J1($, 44, t)\n      ? K1(',
  after: '    T = t.cai_flags?.includes("claudex_managed") ? void 0 : J1($, 44, t)\n      ? K1(',
}, {
  file: toolPermissions,
  name: "managed-connector-group-permissions",
  before: '    ie = J5($, 36, A, w, ne, k, z, B)',
  after: '    ie = c.cai_flags?.includes("claudex_managed") ? void 0 : J5($, 36, A, w, ne, k, z, B)',
}, {
  file: toolPermissions,
  name: "managed-connector-tool-permissions",
  before: '                        showPermissionControl: !0,',
  after: '                        showPermissionControl: !c.cai_flags?.includes("claudex_managed"),',
}, {
  file: directorySchema,
  name: "decode-approved-connector-template",
  before: 'i(() =>\n  e({\n    verified_tier: d(["anthropic", "partner", "community"]).optional(),',
  after: 'const claudexDirectoryLegacy = i(() =>\n  e({\n    verified_tier: d(["anthropic", "partner", "community"]).optional(),',
}, {
  file: directorySchema,
  name: "retain-approved-connector-template",
  before: '      verified_tier: z(d(["anthropic", "partner", "community"])).optional(),\n      taxonomy:',
  after: '      verified_tier: z(d(["anthropic", "partner", "community"])).optional(),\n      legacy: claudexDirectoryLegacy.optional(),\n      taxonomy:',
}, {
  file: directoryPage,
  name: "respect-approved-connector-sign-in-mode",
  before: 'let t = e.thenInitOAuth || (me && e.audience === "self");',
  after: 'let t = e.thenInitOAuth || (me && e.audience === "self" && e.params.mcp_directory_server_uuid === void 0);',
}, {
  file: directoryWizard,
  name: "use-original-connector-template-form",
  before: 'return e.gates.urlTemplate === !0 && L(e.server) ? e.server.urlTemplate : void 0;',
  after: 'return (e.gates.urlTemplate === !0 || e.server.sourceFeed === "claudex") && L(e.server) ? e.server.urlTemplate : void 0;',
}, {
  file: directoryWizard,
  name: "use-published-connector-setup-fields",
  before: '    installSpecEnabled: b,',
  after: '    installSpecEnabled: b && e.sourceFeed !== "claudex",',
}, {
  file: directoryBrowser,
  name: "map-approved-template-to-original-install-form",
  before: '      urlAnyHost: !0,\n    };',
  after: '      urlAnyHost: !0,\n      ...(e.checks.review.by?.type === "your_admin" && { urlTemplate: fx(e.legacy, e.slug ?? "") }),\n    };',
}, {
  file: directoryBrowser,
  name: "approved-connector-directory-origin",
  before: 'return i2({ appEnv: "production", isPubSec: !1 }) ?? window.location.origin;',
  after: 'return window.location.origin;',
}, {
  file: directoryBrowser,
  name: "approved-connector-directory-endpoint-options",
  before: '    c = t.review.state !== "done";',
  after: '    c = t.review.state !== "done" && e.source_feed !== "claudex";',
}, {
  file: directoryBrowser,
  name: "approved-connector-directory-endpoint-options-readback",
  before: '  let n = c8(e),\n    r = n === "community",\n    i = e.legacy,\n    a = Gc(e, t, r);',
  after: '  let n = c8(e),\n    r = n === "community",\n    i = e.legacy,\n    a = Gc(e, t, r && i?.source_feed !== "claudex" && e.checks.review.by?.type !== "your_admin");',
}, {
  file: directoryBrowser,
  name: "approved-connector-directory-selection",
  before: 'return e.verifiedTier !== "community" && e.sourceFeed !== "custom";',
  after: 'return e.sourceFeed === "claudex" || (e.verifiedTier !== "community" && e.sourceFeed !== "custom");',
}, {
  file: directoryBrowser,
  name: "approved-connector-directory-provenance",
  before: '    sourceFeed: r?.source_feed,',
  after: '    sourceFeed: e.checks.review.by?.type === "your_admin" ? "claudex" : r?.source_feed,',
}, {
  file: directoryBrowser,
  name: "approved-connector-directory-search",
  before: 'let e = FF("conditional_mcp_directory_servers", "visibility", []),\n    t = sA.safeParse(e),\n    n = t.success ? t.data : [],\n    r = vK($5),',
  after: 'let n = ["claudex"],\n    r = !0,',
}, {
  file: directoryBrowser,
  name: "approved-connector-directory-visibility",
  before: 'o = a.length > 0 ? a : (e?.visibilityTagsWhenConfigEmpty ?? Rb),\n    s = pr($5),',
  after: 'o = ["claudex"],\n    s = !0,',
}, {
  file,
  name: "custom-connector-creation-grant",
  before: '    n = t === void 0 || t,\n    r = rq() === "free",\n    i = $C(n && r ? void 0 : s$),',
  after: `    { account: __claudexConnectorAccount, activeOrganization: __claudexConnectorOrganization } = E_(),
    __claudexConnectorFrame = typeof window < "u" && window.__claudexOfficialAccountContext,
    __claudexConnectorCreation = __claudexConnectorFrame || __claudexConnectorAccount?.claudex_host_authentication
      ? __claudexConnectorAccount?.claudex_custom_connector_creation === true &&
        (${hostAuthentication}) &&
        !!__claudexConnectorOrganization?.uuid &&
        (!__claudexConnectorFrame || (
          __claudexConnectorFrame.accountUuid === __claudexConnectorAccount.uuid &&
          __claudexConnectorFrame.orgUuid === __claudexConnectorOrganization.uuid
        ))
      : void 0,
    n = (t === void 0 || t) && __claudexConnectorCreation !== false,
    r = rq() === "free" && __claudexConnectorCreation !== true,
    i = $C(n && r ? void 0 : s$),`,
}, {
  file: wizard,
  name: "custom-connector-context-hook",
  before: 'import { Io as O, JE as A, ce, gn as D, hh as le, oS as k } from "./shared-l-p-m-w-2-BMCa56Vr.js";',
  after: 'import { Io as O, JE as A, ce, ce as __claudexConnectorContext, gn as D, hh as le, oS as k } from "./shared-l-p-m-w-2-BMCa56Vr.js";',
}, {
  file: wizard,
  name: "custom-connector-oauth-overrides-grant",
  before: '    ut = ne("dig_dug"),\n    ft = v("dig_dug_provisioned_oauth"),',
  after: `    { account: __claudexConnectorAccount, activeOrganization: __claudexConnectorOrganization } = __claudexConnectorContext(),
    __claudexConnectorFrame = typeof window < "u" && window.__claudexOfficialAccountContext,
    __claudexConnectorOverrides = __claudexConnectorAccount?.claudex_custom_connector_creation === true &&
      (${hostAuthentication}) &&
      !!__claudexConnectorOrganization?.uuid &&
      (!__claudexConnectorFrame || (
        __claudexConnectorFrame.accountUuid === __claudexConnectorAccount.uuid &&
        __claudexConnectorFrame.orgUuid === __claudexConnectorOrganization.uuid
      )),
    ut = ne("dig_dug") || __claudexConnectorOverrides,
    ft = v("dig_dug_provisioned_oauth") || __claudexConnectorOverrides,`,
}, {
  file: wizard,
  name: "custom-connector-https-oauth-overrides",
  before: '    Jn = J3($, 77, ut, ft, U) ? K3($, 77, ut, ft, U, ut && ft && me(U)) : $[80],',
  after: `    Jn = __claudexConnectorOverrides
      ? Qe(U, false) && !nt(U) && !et(U)
      : J3($, 77, ut, ft, U) ? K3($, 77, ut, ft, U, ut && ft && me(U)) : $[80],`,
}, {
  file: wizard,
  name: "custom-connector-retain-public-https-overrides",
  before: '      !!k && !!S?.discovery && (U ?? "").trim() !== (y ?? "") && Qe(U, B) && !me((U ?? "").trim()),',
  after: '      !!k && !!S?.discovery && (U ?? "").trim() !== (y ?? "") && Qe(U, B) && !__claudexConnectorOverrides && !me((U ?? "").trim()),',
}, {
  file: refresh,
  name: "connector-refresh-original-tool-decoder",
  before: '  aq as wE,',
  after: '  aq as wE,\n  zJ as __claudexDecodeConnectorTools,',
}, {
  file: refresh,
  name: "connector-refresh-original-tool-filter",
  before: '  t2 as FyL,',
  after: '  t2 as FyL,\n  tT as __claudexSplitConnectorTools,',
}, {
  file: refresh,
  name: "connector-refresh-host-inventory",
  before: '          await G7K({',
  after: `          const host = window.__claudexOfficialAccountContext;
          if (host?.orgUuid === n && host.accountUuid === r) {
            try {
              await new Promise((resolve, reject) => {
                const stream = new EventSource("/api/organizations/" + n + "/mcp/v2/bootstrap");
                let tools, connected = false;
                const fail = () => {
                  stream.close();
                  reject(Error("Connector tools are unavailable."));
                };
                stream.addEventListener("error", fail, { once: true });
                stream.addEventListener("server_base", (event) => {
                  const result = JSON.parse(event.data);
                  if (result.uuid === e) connected = result.connected === true;
                });
                stream.addEventListener("tools", (event) => {
                  const result = JSON.parse(event.data);
                  if (result.server_uuid === e && Array.isArray(result.tools)) tools = result.tools;
                });
                stream.addEventListener("completed", () => {
                  stream.close();
                  if (!connected || !tools || window.__claudexOfficialAccountContext !== host) return fail();
                  try {
                    const { modelVisible, appOnly } = __claudexSplitConnectorTools(__claudexDecodeConnectorTools(tools));
                    wz.getState().setRemoteTools(e, modelVisible, appOnly);
                    resolve();
                  } catch (error) { reject(error); }
                }, { once: true });
              });
            } catch (error) {
              wz.getState().setRemoteToolsRefreshError(e, { message: error.message });
              throw error;
            } finally {
              wz.getState().setRemoteToolsRefreshing(e, !1);
            }
            return;
          }
          await G7K({`,
}];

const sha = (source) => createHash("sha256").update(source).digest("hex");
export function deriveOfficialUiHostConnectorLimitModule(name, source) {
  if (!Object.hasOwn(hostConnectorLimitInputHashes, name)) return source;
  if (sha(source) !== hostConnectorLimitInputHashes[name])
    throw Error(`Pinned custom connector creation input mismatch: ${name}`);
  let output = source;
  for (const { before, after } of hostConnectorLimitRules.filter((rule) => rule.file === name)) {
    const at = output.indexOf(before);
    if (at < 0 || output.indexOf(before, at + before.length) >= 0)
      throw Error(`Pinned custom connector creation anchor mismatch: ${name}`);
    output = output.slice(0, at) + after + output.slice(at + before.length);
  }
  return output;
}

export function applyOfficialUiHostConnectorLimit(directory) {
  directory = fs.realpathSync(directory);
  if (directory.split(path.sep).includes(".restore"))
    throw Error("Recovered sources are immutable");
  const modules = Object.keys(hostConnectorLimitInputHashes).map((name) => {
    const location = path.join(directory, name);
    const stat = fs.lstatSync(location);
    if (!stat.isFile() || stat.nlink !== 1)
      throw Error("Custom connector creation derivation requires an unlinked regular file");
    const source = fs.readFileSync(location, "utf8");
    return { name, location, output: deriveOfficialUiHostConnectorLimitModule(name, source) };
  });
  for (const { location, output } of modules) fs.writeFileSync(location, output);
  return {
    revision: hostConnectorLimitRevision,
    modules: modules.map(({ name, output }) => ({
      file: name,
      originalSha256: hostConnectorLimitOriginalHashes[name],
      inputSha256: hostConnectorLimitInputHashes[name],
      outputSha256: sha(output),
      rules: hostConnectorLimitRules.filter((rule) => rule.file === name).map(({ name }) => name),
    })),
  };
}
