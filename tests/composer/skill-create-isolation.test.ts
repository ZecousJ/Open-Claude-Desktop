import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { build } from "esbuild";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { parseDocument } from "yaml";

const source = fileURLToPath(new URL("../../", import.meta.url));
const bundleRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "skill-create-bundle-"),
);
let runtime: any;
before(async () => {
  const outfile = path.join(bundleRoot, "runtime.mjs");
  await build({
    stdin: {
      contents:
        'export {registerSkillHandlers} from "./electron/ipc/skills"; export {Store} from "./electron/store/store"; export {accountPluginRoute,skillsRoute} from "./electron/official-ui/api/skills";',
      resolveDir: source,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    banner: {
      js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "unused-electron-exports",
        setup(builder) {
          builder.onResolve({ filter: /^electron$/ }, () => ({
            path: "electron",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "export const dialog={}; export const shell={}; export default {};",
          }));
        },
      },
    ],
  });
  runtime = await import(pathToFileURL(outfile).href);
});
after(() => fs.rmSync(bundleRoot, { recursive: true, force: true }));

function fixture(t: test.TestContext, desktop = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-create-owned-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const account = path.join(root, "synthetic-account-a");
  const foreign = path.join(root, "synthetic-account-b");
  fs.mkdirSync(foreign);
  const store = new runtime.Store(account);
  const skills = path.join(store.root, "codex-home", "skills");
  fs.mkdirSync(skills, { recursive: true });
  const handlers = new Map<string, (...args: any[]) => any>();
  const engine = {
    rpc: {
      async call(method: string) {
        assert.equal(method, "skills/list");
        const list = fs.readdirSync(skills).map((name) => ({
          name,
          path: fs.realpathSync.native(path.join(skills, name, "SKILL.md")),
          scope: "user",
        }));
        return { data: [{ skills: list }] };
      },
    },
  };
  runtime.registerSkillHandlers(
    (name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler),
    {
      store,
      engine,
      window: desktop ? {} : undefined,
      accountActivationIdentity: {},
      accountRetiring: false,
    },
  );
  const call = async (name: string, ...args: any[]) => {
    const handler = handlers.get(name);
    assert.ok(handler, `registered handler ${name}`);
    return handler(...args);
  };
  const save = (name: string) =>
    call("saveSkill", {
      name,
      description: "fixture description",
      instructions: "synthetic marker",
    });
  return { root, store, skills, foreign, save, call };
}

test("normal creation persists through a fresh real Store", async (t) => {
  const f = fixture(t);
  await f.save("normal");
  const fresh = new runtime.Store(f.store.root);
  const file = path.join(
    fresh.root,
    "codex-home",
    "skills",
    "normal",
    "SKILL.md",
  );
  assert.equal(
    fs.readFileSync(file, "utf8"),
    '---\nname: "normal"\ndescription: "fixture description"\n---\n\nsynthetic marker\n',
  );
});

test("classic saveSkill callers cannot submit an authored file set", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.call("saveSkill", {
    name: "classic",
    files: [{ relativePath: "SKILL.md", content: "---\nname: classic\n---\n\nContent" }],
  }, "officialSkillAuthoring"));
  assert.deepEqual(fs.readdirSync(f.skills), []);
});

for (const desktop of [false, true]) {
  for (const location of ["foreign", "same-account"] as const) {
    test(`${desktop ? "desktop" : "cloud"} rejects an existing ${location} named directory link`, async (t) => {
      const f = fixture(t, desktop);
      const target =
        location === "foreign" ? f.foreign : path.join(f.skills, "destination");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "sentinel"), "unchanged");
      const link = path.join(f.skills, "escape");
      fs.symlinkSync(target, link, "dir");
      await assert.rejects(f.save("escape"));
      assert.equal(fs.readlinkSync(link), target);
      assert.deepEqual(fs.readdirSync(target), ["sentinel"]);
      assert.equal(
        fs.readFileSync(path.join(target, "sentinel"), "utf8"),
        "unchanged",
      );
    });
  }
}

test("dangling named link remains unchanged and its target stays absent", async (t) => {
  const f = fixture(t);
  const target = path.join(f.foreign, "absent");
  const link = path.join(f.skills, "dangling");
  fs.symlinkSync(target, link, "dir");
  await assert.rejects(f.save("dangling"));
  assert.equal(fs.readlinkSync(link), target);
  assert.equal(fs.existsSync(target), false);
});

test("regular file at the named target remains unchanged", async (t) => {
  const f = fixture(t);
  const target = path.join(f.skills, "occupied");
  fs.writeFileSync(target, "keep");
  await assert.rejects(f.save("occupied"));
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
});

test("exclusive SKILL.md creation preserves an existing skill", async (t) => {
  const f = fixture(t);
  const target = path.join(f.skills, "existing");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "SKILL.md"), "keep original skill");
  await assert.rejects(f.save("existing"));
  assert.equal(
    fs.readFileSync(path.join(target, "SKILL.md"), "utf8"),
    "keep original skill",
  );
});

test("an existing ordinary empty named directory remains supported", async (t) => {
  const f = fixture(t);
  const target = path.join(f.skills, "empty");
  fs.mkdirSync(target);
  await f.save("empty");
  assert.match(
    fs.readFileSync(path.join(target, "SKILL.md"), "utf8"),
    /synthetic marker/,
  );
});

