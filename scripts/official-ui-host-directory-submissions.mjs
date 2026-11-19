import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const hostDirectorySubmissionsRevision = "claudex-directory-submissions-v1";
const portal = "c00ee8fcb-DCpQbDQW.js";
const forms = "cd9350303-BYClhzi3.js";
const access = "cd1ce60ab-JbFW4GQV.js";
const routes = "c55fb6ff2-DRLtfCCG.js";
const layout = "c68c4283d-B6iLcgAK.js";
const listings = "ca00fcdfd-B-Qw7-FD.js";
const detail = "c214ec848-Df6UAUUH.js";
export const hostDirectorySubmissionsInputHashes = {
  [portal]: "2e90ddc31136897f4389bac1cc7de8a6631f8c8295c2eecb22b559675dc1c8ff",
  [forms]: "746810545eba2f939ab732965a3d7f5e0bfa4ef3ec8e667ec22a247481c48739",
  [access]: "207e4c442bfad9a7b52103a8a2ae8454d07895c5d6b698183cd336abc21472e1",
  [routes]: "c9fa11ed0fd7c06a1085ec73f61280732165d3f49f4d7ced7f3accb00ec18ccf",
  [layout]: "5295ea964c19331e579623fcffbefa7ba3a463951096e27a833989a6435113b2",
  [listings]: "43840cf20d829110c126da25a273a0afedfca64fd926d3eee2afb69d5fb4fdad",
  [detail]: "875aab901c2adf2013367116373d07241f40e35d02ca87368d684445166d2c79",
};
export const hostDirectorySubmissionsOriginalHashes = {
  ...hostDirectorySubmissionsInputHashes,
  [portal]: "629f704299f1ac55d7ef13d0b77a417a207149306580f62e695f57af106a291e",
  [forms]: "b4bc4652d5d6c41969df742be52976d23002e59d36ea1a3adba20e5226d9c264",
  [listings]: "1b8660bebf656bade82a8125ec2895e304147a94c07cad28c5837c2668a0983c",
  [detail]: "ece14e536809534ee0c8c26dfcfa8935a6ebeebc8708fae604d558ffef9f1920",
};

