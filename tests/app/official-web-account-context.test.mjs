import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { CookieJar, JSDOM } from "jsdom";
import { deriveOfficialWebAccountModule } from "../../scripts/official-web-account-context.mjs";

const source = path.resolve(
  process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? ".restore/archive-extracted",
  "claude-frontend-4.4212.0/src/cloud",
);
const common = "assets/v1/shared-l-p-m-w-0-C_nAiu5o.js";
const hint = "assets/v1/shared-l-p-m-w-2-BMCa56Vr.js";
const eager = "assets/v1/shared-l-p-m-w-3-B5uNmf7O.js";
const codeChrome = "assets/v1/shared-22-Ciy9U3_0.js";
const historyRows = "assets/v1/shared-39-BVbIfnmZ.js";
const layout = "assets/v1/shared-23-xVessQLu.js";
const framePolicy = "assets/v1/shared-l-m-0-COo7i6eq.js";
const moveMenu = "assets/v1/shared-140-D6FnSjbS.js";
const chatActionsMenu = "assets/v1/c752b32f8-CkH0gFtn.js";
const moveDialog = "assets/v1/c9d22852b-C4-qsx4Y.js";
const projectQueries = "assets/v1/shared-m-2-DfdOu-fU.js";
const codeQueries = "assets/v1/shared-m-4-CbJwwS_m.js";
const codeComposer = "assets/v1/ca80fca8d-LvEosFmV.js";
const codeControls = "assets/v1/c5da7eb42-BOzerWAp.js";
const codeTerminal = "assets/v1/c03935b01-C5mJBQhH.js";
const codeListRoute = "assets/v1/cbd6c85c8-VtqGtXN9.js";
const codeOnboardingGuard = "assets/v1/c9500abe8-CRS6YI1t.js";
const imageTiles = "assets/v1/cfdc866bf-BDSl0H9m.js";
const codeFilePanel = "assets/v1/cd2efac6e-DHz2EyWB.js";
const coworkActions = "assets/v1/shared-2-CuvP2TaI.js";
const coworkPermissions = "assets/v1/shared-3-f8anTwq9.js";
const coworkPermissionCards = "assets/v1/ca44d5dae-Duwp3Ivb.js";
const coworkTaskMenu = "assets/v1/cc18d27d7-D3efb-Mh.js";
const compactInstructions = "assets/v1/cfe1b8ada-3ZQn_bW7.js";
const fullInstructions = "assets/v1/cdeaafbfc-Bs8B_xOb.js";
const skillLibrary = "assets/v1/c2e144342-BPmQtTD1.js";
const skillMutations = "assets/v1/shared-m-1-Nm0kn4Ee.js";
const skillActions = "assets/v1/cfaabd194-B0CE4rOW.js";
const skillList = "assets/v1/c979ed9d0-C-llIJ0y.js";
const orgKey = "lastActiveOrg";
const alice = { orgUuid: "11111111-1111-4111-8111-111111111111", accountUuid: "alice" };
const bob = { orgUuid: "22222222-2222-4222-8222-222222222222", accountUuid: "bob" };
const original = (file) => fs.readFileSync(path.join(source, file));
const derive = (file) => deriveOfficialWebAccountModule(file, original(file)).toString("utf8");

test("the authenticated Web session scopes the original persisted bootstrap cache", () => {
  const window = { __claudexOfficialAccountContext: { ...alice, sessionMarker: "claudex:41:17" } };
  const resolve = vm.runInNewContext(
    section(derive(common), "function dP(", "function Sr(") + "; dP",
    { window, va: () => ({ lc: "lc", v3lc: "v3lc" }), Sr: Boolean,
      JG: (value) => ({ value, source: "cookie" }) },
  );
  const cookies = { get: () => "cookie-value" };
  assert.equal(resolve(cookies).value, "claudex:41:17");
  window.__claudexOfficialAccountContext = { ...bob, sessionMarker: "claudex:42:19" };
  assert.equal(resolve(cookies).value, "claudex:42:19");
  window.__claudexOfficialAccountContext = undefined;
  assert.equal(resolve(cookies).value, "cookie-value");
});
function section(text, from, to) {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start);
  return text.slice(start, end);
}

test("pinned Web account derivations apply only at their original anchors", () => {
  for (const file of [common, hint, eager, codeChrome, historyRows, layout, moveMenu, chatActionsMenu, moveDialog, compactInstructions, fullInstructions, codeQueries, codeComposer, codeControls, codeFilePanel, codeTerminal, codeListRoute, codeOnboardingGuard, coworkActions, coworkPermissions, coworkTaskMenu, imageTiles, skillLibrary, skillMutations, skillActions, skillList]) {
    const bytes = original(file);
    assert.notDeepEqual(deriveOfficialWebAccountModule(file, bytes), bytes);
    assert.throws(
      () => deriveOfficialWebAccountModule(file, Buffer.from("changed anchor")),
      /anchor mismatch/,
    );
  }
  assert.equal(deriveOfficialWebAccountModule("assets/other.js", Buffer.from("untouched")), undefined);
});

test("the original hosted Code form accepts the app-owned Workflow approval", () => {
  const code = derive(codeControls);
  const validator = vm.runInNewContext(
    [
      section(code, "function __claudexHostedCodeCursor(", "function __claudexCodeResumeHeaders("),
      section(code, "function Jv(", "function Yv("),
      section(code, "function Fy(", "async function Iy("),
      "Fy",
    ].join("\n"),
    {
      window: { __claudexOfficialAccountContext: alice },
      vc: String,
      Zt: String,
      Sc: (name) => /claude/i.test(name),
      sn: (schema) => schema != null,
      G: (schema) => typeof schema === "object",
      Gv: () => true,
      Kv: () => true,
      Gf: () => true,
      Iy: (_session, _request, serverName) => serverName,
    },
  );
  const session = "session_" + "a".repeat(32);
  const request = {
    serverName: "claudex_workflow",
    mode: "form",
    requestedSchema: { type: "object", properties: { decision: { type: "string" } } },
  };
  const event = { requestId: "synthetic-approval" };
  const surface = { drawsForms: () => true };
  assert.equal(validator(session, request, event, surface), "claudex_workflow");
  assert.notEqual(validator("local_other", request, event, surface), "claudex_workflow");
  assert.notEqual(validator(session, { ...request, serverName: "claude_external" }, event, surface), "claude_external");
});

