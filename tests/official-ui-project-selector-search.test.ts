/** Original project selector query with inert account/project snapshots only. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { projectsRoute } from "../electron/official-ui/api/projects";
import { organizationUuid } from "../electron/official-ui/api/context";

const owner = "synthetic-selector-owner";
async function list(
  query: string,
  collection = "projects_v2",
  readOnly = false,
) {
  let data: any,
    status: number | undefined,
    calls = 0;
  const projects = [
    { id: "a", name: "Alpha", kind: "chat", createdAt: 1 },
    { id: "b", name: "Beta", kind: "chat", createdAt: 2 },
    { id: "c", name: "ALPHA Notes", createdAt: 3, pinned: true },
    {
      id: "d",
      name: "Alpha Archived",
      kind: "chat",
      createdAt: 4,
      archivedAt: 5,
    },
    { id: "e", name: "Alpha Local", kind: "local", createdAt: 6 },
  ];
  const ctx: any = {
    readOnly,
    account: () => ({ id: owner, name: "Fixture" }),
    snapshot: async () => ({ projects }),
    call: async () => {
      calls++;
      throw Error("Unexpected mutation");
    },
  };
  const p = `/api/organizations/${organizationUuid(owner)}/${collection}`;
  const url = new URL(p + "?" + query, "http://fixture.invalid");
  assert.equal(
    await projectsRoute(
      { method: "GET" } as any,
      {
        writeHead: (s: number) => (status = s),
        end: (b: string) => (data = JSON.parse(b)),
      } as any,
      p,
      url,
      ctx,
    ),
    true,
  );
  assert.equal(status, 200);
  assert.equal(calls, 0);
  return data;
}
function originalSelectorPath(query: string) {
  const file =
    ".restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1/shared-m-2-DfdOu-fU.js";
  const source = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const node = ast.statements.find(
    (n: any) => ts.isFunctionDeclaration(n) && n.name?.text === "Fr",
  );
  assert.ok(node);
  const producer = vm.runInNewContext("(" + node.getText(ast) + ")", {
    URLSearchParams,
    X4: (v: string) => v.toLowerCase(),
    fd: "projects",
    uD: 1,
    Yp: 1,
  });
  return producer(organizationUuid(owner), owner, {
    limit: 30,
    offset: 0,
    orderBy: "latest_activity",
    searchQuery: query,
    isArchived: false,
    permissionFilter: "chat_create",
  }).path;
}
test("original selector searchQuery no-match request returns empty data/count", async () => {
  const path = originalSelectorPath("No matching synthetic project");
  assert.match(path, /searchQuery=no\+matching\+synthetic\+project/);
  const data = await list(
    new URL(path, "http://fixture.invalid").search.slice(1),
  );
  assert.deepEqual(data.data, []);
  assert.equal(data.pagination.total, 0);
  assert.equal(data.pagination.has_more, false);
});
test("selector search is case-insensitive and pagination counts only matching eligible projects", async () => {
  const data = await list("searchQuery=aLpHa&limit=1&offset=0");
  assert.deepEqual(
    data.data.map((x: any) => x.uuid),
    ["c"],
  );
  assert.deepEqual(data.pagination, {
    total: 2,
    limit: 1,
    offset: 0,
    has_more: true,
  });
  const second = await list("searchQuery=ALPHA&limit=1&offset=1");
  assert.deepEqual(
    second.data.map((x: any) => x.uuid),
    ["a"],
  );
  assert.equal(second.pagination.has_more, false);
});
test("legacy query/search aliases and precedence remain unchanged including explicit empty query", async () => {
  for (const key of ["query", "search", "searchQuery"])
    assert.deepEqual(
      (await list(key + "=beta")).data.map((x: any) => x.uuid),
      ["b"],
    );
  assert.deepEqual(
    (await list("query=beta&search=alpha&searchQuery=missing")).data.map(
      (x: any) => x.uuid,
    ),
    ["b"],
  );
  assert.deepEqual(
    (await list("search=beta&searchQuery=missing")).data.map(
      (x: any) => x.uuid,
    ),
    ["b"],
  );
  assert.equal((await list("query=&searchQuery=missing")).data.length, 3);
  assert.equal((await list("searchQuery=")).data.length, 3);
});
test("search preserves archived/starred filtering, legacy collection shape and read-only permissions", async () => {
  assert.deepEqual(
    (await list("searchQuery=alpha&is_archived=true")).data.map(
      (x: any) => x.uuid,
    ),
    ["d"],
  );
  assert.deepEqual(
    (await list("searchQuery=alpha&starred=true")).data.map((x: any) => x.uuid),
    ["c"],
  );
  assert.deepEqual(
    (await list("searchQuery=beta", "projects")).map((x: any) => x.uuid),
    ["b"],
  );
  const read = await list("searchQuery=beta", "projects_v2", true);
  assert.deepEqual(read.data[0].permissions, [
    "chat_project:chat:view",
    "chat_project:knowledge:view",
  ]);
});
