import fs from "node:fs";
import path from "node:path";

export const hostProjectWorkspaceRevision = "claudex-project-workspace-v3";
export const hostProjectWorkspaceAsset = {
  file: "assets/v1/claudex-host-project-workspace.js",
  source: "scripts/official-host/project-workspace.mjs",
};

const scopeImport = 'from "./claudex-host-project-workspace.js";';
const visibilityTitle = 'i(O, { defaultMessage: "Create a personal project", id: "6/5xih" })';
const matchingRoles = 'u.capabilities.includes("api") || u.capabilities.includes("raven")';

const rules = {
  "shared-6-abVJ5RR0.js": [
    ['    { activeOrganization: l } = ce(),\n    u = nY(),', '    { activeOrganization: l, claudexProjectWorkspace } = ce(),\n    u = nY(),'],
    ['    ee = J2($, 29, c, K) ? K2($, 29, c, K, !c || !An(K.status)) : $[31],', '    ee = !claudexProjectWorkspace && (J2($, 29, c, K) ? K2($, 29, c, K, !c || !An(K.status)) : $[31]),'],
  ],
  "shared-120-CuvT_xum.js": [
    ['function lt(e) {\n  let $ = J9(15),', `const ClaudexProjectFilesDialog = IO({
  entry: {
    id: "claudex_project_files_dialog",
    tier: "T2",
    load: () => import("./ca12e49f2-BafUhOMK.js"),
  },
  pick: (module) => module.ProjectFilesDialog,
  options: { ssr: !1, suspense: !0 },
}).Component;
function lt(e) {
  const { claudexProjectWorkspace } = ce();
  const [previewOpen, setPreviewOpen] = Zt(!1);
  let $ = J9(15),`],
    ['  return J4($, 10, t, s, o, i)\n    ? K4(', `  if (claudexProjectWorkspace && t.preview_url) {
    return aC(hx, { children: [
      gl(GX, { ...i, file: t, handleRemove: s, isLoading: o, handleClick: () => setPreviewOpen(!0) }),
      previewOpen && gl(GW, { fallback: null, children: gl(ClaudexProjectFilesDialog, {
        project: { uuid: r },
        open: previewOpen,
        onOpenChange: setPreviewOpen,
        canEditKnowledgeBase: e.canEditKnowledgeBase,
        pendingAttachments: [],
        selectRequest: { key: t.file_uuid, seq: 1 },
      }) }),
    ] });
  }
  return J4($, 10, t, s, o, i)
    ? K4(`],
    ['function uZ(e) {\n  let $ = J9(24),', `const ClaudexProjectFileContent = IO({
  entry: {
    id: "claudex_project_file_content",
    tier: "T2",
    load: () => import("./ca12e49f2-BafUhOMK.js"),
  },
  pick: (module) => module.ClaudexProjectFileContent,
  options: { ssr: !1, suspense: !0 },
}).Component;
function uZ(e) {
  const { claudexProjectWorkspace } = ce();
  let $ = J9(24),`],
    ['    _ = J4($, 16, i, d, c, u)\n      ? K4(', `    _ = claudexProjectWorkspace && t.preview_url
      ? gl(GW, { fallback: null, children: gl(ClaudexProjectFileContent, { file: t, scrollFade: !0 }) })
      : J4($, 16, i, d, c, u)
      ? K4(`],
  ],
  "shared-46-BL5bnnMV.js": [
    ['function jt() {\n  let $ = J9(1);', `import { ClaudexProjectChatRoute, ClaudexProjectSelection } ${scopeImport}
function jt() {
  let $ = J9(1);`],
    ['K0($, 0, tT(Aj, { children: tT(yi, {}) }))', 'K0($, 0, tT(ClaudexProjectSelection, { children: tT(Aj, { children: tT(yi, {}) }) }))'],
    ['function js() {\n  let $ = J9(279);', `function js() {
  const { uuid } = eU();
  return tT(ClaudexProjectChatRoute, {
    conversationUuid: uuid,
    pending: tT(pU, { className: "flex h-full" }),
    children: tT(ClaudexChatPage, {}),
  });
}
function ClaudexChatPage() {
  let $ = J9(279);`],
  ],
  "shared-l-p-m-w-2-BMCa56Vr.js": [
    ['  Q6 = () => _T(cS);', `  Q6 = () => _T(cS);
export function ClaudexProjectAccount({ workspace, children }) {
  const accountContext = ce();
  return workspace ? gl(cS.Provider, {
    value: {
      ...accountContext,
      claudexProjectWorkspace: workspace,
      claudexProjectPersonalOrganizationUuid: accountContext.activeOrganization?.uuid,
      activeOrganization: { uuid: workspace.uuid, name: workspace.name, capabilities: ["chat"] },
    },
    children,
  }) : children;
}`],
  ],
  "shared-l-p-m-w-3-B5uNmf7O.js": [
    ['function Jm(e, t) {\n  "use no memo";\n  let n = gH(),', `import { isClaudexProjectChat } ${scopeImport}
function Jm(e, t) {
  "use no memo";
  const accountContext = Q6();
  let n = gH(),`],
    ['  if (!h) return { mode: oC(n), hubEligible: !1, hubLook: !1, verdictLatched: !1 };', `  if (accountContext?.claudexProjectWorkspace || isClaudexProjectChat(accountContext?.account?.uuid, e))
    return { mode: "c1", hubEligible: !1, hubLook: !1, verdictLatched: !1 };
  if (!h) return { mode: oC(n), hubEligible: !1, hubLook: !1, verdictLatched: !1 };`],
    ['function Cb(e) {\n  return _b[e].useAvailable();\n}', `function Cb(e) {
  const workspace = Q6()?.claudexProjectWorkspace;
  const original = _b[e].useAvailable();
  if (!workspace || (e !== "project_sharing" && e !== "public_projects")) return original;
  const allowed = workspace.project_sharing_enabled &&
    (e === "project_sharing" || workspace.public_projects_enabled);
  return allowed ? QR : {
    status: "blocked_by_org_admin",
    isAvailable: false,
    isPolicyBlocked: true,
    isUpsellEligible: false,
  };
}`],
  ],
  "shared-4-Kt-jV-IU.js": [
    ['function __claudexTextChatProtocol(state) {\n  const account = state?.account, org = state?.activeOrganization;', `import { rememberClaudexProjectChat } ${scopeImport}
function __claudexTextChatProtocol(state) {
  const account = state?.account;
  const org = state?.claudexProjectWorkspace ? { uuid: state.claudexProjectPersonalOrganizationUuid } : state?.activeOrganization;`],
    ['function __claudexKnownChatPath(pathname, state) {\n  return ', 'function __claudexKnownChatPath(pathname, state) {\n  return (state?.claudexProjectWorkspace && /^\\/project\\/[^/]+\\/?$/.test(pathname)) || '],
    ['function gf(e) {\n  let $ = J9(27),', 'function gf(e) {\n  const accountContext = a4();\n  let $ = J9(27),'],
    ['    d = zZ(t),\n    f = J2($, 5, u, d)', '    d = zZ(t) && !accountContext.claudexProjectWorkspace,\n    f = J2($, 5, u, d)'],
    ['    j = a4().account?.uuid;\n  return J5($, 17, j, D, k, s, i, t, A, O, E)', '    j = accountContext.account?.uuid;\n  return J5($, 17, j, D, k, s, i, t, A, O, E)'],
    ['  let a = rh(),\n    o = X5(),', '  const { account, claudexProjectWorkspace } = a4();\n  const hubComposer = rh();\n  let a = claudexProjectWorkspace ? null : hubComposer,\n    o = X5(),'],
    ['    p = J1($, 10, f)\n      ? K1($, 10, f, (e, t) => {\n          (d.current', `    p = b7((e, t) => {
          if (claudexProjectWorkspace) rememberClaudexProjectChat(account?.uuid, e);
          (d.current`],
    ['            f(e, t));\n        })\n      : $[11],\n    m = J2($, 12, p, i)', '            f(e, t));\n        }, [account?.uuid, claudexProjectWorkspace, f]),\n    m = J2($, 12, p, i)'],
    ['        let t = s ? { ...e, chatStartedFrom: s } : e,', `        let t = s || claudexProjectWorkspace ? {
          ...e,
          ...(s && { chatStartedFrom: s }),
          ...(claudexProjectWorkspace && { tool_search_mode: null }),
        } : e,`],
  ],
  "shared-140-D6FnSjbS.js": [
    ['function LB() {\n  let $ = J9(10),', 'function LB() {\n  const accountContext = ys();\n  let $ = J9(10),'],
    ['    n = ys()?.activeOrganization?.uuid,\n    r = fM(),', '    n = accountContext?.activeOrganization?.uuid,\n    r = fM(),'],
    ['    a = Mr(),\n    o = EL(),\n    s = gM(),', '    a = Mr(),\n    o = EL() && !accountContext?.claudexProjectWorkspace,\n    s = gM(),'],
  ],
  "c1b9abf13-BcRRTBWK.js": [
    ['function q() {\n  let $ = J9(22),', `import { ClaudexProjectScope } ${scopeImport}
import { ce as useProjectAccount } from "./shared-l-p-m-w-2-BMCa56Vr.js";
function q() {
  const projectWorkspace = useProjectAccount().claudexProjectWorkspace;
  let $ = J9(22),`],
    ['    [w, T] = e(J),', '    [w, T] = e(() => projectWorkspace ? "classic" : J()),'],
    ['function ne() {\n  let $ = J9(10),', 'function ne() {\n  const workspace = useProjectAccount().claudexProjectWorkspace;\n  let $ = J9(10),'],
    ['function ie(e) {\n  let $ = J9(28),', 'function ie(e) {\n  const workspace = useProjectAccount().claudexProjectWorkspace;\n  let $ = J9(28),'],
    [visibilityTitle, `(workspace
              ? i(O, { defaultMessage: "Create project", id: "1dkWFB" })
              : ${visibilityTitle})`, 2],
    ['var le = oe,\n  ue = q,', 'var le = () => i(ClaudexProjectScope, { children: i(oe, {}) }),\n  ue = () => i(ClaudexProjectScope, { children: i(q, {}) }),'],
  ],
  "c17beaa76-BvSil78R.js": [
    ['function hi(i) {\n  let $ = J9(203),', `import { useClaudexProjectMenu } ${scopeImport}
import { ce as useProjectAccount } from "./shared-l-p-m-w-2-BMCa56Vr.js";
function hi(i) {
  const workspace = useProjectAccount().claudexProjectWorkspace;
  let $ = J9(203),`],
    ['    h = Le(),\n    _ = Be(),', '    h = Le() || !!workspace,\n    _ = Be(),'],
    ['    te = ie(),\n    J = te && L === "mine"', '    te = ie() && !workspace,\n    J = te && L === "mine"'],
    ['    nt = ti(L === "team" && !B && !H),', '    nt = ti(!workspace && L === "team" && !B && !H),'],
    ['    Vn = H ? void 0 : vn,', '    workspaceMenu = useClaudexProjectMenu(m, G),\n    Vn = workspaceMenu ? (H ? [workspaceMenu] : [workspaceMenu, ...vn]) : H ? void 0 : vn,'],
    ['function Ci() {\n  let $ = J9(48),', 'function Ci() {\n  const workspace = useProjectAccount().claudexProjectWorkspace;\n  let $ = J9(48),'],
    ['    { routing: S, settled: C } = x,\n    w = S !== "classic",\n    T = S === "new_with_classic",', '    { routing: S, settled: vendorSettled } = x,\n    C = !!workspace || vendorSettled,\n    w = !workspace && S !== "classic",\n    T = !workspace && S === "new_with_classic",'],
  ],
  "c4a0274e5-Q8MvhwLz.js": [
    ['function Oe(t) {\n  let $ = J9(116),', 'function Oe(t) {\n  const workspace = k().claudexProjectWorkspace;\n  let $ = J9(116),'],
    ['    re = te(),\n    M = ne(),', '    re = te() || !!workspace,\n    M = ne(),'],
    ['                            ...G,\n                            type: U ?? G.type,', '                            ...G,\n                            ...(workspace && !G.is_private ? { organization_role: "view" } : {}),\n                            type: U ?? G.type,'],
  ],
  "cce610d10-Che793Nz.js": [
    ['import { n as _ } from "./c71dee58b-AkF9Vm4d.js";', `import { n as _, ClaudexProjectReadError } from "./c71dee58b-AkF9Vm4d.js";
import { ClaudexProjectScope } ${scopeImport}
function ProjectScope({ uuid, children }) {
  return t(ClaudexProjectScope, {
    projectUuid: uuid,
    pending: t(o, {}),
    renderError: (onRetry) => t(ClaudexProjectReadError, { onRetry }),
    children,
  });
}`],
    ['I1($, 0, t(_, { uuid: e.uuid }), e.uuid)', 'I1($, 0, t(ProjectScope, { uuid: e.uuid, children: t(_, { uuid: e.uuid }) }), e.uuid)'],
    ['I1($, 0, t(v, { params: { uuid: e.uuid } }), e.uuid)', 'I1($, 0, t(ProjectScope, { uuid: e.uuid, children: t(v, { params: { uuid: e.uuid } }) }), e.uuid)'],
  ],
  "c71dee58b-AkF9Vm4d.js": [
    ['function fm(e) {', 'export { fm as ClaudexProjectReadError };\nfunction fm(e) {'],
    ['    n = _n(),\n    r = hn().activeOrganization?.name,', '    { activeOrganization, claudexProjectWorkspace: workspace } = hn(),\n    n = _n() || !!workspace,\n    r = activeOrganization?.name,'],
    ['    r = _n(),\n    i = yn(),', '    { claudexProjectWorkspace: workspace } = hn(),\n    r = _n() || !!workspace,\n    i = yn(),'],
    ['      E = _n(),\n      D = yn(),', '      { claudexProjectWorkspace: workspace } = hn(),\n      E = _n() || !!workspace,\n      D = yn(),'],
    ['          _ instanceof be && _.statusCode === 403 && h.push("/projects/no-permission");', '          um(_) && h.push("/projects/no-permission");'],
  ],
  "shared-m-2-DfdOu-fU.js": [
    ['function rY() {\n  let { activeOrganization: e } = E_(),\n    t = Ma(),\n    n = zi().isAvailable;\n  return !!e && t && n;', 'function rY() {\n  let { activeOrganization: e, claudexProjectWorkspace: workspace } = E_(),\n    t = Ma(),\n    n = zi().isAvailable;\n  return !!e && (!!workspace || (t && n));'],
  ],
  "shared-0-BgsOqC85.js": [
    ['function Ay() {\n  return k9X();\n}', 'function Ay() {\n  const workspace = a4().claudexProjectWorkspace;\n  const original = k9X();\n  return !workspace && original;\n}'],
    ['function La(e, t) {\n  let { account: n, activeOrganization: r } = a4(),', 'function ClaudexProjectAccounts(e, account, workspace) {\n  return workspace ? [...CL(e), { orgUuid: workspace.uuid, accountUuid: account?.uuid }] : CL(e);\n}\nfunction La(e, t) {\n  let { account: n, activeOrganization: r, claudexProjectWorkspace: workspace } = a4(),'],
    ['    l = CL(e);', '    l = ClaudexProjectAccounts(e, n, workspace);'],
    ['function f4(e, t = !0, n) {\n  let { activeOrganization: r } = a4(),\n    i = r?.uuid;', 'function f4(e, t = !0, n) {\n  let { activeOrganization: r, account, claudexProjectWorkspace: workspace } = a4(),\n    i = r?.uuid, key = ClaudexProjectAccounts(e, account, workspace);'],
    ['    queryKey: n?.quiet === !0 ? [...CL(e), "quiet"] : CL(e),', '    queryKey: n?.quiet === !0 ? [...key, "quiet"] : key,'],
    ['function G6(e) {\n  let { activeOrganization: t } = a4(),', 'function G6(e) {\n  let { activeOrganization: t, account, claudexProjectWorkspace: workspace } = a4(),'],
    ['      r.invalidateQueries({ queryKey: [tr, { projectUuid: e }] });', '      r.invalidateQueries({ queryKey: ClaudexProjectAccounts(e, account, workspace) });'],
  ],
  "cd2e30834-Bk60puxO.js": [
    ['  let { activeOrganization: u } = E(),\n    d = D(),', '  let { activeOrganization: u, claudexProjectWorkspace: workspace } = E(),\n    d = D(),'],
    [`        (${matchingRoles}),`, `        (!!workspace || ${matchingRoles}),`],
  ],
  "c495d62a5-CNOPwu0B.js": [
    ['    { account: c, activeOrganization: m } = fe(),', '    { account: c, activeOrganization: m, claudexProjectWorkspace: workspace } = fe(),'],
    ['      !!m?.capabilities.some((e) => e === "api" || e === "raven"),', '      (!!workspace || !!m?.capabilities.some((e) => e === "api" || e === "raven")),'],
  ],
  "c8d15a635-a_m0kPca.js": [
    ['    { activeOrganization: Be, account: Ve } = oe(),', '    { activeOrganization: Be, account: Ve, claudexProjectWorkspace: workspace } = oe(),'],
    ['    st = de({ enabled: s }),\n    { data: R } = De(s ? f.uuid : void 0),', '    st = de({ enabled: s && !workspace }) && !workspace,\n    { data: R } = De(s && !workspace ? f.uuid : void 0),'],
    ['    Tt = new URL(`/project/${f.uuid}`, window.location.origin).toString(),', '    Tt = new URL(`/project/${f.uuid}`, (workspace ? Ve?.claudex_project_share_origin : void 0) ?? window.location.origin).toString(),'],
  ],
};

export const hostProjectWorkspaceFiles = Object.keys(rules);

export function deriveOfficialUiHostProjectWorkspaceModule(file, source) {
  for (const [before, after, count = 1] of rules[file] ?? []) {
    const sections = source.split(before);
    if (sections.length !== count + 1) throw Error(`Invalid project workspace source anchor in ${file}: ${before}`);
    source = sections.join(after);
  }
  return source;
}

export function applyOfficialUiHostProjectWorkspace(directory) {
  const outputs = hostProjectWorkspaceFiles.map(file => {
    const target = path.join(directory, file);
    return [target, deriveOfficialUiHostProjectWorkspaceModule(file, fs.readFileSync(target, "utf8"))];
  });
  for (const [target, output] of outputs) fs.writeFileSync(target, output);
  return hostProjectWorkspaceRevision;
}