test("the original Settings table reads persistent devices without changing the Cowork picker query", () => {
  const settings = derive("assets/v1/c79197f2b-BdxpRmPT.js");
  const queries = original(eager).toString("utf8");
  const stop = new Error("query captured");
  const reads = [];
  const realm = vm.createContext({
    J9: () => [], J1: () => true, K1: (_cache, _index, _key, value) => value,
    oe: () => ({}), a: () => "ltr", ne: () => ({}), t: (value) => [value], G: () => true,
    sR: "cowork_remote_device_directory", xa: 300000,
    P: (options) => { reads.push(options); throw stop; },
  });
  vm.runInContext(section(queries, "function HJ(", "\nfunction de("), realm);
  vm.runInContext(section(settings, "function Oe(", "\nfunction ke("), realm);
  vm.runInContext(section(settings, "function ze(", "\nfunction Be("), realm);
  const path = `/api/organizations/${alice.orgUuid}/cowork/remote_devices`;
  for (const render of [realm.Oe, realm.ze]) {
    assert.throws(() => render({}), (error) => error === stop);
    const { enabled, forRemoval } = reads.pop();
    assert.equal(enabled, true);
    assert.equal(realm.HJ(alice.orgUuid, forRemoval).path, path + "?for_removal=true");
  }
  assert.equal(realm.HJ(alice.orgUuid).path, path);
});

test("original Cowork permissions read the live snapshot without consuming transcript cursors", () => {
  const id = `session_${"a".repeat(32)}`;
  const completed = [
    { kind: "message", seq: 1, payload: { type: "assistant" } },
    { kind: "message", seq: 2, payload: { type: "result" } },
  ];
  const native = { kind: "permission_request", seq: 3, request: { requestId: "native" } };
  const tool = { kind: "permission_request", request: { requestId: "tool", toolUseId: "use", claudexCoworkApproval: true } };
  const url = { kind: "connect_request", request: { requestId: "url", connectAsk: {}, claudexCoworkApproval: true } };
  const seenSeqs = new Set([1, 2, 3]);
  const state = { logs: { [id]: {
    headSeq: 3, seenSeqs, events: [...completed, native],
    inFlightRespondToolUseIds: new Set(["use", "native"]),
    inFlightRespondRequestIdByToolUseId: new Map([["use", "tool"], ["native", "native"]]),
  } } };
  const actions = derive(coworkActions);
  const permissions = derive(coworkPermissions);
  const realm = vm.createContext({
    window: { __claudexOfficialAccountContext: alice },
    Fd: (state, id, patch) => ({ ...state.logs, [id]: { ...state.logs[id], ...patch } }),
    Yi: () => false, gP: () => false, jU: (payload) => payload.type === "user",
  });
  vm.runInContext(
    section(actions, "export function __claudexRunnerCowork(", "function __claudexCoworkProjectMove(").replace("export ", "") +
    section(permissions, "var r7 = new Set();", "var UO = Object.freeze([]);") + "var UO = [];",
    realm,
  );
  const opened = realm.__claudexApplyCoworkApprovals(state, id, [tool, url]);
  const pending = (log, hidden) => Array.from(realm.Ej(log.events, {}, hidden), ({ requestId }) => requestId);
  assert.deepEqual(pending(opened.logs[id]), ["native", "tool", "url"]);
  const reconnected = realm.__claudexApplyCoworkApprovals(opened, id, [tool, url]);
  assert.deepEqual(pending(reconnected.logs[id]), ["native", "tool", "url"]);
  const settled = realm.__claudexApplyCoworkApprovals(reconnected, id, []);
  assert.deepEqual(pending(settled.logs[id]), ["native"]);
  assert.deepEqual(Array.from(settled.logs[id].events), [...completed, native]);
  assert.equal(settled.logs[id].headSeq, 3);
  assert.equal(settled.logs[id].seenSeqs, seenSeqs);
  assert.deepEqual([...settled.logs[id].inFlightRespondToolUseIds], ["native"]);
});

test("the original Cowork URL card uses the pending Runner request to respond", async () => {
  const body = section(derive(coworkPermissionCards),
    "      if (e._rawRemoteRequest?.claudexCoworkApproval",
    "      if (e.connectAsk !== void 0)");
  const card = vm.runInNewContext(`(e) => {${body}}`, {
    URL, claudexElicitationLink: () => {}, S: (_component, props) => props,
  });
  const answers = [];
  const request = {
    toolUseId: "request-1",
    input: {},
    _rawRemoteRequest: { claudexCoworkApproval: true },
    connectAsk: { url: "https://example.com/link", serverName: "fixture", message: "Connect" },
    respond: (...args) => answers.push(args),
  };
  assert.equal(card({ ...request, _rawRemoteRequest: {} }), undefined);
  assert.equal(card({ ...request, connectAsk: { url: "javascript:alert(1)" } }), undefined);
  const props = card(request);
  assert.equal(props.ask.href, request.connectAsk.url);
  assert.equal(props.ask.host, "example.com");
  const settled = [];
  await props.decide("deny", undefined, { onAnswered: value => settled.push(value) });
  assert.deepEqual(answers, [["deny", {}]]);
  assert.deepEqual(settled, [true]);
});

test("the original detail menu opens the granted Web skill actions", () => {
  const source = derive(skillActions);
  const menu = section(source, "var vr = c((e) => {", "\nfunction yr(");
  const policy = section(source, "    T = t.wiggleEnabled ?? w,", "    O = vt(),");
  const rename = section(source, "    Nt = J2($, 75, jt, e)", "    Pt = Dt(T),");
  const callbacks = section(source, "    let { withheld: n, reason: r } = Et(K, Ie),", "      K2($, 177,").trim().slice(0, -1) + ");";
  const element = (type, props) => ({ type, ...props });
  const last = (...args) => args.at(-1);
  const context = vm.createContext({
    window: { __claudexOfficialAccountContext: {} },
    c: (fn) => fn, s: element, i: element, a: "fragment", f: { Item: "item", Popup: "menu", Trigger: "trigger" },
    gr: "item", J: "message", y: "button", hr: {}, dr: true, fr: false, pr: true,
    J9: () => [], I1: last, Z1: (...args) => args[2], Z2: (...args) => args[2],
    $e: () => ({}), O: () => ({}), Pt: () => false, yt: () => false, nt: () => false, et: () => false,
    Un: () => ({}), H: () => () => false, ne: () => ({ isAvailable: true }), le: (skill) => skill.canEdit,
    Jt: () => "Read-only", be() {}, ln: () => false,
    zn: () => () => false, se: () => false, At: () => ({}), ur() {}, Te: () => "Skill actions", ie: () => "Skill",
    Tr: true, Et: () => ({}), Fe() {},
  });
  for (let index = 0; index <= 5; index++) {
    context[`J${index}`] = () => true;
    context[`K${index}`] = last;
  }
  const render = vm.runInContext(`${section(derive(skillMutations), "function wD(", "\nfunction $i(")}
    const Se = wD;
    ${menu}
    (e, open, H = false) => {
      const $ = [], t = {}, w = false, ${policy} jt = le(e), ${rename} end = null;
      let Qn;
      const [K, Ie, Lt, Y, It, kn, Je, o] = [];
      const wn = () => open("Remove");
      const [U, sn, v, x] = [null, false, () => open("Duplicate"), () => open("Rename")];
      ${callbacks}
      return vr(Qn);
    }`, context);
  const children = (node) => [node, ...[node?.children].flat().filter(Boolean).flatMap(children)];
  const controls = (skill, open, dirty) => {
    const nodes = children(render(skill, open, dirty));
    return {
      trigger: nodes.find((node) => node?.type === "trigger").render,
      entries: Object.fromEntries(nodes.filter((node) => node?.type === "item").map((node) => [node.children.defaultMessage, node])),
    };
  };
  const own = { source: "custom", creatorType: "user", partitionBy: "account", canEdit: false, canRemove: false, claudexCanRenameDuplicate: true };
  const opened = [];
  const { trigger, entries } = controls(own, (action) => opened.push(action));
  assert.equal(trigger.disabled, false);
  entries.Rename.onClick();
  entries.Duplicate.onClick();
  assert.deepEqual(opened, ["Rename", "Duplicate"]);
  assert.equal(entries.Remove.disabled, true);
  assert.equal(controls(own, () => {}, true).entries.Rename, undefined);
  const removable = { ...own, claudexCanRenameDuplicate: false, canRemove: true };
  const remove = controls(removable, (action) => opened.push(action));
  assert.equal(remove.trigger.disabled, false);
  assert.equal(remove.entries.Remove.disabled, false);
  remove.entries.Remove.onClick();
  assert.deepEqual(opened, ["Rename", "Duplicate", "Remove"]);
  assert.equal(remove.entries.Rename, undefined);
  assert.equal(remove.entries.Duplicate, undefined);
  assert.equal(controls(removable, () => {}, true).entries.Remove, undefined);
  for (const claudexCanRenameDuplicate of [undefined, false, "true"]) {
    const { entries } = controls({ canEdit: true, claudexCanRenameDuplicate });
    assert.equal(entries.Rename, undefined);
    assert.equal(entries.Duplicate, undefined);
    assert.equal(entries.Remove.disabled, true);
  }
});

