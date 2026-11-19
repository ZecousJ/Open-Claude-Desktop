/**
 * F036: real Store + registered handlers + REST adapter + private real files.
 * Only runtime discovery/configuration is an inert disk-backed RPC seam. No
 * SDK, provider, account, skill, command, HTTP server or network is started.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { Socket } from "node:net";
import JSZip from "jszip";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import ts from "typescript";
import { parseDocument } from "yaml";
import { skillNamePlan } from "../../shared/skill-name-plan";
import { Store } from "../../electron/store/store";
import { libraryRoute, skillsRoute } from "../../electron/official-ui/api/skills";
import { skillDownloadRoute } from "../../electron/official-ui/api/skill-download";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { skillName } from "../../electron/skills/skill-folder";
import { useElectronShim } from "../runner/runner-core-support.test";

useElectronShim();
const { registerSkillHandlers } = await import("../../electron/ipc/skills");

const originalRoot = path.resolve(
  process.env.CLAUDEX_F036_ORIGINAL_RESOURCES ??
    ".restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1",
);
function original(file: string, hash: string) {
  const source = fs.readFileSync(path.join(originalRoot, file), "utf8");
  assert.equal(createHash("sha256").update(source).digest("hex"), hash);
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}
function declaration(source: ts.SourceFile, name: string) {
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      return node.getText(source);
    if (ts.isVariableStatement(node)) {
      const value = node.declarationList.declarations.find(
        (part) => ts.isIdentifier(part.name) && part.name.text === name,
      );
      if (value) return `var ${value.getText(source)};`;
    }
  }
  throw Error(`Original declaration missing: ${name}`);
}
function originalNameContract(t: TestContext) {
  const files = ["shared-0-BgsOqC85.js", "c89362a96-BlGLtdfu.js"];
  if (files.some((file) => !fs.existsSync(path.join(originalRoot, file)))) {
    t.skip(
      "Pinned original bundle resources are absent; original-consumer comparison was NOT verified. See F036 resource prerequisites.",
    );
    return undefined;
  }
  const slugSource = original(
    files[0],
    "51ea5a9194e05ac89c14f18c3943a94769bb3de50ccf63d4737b4dd01bfd99c4",
  );
  const nameSource = original(
    files[1],
    "a6dc85a3349147422a1e3b8f6e96bdc976f0ebff72c5131456314912a81ead15",
  );
  // Execute unchanged original name functions. aB only memoizes regexp creation.
  return new Function(
    "aB",
    [
      ...["Rk", "xU", "Lb", "mL"].map((name) => declaration(slugSource, name)),
      "var ae = mL;",
      ...["Ce", "we", "Te", "Ee", "De", "Oe", "Ae"].map((name) =>
        declaration(nameSource, name),
      ),
      "return { typed: Ee, slug: mL, problem: Ae };",
    ].join("\n"),
  )((factory: () => unknown) => factory) as {
    typed(value: string): string;
    slug(value: string): string;
    problem(value: string): unknown;
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const body = "\r\n\r\nSelf-authored fixture only. 中文 🧪\r\nSecond line.\r\n";
function fixture(t: TestContext, aliasedProfile = false) {
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "f036-copy-")),
  );
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const root = aliasedProfile ? path.join(workspace, "profile") : workspace;
  const stateRoot = aliasedProfile ? path.join(workspace, "profile-alias") : root;
  const skills = path.join(root, "codex-home", "skills");
  const config = path.join(root, "inert-runtime-config.json");
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(config, "{}");
  if (aliasedProfile) fs.symlinkSync(root, stateRoot, "junction");
  const store = new Store(stateRoot);
  store.settings = {
    ...store.settings,
    providers: [],
  };
  store.flush();
  let currentStore = store;
  let activation: unknown = {};
  let retiring = false;
  let pendingList: ReturnType<typeof deferred> | undefined;
  let listEntered: ReturnType<typeof deferred> | undefined;
  let rejectConfig = 0;
  let afterConfig: (() => void) | undefined;
  let hiddenName: string | undefined;
  type DiskSkill = {
    path: string;
    name: string;
    scope: string;
    enabled: boolean;
    interface?: { displayName: string };
  };
  let listProjection: ((rows: DiskSkill[]) => DiskSkill[]) | undefined;
  const rpcCalls: { method: string; args: unknown }[] = [];
  function readConfig(): Record<string, boolean> {
    return JSON.parse(fs.readFileSync(config, "utf8"));
  }
  function diskList(): DiskSkill[] {
    return fs
      .readdirSync(skills, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => {
        const file = path.join(skills, entry.name, "SKILL.md");
        const metadataPath = path.join(
          skills,
          entry.name,
          "agents",
          "openai.yaml",
        );
        const displayName = fs.existsSync(metadataPath)
          ? parseDocument(fs.readFileSync(metadataPath, "utf8")).getIn([
              "interface",
              "display_name",
            ])
          : undefined;
        return {
          path: file,
          ...(typeof displayName === "string"
            ? { interface: { displayName } }
            : {}),
          name: skillName(fs.readFileSync(file, "utf8"))!,
          scope: "user",
          enabled: readConfig()[file] !== false,
        };
      })
      .filter((row) => row.name !== hiddenName);
  }
  const rpc = {
    async call(method: string, args: { path?: string; enabled?: boolean }) {
      rpcCalls.push({ method, args: structuredClone(args) });
      if (method === "skills/list") {
        const wait = pendingList;
        pendingList = undefined;
        listEntered?.resolve();
        if (wait) await wait.promise;
        const rows = diskList();
        return {
          data: [{ skills: listProjection ? listProjection(rows) : rows }],
        };
      }
      if (method !== "skills/config/write")
        throw Error("Runtime operation forbidden");
      const writes = rpcCalls.filter((call) => call.method === method).length;
      if (writes === rejectConfig)
        throw Error("Synthetic configuration write failure");
      assert.equal(typeof args.path, "string");
      assert.equal(path.dirname(path.dirname(args.path!)), skills);
      assert.equal(typeof args.enabled, "boolean");
      const value = readConfig();
      value[args.path!] = args.enabled!;
      fs.writeFileSync(config, JSON.stringify(value));
      afterConfig?.();
      return {};
    },
  };
  const engine = {
    rpc,
    async ensure() {
      throw Error("Runtime startup forbidden");
    },
  };
  const context = {
    get store() {
      return currentStore;
    },
    engine,
    window: undefined,
    get accountActivationIdentity() {
      return activation;
    },
    get accountRetiring() {
      return retiring;
    },
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerSkillHandlers(
    (name, handler) => handlers.set(name, handler),
    context as never,
  );
  const call = (name: string, ...args: unknown[]) => {
    assert.ok(["listSkills", "duplicateSkill", "renameSkill"].includes(name));
    return handlers.get(name)!(...args);
  };
  const adapter = {
    call,
    account: () => ({ id: "f036-synthetic-owner" }),
    sessionIdentity: () => activation,
    stateDirectory: () => currentStore.root,
    isCurrent: () => !retiring,
    readOnly: false,
    allowSkillCopyRename: false,
  };
  async function request(
    action: string,
    payload: unknown = {},
    method = "POST",
    org = organizationUuid("f036-synthetic-owner"),
  ) {
    const req = Readable.from([Buffer.from(JSON.stringify(payload))]) as any;
    Object.assign(req, { method, headers: {} });
    const res: any = {
      status: 200,
      body: "",
      writeHead(status: number) {
        this.status = status;
      },
      end(value: string) {
        this.body = value;
      },
    };
    const route = `/api/organizations/${org}/${action.startsWith("library/") ? action : `skills/${action}`}`;
    const url = new URL(route, "http://inert.invalid");
    if (action.startsWith("library/")) {
      await libraryRoute(res, url.pathname, url, adapter as never);
    } else {
      await skillsRoute(req, res, url.pathname, url, adapter as never);
    }
    return { status: res.status as number, body: JSON.parse(res.body) };
  }
  async function download(skillId: string) {
    const socket = new Socket(); // Never connected or listening.
    t.after(() => socket.destroy());
    const req = new http.IncomingMessage(socket);
    req.method = "GET";
    const res = new http.ServerResponse(req);
    let headers: http.OutgoingHttpHeaders = {},
      data = Buffer.alloc(0);
    const writeHead = res.writeHead.bind(res);
    res.writeHead = ((status: number, values: http.OutgoingHttpHeaders) => {
      // Execute real Node response validation; only capture bytes instead of
      // attaching a network socket. Invalid Unicode headers throw here.
      const result = writeHead(status, values);
      headers = values;
      return result;
    }) as typeof res.writeHead;
    res.end = ((chunk: string | Buffer) => {
      data = Buffer.from(chunk);
      return res;
    }) as typeof res.end;
    const route = `/api/organizations/${organizationUuid("f036-synthetic-owner")}/skills/download-dot-skill-file`;
    const url = new URL(route, "http://inert.invalid");
    url.searchParams.set("skill_id", skillId);
    await skillDownloadRoute(req, res, route, url, adapter as never);
    return { status: res.statusCode, headers, data };
  }
  function seed(name: string, enabled = true) {
    const folder = path.join(skills, name);
    fs.mkdirSync(path.join(folder, "notes"), { recursive: true });
    fs.writeFileSync(
      path.join(folder, "SKILL.md"),
      `---\r\nname: ${name}\r\ndescription: Self-authored fixture\r\n---${body}`,
    );
    fs.writeFileSync(path.join(folder, "notes", "中文.txt"), "Café\r\n🧪\r\n");
    fs.writeFileSync(
      path.join(folder, "data.bin"),
      Buffer.from([0, 1, 127, 128, 255]),
    );
    if (!enabled) {
      const file = path.join(folder, "SKILL.md"),
        value = readConfig();
      value[file] = false;
      fs.writeFileSync(config, JSON.stringify(value));
      store.settings.disabledSkills = [
        ...(store.settings.disabledSkills ?? []),
        file,
      ];
      store.flush();
    }
    return folder;
  }
  async function id(name: string) {
    const response = await request("list-skills", {}, "GET");
    assert.equal(response.status, 200);
    const row = response.body.skills.find(
      (skill: { name: string }) => skill.name === name,
    );
    assert.ok(row, `Missing listed fixture ${name}`);
    return row.id as string;
  }
  return {
    root,
    skills,
    store,
    config,
    request,
    download,
    seed,
    id,
    call,
    diskList,
    readConfig,
    rpcCalls,
    setReadOnly(allowSkillCopyRename = false) {
      adapter.readOnly = true;
      adapter.allowSkillCopyRename = allowSkillCopyRename;
    },
    projectListedRows(fn: (rows: DiskSkill[]) => DiskSkill[]) {
      listProjection = fn;
    },
    hideNamed(name: string) {
      hiddenName = name;
    },
    afterConfigWrite(fn: () => void) {
      afterConfig = fn;
    },
    rejectConfigWrite(index: number) {
      rejectConfig = index;
    },
    holdList() {
      pendingList = deferred();
      listEntered = deferred();
      return { entered: listEntered.promise, release: pendingList.resolve };
    },
    replaceActivation() {
      activation = {};
    },
    retire() {
      retiring = true;
      activation = {};
    },
    replaceStore() {
      currentStore = new Store(path.join(root, "other-owner"));
      activation = {};
    },
  };
}

test("fixed original input/output vectors preserve Unicode names and reject empty/oversize names", () => {
  assert.deepEqual(skillNamePlan("  Ｎｏｔｅｓ   Copy  "), {
    displayName: "Ｎｏｔｅｓ Copy",
    name: "notes-copy",
  });
  assert.deepEqual(skillNamePlan("学习 笔记"), {
    displayName: "学习 笔记",
    name: "学习-笔记",
  });
  assert.throws(() => skillNamePlan("🧪"));
  assert.throws(() => skillNamePlan("a".repeat(65)));
});

test("actual copy and rename retain original source and Unicode/CRLF body plus all companion files", async (t) => {
  const f = fixture(t),
    source = f.seed("source"),
    before = fs.readFileSync(path.join(source, "SKILL.md"));
  const copied = await f.request("duplicate-skill", {
    skill_id: await f.id("source"),
    new_name: "source-copy",
  });
  assert.equal(copied.status, 200);
  assert.equal(copied.body.skill.name, "source-copy");
  const renamed = await f.request("rename-skill", {
    skill_id: copied.body.skill.id,
    new_name: "renamed",
  });
  assert.equal(renamed.status, 200);
  assert.notEqual(renamed.body.skill.id, copied.body.skill.id);
  assert.equal(fs.existsSync(path.join(f.skills, "source-copy")), false);
  assert.deepEqual(fs.readFileSync(path.join(source, "SKILL.md")), before);
  const saved = path.join(f.skills, "renamed");
  assert.equal(
    skillName(fs.readFileSync(path.join(saved, "SKILL.md"), "utf8")),
    "renamed",
  );
  assert.ok(
    fs.readFileSync(path.join(saved, "SKILL.md"), "utf8").endsWith(body),
  );
  for (const file of ["notes/中文.txt", "data.bin"])
    assert.deepEqual(
      fs.readFileSync(path.join(saved, file)),
      fs.readFileSync(path.join(source, file)),
    );
  assert.equal(new Store(f.root).root, f.root);
  assert.deepEqual(
    f
      .diskList()
      .map((row) => row.name)
      .sort(),
    ["renamed", "source"],
  );
  assert.equal(
    fs.readdirSync(f.skills).some((name) => name.startsWith(".")),
    false,
  );
});

test("64-character names save; 65-character and unusable encoding names do not write files", async (t) => {
  const f = fixture(t);
  f.seed("source");
  const skill_id = await f.id("source");
  assert.equal(
    (await f.request("duplicate-skill", { skill_id, new_name: "a".repeat(64) }))
      .status,
    200,
  );
  const before = fs.readdirSync(f.skills).sort();
  for (const new_name of [
    "a".repeat(65),
    "",
    "\0",
    "\ud800",
    "🧪",
    "../",
    "<tag>",
  ])
    assert.notEqual(
      (await f.request("duplicate-skill", { skill_id, new_name })).status,
      200,
      JSON.stringify(new_name),
    );
  assert.deepEqual(fs.readdirSync(f.skills).sort(), before);
});

for (const [action, typed, slug] of [
  ["duplicate-skill", "Ｎｏｔｅｓ Copy", "notes-copy"],
  ["rename-skill", "学习 笔记", "学习-笔记"],
] as const) {
  test(`${action} accepts original typed-to-slug contract without losing its display name`, async (t) => {
    const f = fixture(t);
    f.seed("source");
    const response = await f.request(action, {
      skill_id: await f.id("source"),
      new_name: typed,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.skill.name, slug);
    assert.equal(response.body.skill.display_name, typed);
    assert.equal(
      skillName(fs.readFileSync(path.join(f.skills, slug, "SKILL.md"), "utf8")),
      slug,
    );
  });
}

test("name collisions and same-name rename preserve files and use original recognizable error codes", async (t) => {
  const f = fixture(t),
    source = f.seed("source"),
    taken = f.seed("taken");
  const before = [source, taken].map((folder) =>
    fs.readFileSync(path.join(folder, "SKILL.md")),
  );
  const skill_id = await f.id("source");
  const results = await Promise.all([
    f.request("duplicate-skill", { skill_id, new_name: "taken" }),
    f.request("rename-skill", { skill_id, new_name: "taken" }),
    f.request("rename-skill", { skill_id, new_name: "source" }),
  ]);
  assert.ok(results.every((result) => result.status !== 200));
  assert.deepEqual(
    [source, taken].map((folder) =>
      fs.readFileSync(path.join(folder, "SKILL.md")),
    ),
    before,
  );
  assert.deepEqual(
    results.map((result) => result.body.error?.details?.error_code),
    [
      "upload_skill_already_exists",
      "upload_skill_already_exists",
      "skill_rename_same_name",
    ],
  );
});

test("renaming a disabled skill preserves disabled runtime and persisted restart state", async (t) => {
  const f = fixture(t),
    source = f.seed("source", false);
  const response = await f.request("rename-skill", {
    skill_id: await f.id("source"),
    new_name: "renamed",
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.skill.enabled, false);
  const moved = path.join(f.skills, "renamed", "SKILL.md");
  assert.equal(f.readConfig()[moved], false);
  assert.notEqual(f.readConfig()[path.join(source, "SKILL.md")], false);
  assert.deepEqual(new Store(f.root).settings.disabledSkills, [moved]);
});

test("renaming with a profile path alias uses the runtime's canonical disabled path", async (t) => {
  const f = fixture(t, true);
  const source = path.join(f.seed("source", false), "SKILL.md");
  const destination = path.join(f.skills, "网页-技能", "SKILL.md");
  const aliasedSource = path.join(f.store.root, path.relative(f.root, source));
  f.store.settings.disabledSkills = [aliasedSource];
  f.store.flush();

  f.setReadOnly(true);
  const response = await f.request("rename-skill", {
    skill_id: await f.id("source"),
    new_name: "网页 技能",
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.skill.enabled, false);
  assert.equal(f.readConfig()[destination], false);
  assert.notEqual(f.readConfig()[source], false);
  assert.deepEqual(new Store(f.root).settings.disabledSkills, [destination]);
});

test("a failed runtime configuration step must not report a successful disabled-skill rename", async (t) => {
  const outcomes = [];
  for (const failure of [1, 2]) {
    const f = fixture(t);
    f.seed("source", false);
    const skill_id = await f.id("source");
    f.rejectConfigWrite(failure);
    const response = await f.request("rename-skill", {
      skill_id,
      new_name: "renamed",
    });
    outcomes.push({
      failure,
      status: response.status,
      enabled: response.body.skill?.enabled,
    });
    assert.ok(
      fs.existsSync(path.join(f.skills, "renamed", "SKILL.md")) ||
        fs.existsSync(path.join(f.skills, "source", "SKILL.md")),
      "recorded files must not disappear",
    );
    assert.ok(
      f.diskList().every((row) => row.enabled === false),
      "configuration failure must not silently enable the existing or renamed skill",
    );
  }
  assert.ok(
    outcomes.every((outcome) => outcome.status !== 200),
    JSON.stringify(outcomes),
  );
});

test("an unconfirmed settings preparation leaves the source disabled and can be retried", async (t) => {
  const f = fixture(t);
  const source = path.join(f.seed("source", false), "SKILL.md");
  const destination = path.join(f.skills, "renamed", "SKILL.md");
  const payload = { skill_id: await f.id("source"), new_name: "renamed" };
  const blockedFile = path.join(f.root, "settings.json.tmp");
  fs.mkdirSync(blockedFile);
  const failed = await f.request("rename-skill", payload);
  assert.equal(failed.status, 400);
  assert.ok(fs.existsSync(source));
  assert.equal(fs.existsSync(destination), false);
  assert.equal(f.readConfig()[source], false);
  assert.notEqual(f.readConfig()[destination], false);
  assert.deepEqual(new Store(f.root).settings.disabledSkills, [source]);

  fs.rmdirSync(blockedFile);
  const retried = await f.request("rename-skill", payload);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.skill.enabled, false);
  assert.deepEqual(new Store(f.root).settings.disabledSkills, [destination]);
});

test("a failed final settings confirmation keeps the moved skill disabled on restart", async (t) => {
  const f = fixture(t);
  const source = path.join(f.seed("source", false), "SKILL.md");
  const destination = path.join(f.skills, "renamed", "SKILL.md");
  const persist = f.store.persistSkillPreference.bind(f.store);
  let saves = 0;
  t.mock.method(f.store, "persistSkillPreference", async () => {
    if (++saves === 2) throw Error("Synthetic final settings acknowledgement failure");
    await persist();
  });
  const response = await f.request("rename-skill", {
    skill_id: await f.id("source"), new_name: "renamed",
  });
  assert.equal(response.status, 400);
  assert.equal(fs.existsSync(source), false);
  assert.ok(fs.existsSync(destination));
  assert.equal(f.readConfig()[destination], false);
  assert.ok(new Store(f.root).settings.disabledSkills?.includes(destination));
});

test("failed manifest rewrite returns failure and leaves the original folder and contents intact", async (t) => {
  const f = fixture(t),
    source = f.seed("source"),
    before = fs.readFileSync(path.join(source, "SKILL.md"));
  const skill_id = await f.id("source"),
    target = path.join(f.skills, "renamed", "SKILL.md");
  const write = fs.writeFileSync;
  t.mock.method(
    fs,
    "writeFileSync",
    (...args: Parameters<typeof fs.writeFileSync>) => {
      if (
        path.basename(String(args[0])) === "0.next" &&
        path.basename(path.dirname(String(args[0]))).startsWith(".rename-")
      )
        throw Error("Synthetic manifest failure before writing");
      return write(...args);
    },
  );
  const response = await f.request("rename-skill", {
    skill_id,
    new_name: "renamed",
  });
  assert.notEqual(response.status, 200);
  assert.deepEqual(fs.readFileSync(path.join(source, "SKILL.md")), before);
  assert.equal(fs.existsSync(path.dirname(target)), false);
});

test("same-store account reactivation while discovering the source performs zero file mutation", async (t) => {
  const f = fixture(t),
    source = f.seed("source"),
    before = fs.readFileSync(path.join(source, "SKILL.md"));
  const hold = f.holdList();
  const pending = f.call(
    "renameSkill",
    path.join(source, "SKILL.md"),
    "renamed",
  );
  await hold.entered;
  f.replaceActivation();
  hold.release();
  const result = await Promise.resolve(pending).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  assert.ok(
    "error" in result,
    `Retired activation returned ${JSON.stringify(result)}`,
  );
  assert.deepEqual(fs.readFileSync(path.join(source, "SKILL.md")), before);
  assert.equal(fs.existsSync(path.join(f.skills, "renamed")), false);
});

test("replacement Store during source discovery is refused with the old source untouched", async (t) => {
  const f = fixture(t),
    source = f.seed("source"),
    before = fs.readFileSync(path.join(source, "SKILL.md"));
  const hold = f.holdList();
  const pending = f.call(
    "duplicateSkill",
    path.join(source, "SKILL.md"),
    "source-copy",
  );
  await hold.entered;
  f.replaceStore();
  hold.release();
  await assert.rejects(Promise.resolve(pending), /account changed/);
  assert.deepEqual(fs.readFileSync(path.join(source, "SKILL.md")), before);
  assert.equal(fs.existsSync(path.join(f.skills, "source-copy")), false);
});

test("F036 mutation guards reject non-POST, read-only and foreign organizations before writes", async (t) => {
  const outcomes = [];
  for (const kind of ["GET", "read-only", "foreign-org"]) {
    const f = fixture(t);
    f.seed("source");
    const skill_id = await f.id("source");
    if (kind === "read-only") f.setReadOnly();
    const response = await f.request(
      "duplicate-skill",
      { skill_id, new_name: "fresh" },
      kind === "GET" ? "GET" : "POST",
      kind === "foreign-org" ? organizationUuid("other-owner") : undefined,
    );
    outcomes.push({
      kind,
      status: response.status,
      wrote: fs.existsSync(path.join(f.skills, "fresh")),
    });
  }
  assert.ok(
    outcomes.every((result) => result.status !== 200 && !result.wrote),
    JSON.stringify(outcomes),
  );
});

test("Web copy and rename authorize actual personal skills and preserve the original conflict response", async (t) => {
  const f = fixture(t);
  const source = f.seed("source");
  const taken = f.seed("notes-copy");
  const system = f.seed("system");
  const outside = path.join(f.root, "workspace", "repo-skill", "SKILL.md");
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.copyFileSync(path.join(source, "SKILL.md"), outside);
  f.projectListedRows((rows) => [
    ...rows.map((row) => row.path.startsWith(system + path.sep) ? { ...row, scope: "system" } : row),
    { path: outside, name: "outside", scope: "user", enabled: true },
  ]);
  f.setReadOnly(true);
  const inventory = await f.request("library/mine?kind=skill", {}, "GET");
  assert.equal(inventory.status, 200);
  const grants = Object.fromEntries(inventory.body.items.map((item: { name: string; viewer: { installed: { claudex_can_rename_duplicate?: boolean } } }) =>
    [item.name, item.viewer.installed.claudex_can_rename_duplicate]));
  assert.deepEqual(grants, { source: true, "notes-copy": true, system: undefined, outside: undefined });
  for (const name of ["system", "outside"]) {
    const skill_id = await f.id(name);
    for (const action of ["duplicate-skill", "rename-skill"]) {
      const refused = await f.request(action, { skill_id, new_name: "refused" });
      assert.equal(refused.status, 404);
    }
  }
  assert.equal(fs.existsSync(path.join(f.skills, "refused")), false);
  const skill_id = await f.id("source");
  for (const action of ["duplicate-skill", "rename-skill"]) {
    const conflict = await f.request(action, { skill_id, new_name: "Ｎｏｔｅｓ Copy" });
    assert.deepEqual(conflict, {
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "You already have a skill with that name. Choose a different one.",
          details: { error_code: "upload_skill_already_exists" },
        },
      },
    });
  }
  assert.equal(skillName(fs.readFileSync(path.join(taken, "SKILL.md"), "utf8")), "notes-copy");
  const copied = await f.request("duplicate-skill", { skill_id, new_name: "新 副本" });
  assert.equal(copied.status, 200);
  const viewer = copied.body.skill.viewer.installed;
  assert.equal(viewer.claudex_can_rename_duplicate, true);
  assert.equal(viewer.can_edit, false);
  assert.equal(viewer.can_remove, false);
  assert.equal(viewer.can_toggle, false);
  const copiedId = copied.body.skill.id;
  const renamed = await f.request("rename-skill", { skill_id: copiedId, new_name: "新 名称" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.skill.display_name, "新 名称");
  const reloaded = await f.request(renamed.body.skill.id, {}, "GET");
  assert.deepEqual(reloaded.body.viewer.installed, viewer);
});

test("a failed disabled rename clears the vacant target for a later enabled copy", async (t) => {
  const f = fixture(t);
  const source = f.seed("source", false);
  const manifest = path.join(source, "SKILL.md");
  const before = fs.readFileSync(manifest);
  const destination = path.join(f.skills, "fresh", "SKILL.md");
  fs.mkdirSync(path.join(source, "agents"));
  fs.writeFileSync(path.join(source, "agents", "openai.yaml"), "interface: [bad YAML");
  f.seed("enabled");
  const failure = await f.request("rename-skill", { skill_id: await f.id("source"), new_name: "fresh" });
  assert.equal(failure.status, 400);
  assert.deepEqual(fs.readFileSync(manifest), before);
  assert.equal(f.readConfig()[manifest], false);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(new Store(f.root).settings.disabledSkills, [manifest]);

  const copied = await f.request("duplicate-skill", { skill_id: await f.id("enabled"), new_name: "fresh" });
  assert.equal(copied.status, 200);
  assert.equal(copied.body.skill.enabled, true);
  assert.ok(fs.existsSync(destination));
});

test("new_name must be a string, not a coerced boolean or single-item array", async (t) => {
  const outcomes = [];
  for (const new_name of [false, ["fresh"]]) {
    const f = fixture(t);
    f.seed("source");
    const response = await f.request("duplicate-skill", {
      skill_id: await f.id("source"),
      new_name,
    });
    outcomes.push({
      input: new_name,
      status: response.status,
      files: fs.readdirSync(f.skills),
    });
  }
  assert.ok(
    outcomes.every(
      (result) => result.status !== 200 && result.files.length === 1,
    ),
    JSON.stringify(outcomes),
  );
});

test("unconfirmed post-save runtime discovery cannot return a successful null skill", async (t) => {
  const f = fixture(t);
  f.seed("source");
  const skill_id = await f.id("source");
  f.hideNamed("renamed");
  const response = await f.request("rename-skill", {
    skill_id,
    new_name: "renamed",
  });
  assert.notEqual(response.status, 200, JSON.stringify(response.body));
  // A filesystem mutation may already be committed; do not falsely promise rollback.
  assert.ok(fs.existsSync(path.join(f.skills, "renamed", "SKILL.md")));
});

test("resource-gated: name planning matches the unchanged pinned original consumer", (t) => {
  const originalName = originalNameContract(t);
  if (!originalName) return;
  for (const input of [
    " Ｎｏｔｅｓ   Copy ",
    "学习 笔记",
    "école_été",
    "e\u0301cole",
    "A\u030A",
    "\u0301",
    "1name",
    "a\u001cb",
    "A__B",
    "Ⅷ Script",
    "name!!!",
    "a".repeat(64),
  ]) {
    const displayName = originalName.typed(input);
    assert.equal(originalName.problem(displayName), null, input);
    assert.deepEqual(skillNamePlan(input), {
      name: originalName.slug(displayName),
      displayName,
    });
  }
});

test("copy and display-only rename preserve YAML comments, unknown fields and companion contents", async (t) => {
  const f = fixture(t),
    source = f.seed("source");
  fs.mkdirSync(path.join(source, "agents"));
  const metadata =
    '# User-maintained comment\ninterface:\n  display_name: Old title # title note\n  short_description: "Keep this"\n  icon_small: ../notes/中文.txt\nunknown_extension:\n  nested: [a, b]\n';
  fs.writeFileSync(path.join(source, "agents", "openai.yaml"), metadata);
  const copied = await f.request("duplicate-skill", {
    skill_id: await f.id("source"),
    new_name: "Notes Copy",
  });
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  assert.equal(copied.body.skill.name, "notes-copy");
  assert.equal(copied.body.skill.display_name, "Notes Copy");
  assert.equal(
    fs.readFileSync(path.join(source, "agents", "openai.yaml"), "utf8"),
    metadata,
  );
  const file = path.join(f.skills, "notes-copy", "agents", "openai.yaml");
  const first = fs.readFileSync(file, "utf8");
  assert.ok(first.includes("# User-maintained comment"));
  assert.ok(first.includes("# title note"));
  const value = parseDocument(first).toJS();
  assert.deepEqual(value.unknown_extension, { nested: ["a", "b"] });
  assert.equal(value.interface.short_description, "Keep this");
  assert.equal(value.interface.icon_small, "../notes/中文.txt");
  // Original wn permits changed typed title with the same saved slug.
  const renamed = await f.request("rename-skill", {
    skill_id: copied.body.skill.id,
    new_name: "NOTES COPY",
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.skill.name, "notes-copy");
  assert.equal(renamed.body.skill.display_name, "NOTES COPY");
  assert.equal(renamed.body.skill.id, copied.body.skill.id);
  const same = await f.request("rename-skill", {
    skill_id: renamed.body.skill.id,
    new_name: "NOTES COPY",
  });
  assert.notEqual(same.status, 200);
  assert.equal(same.body.error.details.error_code, "skill_rename_same_name");
  assert.deepEqual(
    fs.readFileSync(path.join(f.skills, "notes-copy", "data.bin")),
    fs.readFileSync(path.join(source, "data.bin")),
  );
  assert.ok(fs.readFileSync(file, "utf8").includes("# title note"));
});

test("invalid or linked YAML metadata cannot mutate or escape the source folder", async (t) => {
  for (const kind of ["invalid", "link"] as const) {
    const f = fixture(t),
      source = f.seed("source");
    const before = fs.readFileSync(path.join(source, "SKILL.md"));
    fs.mkdirSync(path.join(source, "agents"));
    const metadata = path.join(source, "agents", "openai.yaml");
    const outside = path.join(f.root, "private-metadata.yaml");
    fs.writeFileSync(outside, "interface: { display_name: Original }\n");
    if (kind === "invalid")
      fs.writeFileSync(metadata, "interface: [unterminated");
    else fs.symlinkSync(outside, metadata);
    const response = await f.request("rename-skill", {
      skill_id: await f.id("source"),
      new_name: "New title",
    });
    assert.notEqual(response.status, 200);
    assert.deepEqual(fs.readFileSync(path.join(source, "SKILL.md")), before);
    assert.equal(
      fs.readFileSync(outside, "utf8"),
      "interface: { display_name: Original }\n",
    );
    assert.equal(fs.existsSync(path.join(f.skills, "new-title")), false);
  }
});

test("source enablement changing during disabled-path preparation stops before moving files", async (t) => {
  const f = fixture(t),
    source = f.seed("source", false);
  const skill_id = await f.id("source");
  f.afterConfigWrite(() => {
    const config = f.readConfig();
    config[path.join(source, "SKILL.md")] = true;
    fs.writeFileSync(f.config, JSON.stringify(config));
  });
  const result = await f.request("rename-skill", {
    skill_id,
    new_name: "renamed",
  });
  assert.notEqual(result.status, 200);
  assert.ok(fs.existsSync(path.join(source, "SKILL.md")));
  assert.equal(fs.existsSync(path.join(f.skills, "renamed")), false);
  assert.notEqual(f.readConfig()[path.join(f.skills, "renamed", "SKILL.md")], false);
});

test("second metadata commit failure restores both originals, including originally absent agents metadata", async (t) => {
  for (const existing of [true, false]) {
    const f = fixture(t),
      source = f.seed("source");
    const manifest = fs.readFileSync(path.join(source, "SKILL.md"));
    const originalYaml =
      "# Keep this comment\ninterface:\n  display_name: Original title\n  short_description: Keep me\nextra: [1, 2]\n";
    if (existing) {
      fs.mkdirSync(path.join(source, "agents"));
      fs.writeFileSync(
        path.join(source, "agents", "openai.yaml"),
        originalYaml,
      );
    }
    const skill_id = await f.id("source");
    const rename = fs.renameSync;
    const mocked = t.mock.method(
      fs,
      "renameSync",
      (...args: Parameters<typeof fs.renameSync>) => {
        if (
          path.basename(String(args[0])) === "1.next" &&
          String(args[1]) ===
            path.join(f.skills, "new-title", "agents", "openai.yaml")
        )
          throw Error("Synthetic second metadata commit failure");
        return rename(...args);
      },
    );
    const response = await f.request("rename-skill", {
      skill_id,
      new_name: "New title",
    });
    mocked.mock.restore();
    assert.notEqual(response.status, 200);
    assert.equal(fs.existsSync(path.join(f.skills, "new-title")), false);
    assert.deepEqual(fs.readFileSync(path.join(source, "SKILL.md")), manifest);
    if (existing)
      assert.equal(
        fs.readFileSync(path.join(source, "agents", "openai.yaml"), "utf8"),
        originalYaml,
      );
    else assert.equal(fs.existsSync(path.join(source, "agents")), false);
    assert.deepEqual(
      fs.readFileSync(path.join(source, "data.bin")),
      Buffer.from([0, 1, 127, 128, 255]),
    );
    assert.equal(
      fs.readdirSync(f.skills).some((name) => name.startsWith(".")),
      false,
    );
  }
});

test("post-save confirmation cannot substitute another same-name path or stale/missing display metadata", async (t) => {
  for (const mismatch of [
    "same-name-other-path",
    "wrong-display",
    "missing-display",
  ] as const) {
    const f = fixture(t);
    f.seed("source");
    const unrelated = f.seed("unrelated");
    const originalUnrelated = fs.readFileSync(path.join(unrelated, "SKILL.md"));
    const skill_id = await f.id("source");
    const expected = path.join(f.skills, "renamed", "SKILL.md");
    // The runtime seam reports an inconsistent snapshot; it does not write a
    // second path, mutate a real runtime or edit the newly saved YAML.
    f.projectListedRows((rows) => {
      if (!fs.existsSync(expected)) return rows;
      if (mismatch === "same-name-other-path")
        return rows
          .filter((row) => row.path !== expected)
          .map((row) =>
            row.path === path.join(unrelated, "SKILL.md")
              ? {
                  ...row,
                  name: "renamed",
                  interface: { displayName: "Renamed" },
                }
              : row,
          );
      return rows.map((row) => {
        if (row.path !== expected) return row;
        if (mismatch === "wrong-display")
          return { ...row, interface: { displayName: "Old title" } };
        const { interface: _ignored, ...rest } = row;
        return rest;
      });
    });
    const response = await f.request("duplicate-skill", {
      skill_id,
      new_name: "Renamed",
    });
    assert.notEqual(response.status, 200, mismatch);
    assert.ok(response.body.error);
    assert.deepEqual(
      fs.readFileSync(path.join(unrelated, "SKILL.md")),
      originalUnrelated,
    );
    assert.equal(
      parseDocument(
        fs.readFileSync(
          path.join(f.skills, "renamed", "agents", "openai.yaml"),
          "utf8",
        ),
      ).getIn(["interface", "display_name"]),
      "Renamed",
    );
  }
});

test("renamed Unicode skills remain readable through the real HTTP archive response headers", async (t) => {
  const f = fixture(t),
    source = f.seed("source");
  const original = await f.download(await f.id("source"));
  assert.equal(original.status, 200);
  const renamed = await f.request("rename-skill", {
    skill_id: await f.id("source"),
    new_name: "技能 副本 二",
  });
  assert.equal(renamed.status, 200);
  const downloaded = await f.download(renamed.body.skill.id);
  assert.equal(downloaded.status, 200, downloaded.data.toString("utf8"));
  assert.equal(downloaded.headers["Content-Type"], "application/zip");
  const disposition = downloaded.headers["Content-Disposition"];
  assert.ok(typeof disposition === "string");
  assert.doesNotThrow(() =>
    http.validateHeaderValue("Content-Disposition", disposition),
  );
  assert.match(disposition, /filename="[\x20-\x7e]+"/);
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
  assert.equal(decodeURIComponent(encoded ?? ""), "技能-副本-二.skill");
  const zip = await JSZip.loadAsync(downloaded.data);
  assert.equal(
    skillName(await zip.file("技能-副本-二/SKILL.md")!.async("string")),
    "技能-副本-二",
  );
  assert.equal(
    await zip.file("技能-副本-二/notes/中文.txt")!.async("string"),
    "Café\r\n🧪\r\n",
  );
  assert.deepEqual(
    await zip.file("技能-副本-二/data.bin")!.async("nodebuffer"),
    Buffer.from([0, 1, 127, 128, 255]),
  );
  assert.equal(
    parseDocument(
      await zip.file("技能-副本-二/agents/openai.yaml")!.async("string"),
    ).getIn(["interface", "display_name"]),
    "技能 副本 二",
  );
  assert.equal(fs.existsSync(source), false);
});
