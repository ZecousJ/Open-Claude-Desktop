import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const routes = "shared-46-BL5bnnMV.js";
const home = "shared-23-xVessQLu.js";
const designGallery = "ceba619bc-DG8aW0r_.js";
const designOpener = "shared-6-abVJ5RR0.js";
const sidebar = "shared-20-C2JgSgMH.js";
const sidebarNavigation = "shared-21-BEljNzmn.js";
const sidebarBody = "shared-22-Ciy9U3_0.js";
const card = "cbb0b7045-DDrVn_Qs.js";
const accountMenu = "shared-19-DSOWNXOA.js";
const heatmap = "c469ccfa5-CvN4WhxT.js";
const code = "cc43287c9-BDrqHHqn.js";
const artifactCreate = "4250c6efa1c1d0df3ca9f6c3d12cd0ce5cb5de4466b890d5-D0kzKxm9.js";
const artifactMenu = "c230724a2-BwFktAUZ.js";
const artifactTemplateHost = "shared-9-B15zSG0N.js";
const artifactTemplates = "2a0f6447b438408ae0fa7d9969eef8e1830c95548be1adfc-CT-CcaXE.js";
const browserBackdrop = "c23ea5d22-CmKp4wRw.js";
export const hostApiRevision = "claudex-api-management-v2+service-status-v2+announcements-v2+dispatch-v2+sidebar-startup+template-menu-v2+design-canvas-v1+managed-design-v3+timed-greeting-v3+browser-backdrop-v1";
export const hostApiAssets = [
  ["assets/v1/claudex-host-home-greeting.js", "scripts/official-host/home-greeting.mjs"],
  ["assets/v1/claudex-host-api.js", "scripts/official-host/api-panel.mjs"],
  ["assets/v1/claudex-host-api.css", "scripts/official-host/api-panel.css"],
  ...["openai", "xai", "anthropic", "gemini", "qwen", "deepseek"].map((id) => [
    `assets/v1/claudex-api-vendor-${id}.svg`,
    `mobile/ios/Claudex/Resources/Assets.xcassets/Vendor-${id}.imageset/mark.svg`,
  ]),
  ["assets/v1/claudex-host-service-status.js", "scripts/official-host/service-status-panel.mjs"],
  ["assets/v1/claudex-host-announcements.js", "scripts/official-host/announcement-panel.mjs"],
  ["assets/v1/claudex-host-dispatch.js", "scripts/official-host/dispatch-panel.mjs"],
  ["official-status-preview.html", "scripts/official-host/status-preview.html"],
];
export const hostApiOriginalHashes = {
  [browserBackdrop]: "2e922e093ba46a746ee5c2457c0764f4f39300a7cba974020af56e90950532e4",
  [artifactMenu]: "87ae5b04cb470c2ebdca81f47ef766342c9e11f97a35e84632a651ac107be5a0",
  [artifactTemplateHost]: "d2ede3a147f475aafca0d3e0bbcb8074451a8de0d8b96f3433a25ae1306983f0",
  [artifactTemplates]: "5d3c68c744b3f4375d6c5e2cbfa23d2d783c7ae0497454c514e741ad615d5185",
  [home]: "71d1626ba5ffb6e705cb8cf3eadc8cdbb2c5e2fae32323a6c3f48cdbf6994527",
  [designGallery]: "473712be35da56416820cc985ec10ca457ae9c8bcd0ecd18926fe52e9a13a91c",
  [designOpener]: "2262035dcd5b3f51140b56cece641eb9517238cfa9a97fe708738a72b2b911dd",
  [artifactCreate]: "2b15a23664d5a364e2eb359f24825f971e76982bf09feee44f1a16f954b566e5",
  [routes]: "38cd4a49ad26e1fe06c1325c1f7ef2f0f81ac8fd4abfaa592e04169763f5a76c",
  [sidebar]: "5079a46295b93a1bcb76333a1e52709e1c448f4ea744774b5c5655f22ab118e0",
  [sidebarNavigation]: "fca3c768fcd86b9d6bde6766f7ca4ebf906ccdc5e56d8b7610bb0e8ff0b10326",
  [sidebarBody]: "1864d927c5172f5dfe67282aa70ac945d4277a5fbab4ae1928f73897c0e80d7a",
  [card]: "fb4a7ca1b8a13e4df1fec1a270583cf49730a07b6be235f67c8dc57658777b79",
  [accountMenu]:
    "d0a3ff50f9965c90bf9af2f796bbd291034a7e7427bb2f778f0cd0dff2c32aa3",
  [heatmap]: "46f6bb19ebca2324b7d7edc07617422bdef5938e75e1b3f01565c546242757ad",
  [code]: "8c2d97cb1dc34e2ecb2e1c6918bac434b698dee3833e447527b445b38509c03f",
};
export const hostApiInputHashes = {
  [browserBackdrop]: "3d3e734801338716dd5f7d86b794d202003be87144749275f7a4384267d8369c",
  [artifactMenu]: "2eb7809a68ae24db2fd24dbee771c5e2a15c872b3a7d70b184a6ae2f8c14bd65",
  [artifactTemplateHost]: "963439beef36aa3515e386ef60a4c00f4777bc98215565e31bf72f4ba035f9c4",
  [artifactTemplates]: hostApiOriginalHashes[artifactTemplates],
  [home]: "a2f5d3cbdc7385399d1f6b8b1fa1d286fdbb422a41d2fc19f640dc9abf2d73c4",
  [designGallery]: hostApiOriginalHashes[designGallery],
  [designOpener]: "34739665d03221d701440297adbf3a6fdec7a14795809ecc86b718acfb12f7b6",
  [artifactCreate]: hostApiOriginalHashes[artifactCreate],
  [routes]: "bd3ce6fa8d7812df0a6e76a8c9faf4b77997355895c0fffb1135b724647cf3a6",
  [sidebar]: "79f36a5a1439e5dda2606af5be88b3a4971f229887e262619975779c9c424c4a",
  [sidebarNavigation]: "eee7e05b6e22c912133986d024110fb6f7f5efc935f97c555d300649ab75093b",
  [sidebarBody]: "81f2420b0238104f832929f37a049ca4c9ef2fe744afc1d12757eb5ad3330ba3",
  [card]: hostApiOriginalHashes[card],
  [accountMenu]:
    "af8f462f16e304897a3311d5a6543d3e674ba04a05a42e2598cb773800b81b46",
  [heatmap]: hostApiOriginalHashes[heatmap],
  [code]: "9c3bbbe782c7bab0f5466af1570a270360287df4722bb78d948957ce24ba7287",
};