test("the original list menu offers Remove for an explicitly removable Web skill", () => {
  const last = (...args) => args.at(-1);
  const context = vm.createContext({
    window: { __claudexOfficialAccountContext: alice },
    J9: () => [], J2: () => true, J3: () => true, J4: () => true, K2: last, K3: last, K4: last,
    Q: () => ({}), Gt: (_intl, reason) => reason,
    s: (_type, props) => props, wt: "original-row-menu",
  });
  const render = vm.runInContext(`
    ${section(derive(skillMutations), "function wD(", "\nfunction $i(")}
    const P = wD;
    ${section(derive(skillList), "function ri(", "\nfunction ii(")}
    ri
  `, context);
  const requested = [];
  const actions = {
    removeAvailable: false, shareMode: () => null, onRemove: (skill) => requested.push(skill.skillId),
  };
  const skill = { skillId: "own", creatorType: "user", partitionBy: "account", canRemove: true };
  render({ skill, actions }).remove.onRemove();
  assert.deepEqual(requested, ["own"]);
  for (const canRemove of [undefined, false, "true"]) {
    assert.equal(render({ skill: { ...skill, canRemove }, actions }).remove.onRemove, undefined);
  }
  context.window.__claudexOfficialAccountContext = undefined;
  assert.equal(render({ skill, actions }).remove.onRemove, undefined);
});

test("the original mutation and library parsers retain Web skill actions after a write", () => {
  const source = derive(skillMutations);
  const library = derive(skillLibrary);
  const context = vm.createContext({
    iR: () => false, xy: () => null, Am: () => null, uv: () => false, R0: () => null,
    J: () => null, te: () => null, re: () => null, S: (item) => item.skill.skill_id,
    j: (item) => item.display_name, ne: (item) => item.skill.partition_by,
    m: () => false, y: () => null, P: () => false, x: () => [], F: () => null, p: () => null, M: () => null,
  });
  const { YJ, ar, Y, RP } = vm.runInContext([
    section(source, "function _W(", "\nfunction wD("),
    section(source, "function YJ(", "\nvar wZ ="),
    section(source, "function ar(", "\nfunction TJ("),
    section(library, "function Y(", "\nfunction X("),
    "({ YJ, ar, Y, RP })",
  ].join("\n"), context);
  const skill = {
    id: "new-id", name: "new-name", display_name: "New Name", source: "user",
    creator_type: "user", partition_by: "account", enabled: false,
  };
  const installed = {
    claudex_read_only: true, claudex_can_rename_duplicate: true, claudex_can_edit_contents: true,
    can_edit: false, can_remove: true, can_toggle: false,
  };
  const cached = ar(YJ({ skill: { ...skill, viewer: { installed } }, validation_errors: [] }).skill);
  const normalized = Y(cached);
  assert.equal(normalized.skillId, "new-id");
  assert.equal(normalized.displayName, "New Name");
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.canEdit, false);
  assert.equal(normalized.canRemove, true);
  assert.equal(normalized.canToggle, false);
  assert.equal(normalized.claudexCanRenameDuplicate, true);
  assert.equal(cached.viewer.installed.claudex_read_only, true);
  assert.equal(cached.viewer.installed.claudex_can_edit_contents, true);
  const protectedSkill = ar(RP({ ...skill, viewer: { installed: { ...installed, can_remove: false } } }));
  assert.equal(Y(protectedSkill).canRemove, false);
  const upstream = ar(RP(skill));
  assert.equal(upstream.viewer.installed.can_edit, true);
  assert.equal(upstream.viewer.installed.can_remove, true);
  assert.equal(upstream.viewer.installed.can_toggle, true);
  assert.equal(Y(upstream).claudexCanRenameDuplicate, false);
});

test("workspace diff bypasses the CLI version gate only for the owned Runner capability", () => {
  const realm = vm.createContext({
    __claudexWebCodeNavigation: (auth) => auth.owned === true,
  });
  vm.runInContext(section(derive(codeComposer), "function __claudexWebWorkspaceDiff(", "function Sr("), realm);
  const check = (owned, capability) => realm.__claudexWebWorkspaceDiff({
    owned,
    account: { claudex_web_code: capability },
  });
  assert.equal(check(true, { workspace_diff_available: true }), true);
  assert.equal(check(true, {}), false);
  assert.equal(check(false, { workspace_diff_available: true }), false);
});