const accountImport = 'import {ce as __directoryAccount} from "./shared-l-p-m-w-2-BMCa56Vr.js";';
const hostEnabled = "__directoryAccount().account?.claudex_directory_submissions === true";
const originalForms = `
function __pluginFormData(row, initialData) {
  const data = { ...initialData };
  for (const field of Object.keys(Ii({ ...ka, anthropicContact: "", pluginSha: "",
    pluginTagline: "", licenseType: "", collectsUserData: false,
    termsOfServiceUrl: "", privacyPolicyUrl: "" }))) {
    if (row?.[field] != null) data[field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = row[field];
  }
  return data;
}
function __pluginSubmissionUrl(org, id) {
  const base = "/api/console/organizations/" + org + "/directory/plugin-submissions";
  return id ? base + "/" + encodeURIComponent(id) : base;
}
function __pluginSubmissionDetail({ id, canWrite, edit, render, initialData }) {
  const { activeOrganization } = he();
  const org = activeOrganization?.uuid;
  const read = A(__pluginSubmissionUrl(org, id), {
    enabled: !!org, queryKey: ["pluginSubmissions", { orgUuid: org }, id],
  });
  const erase = j(__pluginSubmissionUrl(org, id), "DELETE", { enabled: !!org });
  const { addError } = xe();
  const query = __directoryQueryClient();
  const navigate = __directoryNavigate();
  const [confirm, setConfirm] = t(false);
  const { hrefs } = Wn();
  if (read.isLoading || read.isPending) return render(c(__directorySkeleton, { eyebrow: true }));
  if (read.isError) return render(r("div", {
    className: "flex flex-col items-start gap-sm",
    children: [
      c("p", { role: "alert", children: c(q, { defaultMessage: "Failed to load submissions.", id: "mro/uk" }) }),
      c(w, { variant: "secondary", onClick: () => read.refetch(),
        children: c(q, { defaultMessage: "Reload", id: "fdCS5/" }) }),
    ],
  }));
  const row = read.data;
  const editable = canWrite && (row.status === "draft" || row.status === "rejected");
  const editHref = hrefs.pluginEdit(row.uuid);
  if (edit && editable) return c(qa, {
    initialData: __pluginFormData(row, initialData), row,
    task: c(q, { defaultMessage: "Edit listing", id: "q2PeTg" }), render,
  }, row.uuid);
  const title = Ji(row) || c(q, { defaultMessage: "Untitled plugin", id: "F8JJ7U" });
  return render(r(i, {
    children: [
      c(__directoryHeader, {
        title,
        subtitle: c(Xi, { plugin: row, hideName: true }),
        status: c(T, { variant: Zi(row.status), children: c(Qi, { status: row.status }) }),
        primaryAction: editable ? c(w, { variant: "primary", href: editHref, children:
          row.status === "draft"
            ? c(q, { defaultMessage: "Continue draft", id: "claudex-directory-continue-draft" })
            : c(q, { defaultMessage: "Edit", id: "wEQDC6Wv3/" }),
        }) : undefined,
      }),
      canWrite && !["approved", "published"].includes(row.status) && c(w, { variant: "secondary", onClick: () => setConfirm(true),
        children: c(q, { defaultMessage: "Delete", id: "K3r6DQW7h+" }) }),
      c(__directoryDeleteDialog, {
        open: confirm, onOpenChange: setConfirm,
        onConfirm: async () => {
          try {
            await erase.mutateAsync();
            query.removeQueries({ queryKey: ["pluginSubmissions", { orgUuid: org }, id] });
            void query.invalidateQueries({ queryKey: ["pluginSubmissions", { orgUuid: org }] });
            await navigate({ to: hrefs.home });
          } catch (error) {
            addError(c(q, { defaultMessage: "Failed to delete the submission. Try again.", id: "claudex-directory-delete-failed" }), { error });
          }
        },
      }),
    ],
  }));
}
`;