export const hostApiRules = [
  {
    file: browserBackdrop,
    name: "theme-the-browser-owned-backdrop",
    before: `    ? e.pageBackgroundColor
      ? e.pageBackgroundColor
      : e.isHtmlPreview || e.activeTabUsesBrowserDefaults
        ? "#ffffff"
        : e.scheme === "dark"
          ? "#131312"
          : "#f5f5f5"`,
    after: '    ? e.pageBackgroundColor || "var(--cds-surface-1)"',
  },
  {
    file: home,
    name: "use-local-time-for-home-greeting",
    before: 'function haZ(e) {',
    after: 'import { homeGreetingForAccount as claudexHomeGreeting } from "./claudex-host-home-greeting.js";\nfunction haZ(e) {',
  },
  {
    file: home,
    name: "translate-current-home-time-period",
    before: `    u = J1($, 2, r)
      ? K1($, 2, r, r.formatMessage({ defaultMessage: "You’re here!", id: "y1XRP1BJQF" }))
      : $[3],`,
    after: '    [claudexGreetingRoll] = lO5(Math.random),\n    [claudexGreeting] = lO5(() => ({})),\n    u = l !== null && (!i?.locale || i.locale === r.locale) ? claudexHomeGreeting(claudexGreeting, r.locale, l.getHours(), i?.account, claudexGreetingRoll) : "",',
  },
  {
    file: home,
    name: "wait-for-the-home-account-and-locale",
    before: `      if (l === null) {
        x = "";
        break bb0;
      }`,
    after: `      if (l === null || (!n && (!i?.account || (i.locale && i.locale !== r.locale)))) {
        x = "";
        break bb0;
      }`,
  },
  {
    file: home,
    name: "replace-retained-static-home-greeting",
    before: `      if (a !== null && !(c && !b)) {
        x = a;`,
    after: `      if (a !== null && !(c && !b)) {
        x = u;`,
  },
  {
    file: home,
    name: "use-timed-greeting-without-a-personalized-feed",
    before: 'l !== null && i ? IC(i.personalized_greeting, "chat", l) || u : ""',
    after: 'l !== null && i ? u : ""',
  },
  {
    file: designOpener,
    name: "open-claudex-design-gallery",
    before: `function W1(e) {
  let $ = J9(6),
    t = vs(),
    { openBehavior: n, designWindowSupported: r, designAvailable: i } = X5();
  return J5($, 0, i, r, e, n, t)
    ? K5($, 0, i, r, e, n, t, (a) => {
        if (!i) {
          window.open(l5(a), "_blank", "noopener");
          return;
        }
        if (n === "embed") {
          let n = new URLSearchParams({ [B9]: a }),
            r = \`\${u1}?\${n.toString()}\`;
          e ? e(r) : t.push(r);
          return;
        }
        if (n === "new_window" && r) {
          window.open(a, "_blank", "noopener");
          return;
        }
        window.open(l5(a), "_blank", "noopener");
      })
    : $[5];
}
`,
    after: `function W1(e) {
  let $ = J9(3), t = vs();
  return J2($, 0, e, t)
    ? K2($, 0, e, t, () => e ? e("/artifacts/design") : t.push("/artifacts/design"))
    : $[2];
}
`,
  },
  {
    file: designGallery,
    name: "remove-standalone-design-promotion",
    before: `function sa() {
  let $ = J9(3),
    e = A(),
    t = Le();
  return J2($, 0, e, t)
    ? K2($, 0, e, t, () => {
        let n = K("design_artifacts_banner", { noRedirect: !0 });
        if (e) {
          t(n);
          return;
        }
        window.location.assign(n);
      })
    : $[2];
}
`,
    after: "",
  },
  {
    file: designGallery,
    name: "remove-standalone-design-promotion-action",
    before: `yi = sa(),
    bi = xt() ? void 0 : yi,`,
    after: "bi = void 0,",
  },
  {
    file: sidebar,
    name: "link-design-sidebar-to-claudex-gallery",
    before: `id: uc,
      href: UL,
      exactHref: !0,
      activeMatch: nP,
      icon: "Palette",`,
    after: `id: uc,
      href: "/artifacts/design",
      exactHref: !0,
      icon: "Palette",`,
  },
  {
    file: sidebar,
    name: "use-claudex-account-for-design-availability",
    before: 'z !== null && n.add("design"),',
    after: '(__account?.uuid || globalThis.__claudexOfficialAccountContext?.accountUuid) && n.add("design"),',
  },
  {
    file: sidebar,
    name: "keep-design-sidebar-in-claudex",
    before: `n.id === "design" &&
          z !== null &&
          ((r = z.href),
          (h = z.hardNav),
          (g = z.external),
          (_ = B.clicked),
          (v = B.shownInline),
          z.openBehavior === "new_window"
            ? (y = e.formatMessage(m_.designNewWindow))
            : z.openBehavior === "browser" && (y = e.formatMessage(m_.designBrowser))),`,
    after: 'n.id === "design" && ((_ = B.clicked), (v = B.shownInline)),',
  },
  {
    file: sidebar,
    name: "exclude-design-from-sidebar-promotions",
    before: `b !== null &&
          n.gate === b &&`,
    after: `n.id !== "design" &&
          b !== null &&
          n.gate === b &&`,
  },
  {
    file: sidebar,
    name: "pin-claudex-design-without-vendor-availability",
    before: "    s = $S(o),",
    after: "    s = o,",
  },
  {
    file: artifactCreate,
    name: "capture-artifact-menu-host-account",
    before: "{ account: S, activeOrganization: C } = g(),\n    w = S?.uuid,",
    after: '{ account: S, activeOrganization: C } = g(),\n    claudexDesignHost = S?.claudex_host_authentication?.status === "authenticated",\n    w = S?.uuid,',
  },
  {
    file: artifactCreate,
    name: "identify-workspace-backed-design-type",
    before: "if (!T || qe || Qt() || ht() !== void 0) return !1;",
    after: 'if (!T || qe || Qt() || ht() !== void 0) return !1;\n            const claudexDesign = (globalThis.__claudexOfficialAccountContext || claudexDesignHost) && n.slug === "bcd2878f-a88d-4094-a616-8e39d8a5fd8a";',
  },
  {
    file: artifactCreate,
    name: "use-existing-design-workspace-without-starting-another-task",
    before: "R && !ye && m && !ce",
    after: "!claudexDesign && R && !ye && m && !ce",
  },
  {
    file: artifactCreate,
    name: "open-created-design-canvas",
    before: "let Ne = performance.now();",
    after: `if (claudexDesign) {
              gt(Q, r ? "active" : "none");
              _t(void 0);
              Ae();
              return a(\`/code/artifact/\${_.slug}?org=\${encodeURIComponent(T)}\`);
            }
            let Ne = performance.now();`,
  },
  {
    file: sidebarNavigation,
    name: "load-pinned-artifact-template-menu-on-open",
    before: 'import { Ap as MK, Ce, Ok, Oz, ht, n8, pb as Rz, y8 as Z8 } from "./shared-9-B15zSG0N.js";',
    after: 'import { Ap as MK, Ce, Ok, Oz, ht, n8, pb as Rz, y8 as Z8, claudexLoadArtifactTemplates } from "./shared-9-B15zSG0N.js";',
  },
  {
    file: sidebarNavigation,
    name: "load-artifact-templates-from-sidebar",
    before: "e ? (n(t), ON(t)) : p()",
    after: 'e ? (n(t), ON(t), void claudexLoadArtifactTemplates().catch(() => {})) : p()',
  },
  {
    file: artifactTemplateHost,
    name: "drop-the-upstream-template-loader-state-hook",
    before: "  vv as JN,\n",
    after: "",
  },
  {
    file: artifactTemplateHost,
    name: "load-the-bundled-artifact-template-component",
    before: `var W$ = h2.__built("saffron_wren_gable");
function Rg() {
  let $ = J9(1),
    e = J0($, 0) ? K0($, 0, []) : $[0];
  return (__(o7, e), null);
}
function o7() {
  Iw();
}
function Oz() {
  let $ = J9(1);
  return JN()
    ? null
    : J0($, 0)
      ? K0($, 0, gl(GW, { fallback: null, children: gl(W$, { gatedErrorFallback: gl(Rg, {}) }) }))
      : $[0];
}`,
    after: `let claudexArtifactTemplates;
export function claudexLoadArtifactTemplates() {
  return claudexArtifactTemplates ??= import("./${artifactTemplates}").catch(error => {
    claudexArtifactTemplates = undefined;
    Iw();
    console.error("Could not load artifact templates.", error);
    throw error;
  });
}
function Oz({ onLoadFailed }) {
  __(() => {
    let mounted = true;
    void claudexLoadArtifactTemplates().catch(() => { if (mounted) onLoadFailed?.(true); });
    return () => { mounted = false; };
  }, [onLoadFailed]);
  return null;
}`,
  },
  {
    file: artifactTemplates,
    name: "register-bundled-templates-without-upstream-gated-import",
    before: "    sendToTypeRules: ds,\n  }));",
    after: "    sendToTypeRules: ds,\n  }, { atBoot: true }));",
  },
  {
    file: artifactMenu,
    name: "settle-template-menu-when-the-module-fails",
    before: "function Gr(e) {\n  let $ = J9(49),",
    after: "function Gr(e) {\n  const [claudexTemplateLoadFailed, claudexSetTemplateLoadFailed] = t(false);\n  let $ = J9(49),",
  },
  {
    file: artifactMenu,
    name: "drop-gallery-template-mount-state",
    before: "    [_, v] = t(!1),\n    y = J2($, 4, f, l)",
    after: "    y = J2($, 4, f, l)",
  },
  {
    file: artifactMenu,
    name: "retry-template-loading-on-next-open",
    before: '(e && !f && (v(!0), l({ event_key: "artifact.studio.create_menu_opened" })), p(e), g(!1));',
    after: '(e && !f && (claudexSetTemplateLoadFailed(false), l({ event_key: "artifact.studio.create_menu_opened" })), p(e), g(!1));',
  },
  {
    file: artifactMenu,
    name: "connect-gallery-menu-to-template-loader",
    before: "let A = J2($, 11, x, _) ? K2($, 11, x, _, x && _ && d(Dt, {})) : $[13],",
    after: "let A = x && f && !S && !claudexTemplateLoadFailed && d(Dt, { onLoadFailed: claudexSetTemplateLoadFailed }),",
  },
  {
    file: artifactMenu,
    name: "remove-gallery-template-placeholders-on-load-error",
    before: "E = T && (S !== void 0 || x),",
    after: "E = T && (S !== void 0 || (x && !claudexTemplateLoadFailed)),",
  },
  {
    file: routes,
    name: "mount-service-announcements-in-authenticated-layout",
    before: 'import { Be, Cf, Nu as v3, Rf as fV, kL, kV } from "./shared-19-DSOWNXOA.js";',
    after: 'import { Be, Cf, Nu as v3, Rf as fV, kL, kV, ClaudexAnnouncementsHost } from "./shared-19-DSOWNXOA.js";',
  },
  {
    file: routes,
    name: "keep-announcements-mounted-across-app-routes",
    before: 'children: tT(rT, { children: tT(CI, { children: e }) })',
    after: 'children: tT(rT, { children: tT(CI, { children: tT(ClaudexAnnouncementsHost, { children: e }) }) })',
  },
  {
    file: accountMenu,
    name: "account-scoped-announcements-controller-and-entries",
    before: "function VY(e) {",
    after: `import { io as createAnnouncementContext, lo as lazyAnnouncementPanel, no as AnnouncementsSuspense } from "./vendor-frame-iz8L1jC9.js";
const ClaudexAnnouncementContext = createAnnouncementContext(null);
const ClaudexAnnouncementPanel = lazyAnnouncementPanel(() => import("./claudex-host-announcements.js").then(module => ({ default: module.HostAnnouncements })));
const ClaudexAnnouncementNotice = lazyAnnouncementPanel(() => import("./claudex-host-announcements.js").then(module => ({ default: module.HostAnnouncementNotice })));
export function ClaudexAnnouncementsHost({ children }) {
  const { account } = w_();
  return account?.claudex_service_announcements === true
    ? gl(ClaudexAnnouncementAccount, { accountId: account.uuid, children }, account.uuid)
    : children;
}
function ClaudexAnnouncementAccount({ accountId, children }) {
  const { locale } = rc();
  const [open, setOpen] = _v(false);
  const [unread, setUnread] = _v(false);
  const [notice, setNotice] = _v(null);
  const zh = locale.toLowerCase().startsWith("zh");
  return UK(ClaudexAnnouncementContext.Provider, {
    value: { setOpen, unread, notice, title: zh ? "服务公告" : "Service announcements", unreadLabel: zh ? "未读公告" : "Unread announcements" },
    children: [children, gl(AnnouncementsSuspense, {
      fallback: null,
      children: gl(ClaudexAnnouncementPanel, { accountId, open, onOpenChange: setOpen, onUnreadChange: setUnread, onNoticeChange: setNotice }),
    })],
  });
}
export function ClaudexComposerAnnouncement({ className }) {
  const { notice } = Hu(ClaudexAnnouncementContext) ?? {};
  return notice ? gl("div", {
    className,
    children: gl(AnnouncementsSuspense, { fallback: null, children: gl(ClaudexAnnouncementNotice, notice) }),
  }) : null;
}
function ClaudexAnnouncementDot() {
  const state = Hu(ClaudexAnnouncementContext);
  return state?.unread ? UK("span", {
    "data-testid": "service-announcements-unread",
    className: "shrink-0",
    children: [gl(D6, { dot: true }), gl("span", { className: "sr-only", children: state.unreadLabel })],
  }) : null;
}
function ClaudexAnnouncementMenuItem() {
  const state = Hu(ClaudexAnnouncementContext);
  if (!state) return null;
  return gl(Op.Item, {
    "data-testid": "user-menu-service-announcements",
    icon: "Scroll",
    onClick: () => state.setOpen(true),
    trailing: gl(ClaudexAnnouncementDot, {}),
    children: state.title,
  });
}
function VY(e) {`,
  },
  {
    file: accountMenu,
    name: "show-original-unread-dot-in-account-trigger",
    before: "            children: [T, P, F],",
    after: "            children: [T, P, F, gl(ClaudexAnnouncementDot, {})],",
  },
  {
    file: accountMenu,
    name: "show-unread-dot-in-original-frame-account-trigger",
    before: `"data-testid": "experiment-frame-user-menu",
            "aria-label": t,
            className:
              "draggable-none flex items-center justify-center rounded-full outline-none transition-colors duration-fast hover:opacity-80 focus-visible:shadow-focus",
            children: n,`,
    after: `"data-testid": "experiment-frame-user-menu",
            "aria-label": t,
            className:
              "draggable-none flex items-center justify-center rounded-full outline-none transition-colors duration-fast hover:opacity-80 focus-visible:shadow-focus",
            children: [n, gl(ClaudexAnnouncementDot, {})],`,
  },
  {
    file: accountMenu,
    name: "place-service-announcement-in-original-composer-notice-slot",
    before: 'gl(R7, { placement: "above-composer", className: Oe })',
    after: 'UK(hx, { children: [gl(ClaudexComposerAnnouncement, { className: CV("mb-4", Oe) }), gl(R7, { placement: "above-composer", className: Oe })] })',
  },
  {
    file: code,
    name: "load-service-announcement-from-the-original-code-composer",
    before: "  KB as Gs,",
    after: "  KB as Gs,\n  ClaudexComposerAnnouncement,",
  },
  {
    file: code,
    name: "place-service-announcement-above-the-original-code-composer",
    before: "            children: [Xr, $r],",
    after: '            children: [Xr, z(ClaudexComposerAnnouncement, { className: "mb-4" }), $r],',
  },
  {
    file: routes,
    name: "account-gated-api-page",
    before: "function f3(e) {",
    after: `const __claudexApiPanel = RH(() => import("./claudex-host-api.js"), "HostApiPanel");
function __claudexApiRoute() {
  const { account, isLoading, refetch } = ce();
  if (isLoading && !account) return null;
  return account?.claudex_api_management === true
    ? tT(__claudexApiPanel, { refreshBootstrap: refetch }, account.uuid)
    : tT(Q5, { to: "/new", replace: true });
}
const __claudexServiceStatusPanel = RH(() => import("./claudex-host-service-status.js"), "HostServiceStatusPanel");
function __claudexServiceStatusRoute() {
  const { account, isLoading } = ce();
  if (isLoading && !account) return null;
  return account?.claudex_service_status === true
    ? tT(__claudexServiceStatusPanel, {}, account.uuid)
    : tT(Q5, { to: "/new", replace: true });
}
const __claudexDispatchPanel = RH(() => import("./claudex-host-dispatch.js"), "HostDispatchPanel");
function __claudexDispatchRoute(VendorLayout) {
  return function ClaudexDispatchRoute() {
    const { account, isLoading } = ce();
    if (isLoading && !account) return null;
    return account?.claudex_dispatch === true
      ? tT(__claudexDispatchPanel, {
          accountId: account.uuid,
          native: account.claudex_dispatch_receiving === true,
        }, account.uuid)
      : tT(VendorLayout, {});
  };
}
function f3(e) {`,
  },
  {
    file: routes,
    name: "adapt-original-dispatch-layout",
    before: '        component: DP("CoworkAgentLayoutRoute"),',
    after: '        component: __claudexDispatchRoute(DP("CoworkAgentLayoutRoute")),',
  },
  {
    file: routes,
    name: "original-authenticated-api-route",
    before: "      S = Jl({\n        getParentRoute: () => x,",
    after: `      __apiAccess = Jl({
        getParentRoute: () => R5,
        path: "service-api",
        component: __claudexApiRoute,
        head: () => Q0({ title: "API" }),
        staticData: { scrollsInPane: !0 },
      }),
      __serviceStatus = Jl({
        getParentRoute: () => R5,
        path: "service-status",
        component: __claudexServiceStatusRoute,
        head: () => Q0({ title: "Service status" }),
        staticData: { scrollsInPane: !0 },
      }),
      S = Jl({
        getParentRoute: () => x,`,
  },
  {
    file: routes,
    name: "register-api-in-sidebar-route-tree",
    before: "        x.addChildren([S, C]),",
    after:
      "        x.addChildren([S, C]),\n        __apiAccess,\n        __serviceStatus,",
  },
  {
    file: accountMenu,
    name: "account-gated-dispatch-menu-item",
    before: "function VY(e) {",
    after: `function __claudexDispatchMenuItem() {
  const { account } = w_();
  const { closeSidebarOnMobile } = L1v();
  return account?.claudex_dispatch === true
    ? gl(Op.Item, {
        "data-testid": "user-menu-dispatch",
        href: "/cowork/agent",
        icon: "Dispatch",
        onClick: closeSidebarOnMobile,
        children: "Dispatch",
      })
    : null;
}
function VY(e) {`,
  },
  {
    file: accountMenu,
    name: "show-original-email-header-for-single-account",
    before: '    T = l !== void 0 && l?.list !== "failed",',
    after: '    T = l !== void 0 && l?.list !== "failed" && (!__claudexNoVendorSubscription(u) || (l?.accountCount ?? 0) > 1),',
  },
  {
    file: accountMenu,
    name: "show-announcements-and-dispatch-in-original-learn-more-menu",
    before: "                children: [Re, Be, Ve, He, Ue, Ge, Je, Ye, Xe, Qe, $e, nt],",
    after: "                children: [Re, Be, Ve, He, Ue, Ge, Je, Ye, Xe, Qe, $e, nt, gl(ClaudexAnnouncementMenuItem, {}), gl(__claudexDispatchMenuItem, {})],",
  },
  {
    file: accountMenu,
    name: "show-original-api-keys-menu-for-claudex-api",
    before: '    { consoleAbsoluteUrl: i } = MZ();\n  if (_Q() !== (t ? "promoted" : "learn_more")) return null;',
    after: `    { consoleAbsoluteUrl: i } = MZ(),
    { account } = w_(),
    hostApi = account?.claudex_api_management === true,
    vendorPlacement = _Q();
  if ((hostApi ? "promoted" : vendorPlacement) !== (t ? "promoted" : "learn_more")) return null;`,
  },
  {
    file: accountMenu,
    name: "link-original-api-keys-menu-to-claudex-api",
    before: '      t = `${i}/settings/keys?${J0($, 4) ? K0($, 4, P8("user_menu", "api_console")) : $[4]}`,',
    after: '      t = hostApi ? "/service-api" : `${i}/settings/keys?${J0($, 4) ? K0($, 4, P8("user_menu", "api_console")) : $[4]}`,',
  },
  {
    file: accountMenu,
    name: "open-claudex-api-keys-in-the-current-app",
    before: '                "data-testid": "user-menu-console",\n                icon: "Key",\n                trailing: $5,\n                href: t,\n                target: "_blank",\n                rel: "noopener",',
    after: '                "data-testid": "user-menu-console",\n                icon: "Key",\n                trailing: t === "/service-api" ? void 0 : $5,\n                href: t,\n                target: t === "/service-api" ? void 0 : "_blank",\n                rel: t === "/service-api" ? void 0 : "noopener",',
  },
  {
    file: heatmap,
    name: "use-explicit-status-colors-in-cell-chart",
    before:
      "    classes: x,\n    range: v,\n    noData: l,\n    classOf: (e) => S.findLastIndex((t, n) => (p && n > 0 ? e > t : e >= t)),",
    after: `    classes: e.value?.categories ?? x,
    range: v,
    noData: l,
    classOf: e.value?.categories ? (value) => value : (e) => S.findLastIndex((t, n) => (p && n > 0 ? e > t : e >= t)),`,
  },
  {
    file: heatmap,
    name: "show-metric-text-in-status-cell-tooltips",
    before: "    u = W(r.details(), (t, n) => e.formatValue(n), n);",
    after: `    details = r.details(),
    u = details.length && typeof details[0].text === "string"
      ? { rows: details, tail: " (" + details.map(({ label, text }) => [label, text].filter(Boolean).join(" ")).join(", ") + ")" }
      : W(details, (t, n) => e.formatValue(n), n);`,
  },
  {
    file: heatmap,
    name: "expose-original-cell-chart-and-heatmap",
    before: "export { qe as ActivityHeatmap };",
    after:
      "export { qe as ActivityHeatmap, ze as CellChartContainer, He as Heatmap };",
  },
  {
    file: sidebar,
    name: "original-service-sidebar-items",
    before: '    {\n      id: "flask",\n      href: vx,',
    after: `    {
      id: "claudex-api",
      href: "/service-api",
      icon: "Key",
      label: "API",
      ariaLabel: "API",
      gate: "claudex-api",
      modes: ["chat", "cowork", "code"],
    },
    {
      id: "claudex-service-status",
      href: "/service-status",
      icon: "Activity",
      label: "Service status",
      gate: "claudex-service-status",
      modes: ["chat", "cowork", "code"],
    },
    {
      id: "flask",
      href: vx,`,
  },
  {
    file: sidebar,
    name: "translate-service-status-sidebar-label",
    before: "function Dv(e, t) {",
    after: `function Dv(e, t) {
  if (e.id === "claudex-service-status" && t.locale.toLowerCase().startsWith("zh")) return "服务状态";`,
  },
  {
    file: sidebar,
    name: "read-service-sidebar-account-capabilities",
    before:
      "    { activeOrganization: Z } = NF(),\n    Q = !s && !!Z && !Y && !X,",
    after: `    { account: __account, activeOrganization: Z } = NF(),
    __apiEnabled = __account?.claudex_api_management === true,
    __serviceStatusEnabled = __account?.claudex_service_status === true,
    Q = !s && !!Z && !Y && !X,`,
  },
  {
    file: sidebar,
    name: "track-service-sidebar-capabilities",
    before: "function lU() {\n  let $ = J9(77),",
    after: "function lU() {\n  let $ = J9(79),",
  },
  {
    file: sidebar,
    name: "invalidate-sidebar-on-service-capabilities-change",
    before: "    J5($, 3, t, U, k, C, h) ||",
    after: "    J1($, 77, __apiEnabled) ||\n    J1($, 78, __serviceStatusEnabled) ||\n    J5($, 3, t, U, k, C, h) ||",
  },
  {
    file: sidebar,
    name: "gate-service-sidebar-items",
    before: '    let n = new Set(U);\n    (p && n.add("scheduled"),',
    after: `    let n = new Set(U);
    if (__apiEnabled) n.add("claudex-api");
    if (__serviceStatusEnabled) n.add("claudex-service-status");
    (p && n.add("scheduled"),`,
  },
  {
    file: sidebar,
    name: "cache-current-service-sidebar-capabilities",
    before: "      K4($, 3, t, U, k, C, h),",
    after: "      ($[77] = __apiEnabled),\n      ($[78] = __serviceStatusEnabled),\n      K4($, 3, t, U, k, C, h),",
  },
  {
    file: sidebar,
    name: "show-service-rows-in-sidebar",
    before:
      '        T = n.hideFromSidebar || (F && t !== "code" && !w) || x9(Y, t, n.id),',
    after:
      '        T = n.id !== "claudex-api" && n.id !== "claudex-service-status" && (n.hideFromSidebar || (F && t !== "code" && !w) || x9(Y, t, n.id)),',
  },
  {
    file: sidebar,
    name: "keep-service-rows-inline-with-sidebar-pins",
    before:
      "          if (!me || (J && !te && vI.has(e)) || (e === Q && !pe.has(VC(e)))) return !0;",
    after:
      '          if (e === "claudex-api" || e === "claudex-service-status" || !me || (J && !te && vI.has(e)) || (e === Q && !pe.has(VC(e)))) return !0;',
  },
  {
    file: sidebarNavigation,
    name: "expose-original-sidebar-navigation-readiness",
    before: "function qG(e) {",
    after: "export { qG as claudexSidebarNavigationReady };\nfunction qG(e) {",
  },
  {
    file: sidebarBody,
    name: "retain-original-sidebar-progressive-rendering",
    before: "function uA(e) {",
    after: `function ClaudexStartupSidebar({ children }) {
  return gl("div", {
    "data-claudex-sidebar-ready": true,
    style: { display: "contents" },
    children,
  });
}
function uA(e) {`,
  },
  {
    file: sidebarBody,
    name: "reveal-original-sidebar-navigation-and-footer-together",
    before: "aC(GM, { children: [vt, Tt, kt, At] })",
    after: "gl(GM, { children: gl(window.__claudexOfficialAccountContext ? ClaudexStartupSidebar : q0, { children: [vt, Tt, kt, At] }) })",
  },
  {
    file: card,
    name: "original-card-title-without-navigation",
    before:
      '      ? K3($, 3, c, y, l, r(o, { dir: y, href: c, "data-primary": !0, className: b, children: l }))',
    after: `      ? K3($, 3, c, y, l, c === void 0
          ? r("span", { dir: y, className: "min-w-0 truncate text-body font-medium text-primary", children: l })
          : r(o, { dir: y, href: c, "data-primary": !0, className: b, children: l }))`,
  },
];