for (const part of ["codex-home", "skills"]) {
  test(`cloud creation refuses a linked ${part} parent`, async (t) => {
    const f = fixture(t);
    const parent = part === "skills" ? f.skills : path.dirname(f.skills);
    fs.rmSync(parent, { recursive: true });
    fs.symlinkSync(f.foreign, parent, "dir");
    await assert.rejects(f.save("escape"));
    assert.deepEqual(fs.readdirSync(f.foreign), []);
    assert.equal(fs.readlinkSync(parent), f.foreign);
  });
}

const owner = "synthetic-account-a";
async function creationServer(t: test.TestContext, f: ReturnType<typeof fixture>, access: {
  readOnly?: boolean;
  allowSkillCreation?: boolean;
} = {}) {
  const identity = {};
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const ctx = {
        account: () => ({ id: owner }),
        stateDirectory: () => f.store.root,
        sessionIdentity: () => identity,
        call: f.call,
        ...access,
    };
    if (await runtime.accountPluginRoute(req, res, url.pathname, url, ctx)) return;
    if (await runtime.skillsRoute(req, res, url.pathname, url, ctx)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return (route: string, payload?: unknown, org = organizationUuid(owner)) => fetch(
    `http://127.0.0.1:${address.port}/api/organizations/${org}/${route}`,
    payload === undefined ? undefined : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

const authorPath = "plugins/account-author";
const simplePath = "skills/create-simple-skill";
const instructions = "\n\n    Indented text 中文\n\n---\n\n  More **Markdown**. \n\n";
const author = (name: string, displayTitle?: string) => ({
  plugin_name: name,
  display_title: displayTitle,
  plugin_description: "fixture description",
  files: [
    { path: "SKILL.md", content: `---\nname: ${JSON.stringify(name)}\ndescription: "fixture description"\n---\n\n${instructions}` },
    { path: "notes/reference.md", content: "  Nested reference\n中文\n" },
  ],
});

test("account-author rejects a named link through the actual saveSkill handler", async (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.foreign, path.join(f.skills, "escape"), "dir");
  const request = await creationServer(t, f);
  const response = await request(authorPath, author("escape"));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.type, "invalid_request_error");
  assert.deepEqual(fs.readdirSync(f.foreign), []);
  assert.equal(fs.readlinkSync(path.join(f.skills, "escape")), f.foreign);
});

test("official creation persists original Markdown, display titles and nested files under one account", async (t) => {
  const f = fixture(t);
  const request = await creationServer(t, f, { readOnly: true, allowSkillCreation: true });
  const draft = author("3-周报", "3 周报");
  const authored = await request(authorPath, draft);
  assert.equal(authored.status, 200);
  const plugin = await authored.json();
  assert.equal(plugin.display_name, "3 周报");
  assert.equal(plugin.skills[0].name, "3-周报");
  assert.equal(plugin.skills[0].display_name, "3 周报");
  assert.equal(plugin.skills[0].partition_by, "account");

  const simple = await request(simplePath, { name: "Simple Skill", description: "fixture description", instructions });
  assert.equal(simple.status, 200);
  const row = await simple.json();
  assert.equal(row.name, "simple-skill");
  assert.equal(row.display_name, "Simple Skill");
  assert.equal(row.partition_by, "account");
  const list = await (await request("skills/list-skills")).json();
  assert.equal(list.skills.find((skill: { name: string }) => skill.name === "3-周报").id, plugin.skills[0].id);
  assert.equal(list.skills.find((skill: { name: string }) => skill.name === "simple-skill").id, row.id);
  const folder = path.join(new runtime.Store(f.store.root).root, "codex-home", "skills");
  for (const file of draft.files)
    assert.equal(fs.readFileSync(path.join(folder, "3-周报", file.path), "utf8"), file.content);
  assert.equal(fs.readFileSync(path.join(folder, "simple-skill", "SKILL.md"), "utf8"), author("simple-skill").files[0].content);
  assert.equal(parseDocument(fs.readFileSync(path.join(folder, "3-周报", "agents", "openai.yaml"), "utf8")).getIn(["interface", "display_name"]), "3 周报");
  assert.deepEqual(fs.readdirSync(f.foreign), []);

  const duplicate = await request(authorPath, { ...draft, files: [draft.files[0]] });
  assert.equal(duplicate.status, 400);
  assert.equal((await duplicate.json()).error.details.error_code, "upload_skill_already_exists");
  assert.equal(fs.readFileSync(path.join(folder, "3-周报", "notes", "reference.md"), "utf8"), draft.files[1].content);
});

test("official skill creation refuses other organizations, methods, and invalid files without writing", async (t) => {
  const f = fixture(t);
  const request = await creationServer(t, f);
  const readonly = await creationServer(t, f, { readOnly: true });
  const draft = author("fixture");
  assert.equal((await request(authorPath, draft, organizationUuid("other"))).status, 404);
  assert.equal((await request(simplePath)).status, 405);
  assert.equal((await readonly(authorPath, draft)).status, 403);
  assert.equal((await request(authorPath, { ...draft, files: [...draft.files, { path: "../outside.md", content: "outside" }] })).status, 400);
  const conflict = await request(authorPath, { ...draft, files: [...draft.files, draft.files[1]] });
  assert.equal(conflict.status, 400);
  const badLayout = await request(authorPath, { ...draft, files: [...draft.files, { path: "notes", content: "collides with directory" }] });
  assert.equal(badLayout.status, 500);
  assert.equal((await badLayout.text()).includes(f.root), false);
  assert.deepEqual(fs.readdirSync(f.skills), []);
});