test("the original image tile fetches owned previews and releases their object URLs", async () => {
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const src = `/api/${alice.orgUuid}/files/${id}/preview`;
  const owned = { src, fullSrc: `/api/organizations/${alice.orgUuid}/files/${id}/contents` };
  const foreign = { src: `/api/${bob.orgUuid}/files/${id}/preview` };
  const inline = { src: "data:image/png;base64,AQID" };
  const requests = [];
  const revoked = [];
  let cleanup;
  let state;
  let changed;
  const completed = new Promise((resolve) => { changed = resolve; });
  const realm = vm.createContext({
    window: { __claudexOfficialAccountContext: alice },
    images: [owned, foreign, inline],
    Na: "data:image/gif;base64,placeholder",
    t: () => [state, (value) => { state = value; changed(); }],
    m: (effect) => { cleanup ??= effect(); },
    AbortController,
    fetch: async (path) => {
      requests.push(path);
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
    },
    URL: {
      createObjectURL: () => "blob:owned-image",
      revokeObjectURL: (url) => revoked.push(url),
    },
  });
  vm.runInContext(section(derive(imageTiles), "function useClaudexHistoryImages(", "function Pi("), realm);
  const render = () => vm.runInContext("useClaudexHistoryImages(images)", realm);
  assert.equal(render()[0].src, realm.Na);
  await completed;
  const rendered = render();
  assert.equal(rendered[0].src, "blob:owned-image");
  assert.equal(rendered[0].fullSrc, "blob:owned-image");
  assert.equal(rendered[1], foreign);
  assert.equal(rendered[2], inline);
  assert.deepEqual(requests, [src]);
  cleanup();
  assert.deepEqual(revoked, ["blob:owned-image"]);
});

test("unified Web history keeps the original task row and drops only its matching chat alias", () => {
  const task = (id) => ({ ref: { kind: "cowork", id }, source: { kind: "cowork", data: { title: "Same title" } } });
  const chat = (id, session) => ({ ref: { kind: "chat", id }, source: { kind: "chat", data: { title: "Same title", claudex_cowork_session: session } } });
  const rows = [chat("chat"), chat("alias", "remote"), task("remote"), chat("fallback", "not-loaded")];
  const merge = section(derive(historyRows), '      if (typeof window < "u" && window.__claudexOfficialAccountContext) {\n        const coworkIds', '      let i = Object.values(fe);');
  for (const [window, expected] of [[{ __claudexOfficialAccountContext: alice }, [rows[0], rows[2], rows[3]]], [{}, rows]]) {
    assert.deepEqual(Array.from(vm.runInNewContext(`let r = rows; ${merge} r`, { window, rows })), expected);
  }
});

test("the original Cowork set-project hook checks the authenticated account and writes the stock PATCH", async () => {
  const id = "cse_" + "a".repeat(32);
  const source = derive(coworkActions);
  const auth = {
    uuid: alice.accountUuid,
    claudex_web_cowork_history: { account_uuid: alice.accountUuid, organization_uuid: alice.orgUuid, project_move: true },
  };
  const requests = [];
  let status = 204;
  const realm = vm.createContext({
    window: { __claudexOfficialAccountContext: alice },
    id, auth, org: alice.orgUuid,
    xT: class extends Error { constructor(_name, status) { super(); this.status = status; } },
    ZR: (error) => error,
    Ew: () => {},
    rawFetch: async (path, options) => {
      requests.push({ path, ...options, body: JSON.parse(options.body) });
      return { ok: status === 204, status };
    },
  });
  const hooks = section(source, "export function __claudexRunnerCowork(", "function ja(").replace("export ", "");
  const action = section(source, "async function Vq(", "async function WY(");
  vm.runInContext(hooks + action, realm);
  assert.equal(vm.runInContext("__claudexCoworkProjectMove(auth, org) && __claudexRunnerCowork(id)", realm), true);
  assert.equal(vm.runInContext("__claudexCoworkProjectMove(auth, 'other-org')", realm), false);
  assert.equal(vm.runInContext("__claudexCoworkProjectMove({ uuid: auth.uuid }, org)", realm), false);
  await vm.runInContext("Vq({ rawFetch, orgUuid: org }, id, 'project')", realm);
  assert.deepEqual(requests, [{
    path: `/api/organizations/${alice.orgUuid}/cowork/sessions/${id}/project`,
    method: "PATCH", body: { project_uuid: "project" },
  }]);
  status = 409;
  assert.equal(await vm.runInContext("Vq({ rawFetch, orgUuid: org }, id, null).catch(Y_)", realm), "Couldn't move to project");
  assert.deepEqual(requests[1].body, { project_uuid: null });
});

test("the original Code form gates admit an owned Runner session", () => {
  const id = `session_${"a".repeat(32)}`;
  const source = section(derive(codeControls), "function tD(", "function iD(");
  const check = (overrides = {}) => vm.runInNewContext(`${source}\n[nD(id), rD(id)]`, {
    id,
    window: { __claudexOfficialAccountContext: alice },
    GE: new Set(), KE: new Set([id]), WE: new Set(), Iw: new Set(),
    $E: () => true, Rv: () => false, Zv: () => false,
    ...overrides,
  });
  assert.deepEqual(Array.from(check()), [true, true]);
  assert.deepEqual(Array.from(check({ window: {} })), [false, false]);
  assert.deepEqual(Array.from(check({ Iw: new Set([id]) })), [false, false]);
  assert.deepEqual(Array.from(check({ $E: () => false })), [false, false]);
  assert.deepEqual(Array.from(check({ window: {}, KE: new Set(), GE: new Set([id]), Rv: () => true })), [true, false]);
});

test("the hosted Code client keeps its history and live event anchors across fresh dials", () => {
  const source = derive(codeControls);
  const id = `session_${"a".repeat(32)}`;
  const first = `evt_${"b".repeat(64)}`;
  const next = `evt_${"c".repeat(64)}`;
  const dial = section(source, "              let Ne = o.dial(z.signal),", "              (kE(");
  const observed = [];
  const realm = vm.createContext({
    id,
    window: { __claudexOfficialAccountContext: alice },
    Ao: (row) => row.ccr_event?.sequence_num,
    uo: () => false, $t: () => false,
    Ss: (_id, sequence) => ({ sequence }),
    z: new AbortController(),
    clearTimeout,
    K_: () => ({}), x: {},
    m: ({ sse }) => sse, b: true, Ae: {},
    vs: () => undefined,
    observe: (event) => observed.push(event.kind),
  });
  const client = vm.runInContext(`(() => {
    ${section(source, "var B_ =", "function G_(")}
    ${section(source, "function q_(", "var uv =")}
    const o = lv(id, observe);
    const e = id;
    return {
      readHistory(sequence_num, event_id) {
        X_(e, [{ type: "assistant", ccr_event: { sequence_num, event_id, source: "worker" } }]);
      },
      consumeLive(sequence_num, event_id) {
        const api = { getSseLastSequenceNum: () => sequence_num, getCcrEvent: () => ({ sequence_num, event_id, source: "worker" }) };
        o.stampFrame(api, {}, { type: "assistant" });
      },
      reset() { o.dial(z.signal).onCatchUpTruncated(true); },
      dial() {
        const resume = J_.get(e);
        const he = resume?.sequence;
        ${dial}
        return K;
      },
    };
  })()`, realm);
  client.readHistory(8, first);
  assert.equal(client.dial().sequence, 8);
  assert.equal(client.dial().headers["Last-Event-ID"], `8:${first}`);
  client.consumeLive(9, next);
  assert.equal(client.dial().headers["Last-Event-ID"], `9:${next}`);
  client.reset();
  assert.deepEqual(observed, ["cleared"]);
  assert.equal(client.dial().sequence, 0);
  assert.equal(client.dial().headers["Last-Event-ID"], "0");
  realm.window = {};
  client.readHistory(3, first);
  assert.equal(client.dial().sequence, 3);
  assert.equal(client.dial().headers["Last-Event-ID"], undefined);
});