const sha = (source) => createHash("sha256").update(source).digest("hex");

export function deriveOfficialUiHostApiModule(file, source) {
  if (!Object.hasOwn(hostApiInputHashes, file)) return source;
  if (sha(source) !== hostApiInputHashes[file])
    throw Error("Pinned API management input mismatch: " + file);
  let output = source;
  for (const { name, before, after } of hostApiRules.filter(
    (rule) => rule.file === file,
  )) {
    if (output.split(before).length !== 2)
      throw Error("Pinned API management anchor mismatch: " + name);
    output = output.replace(before, () => after);
  }
  return output;
}

export function applyOfficialUiHostApi(directory) {
  directory = fs.realpathSync(directory);
  if (
    directory
      .split(path.sep)
      .some(
        (part) => part === ".restore" || part === "claude-frontend-4.4212.0",
      )
  )
    throw Error("Recovered sources are immutable");
  const modules = Object.keys(hostApiInputHashes).map((file) => {
    const target = path.join(directory, file);
    const output = deriveOfficialUiHostApiModule(
      file,
      fs.readFileSync(target, "utf8"),
    );
    return { file, target, output };
  });
  for (const { target, output } of modules) fs.writeFileSync(target, output);
  return {
    revision: hostApiRevision,
    modules: modules.map(({ file, output }) => ({
      file,
      originalSha256: hostApiOriginalHashes[file],
      inputSha256: hostApiInputHashes[file],
      outputSha256: sha(output),
      rules: hostApiRules
        .filter((rule) => rule.file === file)
        .map((rule) => rule.name),
    })),
  };
}
