/** Pinned host installed-library summaries. No invented native component/path inventory. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { hostAuthenticatedExpression } from "./official-ui-host-auth.mjs";
export const hostInstalledPluginsRevision =
  "claudex-installed-plugin-summary-v8";
export const hostInstalledPluginsInputHashes = {
  "cf0e8a0d3-DUFBw2XT.js":
    "9fd69d93c8369e2657619677f04373481625554cd93f8b654f57a837834b2624",
  "shared-m-4-CbJwwS_m.js":
    "8fa7edc3057f81d160ad8802fcaf61881e045ecf0e9137cef37879c5b49e0a01",
  "c08f249ae-5qhemGT7.js":
    "dc92302bf3d7f51e925dd58e71acf6f7356b426d378c31d2af3c5938e7696c6d",
  "c3bb81cd1-BeTk7zYW.js":
    "1da8beda6241e00793e9575c6dc9677a780b01954c5d39cfc94a7222a43df35d",
  "c24c8737b-5PJBZo1Q.js":
    "810482a8d886cdb0a03ac7bb79202a6f72943aeeb7facaff56b191689d7ad552",
  "ccea1f474-B2jbjvXx.js":
    "0a0305c13a2b5f4316a92ffc6ae8bcfc5b0b37daf5760b5d8bd0ace265798c1b",
  "c6a2a31c4-Ctc4FG8F.js":
    "6d92204d1335c31700a1633bb7b32fe8fc232f427a099df717a8a8ac29d6e2a9",
  "c979ed9d0-C-llIJ0y.js":
    "017233e73f112faac9abaea152dc80e6e7b2655af67be7ded3e8372cfa0f1769",
  "c2e144342-BPmQtTD1.js":
    "9664c61c191fc3a5b98c23bfc6492cb55c583e607be1a9a9ad56fdbed9827c77",
  "c27f32a39-pQdcmpai.js":
    "30e0549430577a7c82c698a86a4399ea15aff82a61c0ba8ab268039f84294515",
};
export const hostInstalledPluginsOriginalHashes = {
  ...hostInstalledPluginsInputHashes,
  "c6a2a31c4-Ctc4FG8F.js":
    "5e13d857dfdf2214034d4077f4e8334fd6b260d4ce2ac76a16ae2d126b182b7b",
  "c979ed9d0-C-llIJ0y.js":
    "23cf5b97ceef97d159f888b708022d02c4fd516141a6535fe9a92fcff7a46592",
  "c2e144342-BPmQtTD1.js":
    "5e4f586b5dd369c786c9287e09c5c0c3980cf3563d31ce53405d4b1c8107b730",
  "c27f32a39-pQdcmpai.js":
    "1b587e2756bb562595d8fc95c36ae27c356de62ca1ad5c9bb56cf4942b098e2c",
  "shared-m-4-CbJwwS_m.js":
    "8030f304f03f4687571c251cb4239fea916b6c5665318bf84e27d7685c1dc6a9",
  "c24c8737b-5PJBZo1Q.js":
    "616b2660e134883e7adb831608c37532ae1db914a7ca06e800072033d907c2d2",
  "ccea1f474-B2jbjvXx.js":
    "8f971a8e3a2626bd4fe79330ecdb6850f116a087ff41d759304b745b002019ed",
};
export const installedSummaryHostSource = `function __claudexInstalledSummaryHost(context) { const e=context?.account; return ${hostAuthenticatedExpression} && typeof context?.activeOrganization?.uuid === "string" && context.activeOrganization.uuid.length > 0; }\n`;
const managedDetailProjection = `function __claudexPluginDetail(detail, record) {
 if (record.claudex_organization_plugin === true) return {...detail,id:record.id,backendId:record.id,source:"org",notOnThisComputer:false,claudexOrganizationPlugin:true};
 if (record.claudex_local_marketplace === true) return {...detail,id:record.id,source:"local",notOnThisComputer:false,claudexLocalMarketplace:true};
 return {...detail,id:record.id};
}
`;
export const installedSummaryDetailSource = managedDetailProjection + `function DN(id,options) {
 const context=LO(), supported=__claudexInstalledSummaryHost(context) && typeof id === "string" && /^plugin_[a-f0-9]{24}$/.test(id);
 const vendor=__claudexVendorPluginDetail(supported ? null : id, options);
 const read=qb(supported ? id : undefined,{enabled:supported,quietFailure:true});
 if(!supported)return vendor;
 return {data:read.data ? __claudexPluginDetail(Ho(read.data),read.data) : null,isLoading:read.isLoading,error:read.error ?? null,resolvedViaRemoteApi:true,linkVerdict:read.isError ? "failed" : null,retryLink:()=>read.refetch()};
}
`;
const list = "cf0e8a0d3-DUFBw2XT.js",
  merge = "c08f249ae-5qhemGT7.js",
  detail = "shared-m-4-CbJwwS_m.js";
const actions = "c3bb81cd1-BeTk7zYW.js";
const libraryDetail = "c24c8737b-5PJBZo1Q.js";
const search = "ccea1f474-B2jbjvXx.js";
const customize = "c6a2a31c4-Ctc4FG8F.js";
const discoveryCards = "c979ed9d0-C-llIJ0y.js";
const installTarget = "c2e144342-BPmQtTD1.js";
const enabledAction = "c27f32a39-pQdcmpai.js";
const registeredRepositoryQuery = "function useClaudexRegisteredRepositories(enabled) {\n" +
  "  const context = Rt();\n" +
  '  const bridge = globalThis["claude.web"]?.CustomPlugins;\n' +
  '  const mode = Kn() ? "ccd" : "cowork";\n' +
  '  const active = enabled && __claudexInstalledSummaryHost(context) && typeof bridge?.listMarketplaces === "function" && typeof bridge?.removeMarketplace === "function";\n' +
  "  const query = dn({\n" +
  '    queryKey: ["marketplaces", "claudex-registered-repositories", context?.account?.uuid, mode],\n' +
  "    enabled: active,\n" +
  '    queryFn: () => bridge.listMarketplaces([], {mode, scope:"registered-repositories"}),\n' +
  "  });\n" +
  "  return {active, rows: active ? query.data : undefined, refetch: query.refetch};\n" +
  "}\n";
export const hostInstalledPluginsRules = [
  {
    file: merge,
    name: "project-server-confirmed-installed-organization-row",
    before: '    id: v ? m(_) : p({ name: o, marketplaceName: c }),\n    backendId: _,',
    after: '    id: t.claudex_organization_plugin === true ? _ : v ? m(_) : p({ name: o, marketplaceName: c }),\n    ...(t.claudex_organization_plugin === true && {claudexOrganizationPlugin:true}),\n    backendId: _,',
  },
  {
    file: installTarget,
    name: "preserve-organization-approval-on-discovery-card",
    before: "    isInstalled: t.has(r) || t.has(i),\n    source: \"remote\",",
    after: "    isInstalled: t.has(r) || t.has(i),\n    ...(e.claudex_organization_plugin === true && {claudexOrganizationPlugin:true}),\n    source: \"remote\",",
  },
  {
    file: installTarget,
    name: "preserve-organization-approval-on-card-action-target",
    before: "    partitionBy: i ? null : H({ plugin: e, provenance: t }),\n    presentsAs:",
    after: "    partitionBy: i ? null : H({ plugin: e, provenance: t }),\n    ...(e.claudexOrganizationPlugin === true && {claudexOrganizationPlugin:true}),\n    presentsAs:",
  },
  {
    file: installTarget,
    name: "carry-organization-approval-to-the-original-action",
    before: "  return W(t, N(e), e.provenance.marketplace_id ?? void 0, U(e.provenance));",
    after: "  return {...W(t, N(e), e.provenance.marketplace_id ?? void 0, U(e.provenance)), ...(e.claudex_organization_plugin === true && {claudexOrganizationPlugin:true})};",
  },
  {
    file: enabledAction,
    name: "use-server-enabled-mutation-for-an-organization-plugin",
    before: "          if (r)\n            y = l({\n              pluginId: d,\n              backendId: e.backendId ?? d,",
    after: "          if (r || e.claudexOrganizationPlugin === true)\n            y = l({\n              pluginId: d,\n              backendId: e.backendId ?? d,\n              claudexOrganizationPlugin: e.claudexOrganizationPlugin === true,",
  },
  {
    file: detail,
    name: "carry-organization-marker-through-set-enabled",
    before: "            backendId: n,\n            enabled: a,\n            composedMoves: ha.get(t),",
    after: "            backendId: n,\n            enabled: a,\n            claudexOrganizationPlugin: e.claudexOrganizationPlugin === true,\n            composedMoves: ha.get(t),",
  },
  {
    file: detail,
    name: "send-organization-enable-to-the-approved-runtime",
    before: "        let c = HO(e, i);\n        o !== void 0 && cl(c, \"PUT\", o);",
    after: "        let c = HO(e, i) + (r.claudexOrganizationPlugin === true ? \"?source=organization\" : \"\");\n        o !== void 0 && cl(c, \"PUT\", o);",
  },
  {
    file: detail,
    name: "verify-returned-managed-state-before-reporting-success",
    before: "          f = await t(c, { method: \"PUT\", body: JSON.stringify({ enabled: a }) });",
    after: "          f = await t(c, { method: \"PUT\", body: JSON.stringify({ enabled: a }) });\n          if (r.claudexOrganizationPlugin === true && (f?.claudex_organization_plugin !== true || f.id !== i || f.installed !== true || f.enabled !== a)) throw Error(\"The organization plugin state could not be confirmed.\");",
  },
  {
    file: detail,
    name: "require-current-managed-update-response",
    before: "            n = a && l0(t) && u() && s?.() ? await d() : void 0;",
    after: "            n = r.claudexOrganizationPlugin !== true && a && l0(t) && u() && s?.() ? await d() : void 0;",
  },
  {
    file: detail,
    name: "avoid-legacy-plugin-sync-after-managed-disable",
    before: "          !a && n5() && N9?.syncSkills?.(),\n          a && WM() === l",
    after: "          !a && r.claudexOrganizationPlugin !== true && n5() && N9?.syncSkills?.(),\n          a && WM() === l",
  },
  {
    file: detail,
    name: "retain-consent-without-optimistic-managed-installation",
    before: "          (ha.set(t, i), e.enabled && Ln.set(t, await o(Qi(e), { actsOnServedRecord: !0 })));\n          let a = pN(n),",
    after: "          (ha.set(t, i), e.enabled && Ln.set(t, await o(Qi(e), { actsOnServedRecord: !0 })));\n          if (e.claudexOrganizationPlugin === true) return {movesAtMutate:i};\n          let a = pN(n),",
  },
  {
    file: detail,
    name: "avoid-optimistic-rollback-for-managed-installation",
    before: "          if (a === void 0 || a.movesAtMutate !== WM()) {\n            e?.onError?.(t, i);",
    after: "          if (i.claudexOrganizationPlugin === true || a === void 0 || a.movesAtMutate !== WM()) {\n            e?.onError?.(t, i);",
  },
  {
    file: detail,
    name: "reread-managed-installation-without-vendor-materialization",
    before: "          let c = Ln.get(s);\n          if (o?.movesAtMutate !== WM()) {",
    after: "          let c = Ln.get(s);\n          if (i.claudexOrganizationPlugin === true) {\n            if (o?.movesAtMutate === WM()) {\n              r.setQueriesData({queryKey:[TQ],predicate:query=>query.queryKey[1]?.backendPluginId===i.backendId}, record => record && {...record,enabled:t.enabled});\n              iw(r, n);\n              fz(r, n);\n            }\n            e?.onSuccess?.(i, t, c);\n            return;\n          }\n          if (o?.movesAtMutate !== WM()) {",
  },
  {
    file: discoveryCards,
    name: "organization-catalog-list-disables-plugin-actions",
    before: "                  onAdd: o.onAddPlugin,\n                  addPending: c,\n                  tryInChat: o.tryInChat,",
    after: "                  onAdd: n.item.claudex_organization_catalog_only ? void 0 : o.onAddPlugin,\n                  addPending: c,\n                  tryInChat: n.item.claudex_organization_catalog_only || n.item.claudex_organization_plugin ? void 0 : o.tryInChat,",
  },
  {
    file: discoveryCards,
    name: "reserve-managed-try-in-chat-for-confirmed-session-activation",
    before: "                !(n && !g) &&\n                  (t.placement === \"plugin\" || t.placement === \"wrap\") &&",
    after: "                !t.item.claudex_organization_plugin && !(n && !g) &&\n                  (t.placement === \"plugin\" || t.placement === \"wrap\") &&",
  },
  {
    file: discoveryCards,
    name: "do-not-offer-try-in-chat-in-the-managed-install-action",
    before: '                          tryInChat: t.placement === "plugin" && r !== "cta" ? i.tryInChat : void 0,',
    after: '                          tryInChat: !t.item.claudex_organization_plugin && t.placement === "plugin" && r !== "cta" ? i.tryInChat : void 0,',
  },
  {
    file: discoveryCards,
    name: "organization-catalog-grid-disables-plugin-actions",
    before: "    d = J1($, 0, t) ? K1($, 0, t, vr(t)) : $[1],",
    after: "    d = J1($, 0, t) ? K1($, 0, t, t.item.claudex_organization_catalog_only ? null : vr(t)) : $[1],",
  },
  {
    file: discoveryCards,
    name: "organization-catalog-card-does-not-advertise-add",
    before: "      return t.onAddPlugin !== void 0;",
    after: "      return !e.item.claudex_organization_catalog_only && t.onAddPlugin !== void 0;",
  },
  {
    file: customize,
    name: "organization-catalog-details-disable-install",
    before: "    O = m && y ? C : void 0,",
    after: "    O = m && y && !o.claudex_organization_catalog_only ? C : void 0,",
  },
  {
    file: customize,
    name: "show-marketplace-management-for-registered-repositories",
    before: "    A = l && (O.length > 0 || k.length > 0),",
    after: "    hostRepositories = useClaudexRegisteredRepositories(l),\n    A = l && (O.length > 0 || k.length > 0 || (hostRepositories.rows?.length ?? 0) > 0),",
  },
  {
    file: customize,
    name: "refresh-registered-repositories-on-dialog-open",
    before: "    ue = J0($, 41) ? K0($, 41, () => D(!0)) : $[41],",
    after: "    ue = () => { if (hostRepositories.rows?.length) { void hostRepositories.refetch(); D(\"registered\"); } else D(!0); },",
  },
  {
    file: customize,
    name: "render-original-local-marketplace-dialog",
    before: "    Te = J1($, 80, E) ? K1($, 80, E, E && p(bd, { isOpen: !0, onClose: de })) : $[81],",
    after: "    Te = E === \"registered\" ? hostRepositories.active && hostRepositories.rows && p(Sd, {isOpen:!0, onClose:de, marketplaces:hostRepositories.rows, plugins:hostRepositories.rows.flatMap(row=>row.installedPlugins), adminManagedNames:hd}) : E && p(bd, { isOpen: !0, onClose: de }),",
  },
  {
    file: detail,
    name: "read-registered-repositories-again-after-native-add",
    before: "          (Nz.has(e) || n.setQueryData([Ff, i, a], (t) => rD(t, e)),",
    after: "          if (e.savedTo === \"this_computer\") await n.invalidateQueries({queryKey: [Ff, \"claudex-registered-repositories\"]});\n          (Nz.has(e) || n.setQueryData([Ff, i, a], (t) => rD(t, e)),",
  },
  {
    file: detail,
    name: "read-registered-repositories-again-after-removal",
    before: "      ? K5($, 17, a, e, n, t, o, async (r, i) => {\n          (await t.invalidateQueries({ queryKey: [wu] }),",
    after: "      ? K5($, 17, a, e, n, t, o, async (r, i) => {\n          if (!i.backendId) await t.invalidateQueries({queryKey: [Ff, \"claudex-registered-repositories\"]});\n          (await t.invalidateQueries({ queryKey: [wu] }),",
  },
  {
    file: search,
    name: "carry-confirmed-marketplace-search-results",
    before:
      "    oe = J3($, 41, ie, re, ae)\n      ? K3($, 41, ie, re, ae, { cardDeps: re, pending: ie, cards: ae })\n      : $[44],",
    after:
      '    oe = J3($, 41, ie, re, ae)\n      ? K3($, 41, ie, re, ae, { cardDeps: re, pending: ie, cards: ae })\n      : $[44],\n    __claudexBrowse = t === "plugins" && q && !r.narrowed && globalThis["claude.web"]?.CustomPlugins?.addMarketplace ? J : void 0,\n    __claudexBrowseItems = __claudexBrowse && !n.unsettled && !J.isFetching && !J.isError\n      ? J.items.filter(item => item.claudex_local_marketplace === true) : void 0,',
  },
  {
    file: search,
    name: "pass-confirmed-marketplace-search-results",
    before:
      "    : $[123];\n  return J2($, 124, xe, Se) ? K2($, 124, xe, Se, i(a, { children: [xe, Se] })) : $[126];",
    after:
      "    : $[123];\n  return i(a, {children:[xe, __claudexBrowse ? f(he, {...Se.props, browseItems:__claudexBrowseItems, browseQuery:__claudexBrowse}) : Se]});",
  },
  {
    file: search,
    name: "render-confirmed-marketplace-search-results",
    before: "    Le = a.errored || o.isError,",
    after:
      "    __claudexDirectoryIds = new Set([...a.inPage.plugins,...a.addable.plugins,...a.yours.plugins].map(item=>item.id)),\n    __claudexMarketplaceCards = A && e.browseItems?.length\n      ? Xr(e.browseItems.filter(item=>!__claudexDirectoryIds.has(item.plugin?.backend_id)), A.cardDeps.overlay, true, A.pending.tryingKey) : [],\n    Le = a.errored || o.isError || e.browseQuery?.isError === true,",
  },
  {
    file: search,
    name: "include-marketplace-rows-in-search-empty-state",
    before: "      !a.inPage.hasMore,\n    We = J2($, 99, a, o)",
    after:
      "      !a.inPage.hasMore && __claudexMarketplaceCards.length === 0 && !e.browseQuery?.isFetching,\n    We = J2($, 99, a, o)",
  },
  {
    file: search,
    name: "retry-marketplace-search-with-the-directory",
    before:
      "    We = J2($, 99, a, o)\n      ? K2($, 99, a, o, () => {\n          (a.retry(), o.refetch());\n        })\n      : $[101],",
    after:
      "    We = e.browseQuery ? () => { a.retry(); o.refetch(); e.browseQuery.refetch(); } : J2($, 99, a, o)\n      ? K2($, 99, a, o, () => { a.retry(); o.refetch(); }) : $[101],",
  },
  {
    file: search,
    name: "include-marketplace-rows-in-announced-search-count",
    before: "    _t = Mt(mt ?? 0, q, ft, gt),",
    after:
      "    _t = Mt((mt ?? 0) + __claudexMarketplaceCards.length, q, ft, __claudexMarketplaceCards.length && (mt === 0 || mt !== void 0 && !e.browseQuery?.hasMore) ? void 0 : gt),",
  },
  {
    file: search,
    name: "announce-newly-resolved-marketplace-search-count",
    before: "  vt && yt?.query !== q && xt({ query: q, message: _t.message });",
    after:
      "  vt && (yt?.query !== q || yt?.message !== _t.message) && xt({ query: q, message: _t.message });",
  },
  {
    file: search,
    name: "append-original-marketplace-cards-to-search",
    before:
      "  return J4($, 200, jt, ee, Pt, Yt)\n    ? K4($, 200, jt, ee, Pt, Yt, i(jt, { query: ee, children: [Pt, Yt] }))\n    : $[204];",
    after:
      '  return i(jt, {query:ee, children:[Pt,Yt,__claudexMarketplaceCards.length > 0 && f("section",{"data-testid":"customize-marketplace-search-results",children:f(Zr,{cards:__claudexMarketplaceCards,block:Br({q:n.serverQ}),deps:A.cardDeps,pending:A.pending,listCount:br("name",H)})})]});',
  },
  {
    file: detail,
    name: "read-desktop-repository-binding-during-render",
    before: "function M_(e) {\n  let $ = J9(22),",
    after:
      "function M_(e) {\n  const localMarketplace=__claudexInstalledSummaryHost(LO()) && !!ba?.addMarketplace;\n  let $ = J9(22),",
  },
  {
    file: detail,
    name: "use-desktop-repository-marketplace",
    before:
      "          if (s || !ba?.addMarketplace) {\n            let e = await l(t);",
    after:
      '          if (o !== "account" && localMarketplace) {\n            return {...(await ba.addMarketplace(t,[],a)),savedTo:"this_computer"};\n          }\n          if (s || !ba?.addMarketplace) {\n            let e = await l(t);',
  },
  {
    file: libraryDetail,
    name: "use-confirmed-local-marketplace-record-for-detail-controls",
    before: "          plugin: C,\n          shell: Ur,",
    after:
      "          plugin: b?.claudexLocalMarketplace === true || b?.claudexOrganizationPlugin === true ? b : C,\n          shell: Ur,",
  },
  {
    file: libraryDetail,
    name: "project-local-marketplace-capability-into-library-detail",
    before: "    Ve = J1($, 42, Y) ? K1($, 42, Y, Y ? et(Y) : null) : $[43],",
    after:
      '    Ve = J1($, 42, Y) ? K1($, 42, Y, Y ? Y.claudex_local_marketplace === true || Y.claudex_organization_plugin === true ? __claudexPluginDetail(et(Y),Y) : et(Y) : null) : $[43],',
  },
  {
    file: actions,
    name: "read-local-marketplace-enablement-from-runtime-record",
    before: "    { isWebInstallEnabled: l, webEnabledIds: d } = e,",
    after:
      "    { isWebInstallEnabled: web, webEnabledIds: d } = e,\n    l = web && t.claudexLocalMarketplace !== true && t.claudexOrganizationPlugin !== true,",
  },
  {
    file: actions,
    name: "toggle-verified-local-marketplace-plugin",
    before: "          if (O || (P && N)) {",
    after:
      "          if (r.claudexOrganizationPlugin === true) {\n            if (!y) f({...K,enabled:!N,claudexOrganizationPlugin:true});\n            return;\n          }\n          if (r.claudexLocalMarketplace === true) {\n            if (!b) v({pluginId:r.id,enabled:!r.enabled,isLocal:true,inHand:r});\n            return;\n          }\n          if (O || (P && N)) {",
  },
  {
    file: actions,
    name: "remove-verified-local-marketplace-plugin",
    before:
      "                        if (r.isFromManualMarketplace && r.marketplaceName && !C) {",
    after:
      '                        if (r.claudexOrganizationPlugin === true) {\n                          m({pluginId:r.id,backendId:r.backendId,claudexOrganizationPlugin:true});\n                          return;\n                        }\n                        if (r.claudexLocalMarketplace === true) {\n                          m({pluginId:r.id,source:"local"});\n                          return;\n                        }\n                        if (r.isFromManualMarketplace && r.marketplaceName && !C) {',
  },
  {
    file: detail,
    name: "use-confirmed-host-marketplace-install",
    before:
      "              await v({ backendId: b, enabled: !0, composedMoves: g });",
    after:
      "              const applied = await v({ backendId: b, enabled: !0, composedMoves: g });\n              if (applied?.claudex_local_marketplace === true && applied.enabled === true && applied.id === b) {\n                return { success: !0, pluginId: n };\n              }",
  },
  {
    file: detail,
    name: "use-account-plugin-removal-for-local-marketplace",
    before:
      "          let { pluginId: c, scope: m, backendId: g, source: _ } = e;\n          if (f(c)) {",
    after:
      '          let { pluginId: c, scope: m, backendId: g, source: _ } = e;\n          if (e.claudexOrganizationPlugin === true) {\n            if (!r || !/^plugin_[a-f0-9]{24}$/.test(g ?? c)) throw Error("Missing organization plugin identity.");\n            const response = await fetch(`/api/organizations/${r}/plugins/${g ?? c}?source=organization`, {method:"DELETE"});\n            if (!response.ok) throw Error("The organization plugin could not be removed.");\n            const record = await response.json();\n            if (record.claudex_organization_plugin !== true || record.id !== (g ?? c) || record.installed !== false) throw Error("The organization plugin removal could not be confirmed.");\n            return;\n          }\n          if (_ === "local" && /^plugin_[a-f0-9]{24}$/.test(c)) {\n            if (!ba?.uninstallPlugin) throw Error("Local plugin removal is unavailable.");\n            await ba.uninstallPlugin(c, [], {...a, pluginSource:"local"});\n            return;\n          }\n          if (f(c)) {',
  },
  {
    file: detail,
    name: "skip-optimistic-removal-for-organization-plugins",
    before: "          vd.set(n, WM());\n          let c = h(r, o);",
    after: "          vd.set(n, WM());\n          if (e.claudexOrganizationPlugin === true) return;\n          let c = h(r, o);",
  },
  {
    file: detail,
    name: "refresh-organization-plugin-detail-after-verified-removal",
    before: "            u = vd.get(s);\n          ((u === void 0 || u === WM()) &&",
    after: "            u = vd.get(s);\n          if (i.claudexOrganizationPlugin === true && u === WM()) {\n            t.invalidateQueries({queryKey:[TQ],predicate:query=>query.queryKey[1]?.backendPluginId===(i.backendId ?? i.pluginId)});\n          }\n          ((u === void 0 || u === WM()) &&",
  },
  {
    file: detail,
    name: "refresh-local-marketplace-detail-after-toggle",
    before:
      '          if (!_.success) throw Error(_.error ?? "Failed to toggle plugin");\n          return _;',
    after:
      '          if (!_.success) throw Error(_.error ?? "Failed to toggle plugin");\n          if (e.inHand?.claudexLocalMarketplace === true) {\n            t.setQueriesData({queryKey:[TQ],predicate:query=>query.queryKey[1]?.backendPluginId===r}, record => record && {...record,enabled:_.enabled ?? l});\n            await t.invalidateQueries({queryKey:[TQ],predicate:query=>query.queryKey[1]?.backendPluginId===r});\n            l6(t);\n            _V(t);\n          }\n          return _;',
  },
  {
    file: list,
    name: "host-library-independent-native-routing",
    before: '    f = !l && ke === "loading",',
    after: '    f = !__hostSummary && !l && ke === "loading",',
  },
  {
    file: detail,
    name: "host-summary-detail-retain-vendor-hooks",
    before: "function DN(\n",
    after: "function __claudexVendorPluginDetail(\n",
  },
  {
    file: list,
    name: "host-account-context",
    before: "function i(r) {\n  let $ = J9(86),",
    after:
      "function i(r) {\n  const __hostSummary=__claudexInstalledSummaryHost(__claudexPluginAccount());\n  let $ = J9(86),",
  },
  {
    file: list,
    name: "no-inapplicable-native-sync",
    before: "    Oe = i === void 0 || i,",
    after: "    Oe = (i === void 0 || i) && !__hostSummary,",
  },
  {
    file: list,
    name: "account-library-read-enabled",
    before: '    d = Ae.web && ke !== "loading",',
    after: '    d = __hostSummary || (Ae.web && ke !== "loading"),',
  },
  {
    file: list,
    name: "no-inapplicable-remote-inventory",
    before: "    m = ne(l);",
    after: "    m = ne(l) && !__hostSummary;",
  },
  {
    file: list,
    name: "no-inapplicable-local-inventory",
    before: "    _ = u && o,",
    after: "    _ = u && o && !__hostSummary,",
  },
  {
    file: list,
    name: "no-inapplicable-local-loading",
    before: "    Ne = u && c && (v.isLoading || (!o && b === void 0)),",
    after:
      "    Ne = !__hostSummary && u && c && (v.isLoading || (!o && b === void 0)),",
  },
  {
    file: list,
    name: "keep-native-inventory-unknown",
    before: "    if (!u) {\n      I = J0($, 16)",
    after: "    if (!u || __hostSummary) {\n      I = J0($, 16)",
  },
  {
    file: list,
    name: "no-native-marketplace-probe",
    before: "    { data: z } = ie(u && o),",
    after: "    { data: z } = ie(u && o && !__hostSummary),",
  },
  {
    file: list,
    name: "real-server-summary-membership",
    before: "  let Ue = He,",
    after:
      "  const __hostRows=__claudexPluginMemo(() => __hostSummary ? ge(w, [], {platform:p, isCCDContext:l, systemInternalIds:F, wrapIdentities:N, hostInstalledSummary:true, publisherCreditOn:H}) : null, [__hostSummary,w,p,l,F,N,H]);\n  let Ue = __hostRows ?? He,",
  },
  {
    file: list,
    name: "ignore-only-inapplicable-native-query-state",
    before: "    G = u && c && v.isError && b === void 0,",
    after: "    G = !__hostSummary && u && c && v.isError && b === void 0,",
  },
  {
    file: list,
    name: "summary-data-readiness",
    before:
      '    ot = p === "desktop" ? !q.ipc && !K && (!U || w !== void 0 || E) : !J || w !== void 0,',
    after:
      '    ot = __hostSummary ? w !== void 0 : p === "desktop" ? !q.ipc && !K && (!U || w !== void 0 || E) : !J || w !== void 0,',
  },
  {
    file: merge,
    name: "explicit-host-summary-input",
    before: "    serverListDecides: s = !1,",
    after:
      "    serverListDecides: s = !1,\n    hostInstalledSummary: __hostSummary = !1,",
  },
  {
    file: merge,
    name: "installed-summary-disabled-membership",
    before: '  let f = new Set();\n  if (n === "web") {',
    after:
      '  let f = new Set();\n  if (__hostSummary) {\n    const rows=[], seen=new Set();\n    for(const item of e ?? []) {\n      if(!q(item) || item.viewer?.added !== true || !item.viewer.installed) continue;\n      const client={...G(item),id:item.plugin.backend_id};\n      if(seen.has(client.id)) continue;\n      seen.add(client.id); rows.push(F(item,client,"server",n,P,u));\n    }\n    return {rows,projectKeys:f,offListRows:[]};\n  }\n  if (n === "web") {',
  },
];
const sha = (s) => createHash("sha256").update(s).digest("hex");
export function deriveOfficialUiHostInstalledPluginsModule(file, source) {
  if (!Object.hasOwn(hostInstalledPluginsInputHashes, file)) return source;
  if (sha(source) !== hostInstalledPluginsInputHashes[file])
    throw Error("Pinned installed-plugin summary checksum mismatch: " + file);
  let result = source;
  for (const rule of hostInstalledPluginsRules.filter((r) => r.file === file)) {
    const at = result.indexOf(rule.before);
    if (at < 0 || result.indexOf(rule.before, at + rule.before.length) >= 0)
      throw Error(
        "Pinned installed-plugin summary anchor mismatch: " + rule.name,
      );
    result =
      result.slice(0, at) + rule.after + result.slice(at + rule.before.length);
  }
  return (
    (file === list
      ? 'import {ce as __claudexPluginAccount} from "./shared-l-p-m-w-2-BMCa56Vr.js";\nimport {wo as __claudexPluginMemo} from "./vendor-frame-iz8L1jC9.js";\n' +
        installedSummaryHostSource
      : file === detail
        ? installedSummaryHostSource + installedSummaryDetailSource
        : file === libraryDetail
          ? managedDetailProjection
        : file === customize
          ? installedSummaryHostSource + registeredRepositoryQuery
        : "") + result
  );
}
export function applyOfficialUiHostInstalledPlugins(directory) {
  directory = fs.realpathSync(directory);
  if (directory.split(path.sep).includes(".restore"))
    throw Error("Recovered sources are immutable");
  const records = Object.keys(hostInstalledPluginsInputHashes).map((file) => {
    const location = path.join(directory, file);
    if (fs.lstatSync(location).isSymbolicLink())
      throw Error("Installed-plugin output symlink rejected");
    const input = fs.readFileSync(location, "utf8"),
      output = deriveOfficialUiHostInstalledPluginsModule(file, input);
    return { file, location, input, output };
  });
  for (const row of records) fs.writeFileSync(row.location, row.output);
  return {
    revision: hostInstalledPluginsRevision,
    modules: records.map((r) => ({
      file: r.file,
      originalSha256: hostInstalledPluginsOriginalHashes[r.file],
      inputSha256: sha(r.input),
      outputSha256: sha(r.output),
      rules: hostInstalledPluginsRules
        .filter((x) => x.file === r.file)
        .map((x) => x.name),
    })),
  };
}
