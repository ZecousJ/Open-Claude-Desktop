import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { deriveOfficialUiHostProjectWorkspaceModule } from "../../scripts/official-ui-host-project-workspace.mjs";
import { deriveOfficialUiHostProjectKnowledgeModule } from "../../scripts/official-ui-host-project-knowledge.mjs";
import { brandedModule } from "../../scripts/official-web-assets.mjs";

const renderer = readFileSync(new URL("../../scripts/official-host/project-workspace.mjs", import.meta.url), "utf8")
  .replace(/^import .+;\n/gm, "")
  .replace(/^export /gm, "");

function mount(workspaces) {
  const selection = { selection: null, select: (value) => { selection.selection = value; } };
  const ctx = { account: { uuid: "account-a", claudex_project_workspaces: workspaces }, activeOrganization: { uuid: "personal-a" } };
  const requests = [];
  let result;
  const render = vm.runInNewContext(`${renderer}\n({ ClaudexProjectScope, ClaudexProjectChatRoute, useClaudexProjectMenu, rememberClaudexProjectChat, isClaudexProjectChat })`, {
    createContext() {},
    useContext: () => selection,
    useAccount: () => ctx,
    useGet(path, options) {
      if (options.enabled) requests.push({ path, queryKey: Array.from(options.queryKey) });
      return result ?? {};
    },
    ClaudexProjectAccount: ({ workspace }) => workspace?.uuid ?? ctx.activeOrganization.uuid,
    jsx: (component, props) => component(props),
  });
  return {
    ctx, requests,
    show(projectUuid, lookup) {
      result = lookup;
      return render.ClaudexProjectScope({ projectUuid, pending: "Loading", renderError: () => "Retry" });
    },
    showChat(conversationUuid, lookup) {
      result = lookup;
      return render.ClaudexProjectChatRoute({ conversationUuid, pending: "Loading", children: "Chat" });
    },
    remember: render.rememberClaudexProjectChat,
    isProjectChat: (conversation) => render.isClaudexProjectChat(ctx.account.uuid, conversation),
    menu: (onSelect = () => {}) => render.useClaudexProjectMenu({ formatMessage: (message) => message.defaultMessage }, onSelect),
  };
}

test("the project workspace choice changes lists for the current account without changing its personal organization", () => {
  const fixture = mount([{ uuid: "alpha", name: "Alpha" }, { uuid: "beta", name: "Beta" }]);
  assert.equal(fixture.show(), "personal-a");
  assert.deepEqual(Array.from(fixture.menu().items, ({ label }) => label), ["Personal", "Alpha", "Beta"]);
  fixture.menu((category) => assert.equal(category, "mine")).items[2].onSelect();
  assert.equal(fixture.show(), "beta");
  assert.equal(fixture.menu().items[2].checked, true);
  assert.deepEqual(fixture.ctx.activeOrganization, { uuid: "personal-a" });
  fixture.ctx.account.uuid = "account-b";
  fixture.ctx.activeOrganization.uuid = "personal-b";
  assert.equal(fixture.show(), "personal-b");
  assert.deepEqual(fixture.requests, []);
});

test("a copied project link resolves the authorized workspace before the project renders", () => {
  const fixture = mount([{ uuid: "alpha", name: "Alpha" }, { uuid: "beta", name: "Beta" }]);
  fixture.menu().items[2].onSelect();
  assert.equal(fixture.show("project", { isPending: true }), "Loading");
  assert.equal(fixture.show("project", { isSuccess: true, data: { organization_uuid: "alpha" } }), "alpha");
  assert.equal(fixture.show("project", { isSuccess: true, data: { organization_uuid: "another" } }), "Retry");
  assert.equal(fixture.show("project", { isError: true, error: { statusCode: 503 } }), "Retry");
  assert.equal(fixture.show("project", { isError: true, error: { statusCode: 404 } }), "personal-a");
  assert.deepEqual(fixture.requests[0], {
    path: "/api/claudex/project-organizations/resolve/project",
    queryKey: ["claudex_project_organization", "account-a", "project"],
  });
  assert.equal(fixture.show(), "beta");
});