export const hostDirectorySubmissionsRules = [
  [access, "host-directory-access", '    d = v();\n  return a || !s', `    d = v(),
    host = aAccount().account?.claudex_directory_submissions === true;
  if (host && !a && s) return { access: "ok" };
  return a || !s`],
  [access, "host-account-import", 'function f() {', accountImport.replace("__directoryAccount", "aAccount") + '\nfunction f() {'],
  [routes, "host-portal-readiness", 'function X() {\n', accountImport + `
function X() {
  const account = __directoryAccount().account;
`],
  [routes, "host-portal-availability", '  return s && !d ? "pending" : i && o ? "on" : "off";', `  return account?.claudex_host_authentication
    ? account.claudex_directory_submissions === true ? "on" : "off"
    : s && !d ? "pending" : i && o ? "on" : "off";`],
  [layout, "host-portal-layout", 'function ae() {', `${accountImport}
function ae() {`],
  [layout, "host-original-portal-hrefs", '    mcpDetail: (e) => R({ kind: "mcpDetail", slug: e }),', `    mcpDetail: (e) => R({ kind: "mcpDetail", slug: e }),
    mcpEdit: (e) => R({ kind: "mcpEdit", slug: e }),`],
  [layout, "host-plugin-edit-href", '    pluginSource: (e) => R({ kind: "pluginSource", id: e }),', `    pluginSource: (e) => R({ kind: "pluginSource", id: e }),
    pluginEdit: (e) => R({ kind: "pluginEdit", id: e }),`],
  [layout, "host-portal-context-hrefs", '  return J3($, 0, n, t, e)\n    ? K3($, 0, n, t, e, e === "directory_manage" ? { mount: e, hrefs: n ? Te : U, entry: t } : De)', `  const hosted = ${hostEnabled};
  const showDetails = n || hosted;
  return J3($, 0, showDetails, t, e)
    ? K3($, 0, showDetails, t, e, e === "directory_manage" ? { mount: e, hrefs: showDetails ? Te : U, entry: t } : De)`],
  [layout, "host-original-page-layout", '    v = de(),', `    hosted = ${hostEnabled},
    v = de(),`],
  [layout, "host-original-page-header", 'if ((x(d === void 0 ? _ : `${d} \\u00B7 ${_}`), v === !0)) {', 'if ((x(d === void 0 ? _ : `${d} \\u00B7 ${_}`), v === !0 || hosted)) {'],
  [portal, "host-classic-body", 'function ze(e) {', `${accountImport}
import { __pluginSubmissionDetail } from "./${forms}";
import { zt as __directoryLoadMcp } from "./${listings}";
import { c as __directorySkeleton } from "./${layout}";
function ze(e) {
  return ${hostEnabled} ? i(__hostDirectoryPortal, e) : i(__vendorDirectoryPortal, e);
}
function __vendorDirectoryPortal(e) {`],
  [portal, "host-classic-routes", 'function Ue(e) {', `
function __hostDirectoryPortal({ route }) {
  const kinds = E();
  const { account } = __directoryAccount();
  if (!D(route, kinds) || !["home", "new", "newConnector", "newPlugin", "mcpDetail", "mcpEdit", "pluginDetail", "pluginEdit"].includes(route.kind))
    return i(f, {});
  const scope = account?.uuid;
  switch (route.kind) {
    case "newConnector":
      return i(__hostMcpWizard, {}, scope + ":newConnector");
    case "mcpEdit":
    case "mcpDetail":
      return i(__hostMcpRoute, { route }, scope + ":" + Ke(route));
    case "newPlugin": {
      const initialData = { submitterEmail: account?.email_address ?? "" };
      return i(Oe, { initialData, task: i(x, { ...U.submitPlugin }),
        render: (children, actions) => i(z, { page: "newPlugin", crumbs: re, actions, children }),
      }, scope);
    }
    case "pluginDetail":
    case "pluginEdit":
      return i(__hostPluginSubmission, { route }, scope + ":" + route.id + ":" + route.kind);
    default:
      return i(Ue, { route, canWrite: true, kinds }, scope + ":" + Ke(route));
  }
}
function __hostMcpRoute({ route }) {
  const read = __directoryLoadMcp(route.slug, { quietNotFound: true });
  const draft = read.data?.submission_data?.claudex_draft;
  if (read.isPending) return i(z, {
    page: route.kind, crumbs: oe, children: i(__directorySkeleton, { eyebrow: true }),
  });
  if (read.data?.status === "draft" && draft && route.kind === "mcpEdit")
    return i(__hostMcpWizard, { row: read.data }, read.data.id);
  return route.kind === "mcpEdit"
    ? i(xe, { slug: route.slug, canWrite: true })
    : i(be, { slug: route.slug, canWrite: true });
}
function __hostMcpWizard({ row }) {
  const { account } = __directoryAccount();
  const task = i(x, { ...U.submitConnector });
  const initialData = {
    primaryContactName: account?.full_name ?? "",
    primaryContactEmail: account?.email_address ?? "",
    ...row?.submission_data?.claudex_draft?.form_data,
  };
  return i(Ee, {
    task, initialData, sections: j, row,
    render: (children, actions) => i(z, {
      page: row ? "mcpEdit" : "newConnector", crumbs: oe, actions, children,
    }),
  });
}
function __hostPluginSubmission({ route }) {
  const { account } = __directoryAccount();
  return i(__pluginSubmissionDetail, {
    id: route.id, canWrite: true, edit: route.kind === "pluginEdit",
    initialData: { submitterEmail: account?.email_address ?? "" },
    render: (children, actions) => i(z, {
      page: route.kind, crumbs: route.kind === "pluginEdit" ? re : [],
      actions, children,
    }),
  });
}
function Ue(e) {`],
  [forms, "classic-mcp-host-state", 'function xa({ initialData: e, sections: a, onDraftSaved: l, task: f, onFinished: p }) {', 'function xa({ initialData: e, sections: a, onDraftSaved: l, task: f, onFinished: p, row, render }) {'],
  [forms, "classic-mcp-scope", '    Te = d(() => Ot(A), [A]),', `    draftIdentity = row ? A + ":" + row.id : A,
    draft = row?.submission_data?.claudex_draft,
    Te = d(() => Ot(draftIdentity), [draftIdentity]),`],
  [forms, "classic-mcp-original-steps", '    ae = ne("mcp_auto_review_enabled_main"),\n    oe = ye(),', `    offeredAutoReview = ne("mcp_auto_review_enabled_main"),
    ae = !render && offeredAutoReview,
    useNewForm = ye(),
    oe = !!render || useNewForm,`],
  [forms, "classic-mcp-disable-vendor-checks", '    H = ne("mcp_server_spec_submit_main"),\n    U = on(),', `    offeredServerSpec = ne("mcp_server_spec_submit_main"),
    H = !render && offeredServerSpec,
    offeredAuthProbe = on(),
    U = render ? "off" : offeredAuthProbe,`],
  [forms, "classic-mcp-disable-managed-auth", '    ze = Wt(),\n    Be = gt(),\n    Ve = pe(),\n    He = de(je.serverSpec?.mode === "authoring" && je.serverSpec.oauth?.idJagDeclared === !0);', `    offeredCredentials = Wt(),
    ze = !render && offeredCredentials,
    offeredGlobalHeaders = gt(),
    Be = !render && offeredGlobalHeaders,
    offeredManagedAuth = pe(),
    Ve = !render && offeredManagedAuth,
    offeredIdJag = de(je.serverSpec?.mode === "authoring" && je.serverSpec.oauth?.idJagDeclared === !0),
    He = !render && offeredIdJag;`],
  [forms, "classic-mcp-disable-ema-enrollment", '    St = fe(),', `    offeredEma = fe(),
    St = !render && offeredEma,`],
  [forms, "classic-mcp-draft-row", '    M = n(null),\n    P = n(!1),', '    M = n(row ?? null),\n    P = n(!1),'],
  [forms, "classic-mcp-initial-snapshot", '    [Me, Ne] = t(void 0),\n    [Pe, Fe]', '    [Me, Ne] = t(row?.submission_data?.server_snapshot),\n    [Pe, Fe]'],
  [forms, "classic-mcp-keep-restored-snapshot", '    (Ne(void 0), Fe({ key: "none", draft: At }), (z.current = {}));', '    (Ne(row?.submission_data?.server_snapshot), Fe({ key: "none", draft: At }), (z.current = {}));'],
  [forms, "classic-mcp-resume-progress", '  let [Ue, We] = Se(Te.currentStep, W[0].steps[0]),\n    Y = fn(a ?? it, W, Ue),\n    [Ge, Ke] = Se(Te.touchedSteps, []),', `  let [Ue, We] = Se(Te.currentStep, draft?.current_step ?? W[0].steps[0]),
    Y = fn(a ?? it, W, Ue),
    [Ge, Ke] = Se(Te.touchedSteps, draft?.touched_steps ?? []),`],
  [forms, "classic-mcp-probe-after-resume", '    { tools: yt, widgetReads: bt } = Fn(J, Ye, { enabled: E === null && M.current === null }),', '    { tools: yt, widgetReads: bt } = Fn(J, Ye, { enabled: E === null && (!!render || M.current === null) }),'],
  [forms, "classic-mcp-persisted-draft", '  let rr = s(', `  const navigate = __directoryNavigate();
  const request = __directoryRequest("Mutation error");
  const [confirmDelete, setConfirmDelete] = t(false);
  async function writeMcp(data, final, warnings, includeSnapshot = true) {
    const existing = M.current;
    const storedSlug = existing && existing.slug !== existing.id ? existing.slug : "";
    const slug = final ? (J.slug || storedSlug || pn(J.name ?? "")) : storedSlug;
    const answers = final ? __directoryMcpPayload(data, warnings) : {
      data: { type: "remote", name: J.name, one_liner: J.oneLiner, description: J.description,
        icon_url: J.iconUrl, remote: { url: J.remoteUrl, transport: J.remoteTransport } },
      submission_data: { server_snapshot: includeSnapshot ? J.serverSnapshot : undefined, claudex_draft: {
        form_data: ke, current_step: Ue, touched_steps: Ge,
      } },
    };
    const base = "/api/organizations/" + A + "/directory/mcp-servers";
    let saved;
    try {
      saved = await request(existing ? base + "/" + existing.id : base, {
        method: existing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, ...answers }),
      });
    } catch (error) {
      if (includeSnapshot && data.serverSnapshot && Bt(error))
        return writeMcp({ ...data, serverSnapshot: undefined }, final, warnings, false);
      throw error;
    }
    M.current = saved;
    void k.invalidateQueries({ queryKey: ["mcp-submissions"] });
    return saved;
  }
  async function saveMcpAndExit() {
    if (P.current) return;
    P.current = true;
    I(true);
    try {
      await writeMcp(J, false);
      Je();
      await navigate({ to: _.home });
    } catch (error) {
      m(c(q, { defaultMessage: "Failed to save the draft. Try again.", id: "claudex-directory-save-failed" }), { error });
    } finally {
      P.current = false;
      I(false);
    }
  }
  async function deleteMcpDraft() {
    if (P.current) return;
    P.current = true;
    I(true);
    try {
      await request("/api/organizations/" + A + "/directory/mcp-servers/" + row.id, { method: "DELETE" });
      Je();
      setConfirmDelete(false);
      void k.invalidateQueries({ queryKey: ["mcp-submissions"] });
      await navigate({ to: _.home });
    } catch (error) {
      m(c(q, { defaultMessage: "Failed to delete the submission. Try again.", id: "claudex-directory-delete-failed" }), { error });
    } finally {
      P.current = false;
      I(false);
    }
  }
  let rr = s(`],
  [forms, "classic-mcp-complete-draft-on-submit", '              l = M.current;\n            if (!l)', `              l = M.current;
            if (render) {
              try {
                l = await writeMcp(n, true, e);
                Je();
              } catch (error) {
                m(ht(kt, error), { error, messageForLogging: "mcp-submission save failed" });
                return;
              }
            }
            if (!l)`],
  [forms, "classic-mcp-current-draft-final-submit", '    }, [Re, kr, Fr, X, Y, G, be, Dr, Nr, Or, Oe, K, Ee, J, V, y, Je, m, kt, hn, vt, p]),', '    }, [Re, kr, Fr, X, Y, G, be, Dr, Nr, Or, Oe, K, Ee, J, V, y, Je, m, kt, hn, vt, p, render, writeMcp]),'],
  [forms, "classic-mcp-original-wizard-shell", '  return E !== null && y\n    ? c($i, {', '  const wizard = E !== null && (y || render)\n    ? c($i, {'],
  [forms, "classic-mcp-save-and-exit-control", '        });\n}\nfunction Sa(e) {', `        });
  if (!render) return wizard;
  if (E !== null) return render(wizard);
  const save = c(__directorySaveAndExit, { kind: "connector", onSave: saveMcpAndExit });
  return render(wizard, row ? r(i, {
    children: [
      c(w, { variant: "secondary", onClick: () => setConfirmDelete(true),
        children: c(q, { defaultMessage: "Delete", id: "K3r6DQW7h+" }) }),
      save,
      c(__directoryDeleteDialog, {
        open: confirmDelete, onOpenChange: setConfirmDelete, onConfirm: deleteMcpDraft,
      }),
    ],
  }) : save);
}
function Sa(e) {`],
  [forms, "original-plugin-detail", 'export { Gi as a, Wi as i, xa as n, Li as o, Hi as r, qa as t };', `
import { u as __directoryNavigate } from "./vendor-router-B8AYN-9t.js";
import { h as __directoryQueryClient } from "./vendor-query-CdfkcLg6.js";
import { rs as __directoryRequest } from "./shared-l-p-m-w-1-O9prfPUL.js";
import { DT as __directorySessionStorage } from "./shared-l-p-m-w-0-C_nAiu5o.js";
import { $t as __directoryHeader, __directoryDeleteDialog, __directoryMcpPayload } from "./${listings}";
import { c as __directorySkeleton } from "./${layout}";
import { q as __directorySaveAndExit } from "./c214ec848-Df6UAUUH.js";
${originalForms}
export { Gi as a, Wi as i, xa as n, Li as o, Hi as r, qa as t, __pluginSubmissionDetail };`],
  [forms, "plugin-detail-reuse-list-copy", 'var Xi = l(function ({ plugin: e }) {', 'var Xi = l(function ({ plugin: e, hideName = false }) {'],
  [forms, "plugin-detail-title-once", '      c("span", {\n        className: "truncate text-body text-primary",\n        title: t || void 0,', '      !hideName && c("span", {\n        className: "truncate text-body text-primary",\n        title: t || void 0,'],
  [forms, "plugin-scoped-wizard-state", '    { initialData: a, task: o } = e,', '    { initialData: a, task: o, row, render } = e,'],
  [forms, "plugin-session-identity", '    h = J1($, 0, m) ? K1($, 0, m, Ha(m)) : $[1],', `    draftScope = row ? m + ":" + row.uuid : m,
    h = J1($, 0, draftScope) ? K1($, 0, draftScope, Ha(draftScope)) : $[1],`],
  [forms, "plugin-server-draft-initial-state", '    [v, y] = Se(h.currentStep, "introduction"),', `    [v, y] = Se(h.currentStep, row?.current_step ?? (row?.status === "rejected" ? "pluginInfo" : "introduction")),`],
  [forms, "plugin-server-draft-progress", '    [T, E] = Se(h.touchedSteps, C),', '    [T, E] = Se(h.touchedSteps, row?.touched_steps ?? C),'],
  [forms, "plugin-draft-mutations", '  let le = I === 0,', `  const query = __directoryQueryClient();
  const navigate = __directoryNavigate();
  const request = __directoryRequest("Mutation error");
  const [savedId, setSavedId] = Se(h.formData + ":id", row?.uuid);
  const pending = n(false);
  const savedIdRef = n(savedId);
  const pluginListKey = ["pluginSubmissions", { orgUuid: m }];
  function clearDraft() {
    for (const key of [...Object.values(h), h.formData + ":id"]) __directorySessionStorage.removeItem(Wa + key);
  }
  async function writeDraft(status) {
    const values = { ...Ii(x), submitted_via: "claude_ai", status,
      current_step: v, touched_steps: T };
    const id = savedIdRef.current;
    const saved = await request(__pluginSubmissionUrl(m, id), {
      method: id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
    });
    savedIdRef.current = saved.uuid;
    setSavedId(saved.uuid);
    query.setQueryData([...pluginListKey, saved.uuid], saved);
    void query.invalidateQueries({ queryKey: pluginListKey });
    return saved;
  }
  async function saveAndExit() {
    if (pending.current) return;
    pending.current = true;
    ne(true);
    try {
      await writeDraft("draft");
      clearDraft();
      await navigate({ to: l.home });
    } catch (error) {
      s(c(q, { defaultMessage: "Failed to save the draft. Try again.", id: "claudex-directory-save-failed" }), { error });
    } finally {
      pending.current = false;
      ne(false);
    }
  }
  async function submitPlugin(data) {
    if (!render) return d(data);
    const id = savedIdRef.current ?? (await writeDraft("draft")).uuid;
    let saved;
    try {
      saved = await request(__pluginSubmissionUrl(m, id), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...Ii(data), status: "pending" }),
      });
    } catch (error) {
      const confirmed = await request(__pluginSubmissionUrl(m, id), { method: "GET" }).catch(() => undefined);
      if (!confirmed || ["draft", "rejected"].includes(confirmed.status)) throw error;
      saved = confirmed;
    }
    void query.invalidateQueries({ queryKey: pluginListKey, exact: true });
    clearDraft();
    return saved;
  }
  let le = I === 0,`],
  [forms, "plugin-submit-existing-draft", '              let e = await d(x);', '              let e = await submitPlugin(x);'],
  [forms, "plugin-submit-current-render", '    ge = J5($, 56, s, d, R, L, x, P, m, y, S, E, B)\n      ? K5($, 56, s, d, R, L, x, P, m, y, S, E, B, async () => {\n          if (P) return;', `    ge = async () => {
          if (P || pending.current) return;`],
  [forms, "plugin-submit-preserve-feedback", '                Ga(m),', '                Ga(draftScope),'],
  [forms, "plugin-submit-bind-current-draft", '        })\n      : $[67],\n    _e = J1($, 68, z)', '        },\n    _e = J1($, 68, z)'],
  [forms, "plugin-success-original-confirmation", '  if (g)\n    return J1($, 75, _e)', `  if (g && render) return render(c(Va, {
    onSubmitAnother: row ? () => navigate({ to: l.newPlugin() }) : () => {
      savedIdRef.current = undefined;
      setSavedId(undefined);
      _e();
    },
    submissionsHref: l.home,
  }));
  if (g)
    return J1($, 75, _e)`],
  [forms, "plugin-original-save-control", '  return J2($, 117, ge, Me) ? K2($, 117, ge, Me, c(Y, { onSubmit: ge, children: Me })) : $[119];', `  const form = c(Y, { onSubmit: ge, children: Me });
  return render ? render(form, c(__directorySaveAndExit, { kind: "plugin", onSave: saveAndExit })) : form;`],
  [forms, "classic-mcp-no-vendor-held-credentials", '  let g = t.authType,', `  const hosted = he().account?.claudex_directory_submissions === true;
  let g = t.authType,`],
  [forms, "classic-mcp-auth-modes", 'children: [N, ne, I, z, ae]', 'children: hosted ? [N, ne, ae] : [N, ne, I, z, ae]'],
  [forms, "classic-mcp-hide-vendor-auth-enrollment", 'children: [E, V, se, ce, U, le]', 'children: [E, V, se, ce, U, hosted ? null : le]'],
  [forms, "mcp-listing-release-copy", 'After review, approved servers appear at <dirLink>Claudex/directory</dirLink> for other Claudex organizations to install.', 'Publish approved servers to make them available in <dirLink>the directory</dirLink>.'],
  [forms, "plugin-directory-discovery-copy", 'Reviewed plugins are available for anyone to install from the marketplace.', 'Published plugins appear in the directory.'],
  [forms, "plugin-directory-discovery-message", 'id: "14c/Qu"', 'id: "claudex-directory-plugin-listing"'],
  [forms, "plugin-service-terms-context", '  La = l((e) => {', `  La = l((e) => {
    const account = he().account;
    const hosted = account?.claudex_directory_submissions === true;
    const termsUrl = account?.claudex_directory_terms_url;
    const termsLabel = { defaultMessage: "Terms of Service", id: "claudex-directory-terms-link" };
    const terms = hosted ? {
      defaultMessage: "By submitting, I agree to the {termsLink} and authorize Claudex to contact me about this plugin. If approved, the plugin listing may appear in the directory.",
      id: "claudex-directory-plugin-terms",
    } : Ia.terms;`],
  [forms, "plugin-service-terms-label", 'a.formatMessage(Ia.terms, {', 'a.formatMessage(terms, {'],
  [forms, "plugin-service-terms-accessible-label", 'termsLink: a.formatMessage(Ia.termsLink),', 'termsLink: a.formatMessage(hosted ? termsLabel : Ia.termsLink),'],
  [forms, "plugin-service-terms-visible-label", '              ...Ia.terms,', '              ...terms,'],
  [forms, "plugin-service-terms-url", '                termsLink: c(E, {\n                  href: Fa.softwareDirectoryTerms,\n                  external: !0,\n                  className: "text-secondary",\n                  children: c(q, { ...Ia.termsLink }),\n                }),', `                termsLink: hosted && !termsUrl
                  ? c(q, termsLabel)
                  : c(E, {
                      href: hosted ? termsUrl : Fa.softwareDirectoryTerms,
                      external: !0,
                      className: "text-secondary",
                      children: c(q, hosted ? termsLabel : Ia.termsLink),
                    }),`],
  [forms, "plugin-source-review-copy", 'Plugins are typically served via a GitHub repo. For each submission we will take the latest commit (tagged via SHA) and copy this into our official marketplace for serving after a security screening.', 'Link to the GitHub repository that contains your plugin.'],
  [forms, "plugin-source-review-message", 'id: "JfyKcD"', 'id: "claudex-directory-plugin-source"'],
  [detail, "host-mcp-editor-actions", '  let k = r && (!d || p.editable_as_owner === !0),', `  let k = r && (!d || p.editable_as_owner === !0) &&
      (!hosted || ["draft", "changes_requested"].includes(p.status)),`],
  [detail, "host-mcp-account-import", 'function wt() {', accountImport + '\nfunction wt() {'],
  [detail, "host-mcp-detail-author-capability", '    { slug: t, canWrite: r } = e,\n    o = S(),', `    { slug: t, canWrite: r } = e,
    hosted = ${hostEnabled},
    o = S(),`],
  [listings, "mcp-reviewer-setup-example", 'Sign up at example.com/signup with email reviewer@anthropic.com, then connect via OAuth using client_id=…', 'Sign up at example.com/signup, then follow the setup guide to connect a test account.'],
  [listings, "mcp-reviewer-setup-example-message", 'id: "OMQQ9C"', 'id: "claudex-directory-mcp-review-setup-example"'],
  [listings, "mcp-reviewer-setup", "We reserve the right to manually review all servers. Provide clear test-account setup and access instructions. We’re working to automate this process to reduce the time it takes to get your server into the directory — write these instructions so they contain every link, credential, and step needed to autonomously access the MCP server. For enterprise accounts or servers that require a fully populated account, provide test credentials that grant access to a fully populated account for review.", "Provide links and steps for creating a test account with the data needed to review the server. Keep passwords, tokens, and client secrets out of the submission."],
  [listings, "mcp-reviewer-setup-message", 'id: "gA/wvt"', 'id: "claudex-directory-mcp-review-setup"'],
  [listings, "reuse-original-confirmation", 'export {\n', 'export {\n  rb as __directoryDeleteDialog,\n  Rd as __directoryMcpPayload,\n'],
].map(([file, name, before, after]) => ({ file, name, before, after }));

