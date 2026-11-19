/** Actual route/handlers/Store/files; only SDK discovery and scan are inert seams. */
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import JSZip from "jszip";
import { Store } from "../../electron/store/store";
import { skillName } from "../../electron/skills/skill-folder";
import { skillsRoute } from "../../electron/official-ui/api/skills";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { useElectronShim } from "../runner/runner-core-support.test";
useElectronShim();
const { registerSkillHandlers } = await import("../../electron/ipc/skills");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
function fixture(t: TestContext) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "f034-edit-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skills = path.join(root, "codex-home", "skills");
  fs.mkdirSync(skills, { recursive: true });
  const store = new Store(root);
  store.flush();
  let identity: unknown = {},
    retiring = false,
    hide = false,
    hideAfterSave = false,
    failScan = false;
  let scanWait: ReturnType<typeof deferred> | undefined,
    scanEntered: ReturnType<typeof deferred> | undefined;
  let authWait: ReturnType<typeof deferred> | undefined,
    authEntered: ReturnType<typeof deferred> | undefined;
  const calls: string[] = [];
  const rpc = {
    async call(method: string) {
      assert.equal(method, "skills/list");
      calls.push(method);
      return {
        data: [
          {
            skills: fs
              .readdirSync(skills, { withFileTypes: true })
              .filter((e) => e.isDirectory() && !e.name.startsWith("."))
              .map((e) => {
                const file = path.join(skills, e.name, "SKILL.md");
                return {
                  name: skillName(fs.readFileSync(file, "utf8")),
                  path: file,
                  scope: "user",
                  enabled: !(store.settings.disabledSkills ?? []).includes(
                    file,
                  ),
                };
              })
              .filter(() => !hide),
          },
        ],
      };
    },
  };
  const engine = {
    rpc,
    ensure: async () => {
      throw Error("No runtime startup");
    },
  };
  const context = {
    store,
    engine,
    window: undefined,
    get accountActivationIdentity() {
      return identity;
    },
    get accountRetiring() {
      return retiring;
    },
    remote: {
      session: {
        async authorized(fn: (token: string) => unknown) {
          authEntered?.resolve();
          if (authWait) await authWait.promise;
          return fn("inert-not-a-credential");
        },
      },
      backend: {
        client: {
          async directoryRequest() {
            calls.push("directoryRequest");
            scanEntered?.resolve();
            if (scanWait) await scanWait.promise;
            if (failScan) throw Error("Synthetic service scan refusal");
            return {};
          },
        },
      },
    },
  };
  const handlers = new Map<string, Function>();
  registerSkillHandlers((name, fn) => handlers.set(name, fn), context as never);
  const api = {
    account: () => ({ id: "f034-inert-owner" }),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    isCurrent: () => !retiring,
    readOnly: false,
    async call(name: string, ...args: unknown[]) {
      calls.push(name);
      assert.ok(
        ["listSkills", "installSkillFiles", "replaceSkillContents"].includes(
          name,
        ),
      );
      const result = await handlers.get(name)!(...args);
      if (name === "installSkillFiles" && hideAfterSave) hide = true;
      return result;
    },
  };
  function seed(name: string) {
    const dir = path.join(skills, name);
    fs.mkdirSync(dir);
    const text = `---\nname: ${JSON.stringify(name)}\ndescription: Original description\ncustom: [keep, me]\n---\n\nOriginal body 中文 🧪.\n`;
    fs.writeFileSync(path.join(dir, "SKILL.md"), text);
    fs.mkdirSync(path.join(dir, "agents"));
    fs.writeFileSync(
      path.join(dir, "agents/openai.yaml"),
      '# Keep comment\ninterface:\n  display_name: "Display title"\n',
    );
    fs.writeFileSync(path.join(dir, "notes.txt"), "Companion\r\n");
    return { dir, text };
  }
  async function route(action: string, req: any, url: URL) {
    let status = 0;
    let data = "";
    const res = {
      writeHead(s: number) {
        status = s;
      },
      end(v: string) {
        data = v;
      },
    };
    await skillsRoute(
      req,
      res as never,
      `/api/organizations/${organizationUuid("f034-inert-owner")}/skills/${action}`,
      url,
      api as never,
    );
    return { status, body: JSON.parse(data) };
  }
  async function id(name: string) {
    const req = Object.assign(Readable.from([]), {
      method: "GET",
      headers: {},
    });
    const result = await route(
      "list-skills",
      req,
      new URL("http://inert.invalid/"),
    );
    return result.body.skills.find((s: { name: string }) => s.name === name)
      .id as string;
  }
  async function save(
    skillId: string,
    name: string,
    files: Record<string, string>,
    options: {
      check?: string;
      method?: string;
      org?: string;
      overwrite?: string;
      extra?: boolean;
      replacement?: boolean;
      wrap?: string;
    } = {},
  ) {
    const zip = new JSZip();
    for (const [file, text] of Object.entries(files)) zip.file(file, text);
    const data = await zip.generateAsync({ type: "uint8array" });
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(data)], `${name}.skill`, { type: "application/zip" }),
    );
    form.set("overwrite", options.overwrite ?? "true");
    form.set("check_skill_name", options.check ?? name);
    form.set("wrap", options.wrap ?? "true");
    form.set("replaced_skill_id", skillId);
    if (options.extra) form.set("unexpected", "x");
    if (options.replacement === false) {
      form.delete("replaced_skill_id");
      form.delete("check_skill_name");
      form.delete("wrap");
      form.set("overwrite", "false");
    }
    const encoded = new Request("http://inert.invalid/", {
      method: "POST",
      body: form,
    });
    const contentType = encoded.headers.get("content-type");
    assert.ok(contentType);
    const req = Object.assign(
      Readable.from([Buffer.from(await encoded.arrayBuffer())]),
      {
        method: options.method ?? "POST",
        headers: { "content-type": contentType },
      },
    );
    const p = `/api/organizations/${options.org ?? organizationUuid("f034-inert-owner")}/skills/upload-skill`;
    const url = new URL(p, "http://inert.invalid");
    if (options.replacement === false) {
      url.searchParams.set("overwrite", "false");
    } else {
      url.searchParams.set("overwrite", options.overwrite ?? "true");
      url.searchParams.set("check_skill_name", options.check ?? name);
      url.searchParams.set("wrap", options.wrap ?? "true");
    }
    let status = 0,
      dataOut = "";
    const res = {
      writeHead(s: number) {
        status = s;
      },
      end(v: string) {
        dataOut = v;
      },
    };
    await skillsRoute(req as unknown as IncomingMessage, res as never, p, url, api as never);
    return { status, body: JSON.parse(dataOut) };
  }
  return {
    root,
    skills,
    store,
    seed,
    id,
    save,
    calls,
    api,
    hide() {
      hide = true;
    },
    hideAfterSave() {
      hideAfterSave = true;
    },
    failScan() {
      failScan = true;
    },
    changeActivation() {
      identity = {};
    },
    retire() {
      retiring = true;
    },
    holdAuthorization() {
      authWait = deferred();
      authEntered = deferred();
      return { entered: authEntered.promise, release: authWait.resolve };
    },
    holdScan() {
      scanWait = deferred();
      scanEntered = deferred();
      return { entered: scanEntered.promise, release: scanWait.resolve };
    },
  };
}
const updated = (name: string) =>
  `---\nname: ${JSON.stringify(name)}\ndescription: Updated description\ncustom: [keep, me]\n---\n\nUpdated body 中文 🧪.\n`;
