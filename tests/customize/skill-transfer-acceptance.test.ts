import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import JSZip from "jszip";
import {
  organizationUuid,
  type AdapterContext,
} from "../../electron/official-ui/api/context";
import {
  accountPluginRoute,
  skillsRoute,
} from "../../electron/official-ui/api/skills";
import { skillName } from "../../electron/skills/skill-folder";
import { Store } from "../../electron/store/store";
import { useElectronShim } from "../runner/runner-core-support.test";

useElectronShim();
const { registerSkillHandlers } = await import("../../electron/ipc/skills");

const markdown = (name: string, body = "Example instructions") =>
  `---\nname: ${name}\ndescription: Transfer acceptance fixture\n---\n\n${body}\n`;

async function fixture(t: TestContext) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "f037-transfer-")),
  );
  const store = new Store(root);
  const folder = path.join(root, "codex-home", "skills");
  fs.mkdirSync(folder, { recursive: true });
  let activation = {};
  let retireOnList = false;
  const disabled = new Set<string>();
  const manifest = (name: string) => path.join(folder, name, "SKILL.md");
  const rpc = {
    async call(method: string, input: { path: string; enabled: boolean }) {
      if (method === "skills/config/write") {
        if (input.enabled) disabled.delete(input.path);
        else disabled.add(input.path);
        return {};
      }
      assert.equal(method, "skills/list");
      if (retireOnList) activation = {};
      const skills = fs.readdirSync(folder).flatMap((directory) => {
        const file = manifest(directory);
        if (!fs.existsSync(file)) return [];
        return [
          {
            name: skillName(fs.readFileSync(file, "utf8")),
            path: file,
            scope: "user",
            enabled: !disabled.has(file),
          },
        ];
      });
      return { data: [{ skills }] };
    },
  };
  const context = {
    store,
    engine: { rpc },
    window: undefined,
    accountRetiring: false,
    get accountActivationIdentity() {
      return activation;
    },
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerSkillHandlers(
    (name, handler) => handlers.set(name, handler),
    context as never,
  );
  const owner = "transfer-fixture";
  const ctx = {
    account: () => ({ id: owner }),
    sessionIdentity: () => activation,
    stateDirectory: () => root,
    isCurrent: () => true,
    readOnly: false,
    async call(name: string, ...args: unknown[]) {
      return handlers.get(name)?.(...args);
    },
  } as AdapterContext;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (
      !(await skillsRoute(req, res, url.pathname, url, ctx)) &&
      !(await accountPluginRoute(req, res, url.pathname, url, ctx))
    ) {
      res.writeHead(404).end();
    }
  });
  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/organizations/${organizationUuid(owner)}`;
  const legacy = "/skills/upload-skill";
  const account = "/marketplaces/own-uploads/plugins/account-upload";
  return {
    account,
    legacy,
    manifest,
    root,
    async upload(
      endpoint: string,
      file: File,
      fields: Record<string, string> = {},
    ) {
      const form = new FormData();
      form.set("file", file);
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      const response = await fetch(base + endpoint, {
        method: "POST",
        body: form,
      });
      return { status: response.status, body: await response.json() };
    },
    async remove(id: string) {
      return fetch(base + "/skills/delete-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill_id: id }),
      });
    },
    async disable(name: string) {
      await ctx.call("setSkillEnabled", manifest(name), false);
    },
    retireOnList() {
      retireOnList = true;
    },
  };
}

const md = (name: string, body?: string) =>
  new File([markdown(name, body)], `${name}.md`);

test("ordinary upload conflict identifies the installed name and only replaces the selected skill", async (t) => {
  const f = await fixture(t);
  const uploaded = await f.upload(
    f.account + "?overwrite=false&upload_source=customize_upload",
    md("field-notes"),
  );
  assert.equal(uploaded.status, 200);
  const first = uploaded.body.skills[0];
  const conflict = await f.upload(
    f.legacy + "?overwrite=false",
    md("field-notes", "Revised"),
    { upload_source: "customize_upload" },
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body.error.details, {
    error_code: "upload_skill_already_exists",
    skill_name: "field-notes",
  });
  assert.equal(
    fs.readFileSync(f.manifest("field-notes"), "utf8"),
    markdown("field-notes"),
  );
  const wrong = await f.upload(
    f.account + `?overwrite=true&expected_plugin_id=${uploaded.body.id}`,
    md("other"),
  );
  assert.equal(wrong.status, 400);
  assert.equal(fs.existsSync(f.manifest("other")), false);
  const replaced = await f.upload(
    f.legacy + "?overwrite=true",
    md("field-notes", "Revised"),
    {
      overwrite: "true",
      replaced_skill_id: first.id,
    },
  );
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.skill.id, first.id);
  assert.equal(
    fs.readFileSync(f.manifest("field-notes"), "utf8"),
    markdown("field-notes", "Revised"),
  );
  await f.disable("field-notes");
  const enabled = await f.upload(
    f.account + `?overwrite=true&expected_plugin_id=${uploaded.body.id}&enable_on_replace=true`,
    md("field-notes", "Final"),
  );
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.skills[0].id, first.id);
  assert.equal(enabled.body.skills[0].enabled, true);
  assert.deepEqual(new Store(f.root).settings.disabledSkills, []);
});

test("upload handles nested skill archives and enforces the original file size limit", async (t) => {
  const f = await fixture(t);
  const zip = new JSZip();
  zip.file("workbook/SKILL.md", markdown("workbook"));
  zip.file(
    "workbook/references/large-record.bin",
    Buffer.alloc(21 * 1024 * 1024),
  );
  zip.file("outside.txt", "Not a skill file");
  const data = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });
  const uploaded = await f.upload(
    f.legacy,
    new File([new Uint8Array(data)], "workbook.skill"),
  );
  assert.equal(uploaded.status, 200);
  const installed = path.dirname(f.manifest("workbook"));
  assert.equal(
    fs.statSync(path.join(installed, "references/large-record.bin")).size,
    21 * 1024 * 1024,
  );
  assert.equal(fs.existsSync(path.join(installed, "outside.txt")), false);
  const tooLarge = await f.upload(
    f.legacy,
    new File([Buffer.alloc(30 * 1024 * 1024 + 1)], "too-large.zip"),
  );
  assert.equal(tooLarge.status, 413);
  assert.equal(
    tooLarge.body.error.details.error_code,
    "zip_compressed_too_large",
  );
});

test("delete clears the skill's disabled state and cannot run after account retirement", async (t) => {
  const f = await fixture(t);
  const uploaded = await f.upload(f.legacy, md("working-notes"));
  assert.equal(uploaded.status, 200);
  await f.disable("working-notes");
  assert.deepEqual(new Store(f.root).settings.disabledSkills, [
    f.manifest("working-notes"),
  ]);
  assert.equal((await f.remove(uploaded.body.skill.id)).status, 200);
  assert.equal(fs.existsSync(f.manifest("working-notes")), false);
  assert.deepEqual(new Store(f.root).settings.disabledSkills, []);
  const reinstalled = await f.upload(f.legacy, md("working-notes"));
  assert.equal(reinstalled.status, 200);
  assert.equal(reinstalled.body.skill.enabled, true);
  f.retireOnList();
  assert.equal((await f.remove(reinstalled.body.skill.id)).status, 409);
  assert.equal(
    fs.readFileSync(f.manifest("working-notes"), "utf8"),
    markdown("working-notes"),
  );
});
