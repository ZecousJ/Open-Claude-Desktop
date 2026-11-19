import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { bootstrapOf } from "../electron/official-ui/api/bootstrap";
import { organizationUuid, type AdapterContext } from "../electron/official-ui/api/context";
import { projectsRoute } from "../electron/official-ui/api/projects";
import { ProjectKnowledgeStore } from "../electron/projects/project-knowledge";
import type { Project } from "../shared/types";

const source = path.join(
  process.env.CLAUDEX_OFFICIAL_UI_SOURCE ?? ".restore/archive-extracted/claude-frontend-4.4212.0",
  "src/cloud/assets/v1",
);
function declaration(file: string, name: string) {
  const text = fs.readFileSync(path.join(source, file), "utf8");
  const found = text.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(found, `${file} contains ${name}`);
  return found[0];
}
const consumer = [
  declaration("shared-l-p-m-w-0-C_nAiu5o.js", "D3"),
  ...["H7", "ct", "AT"].map(name => declaration("shared-4-Kt-jV-IU.js", name)),
  ...["ve", "K"].map(name => declaration("cfe1b8ada-3ZQn_bW7.js", name)),
].join("\n");

test("the original project meter and Add control use the store's byte quota", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-capacity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recorded = {
    org_growthbook: {
      features: {
        "2014784443": { defaultValue: true },
        "815173524": { defaultValue: { limit: 2_000_000, search_threshold: 50_000 } },
      },
    },
  };
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data/bootstrap-defaults.json"), JSON.stringify(recorded));
  const project = {
    id: "capacity-project", kind: "chat", name: "Capacity",
    description: "", instructions: "", createdAt: 1,
  } satisfies Project;
  const store = new ProjectKnowledgeStore(root, () => [project]);
  const folder = store.folder(project.id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "notes.txt"), Buffer.alloc(7_808, "x"));
  const pdf = path.join(folder, "scan.pdf");
  fs.writeFileSync(pdf, "%PDF-1.7\n");
  fs.truncateSync(pdf, 30 * 1024 * 1024);
  const ctx = {
    root,
    readOnly: true,
    account: () => ({ id: "owner", name: "Owner" }),
    settings: () => ({ providers: [] }),
    modelCatalog: async () => null,
    snapshot: async () => ({ projects: [project] }),
    call: async (method: string) => method === "listProjectKnowledge" ? store.list(project.id) : undefined,
    log: () => {},
  } as unknown as AdapterContext;
  const bootstrap = await bootstrapOf(ctx);
  let stats: { knowledge_size: number; max_knowledge_size: number; use_project_knowledge_search: boolean };
  const route = `/api/organizations/${organizationUuid("owner")}/projects/${project.id}/kb/stats`;
  const readStats = async () => {
    await projectsRoute(
      { method: "GET" } as Parameters<typeof projectsRoute>[0],
      {
        writeHead: (status: number) => assert.equal(status, 200),
        end: (body: string) => { stats = JSON.parse(body); },
      } as unknown as Parameters<typeof projectsRoute>[1],
      route, new URL(route, "http://fixture.invalid"), ctx,
    );
  };
  const last = (...values: unknown[]) => values.at(-1);
  const context = vm.createContext({
    features: bootstrap.org_growthbook.features,
    J9: () => [], J1: () => true, J2: () => true,
    K1: last, K2: last, K3: last,
    BP: () => false, Iw: () => ({ isAvailable: false }),
    uB: () => ({ models: [] }), GL: {}, wz: 52_428_800, z5: 190_000,
    YY: "__gb__4021483600", RH: new Set(), lz: () => false,
    G3: () => ({}), g0: () => ({}), up: () => ({}),
    _v: () => ({ data: stats }), tj: 4,
    q: "capacity-label", s: (_component: unknown, props: unknown) => props,
    l: (effect: () => void) => effect(),
  });
  vm.runInContext(`${consumer}
    function pr(name) { return features[D3(name)].defaultValue; }
    function Ux(name, key, fallback) { return features[D3(name)].defaultValue[key] ?? fallback; }
    function E(id) { return AT(id); }
    function O() { return ct(); }
    function capacity() {
      let full;
      K({ projectUuid: "capacity-project", onChange: value => { full = value; } });
      return { ...ve({ projectUuid: "capacity-project", count: 2 }), full };
    }
  `, context);
  await readStats();
  assert.equal(stats!.knowledge_size, 31_465_088);
  assert.equal(stats!.max_knowledge_size, 100_000_000);
  assert.equal(stats!.use_project_knowledge_search, false);
  const result = vm.runInContext("capacity()", context);
  assert.equal(result.pct, 32);
  assert.equal(result.full, false);
  fs.truncateSync(pdf, 100_000_001 - 7_808);
  await readStats();
  const full = vm.runInContext("capacity()", context);
  assert.equal(full.pct, 100);
  assert.equal(full.full, true);
  fs.unlinkSync(pdf);
  await readStats();
  const small = vm.runInContext("capacity()", context);
  assert.equal(small.pct, 1);
  assert.equal(small.full, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "data/bootstrap-defaults.json"), "utf8")), recorded);
});