test("the original terminal uses the hosted bridge only for owned Cloud Code", () => {
  const id = `session_${"a".repeat(32)}`;
  const capability = {
    version: 1, available: true, account_uuid: alice.accountUuid, organization_uuid: alice.orgUuid, terminal_available: true,
  };
  const hosted = {};
  const stock = {};
  const local = {};
  const stopped = [];
  const codeTerminalContext = {
    forSession: (sessionId) => sessionId === id ? hosted : undefined,
    stop: (sessionId, key) => stopped.push([sessionId, key]),
  };
  const choose = ({ frame = true, authorized = true, owned = true, terminal = true, archived = false, vendor = false, type = "remote", withheld = false } = {}) => {
    const source = derive(codeControls);
    const realm = vm.createContext({
      session: { type, id },
      window: frame ? { __claudexOfficialAccountContext: { ...alice, codeTerminal: codeTerminalContext } } : {},
      Lr: () => codeAuth(authorized ? { ...capability, terminal_available: terminal } : undefined),
      J9: () => [], J1: () => true, K1: (_cache, _slot, _input, value) => value,
      pt: () => true, Ke: () => true, Je: () => true, Iu: () => true,
      nR: () => vm.runInContext("ZL(meta)", realm), Lu: (value) => value,
      meta: { isShared: !owned, isArchived: archived },
      B: () => vendor, oB: () => () => ({ withheld }),
      Ju: () => stock, qu: local,
    });
    return vm.runInContext(`${codeGate()}${section(source, "function ZL(", "var QL =")}${section(source, "function iR(", "function aR(")}iR(session)`, realm);
  };
  assert.equal(choose(), hosted);
  assert.equal(choose({ owned: false }), undefined);
  assert.equal(choose({ withheld: true }), undefined);
  assert.equal(choose({ authorized: false }), undefined);
  assert.equal(choose({ terminal: false, vendor: true }), undefined);
  assert.equal(choose({ archived: true, vendor: true }), undefined);
  assert.equal(choose({ frame: false, vendor: true }), stock);
  assert.equal(choose({ frame: false, archived: true, vendor: true }), stock);
  assert.equal(choose({ type: "local" }), local);
  vm.runInNewContext(`${section(derive(codeTerminal), "function Zt(", "var Qt =")}Zt(id, id + "::2")`, {
    id, Wt: undefined, Yt: new Map(), window: { __claudexOfficialAccountContext: { codeTerminal: codeTerminalContext } },
  });
  assert.deepEqual(stopped, [[id, id + "::2"]]);
});

test("the original Runner Code Stop sends its observed turn and does not replay a failure", async () => {
  const source = section(derive(codeControls), "    async stop(e, t) {", "    async getTaskOutput(").trim().slice(0, -1);
  const calls = [];
  const expected = { turnId: "turn", turnCreatedAt: 2, conversationCreatedAt: 1, threadId: "thread" };
  let response = { ok: false, status: 409 };
  const { stop } = vm.runInNewContext(`({${source}})`, {
    Pe: async (id, events, options) => {
      calls.push(JSON.parse(JSON.stringify({ id, events, options })));
      return response;
    },
    mo: () => true,
    f: () => assert.fail("Runner Stop must not obtain a replay"),
    dA: 0,
    ge: () => "fixture",
    ko: () => false,
    jT: new Map(),
    p: (error) => error,
    fs: class extends Error {},
  });
  await assert.rejects(stop("session_fixture", {
    runner: true,
    turnTarget: expected,
    queuedMessageUuid: "selected",
  }));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { replayable: false });
  assert.deepEqual(calls[0].events[0].request, {
    subtype: "interrupt",
    queued_message_uuid: "selected",
    turn_target: expected,
  });
  response = { ok: true, json: async () => ({ events: [], cancelled_start: "starting" }) };
  assert.equal(await stop("session_fixture", { runner: true, startingInputUuid: "starting" }), "starting");
  assert.deepEqual(calls[1].events[0].request, {
    subtype: "interrupt",
    starting_input_uuid: "starting",
  });
});

test("the original cloud transport uses hosted files only for the displayed Code session", async () => {
  const id = "session_" + "a".repeat(32);
  const alias = id.replace("session_", "cse_");
  const other = "session_" + "b".repeat(32);
  const requests = [];
  const bridge = {
    matches: (session) => session === id || session === alias,
    list: async (session, path) => {
      requests.push(["list", session, path]);
      return [{ name: "设计", isDirectory: true }];
    },
    read: async (session, path) => {
      requests.push(["read", session, path]);
      return path.endsWith(".txt")
        ? { status: "ok", file: { contents: "真实内容" } }
        : { status: "notFound" };
    },
  };
  const source = derive(codeControls);
  const realm = vm.createContext({
    window: { __claudexCodeWorkspace: bridge },
    id, alias, other, bridge,
    sC: (path) => !path.includes(".."), pE: () => false, dD: () => true,
    reason: [],
  });
  vm.runInContext(`
    ${section(source, "function __claudexHostedCodeWorkspace(", "export { __claudexHostedCodeWorkspace")}
    ${section(source, "  async function at(e, t, n)", "  async function ot(e, t, n)")}
    ${section(source, "  async function st(e, t, n)", "  async function ct(e, t, n, r, i)")}
  `, realm);
  const run = (expression) => vm.runInContext(expression, realm);
  assert.equal(run("__claudexHostedCodeWorkspace(alias)"), bridge);
  assert.equal(run("__claudexHostedCodeWorkspace(other)"), null);
  const listed = await run('at(id, "")');
  assert.equal(listed.root, "/workspace");
  assert.equal(listed.entries[0].name, "设计");
  assert.equal((await run('at(id, "../other")')).status, "denied");
  assert.equal((await run('at(other, "")')).status, "unsupported");
  assert.equal((await run('st(alias, "/workspace/设计/说明.txt")')).contents, "真实内容");
  assert.equal(await run('st(id, "/workspace/missing", {onNullReason: (value) => reason.push(value)})'), null);
  assert.equal(run("reason[0]"), "cli_not_found");
  assert.deepEqual(requests, [
    ["list", id, ""],
    ["read", alias, "/workspace/设计/说明.txt"],
    ["read", id, "/workspace/missing"],
  ]);
});