test("original full-file Save version supports an existing Unicode name and preserves complete metadata", async (t) => {
  const f = fixture(t),
    s = f.seed("技能-原件");
  const result = await f.save(await f.id("技能-原件"), "技能-原件", {
    "SKILL.md": updated("技能-原件"),
    "agents/openai.yaml":
      '# Keep comment\ninterface:\n  display_name: "Display title"\n',
    "notes.txt": "Companion\r\n",
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(
    fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8"),
    updated("技能-原件"),
  );
  assert.equal(
    fs.readFileSync(path.join(s.dir, "notes.txt"), "utf8"),
    "Companion\r\n",
  );
  assert.equal(new Store(f.root).root, f.root);
});
for (const mismatch of ["unknown-id", "different-name"] as const)
  test(`Save version ${mismatch} cannot overwrite another existing skill`, async (t) => {
    const f = fixture(t);
    f.seed("source");
    const other = f.seed("other");
    const result = await f.save(
      mismatch === "unknown-id"
        ? "skill_" + "0".repeat(24)
        : await f.id("source"),
      "other",
      { "SKILL.md": updated("other") },
      { check: "source" },
    );
    assert.notEqual(result.status, 200);
    assert.equal(
      fs.readFileSync(path.join(other.dir, "SKILL.md"), "utf8"),
      other.text,
    );
  });
test("same-Store account activation change while security scan awaits cannot write the edited files", async (t) => {
  const f = fixture(t),
    s = f.seed("source");
  const id = await f.id("source"),
    hold = f.holdScan();
  const pending = f.save(id, "source", { "SKILL.md": updated("source") });
  await hold.entered;
  f.changeActivation();
  hold.release();
  const result = await pending;
  assert.notEqual(result.status, 200);
  assert.equal(fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8"), s.text);
});

test("source content changed during scan is never overwritten", async (t) => {
  const f = fixture(t),
    s = f.seed("source"),
    hold = f.holdScan();
  const pending = f.save(await f.id("source"), "source", {
    "SKILL.md": updated("source"),
  });
  await hold.entered;
  const concurrent = s.text + "Concurrent local edit.\n";
  fs.writeFileSync(path.join(s.dir, "SKILL.md"), concurrent);
  hold.release();
  const result = await pending;
  assert.notEqual(result.status, 200);
  assert.equal(
    fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8"),
    concurrent,
  );
});
test("replacement preserves hidden files, permissions and disabled state while removing deleted visible files", async (t) => {
  const f = fixture(t),
    s = f.seed("source");
  fs.writeFileSync(path.join(s.dir, ".local-metadata"), "untouched");
  fs.writeFileSync(
    path.join(s.dir, "large-record.bin"),
    Buffer.alloc(10_000_001),
  );
  fs.chmodSync(path.join(s.dir, "SKILL.md"), 0o640);
  f.store.settings.disabledSkills = [path.join(s.dir, "SKILL.md")];
  f.store.flush();
  const result = await f.save(await f.id("source"), "source", {
    "SKILL.md": updated("source"),
    "agents/openai.yaml": fs.readFileSync(
      path.join(s.dir, "agents/openai.yaml"),
      "utf8",
    ),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.skill.enabled, false);
  assert.equal(
    fs.readFileSync(path.join(s.dir, ".local-metadata"), "utf8"),
    "untouched",
  );
  assert.equal(fs.statSync(path.join(s.dir, "SKILL.md")).mode & 0o777, 0o640);
  assert.equal(fs.existsSync(path.join(s.dir, "notes.txt")), false);
  assert.equal(fs.existsSync(path.join(s.dir, "large-record.bin")), false);
  assert.deepEqual(new Store(f.root).settings.disabledSkills, [
    path.join(s.dir, "SKILL.md"),
  ]);
});
test("failed directory swap restores exact original content and leaves no staging folder", async (t) => {
  const f = fixture(t),
    s = f.seed("source"),
    id = await f.id("source");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (
      path.basename(String(from)).startsWith(".upload-") &&
      String(to) === s.dir
    )
      throw Error("Synthetic swap failure");
    return rename(from, to);
  });
  const result = await f.save(id, "source", { "SKILL.md": updated("source") });
  assert.notEqual(result.status, 200);
  assert.equal(fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8"), s.text);
  assert.equal(
    fs.readFileSync(path.join(s.dir, "notes.txt"), "utf8"),
    "Companion\r\n",
  );
  assert.deepEqual(fs.readdirSync(f.skills), ["source"]);
});
test("unconfirmed rollback preserves the backup and reports uncertainty rather than success", async (t) => {
  const f = fixture(t),
    s = f.seed("source"),
    id = await f.id("source");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === s.dir) throw Error("Synthetic move refusal");
    return rename(from, to);
  });
  const result = await f.save(id, "source", { "SKILL.md": updated("source") });
  assert.notEqual(result.status, 200);
  assert.match(result.body.error.message, /restoration could not be confirmed/);
  const backup = fs
    .readdirSync(f.skills)
    .find((n) => n.startsWith(".replaced-"));
  assert.ok(backup);
  assert.equal(
    fs.readFileSync(path.join(f.skills, backup, "SKILL.md"), "utf8"),
    s.text,
  );
});
test("service and local security scan refusals preserve original files", async (t) => {
  for (const service of [true, false]) {
    const f = fixture(t),
      s = f.seed("source");
    if (service) f.failScan();
    const result = await f.save(await f.id("source"), "source", {
      "SKILL.md":
        updated("source") +
        (service ? "" : "\nEICAR-STANDARD-ANTIVIRUS-TEST-FILE"),
    });
    assert.notEqual(result.status, 200);
    assert.equal(fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8"), s.text);
  }
});
test("original replacement guards reject method, organization, read-only, missing authority, mismatched name and malformed flags before dispatch", async (t) => {
  for (const mode of [
    "method",
    "org",
    "readonly",
    "missing-authority",
    "check",
    "overwrite",
    "wrap",
    "extra",
  ] as const) {
    const f = fixture(t),
      s = f.seed("source"),
      id = await f.id("source");
    if (mode === "readonly") f.api.readOnly = true;
    if (mode === "missing-authority")
      Object.assign(f.api, { isCurrent: undefined });
    const result = await f.save(
      id,
      "source",
      { "SKILL.md": updated("source") },
      {
        ...(mode === "method" ? { method: "GET" } : {}),
        ...(mode === "org" ? { org: organizationUuid("other-owner") } : {}),
        ...(mode === "check" ? { check: "other" } : {}),
        ...(mode === "overwrite" ? { overwrite: "false" } : {}),
        ...(mode === "wrap" ? { wrap: "false" } : {}),
        ...(mode === "extra" ? { extra: true } : {}),
      },
    );
    assert.notEqual(result.status, 200, mode);
    assert.equal(f.calls.includes("installSkillFiles"), false, mode);
    assert.equal(
      fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8"),
      s.text,
      mode,
    );
  }
});
test("missing after-list confirmation reports an unconfirmed save, never successful null", async (t) => {
  const f = fixture(t),
    s = f.seed("source"),
    id = await f.id("source");
  f.hideAfterSave();
  const result = await f.save(id, "source", { "SKILL.md": updated("source") });
  assert.notEqual(result.status, 200);
  assert.match(result.body.error.message, /could not be confirmed/);
  assert.equal(
    fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8"),
    updated("source"),
  );
});
test("ordinary new upload retains original ASCII rules while 64 Unicode codepoint existing target can be edited", async (t) => {
  const f = fixture(t);
  const ordinary = await f.save(
    "unused",
    "new-skill",
    { "SKILL.md": updated("new-skill") },
    { replacement: false },
  );
  assert.equal(ordinary.status, 200);
  const unknownUnicode = await f.save(
    "unused",
    "技能-新增",
    { "SKILL.md": updated("技能-新增") },
    { replacement: false },
  );
  assert.notEqual(unknownUnicode.status, 200);
  const name = "a" + "𐐨".repeat(63),
    s = f.seed(name);
  const result = await f.save(await f.id(name), name, {
    "SKILL.md": updated(name),
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(
    fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8"),
    updated(name),
  );
});

test("delayed authorization cannot transmit old-account skill files after activation changes", async (t) => {
  const f = fixture(t),
    s = f.seed("source"),
    id = await f.id("source"),
    hold = f.holdAuthorization();
  const pending = f.save(id, "source", { "SKILL.md": updated("source") });
  await hold.entered;
  f.changeActivation();
  hold.release();
  const result = await pending;
  assert.notEqual(result.status, 200);
  assert.equal(f.calls.filter((n) => n === "directoryRequest").length, 0);
  assert.equal(fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8"), s.text);
});