test("project Chat uses the current account's original REST conversation across navigation and reopen", () => {
  const fixture = mount([{ uuid: "alpha", name: "Alpha" }]);
  fixture.remember("account-a", "launched");
  assert.equal(fixture.showChat("launched", { isPending: true }), "Chat");
  assert.deepEqual(fixture.requests, []);
  assert.equal(fixture.isProjectChat("launched"), true);
  assert.equal(fixture.showChat("reopened", { isPending: true }), "Loading");
  assert.deepEqual(fixture.requests[0], {
    path: "/api/organizations/personal-a/chat_conversations/reopened?claudex_project_binding=1",
    queryKey: ["claudex_project_chat", "account-a", "personal-a", "reopened"],
  });
  assert.equal(fixture.showChat("reopened", { data: { claudex_project_organization_uuid: "alpha" } }), "Chat");
  assert.equal(fixture.isProjectChat("reopened"), true);
  assert.equal(fixture.showChat("ordinary", { data: { claudex_project_organization_uuid: null } }), "Chat");
  assert.equal(fixture.isProjectChat("ordinary"), false);
  fixture.ctx.account.uuid = "account-b";
  assert.equal(fixture.isProjectChat("launched"), false);
  assert.equal(fixture.isProjectChat("reopened"), false);
});

test("stock native navigation opens organization projects in their canonical Project view", () => {
  const root = path.join(process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? ".restore/archive-extracted", "claude-frontend-4.4212.0/src/cloud/assets/v1");
  const file = "shared-140-D6FnSjbS.js";
  const source = deriveOfficialUiHostProjectWorkspaceModule(file, readFileSync(path.join(root, file), "utf8"));
  const navigate = source.slice(source.indexOf("function LB()"), source.indexOf("\nfunction w9("));
  let workspace;
  const route = vm.runInNewContext(`${navigate}\nLB`, {
    J9: (size) => Array(size), J5: () => true, Z5: (_, __, callback) => callback, I4: (_, __, callback) => callback,
    b$: () => undefined, Rn: () => "/epitaxy", fM: () => undefined, QR: () => ({}), Mr: () => false,
    ys: () => ({ activeOrganization: { uuid: workspace ? "organization" : "personal" }, claudexProjectWorkspace: workspace }),
    EL: () => true, gM: () => true, Vs: () => ({ resolve: () => "cowork" }),
    X6: () => undefined, hu: "/cowork/project", AQ: ({ id }) => `/project/${id}`,
  });
  const classic = { kind: "project", id: "fixture" };
  assert.equal(route()(classic), "/cowork/project/fixture");
  workspace = { uuid: "organization" };
  assert.equal(route()(classic), "/project/fixture");
  assert.equal(route()({ ...classic, kind: "epitaxy-project" }), "/epitaxy/project/fixture");
});

test("stock project file viewer requests shared file bytes from their project and keeps personal aliases", async () => {
  const root = path.join(process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? ".restore/archive-extracted", "claude-frontend-4.4212.0/src/cloud/assets/v1");
  const file = "ca12e49f2-BafUhOMK.js";
  const source = deriveOfficialUiHostProjectKnowledgeModule(file, brandedModule(readFileSync(path.join(root, file), "utf8")));
  const start = source.indexOf("function Ft(t)");
  const viewer = source.slice(start, source.indexOf("\nexport ", start));
  const requested = [];
  let scope;
  let query;
  const render = vm.runInNewContext(`${viewer}\nFt`, {
    J9: (size) => Array(size), J0: () => true, J1: () => true, J3: () => true, J4: () => true,
    I1: (_, __, value) => value, I3: (_, __, value) => value, I4: (_, __, value) => value,
    Z1: (_, __, value) => value, K0: () => null, K3: (...args) => args.at(-1),
    j: () => ({}), S: () => scope, M: () => ({ displayFileType: "rich" }), D: () => false,
    m: () => async (url) => { requested.push(url); return new Response("data"); },
    O: (org, id) => `/api/organizations/${org}/files/${id}/contents`,
    ne: (options) => { query = options; return { isPending: true }; },
    o() {}, p: null,
  });
  const shared = "/api/organizations/shared/projects/project/knowledge/file";
  const row = { file_uuid: "file", file_name: "data.csv", preview_url: shared };
  scope = { activeOrganization: { uuid: "shared" }, claudexProjectWorkspace: { uuid: "shared" } };
  render({ file: row });
  assert.equal(query.staleTime, 0);
  await query.queryFn({});
  render({ file: { ...row, preview_url: null } });
  await query.queryFn({});
  scope = { activeOrganization: { uuid: "personal" } };
  render({ file: row });
  assert.equal(query.staleTime, Infinity);
  await query.queryFn({});
  render({ file: { ...row, file_name: "data.XLS" } });
  await query.queryFn({});
  assert.deepEqual(requested, [
    shared,
    "/api/organizations/shared/files/file/contents",
    "/api/organizations/personal/files/file/contents",
    "/api/organizations/personal/files/file/preview",
  ]);
});