test("the original file panel receives hosted image bytes and document bytes in its preview formats", async () => {
  const source = derive(codeFilePanel);
  const branch = section(source, "        if (hostedWorkspace) {", "        if (R !== null && Jt !== void 0) {");
  const calls = [];
  const read = (r, hostedDocument, download) => vm.runInNewContext(`
    (async () => {
      const t = { aborted: false };
      const n = [];
      ${branch}
    })()
  `, {
    r, hostedDocument,
    hostedWorkspace: { download: async (session, path) => {
      calls.push([session, path]);
      return download();
    } },
    I: { id: "session_" + "a".repeat(32) },
    nn: () => "image/png", __claudexWorkspaceBytes: (content) => Uint8Array.from(Buffer.from(content, "base64")),
    ed: (_previous, bytes, mime) => new Blob([bytes], { type: mime }),
    gn: { getQueryData: () => null },
  });
  const content = Buffer.from([0, 1, 254, 255]).toString("base64");
  const image = await read("/workspace/preview.png", null, async () => ({ content }));
  assert.equal(image.type, "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from([0, 1, 254, 255]));
  const document = await read("/workspace/report.pdf", "application/pdf", async () => ({ content }));
  assert.ok(document instanceof ArrayBuffer);
  assert.deepEqual(Buffer.from(document), Buffer.from([0, 1, 254, 255]));
  const failed = await read("/workspace/vanished.png", null, async () => { throw Error("gone"); });
  assert.equal(failed.unavailable, "load_failed");
  assert.deepEqual(calls.map(([, path]) => path), ["/workspace/preview.png", "/workspace/report.pdf", "/workspace/vanished.png"]);
});

test("the original Cloud Code detail normalizer keeps the Runner's connector selection and workspace", () => {
  const config = { mcpServers: { selected: { type: "http", url: "https://fixture.invalid/mcp", headers: { "X-MCP-Server-ID": "selected" } } } };
  const key = "a".repeat(32);
  const cwd = "/fixture/workspace/code/session";
  const session = { id: "cse_" + key, config: { model: "code" }, session_context: { mcp_config: config, cwd, private: true } };
  const source = derive(codeQueries);
  const normalize = (result, window) => vm.runInNewContext(`
    ${section(source, "function oC(", "var dx =")}
    ${section(source, "function _o(", "function BX(")}
    ${section(source, "function FW(", "function pa(")}
    FW("org", "session_example").transform(result)
  `, {
    window, result, JM: {}, eE: () => [], UU: (id) => id,
    vH: (response) => response, wG: (id) => id.replace(/^cse_/, "session_"),
    gm: () => "idle", bG: () => "", gS: (value) => value, _K: () => false, O5: () => false, nO: () => undefined,
  });
  const selected = normalize({ session }, { __claudexOfficialAccountContext: alice });
  assert.equal(selected.id, "session_" + key);
  assert.equal(selected.session_context.model, "code");
  assert.equal(selected.session_context.mcp_config, config);
  assert.equal(selected.session_context.cwd, cwd);
  assert.equal(selected.session_context.private, undefined);
  assert.equal(normalize({ session }, {}).session_context.mcp_config, undefined);
  assert.equal(normalize({ session }, {}).session_context.cwd, undefined);
  assert.equal(normalize({ session: { id: "session_" + key } }, { __claudexOfficialAccountContext: alice }).session_context.mcp_config, undefined);
  assert.equal(normalize({ session: { ...session, id: "session_vendor" } }, { __claudexOfficialAccountContext: alice }).session_context.mcp_config, undefined);
  assert.equal(normalize({ shared: { session } }, { __claudexOfficialAccountContext: alice }).session.session_context.mcp_config, undefined);
  assert.equal(normalize({ shared: { session } }, { __claudexOfficialAccountContext: alice }).session.session_context.cwd, undefined);
});

test("the original Runner Code menu selects connector UUIDs and settles overlapping mutations", async () => {
  const composer = derive(codeComposer);
  const queries = derive(codeQueries);
  const sessionId = "session_" + "a".repeat(32);
  const key = ["code-details", { orgUuid: alice.orgUuid, sessionId }];
  let cached = { type: "internal_session", session_context: { mcp_config: { mcpServers: {} } } };
  const pending = [];
  const invalidated = [];
  const queryClient = {
    getQueryData: () => cached,
    setQueryData: (_key, update) => (cached = typeof update === "function" ? update(cached) : update),
    invalidateQueries: async (query) => invalidated.push(JSON.parse(JSON.stringify(query))),
  };
  const menu = (window, vendorMutation) => vm.runInNewContext(`
    ${section(composer, "function Hr(", "var Q = je(")}
    ${section(queries, "function zK(", "function xQ(")}
    function Fe() {
      return { mutate: vendorMutation, mutateAsync: (input) => submit(zK(input)) };
    }
    Ur(sessionId, true)
  `, {
    window, sessionId, vendorMutation,
    b: key[0], J: () => true, J9: () => [], J1: () => true, J2: () => true, J5: () => true,
    K1: (...args) => args.at(-1), K2: (...args) => args.at(-1),
    I1: (_slots, _index, value) => value, I5: (_slots, _index, value) => value,
    Z1: (_slots, _index, value) => value,
    Re: () => ({ data: cached }), Ge: (data) => data, Ke: () => false, lt: () => false,
    ce: () => ({ activeOrganization: { uuid: alice.orgUuid } }), P: () => queryClient,
    submit: (body) => new Promise((resolve, reject) => pending.push({ body: JSON.parse(JSON.stringify(body)), resolve, reject })),
  });
  const { toggleSessionConnector } = menu({ __claudexOfficialAccountContext: alice }, () => assert.fail("Runner mutation used vendor callbacks"));
  const first = { name: "Shared", uuid: "first-id", url: "https://first.invalid/mcp" };
  const second = { ...first, uuid: "second-id", url: "https://second.invalid/mcp" };
  const selfNamed = { name: "self-id", uuid: "self-id", url: "https://self.invalid/mcp" };
  const selection = () => Object.keys(cached.session_context.mcp_config.mcpServers);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  toggleSessionConnector(first, true);
  toggleSessionConnector(second, true);
  const row = (server) => ({ name: server.uuid, type: "http", url: server.url, headers: { "X-MCP-Server-ID": server.uuid } });
  assert.deepEqual(pending[0].body, { mcp_servers: [row(first)] });
  assert.deepEqual(pending[1].body, { mcp_servers: [row(first), row(second)] });
  pending[0].reject(Error("First request failed"));
  await settle();
  assert.deepEqual(selection(), [first.uuid, second.uuid]);
  pending[1].resolve();
  await settle();
  toggleSessionConnector(selfNamed, true);
  assert.deepEqual(selection(), [first.uuid, second.uuid, selfNamed.uuid]);
  pending[2].reject(Error("Latest request failed"));
  await settle();
  assert.deepEqual(selection(), [first.uuid, second.uuid]);
  assert.deepEqual(invalidated, Array(3).fill({ queryKey: key, exact: true }));

  const vendor = menu({}, (input, { onError }) => {
    assert.deepEqual(Object.keys(input.mcpConfig.mcpServers), [first.uuid, second.uuid, "Vendor"]);
    onError();
  });
  vendor.toggleSessionConnector({ ...selfNamed, name: "Vendor" }, true);
  assert.deepEqual(selection(), [first.uuid, second.uuid]);
});

const codeGrant = {
  version: 1,
  account_uuid: alice.accountUuid,
  organization_uuid: alice.orgUuid,
  available: true,
};
const codeGate = () => section(derive(eager), "export function __claudexWebCodeNavigation(", "var nX =")
  .replace(/^export /, "");
const codeAuth = (capability, organization = alice.orgUuid) => ({
  account: { uuid: alice.accountUuid, claudex_web_code: capability },
  activeOrganization: { uuid: organization },
});

test("the original Web Code entry requires the authenticated Runner capability for this frame", () => {
  const decision = section(derive(eager), "  Ul = () => {", "  av = () => {")
    .trimEnd().replace(/,$/, ";");
  const decide = (capability, frame = alice, organization = alice.orgUuid, vendor = false) =>
    vm.runInNewContext(`${codeGate()} const ${decision} Ul();`, {
      window: { __claudexOfficialAccountContext: frame },
      LO: () => codeAuth(capability, organization),
      l9: () => vendor,
      aO: () => vendor,
    });
  assert.equal(decide(codeGrant), true);
  assert.equal(decide(undefined), false);
  assert.equal(decide({ ...codeGrant, available: false }), false);
  assert.equal(decide({ ...codeGrant, version: 2 }), false);
  assert.equal(decide({ ...codeGrant, account_uuid: bob.accountUuid }), false);
  assert.equal(decide(codeGrant, bob), false);
  assert.equal(decide(codeGrant, alice, bob.orgUuid), false);
  assert.equal(decide(undefined, bob, bob.orgUuid, true), true);
});

test("a stale no-Code-plan marker cannot suppress the Runner history feed", () => {
  const name = "spa:sidebarNoCodePlan";
  const run = (source, capability, organization = alice.orgUuid, paid = false) => {
    const storage = new Map([[name, organization]]);
    const show = vm.runInNewContext(`
      ${codeGate()}
      const Ii = ${JSON.stringify(name)};
      ${section(source, "function Yu(", "function q5(")}
      Yu(false);
    `, {
      window: { __claudexOfficialAccountContext: alice },
      E_: () => codeAuth(capability, organization),
      W1: () => paid,
      J9: () => [],
      J3: () => true,
      K3: (...args) => args.at(-1),
      K4: (...args) => args.at(-1),
      Zt: (initialize) => [initialize(), () => {}],
      Gw: (effect) => effect(),
      nT: () => organization,
      qB: () => true,
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      },
    });
    return [show, storage.has(name)];
  };
  const unmodified = original(codeChrome).toString("utf8");
  assert.deepEqual(run(unmodified, codeGrant), [false, true]);
  assert.deepEqual(run(derive(codeChrome), codeGrant), [true, false]);
  assert.deepEqual(run(derive(codeChrome), undefined), [false, true]);
  assert.deepEqual(run(derive(codeChrome), codeGrant, bob.orgUuid), [false, true]);
  assert.deepEqual(run(derive(codeChrome), undefined, alice.orgUuid, true), [true, false]);
});