const sha = (source) => createHash("sha256").update(source).digest("hex");

export function deriveOfficialUiHostDirectorySubmissionsModule(file, source) {
  if (!Object.hasOwn(hostDirectorySubmissionsInputHashes, file)) return source;
  if (sha(source) !== hostDirectorySubmissionsInputHashes[file])
    throw Error("Pinned directory submission input mismatch: " + file);
  for (const rule of hostDirectorySubmissionsRules.filter((rule) => rule.file === file)) {
    const index = source.indexOf(rule.before);
    if (index < 0 || source.indexOf(rule.before, index + rule.before.length) >= 0)
      throw Error("Pinned directory submission anchor mismatch: " + rule.name);
    source = source.slice(0, index) + rule.after + source.slice(index + rule.before.length);
  }
  return source;
}

export function applyOfficialUiHostDirectorySubmissions(directory) {
  const modules = Object.keys(hostDirectorySubmissionsInputHashes).map((file) => {
    const location = path.join(directory, file);
    const input = fs.readFileSync(location, "utf8");
    const output = deriveOfficialUiHostDirectorySubmissionsModule(file, input);
    return { file, location, output, inputSha256: sha(input), outputSha256: sha(output) };
  });
  for (const { location, output } of modules) fs.writeFileSync(location, output);
  return {
    revision: hostDirectorySubmissionsRevision,
    modules: modules.map(({ file, inputSha256, outputSha256 }) => ({
      file, originalSha256: hostDirectorySubmissionsOriginalHashes[file], inputSha256, outputSha256,
      rules: hostDirectorySubmissionsRules.filter((rule) => rule.file === file).map((rule) => rule.name),
    })),
  };
}