test("Web preserves the original sidebar layout decision", () => {
  const originalDecision = section(original(codeChrome).toString("utf8"), "    W = (j && !L) || B,", "    Y =");
  assert.ok(derive(codeChrome).includes(originalDecision));
  assert.doesNotMatch(derive(codeChrome), /runnerCodeSwitcher/);
});

test("the original project rails grant only the Instructions editor", () => {
  const render = (hasGrant, view, knowledgePermission = false) => {
    const element = (type, props) => ({ type, props });
    const symbols = ["N", "b", "u", "H", "a", "jt", "Mt", "j", "I", "Z", "Pt", "Kt", "Jt", "kt"];
    const realm = vm.createContext({
      ...Object.fromEntries(symbols.map(name => [name, name])),
      J9: () => [], J0: () => true, J1: () => true, J2: () => true, J3: () => true, J4: () => true,
      K0: (...args) => args.at(-1), K1: (...args) => args.at(-1), K2: (...args) => args.at(-1),
      K3: (...args) => args.at(-1), K4: (...args) => args.at(-1), I1: (...args) => args.at(-2),
      h: element, s: element, i: element,
      a: element,
      x: () => ({ formatMessage: ({ defaultMessage }) => defaultMessage }),
      Q: () => ({ formatMessage: ({ defaultMessage }) => defaultMessage }),
      n: () => [view, () => {}],
      props: {
        project: { uuid: "fixture", prompt_template: "Saved", claudex_can_edit_instructions: hasGrant },
        canEditKnowledgeBase: knowledgePermission,
      },
    });
    return vm.runInContext(`(() => {
      ${section(derive(compactInstructions), "function me(e)", "function K(e)")}
      ${section(derive(fullInstructions), "function ji(e)", "var Mi =")}
      return [me(props), ji(props)];
    })()`, realm);
  };
  const find = (element, type) => {
    if (element?.type === type) return element.props;
    return [element?.props?.children].flat().map(child => child && find(child, type)).find(Boolean);
  };
  const [compact, full] = render(true, "instructions");
  assert.equal(find(compact, "H").viewOnly, false);
  assert.equal(find(full, "Jt").viewOnly, false);
  assert.equal(find(full, "Jt").hideRecommendedTools, true);
  assert.equal(find(full, "Kt").canEditKnowledgeBase, false);
  assert.equal(find(render(true, "tools")[1], "Jt").viewOnly, true);
  assert.equal(find(render(false, "instructions")[0], "H").viewOnly, true);
  assert.equal(find(render(false, "instructions")[1], "Jt").viewOnly, true);
  assert.equal(find(render(false, "instructions", true)[1], "Jt").hideRecommendedTools, false);
});

test("original move pickers accept move-only targets while project creation checks retain their permission", () => {
  const originalCreateCheck = section(original(projectQueries).toString("utf8"), "function bD(e)", "function Az(");
  const readOnly = { uuid: "read", permissions: ["chat_project:chat:view"] };
  const movable = { ...readOnly, uuid: "move", claudex_can_move_conversation: true };
  const create = { ...readOnly, permissions: ["chat_project:chat:create"] };
  const harmony = { ...movable, is_harmony_project: true };
  const realm = vm.createContext({
    i: "current", n: "current", c: "current", A: [readOnly],
    $: [],
    $u: { ConversationCreate: "chat_project:chat:create" },
    J1: () => true,
    J2: () => true,
    K1: (...args) => args.at(-1),
    K2: (...args) => args.at(-1),
  });
  const moveTargets = vm.runInContext(`(() => {
    ${originalCreateCheck}
    const oe = bD, Ge = bD;
    ${section(derive(moveMenu), "    x = J1($, 4, i)", "\n    S =").trim().replace(/,$/, ";").replace(/^x =/, "const x =")}
    ${section(derive(chatActionsMenu), "      let r = J1($, 14, n)", "\n      ((t = e.filter(r))")}
    ${section(derive(chatActionsMenu), "    let e = J2($, 54, A, n)", "\n      t = N.projects.filter(e)").trimEnd().replace(/,$/, ";")}
    const ${section(derive(moveDialog), "N = J1($, 15, c)", "\n    P =").trimEnd().replace(/,$/, ";")}
    return { move: [x, r, e, N], create: bD };
  })()`, realm);
  for (const accepts of moveTargets.move) {
    assert.equal(accepts(readOnly), false);
    assert.equal(accepts(movable), true);
    assert.equal(accepts(harmony), false);
  }
  assert.equal(moveTargets.create(movable), false);
  assert.equal(moveTargets.create(create), true);
});

test("the original sidebar and header use the Web layout only in the authenticated host frame", () => {
  const layoutCode = section(derive(layout), "function N4(e)", "function FQ(e)");
  const policyCode = section(original(framePolicy).toString("utf8"), "function jV(e)", "var NV =");
  function layoutPolicy({ account, iframe, incognito = false, routeAllowsFrame = true }) {
    const realm = vm.createContext({
      window: { __claudexOfficialAccountContext: account },
      J9: () => [],
      J2: () => true,
      J3: () => true,
      J5: () => true,
      K2: (...args) => args.at(-1),
      K3: (...args) => args.at(-1),
      K5: (...args) => args.at(-1),
      tT: (type, props) => ({ type, props }),
      UK: (type, props) => ({ type, props }),
      $t: (select) => select({ isInIframe: iframe }),
      wS: () => ({ incognitoModeEnabled: incognito }),
      fq: () => false,
      VX: () => ({ resolvedMode: "light" }),
      Vm: () => routeAllowsFrame,
      TI: (select) => select({ active: false }),
      ...Object.fromEntries(["xF", "v_", "$9", "X5", "af", "rR", "FQ", "V1"].map((name) => [name, name])),
    });
    return vm.runInContext(`(() => {
      ${layoutCode}
      ${policyCode}
      const header = N4({ children: null }).props.children.props;
      const sidebar = header.children.props.children.props.children.props.children.props.children[1].props;
      return jV(header) && jV(sidebar);
    })()`, realm);
  }
  assert.equal(layoutPolicy({ iframe: true, account: alice }), true);
  assert.equal(layoutPolicy({ iframe: true }), false);
  assert.equal(layoutPolicy({ iframe: false }), true);
  assert.equal(layoutPolicy({ iframe: true, account: alice, incognito: true }), false);
  assert.equal(layoutPolicy({ iframe: true, account: alice, routeAllowsFrame: false }), false);
});

test("original readers and cookie subscriptions keep each Web document on its own organization", (t) => {
  const cookieJar = new CookieJar();
  const sharedHints = new Map([["__qk_hint_account_uuid", "stale"]]);
  const commonCode = section(derive(common), "function __claudexWebChatOrganization(", "\n  VG = (e) =>").replace(/,$/, ";");
  const rawCode = section(derive(eager), "function nq(e)", "function Qx()");
  const hintCode = section(derive(hint), "function vk(e)", "function f7()");
  const open = (context) => {
    const dom = new JSDOM("", { url: "https://fixture.invalid/new", cookieJar });
    t.after(() => dom.window.close());
    const changes = new Set();
    const cookieStore = {
      addEventListener: (_name, callback) => changes.add(callback),
      removeEventListener: (_name, callback) => changes.delete(callback),
    };
    const window = {
      __claudexOfficialAccountContext: context,
      location: dom.window.location,
      cookieStore,
      localStorage: {
        getItem: (key) => sharedHints.get(key),
        setItem: (key, value) => sharedHints.set(key, value),
      },
    };
    const realm = vm.createContext({
      window,
      document: dom.window.document,
      P0: { LAST_ACTIVE_ORG: orgKey },
      ag: () => true,
      eK: () => null,
      ba: (value) => typeof value === "string" && value.length === 36,
      CT: (initialize) => {
        let state = initialize();
        return { setState: (update) => { state = update(state); }, getState: () => state };
      },
    });
    // Keep the modules' same-named private helpers in their own scopes.
    const api = vm.runInContext(`(() => { ${commonCode}; return {Wa, RV, pJ}; })()`, realm);
    const raw = vm.runInContext(`(() => { ${rawCode}; return kZ; })()`, realm);
    const hints = vm.runInContext(`(() => { ${hintCode}; return {R2, es}; })()`, realm);
    return {
      api, raw, hints, document: dom.window.document,
      notify: () => { for (const callback of changes) callback(); },
    };
  };
  const a = open(alice);
  const b = open(bob);
  const unbound = open(undefined);
  unbound.api.Wa.set(orgKey, bob.orgUuid);
  assert.equal(unbound.api.Wa.get(orgKey), bob.orgUuid);
  assert.equal(unbound.raw(orgKey), bob.orgUuid);
  assert.equal(unbound.hints.R2().accountUuid, "stale");
  let changes = 0;
  const unsubscribe = a.api.RV(() => changes++);
  t.after(unsubscribe);
  assert.equal(a.api.pJ(orgKey), alice.orgUuid);
  unbound.api.Wa.set(orgKey, alice.orgUuid);
  a.notify();
  assert.equal(changes, 0);
  for (const [frame, context] of [[a, alice], [b, bob]]) {
    assert.equal(frame.api.Wa.get(orgKey), context.orgUuid);
    assert.equal(frame.api.Wa.getIds([orgKey])[orgKey], context.orgUuid);
    assert.equal(frame.raw(orgKey), context.orgUuid);
    assert.equal(frame.hints.R2(), context);
    frame.api.Wa.set(orgKey, bob.orgUuid);
    frame.api.Wa.delete(orgKey);
    frame.hints.es({ accountUuid: context.accountUuid });
  }
  assert.equal(unbound.api.Wa.get(orgKey), alice.orgUuid);
  assert.equal(sharedHints.get("__qk_hint_account_uuid"), "stale");
  assert.equal(a.api.pJ("theme"), undefined);
  b.api.Wa.set("theme", "dark");
  a.notify();
  assert.equal(changes, 1);
  assert.equal(a.raw("theme"), "dark");
  assert.match(a.document.cookie, /theme=dark/);
});
