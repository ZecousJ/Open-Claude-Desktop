import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { parseDocument } from "yaml";
import { Store } from "../../electron/store/store";
import { skillName } from "../../electron/skills/skill-folder";
import { organizationUuid } from "../../electron/official-ui/api/context";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { encodeWireValue } from "../../shared/web-wire";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import {
  negotiatedOfficialAction,
  readOfficialCapabilities,
} from "../../src-web/official/negotiated-action";
import { useElectronShim } from "./runner-core-support.test";

useElectronShim();
const { Dispatcher } = await import("../../runner/src/dispatcher");
const { registerSkillHandlers } = await import("../../electron/ipc/skills");

function fixture(t: TestContext, requestUpload?: (id: string, offset: number) => unknown) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "official-skill-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, "owner"));
  const personalFolder = path.join(store.root, "codex-home/skills");
  const skills: {
    scope: string;
    name: string;
    path: string;
    enabled: boolean;
    interface?: { displayName: string };
  }[] = [
    {
      scope: "user",
      name: "personal",
      path: path.join(personalFolder, "personal/SKILL.md"),
      enabled: true,
    },
    {
      scope: "admin",
      name: "shared",
      path: path.join(store.root, "shared/SKILL.md"),
      enabled: true,
    },
    {
      scope: "user",
      name: "other",
      path: path.join(root, "other/codex-home/skills/other/SKILL.md"),
      enabled: true,
    },
  ];
  for (const skill of skills) {
    fs.mkdirSync(path.dirname(skill.path), { recursive: true });
    fs.writeFileSync(
      skill.path,
      `---\nname: ${skill.name}\ndescription: Inert fixture\n---\n`,
    );
  }
  let identity = {};
  const writes: { path: string; enabled: boolean }[] = [];
  const engine = {
    rpc: {
      async call(method: string, input: { path: string; enabled: boolean }) {
        if (method === "skills/list") {
          const rows = skills.filter((skill) => fs.existsSync(skill.path));
          for (const folder of fs.readdirSync(personalFolder)) {
            const file = path.join(personalFolder, folder, "SKILL.md");
            if (
              !fs.existsSync(file) ||
              rows.some((skill) => skill.path === file)
            )
              continue;
            const metadata = path.join(
              personalFolder,
              folder,
              "agents/openai.yaml",
            );
            const displayName = fs.existsSync(metadata)
              ? parseDocument(fs.readFileSync(metadata, "utf8")).getIn([
                  "interface",
                  "display_name",
                ])
              : undefined;
            const name = skillName(fs.readFileSync(file, "utf8"));
            assert.ok(name);
            rows.push({
              scope: "user",
              name,
              path: file,
              enabled: true,
              ...(typeof displayName === "string"
                ? { interface: { displayName } }
                : {}),
            });
          }
          return { data: [{ skills: rows }] };
        }
        assert.equal(method, "skills/config/write");
        const skill = skills.find((skill) => skill.path === input.path);
        assert.ok(skill);
        writes.push(input);
        skill.enabled = input.enabled;
      },
    },
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ctx = {
    userId: 1,
    activeAccount: { id: "owner" },
    signedOut: false,
    closedFlag: false,
    accountRetiring: false,
    window: undefined,
    store,
    engine,
    handlers,
    get accountActivationIdentity() {
      return identity;
    },
    officialSessionIdentity: () => identity,
    engineRunning: () => true,
    onEvent: () => () => {},
    setAccessToken() {},
    appVersion: "test",
    log() {},
  };
  registerSkillHandlers(
    (name, handler) => handlers.set(name, handler),
    ctx as never,
  );
  const dispatcher = new Dispatcher({
    officialUiRoot: root,
    officialUiActions: true,
    runtime: {
      serviceUrl: "http://unused",
      stateDir: root,
      providerServiceScript: "unused",
      version: "test",
      codexBinary: () => "unused",
    },
    link: {
      send: () => assert.fail("Unexpected link send"),
      request: async (operation, userId, body) => {
        assert.equal(operation, "store.files.get");
        assert.equal(userId, ctx.userId);
        assert.ok(requestUpload && body && typeof body === "object" && "id" in body && "offset" in body);
        assert.equal(typeof body.id, "string");
        assert.equal(typeof body.offset, "number");
        if (typeof body.id === "string" && typeof body.offset === "number")
          return requestUpload(body.id, body.offset);
        assert.fail("Unexpected upload request");
      },
    },
    publish() {},
    openUrl() {},
    log() {},
  });
  dispatcher.contexts.set(ctx.userId, ctx as never);
  const call = (method: string, ...args: unknown[]) =>
    dispatcher.run({
      t: "call",
      id: "test",
      deadlineMs: 1000,
      method,
      user: { id: ctx.userId, accessToken: "fixture" },
      args: args.map(encodeWireValue),
    });
  const read = (request: OfficialUiReadRequest) =>
    call("officialUiRead", request) as Promise<OfficialUiReadResponse>;
  const action = (request: OfficialUiReadRequest) =>
    call("officialUiAction", request) as Promise<OfficialUiReadResponse>;
  const fetch = createOfficialReadFetch(
    "https://fixture.test",
    read,
    async () => assert.fail("Unexpected network"),
    undefined,
    negotiatedOfficialAction({
      mode: "engine-chat",
      accountId: "1",
      isCurrent: () => true,
      read,
      action,
    }),
  );
  const org = organizationUuid(ctx.activeAccount.id);
  const base = `/api/organizations/${org}`;
  const mine = async () => {
    const response = await fetch(base + "/library/mine?kind=skill");
    assert.equal(response.status, 200);
    const { items } = await response.json();
    return items as {
      id: string;
      name: string;
      viewer: {
        installed: {
          enabled: boolean;
          can_toggle: boolean;
          can_edit: boolean;
          can_remove: boolean;
          claudex_can_rename_duplicate?: true;
        };
      };
    }[];
  };
  return {
    fetch,
    read,
    action,
    call,
    org,
    base,
    mine,
    store,
    skills,
    writes,
    handlers,
    rotate() {
      identity = {};
    },
  };
}

const json = (data: unknown) =>
  ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }) as const;

test("official Web toggles the selected personal skill through the runner and persists the result", async (t) => {
  const f = fixture(t);
  const [personal, shared] = await f.mine();
  const route = f.base + "/skills/disable-skill";
  assert.equal(personal.name, "personal");
  assert.equal(personal.viewer.installed.can_toggle, true);
  assert.equal(shared.viewer.installed.can_toggle, false);

  const disabled = await f.fetch(route, json({ skill_id: personal.id }));
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).enabled, false);
  assert.equal((await f.mine())[0].viewer.installed.enabled, false);
  assert.deepEqual(new Store(f.store.root).settings.disabledSkills, [
    f.skills[0].path,
  ]);

  const enabled = await f.fetch(
    f.base + "/skills/enable-skill",
    json({ skill_id: personal.id }),
  );
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).enabled, true);
  assert.equal((await f.mine())[0].viewer.installed.enabled, true);
  assert.deepEqual(new Store(f.store.root).settings.disabledSkills, []);
  assert.deepEqual(f.writes, [
    { path: f.skills[0].path, enabled: false },
    { path: f.skills[0].path, enabled: true },
  ]);
});

test("official Web requires a current lease, the exact route, and only a skill ID", async (t) => {
  const f = fixture(t);
  const [personal, shared] = await f.mine();
  const route = f.base + "/skills/disable-skill";
  const request = {
    method: "POST",
    path: route,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({ skill_id: personal.id })),
  } as const;
  assert.equal((await f.action(request)).status, 409);
  const { activationLease } = await readOfficialCapabilities(f.read, "1");
  f.rotate();
  assert.equal(
    (await f.action({ ...request, capabilityLease: activationLease })).status,
    409,
  );
  await assert.rejects(f.read(request), /Invalid official Web request/);
  assert.equal((await f.fetch(route)).status, 501);
  assert.equal(
    (await f.fetch(route + "?x=1", json({ skill_id: personal.id }))).status,
    501,
  );
  assert.equal(
    (
      await f.fetch(
        route.replace(f.org, organizationUuid("other")),
        json({ skill_id: personal.id }),
      )
    ).status,
    404,
  );
  assert.equal(
    (await f.fetch(route, json({ skill_id: shared.id }))).status,
    404,
  );
  assert.equal(
    (
      await f.fetch(
        route,
        json({ skill_id: personal.id, path: f.skills[0].path }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.fetch(route, json({ skill_id: f.skills[0].path }))).status,
    400,
  );
  assert.equal(
    (await f.fetch(route, json({ skill_id: "x".repeat(4096) }))).status,
    413,
  );
  assert.equal(
    (
      await f.fetch(route, {
        ...json({ skill_id: personal.id }),
        headers: { "Content-Type": "application/proto" },
      })
    ).status,
    400,
  );

  f.handlers.delete("setSkillEnabled");
  assert.equal((await f.mine())[0].viewer.installed.can_toggle, false);
  assert.equal(
    (await f.fetch(route, json({ skill_id: personal.id }))).status,
    501,
  );
  assert.deepEqual(f.writes, []);
});

test("classic browser skill toggles stay inside the account's personal skills", async (t) => {
  const f = fixture(t);
  const [personal, shared, other] = f.skills;
  await assert.rejects(f.call("setSkillEnabled", shared.path, false));
  await assert.rejects(f.call("setSkillEnabled", other.path, false));
  await f.call("setSkillEnabled", personal.path, false);
  assert.deepEqual(f.writes, [{ path: personal.path, enabled: false }]);
});

test("official Web copies and renames a personal skill through the runner", async (t) => {
  const f = fixture(t);
  const [personal] = await f.mine();
  assert.equal(personal.viewer.installed.claudex_can_rename_duplicate, true);
  assert.equal(personal.viewer.installed.can_edit, false);
  assert.equal(personal.viewer.installed.can_remove, true);
  const source = path.dirname(f.skills[0].path);
  fs.writeFileSync(path.join(source, "reference.txt"), "Fixture reference\n");

  const duplicate = await f.fetch(
    f.base + "/skills/duplicate-skill",
    json({ skill_id: personal.id, new_name: "personal-copy" }),
  );
  assert.equal(duplicate.status, 200, await duplicate.clone().text());
  const { skill: copy } = await duplicate.json();
  assert.equal(copy.name, "personal-copy");
  assert.notEqual(copy.id, personal.id);
  assert.ok(fs.existsSync(f.skills[0].path));

  const rename = await f.fetch(
    f.base + "/skills/rename-skill",
    json({ skill_id: copy.id, new_name: "Working Copy" }),
  );
  assert.equal(rename.status, 200, await rename.clone().text());
  const { skill: renamed } = await rename.json();
  assert.equal(renamed.name, "working-copy");
  assert.equal(renamed.display_name, "Working Copy");
  assert.equal(renamed.viewer.installed.claudex_can_rename_duplicate, true);
  const names = (await f.mine()).map((skill) => skill.name);
  assert.ok(names.includes("working-copy"));
  assert.ok(!names.includes("personal-copy"));
  assert.equal(
    fs.readFileSync(
      path.join(source, "..", "working-copy", "reference.txt"),
      "utf8",
    ),
    "Fixture reference\n",
  );
});

test("official Web skill copy and rename require an exact route, current lease, and owned skill", async (t) => {
  const f = fixture(t);
  const [personal, shared, other] = await f.mine();
  assert.equal(shared.viewer.installed.claudex_can_rename_duplicate, undefined);
  assert.equal(other.viewer.installed.claudex_can_rename_duplicate, undefined);
  const duplicate = f.base + "/skills/duplicate-skill";
  const rename = f.base + "/skills/rename-skill";
  const payload = { skill_id: personal.id, new_name: "fresh" };
  const request = {
    method: "POST",
    path: duplicate,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(payload)),
  } as const;
  assert.equal((await f.action(request)).status, 409);
  const { activationLease } = await readOfficialCapabilities(f.read, "1");
  const upload = await f.call("officialUiAction", {
    ...request,
    capabilityLease: activationLease,
    body: { $upload: "fixture" },
  });
  assert.ok(upload && typeof upload === "object" && "status" in upload);
  assert.equal(upload.status, 400);
  f.rotate();
  assert.equal(
    (await f.action({ ...request, capabilityLease: activationLease })).status,
    409,
  );
  assert.equal((await f.fetch(duplicate)).status, 501);
  assert.equal((await f.fetch(rename + "?x=1", json(payload))).status, 501);
  for (const skill of [shared, other])
    assert.equal(
      (await f.fetch(duplicate, json({ ...payload, skill_id: skill.id })))
        .status,
      404,
    );
  assert.equal(
    (await f.fetch(rename, json({ ...payload, new_name: "x".repeat(4096) })))
      .status,
    413,
  );
  assert.equal(
    (
      await f.fetch(rename, {
        ...json(payload),
        headers: { "Content-Type": "application/proto" },
      })
    ).status,
    400,
  );
  f.handlers.delete("renameSkill");
  assert.equal(
    (await f.mine())[0].viewer.installed.claudex_can_rename_duplicate,
    undefined,
  );
  assert.equal((await f.fetch(duplicate, json(payload))).status, 501);
  assert.deepEqual(
    fs.readdirSync(path.dirname(path.dirname(f.skills[0].path))),
    ["personal"],
  );
  assert.ok(fs.existsSync(f.skills[0].path));
});

test("classic browser can still copy and rename its personal skill", async (t) => {
  const f = fixture(t);
  const manifest = f.skills[0].path;
  const root = path.dirname(path.dirname(manifest));
  assert.equal(
    await f.call("duplicateSkill", manifest, "personal-copy"),
    "personal-copy",
  );
  assert.equal(
    await f.call("renameSkill", manifest, "working-notes"),
    "working-notes",
  );
  assert.deepEqual(fs.readdirSync(root).sort(), [
    "personal-copy",
    "working-notes",
  ]);
});

test("the original Web upload and delete routes require current account authority", async (t) => {
  const f = fixture(t);
  const [personal, shared, other] = await f.mine();
  assert.equal(personal.viewer.installed.can_remove, true);
  assert.equal(shared.viewer.installed.can_remove, false);
  assert.equal(other.viewer.installed.can_remove, false);
  const uploadPath = f.base + "/marketplaces/own-uploads/plugins/account-upload?overwrite=false";
  const deletePath = f.base + "/skills/delete-skill";
  const form = new FormData();
  form.append("file", new File(["---\nname: from-web\ndescription: A test skill\n---\nContent from browser.\n"], "SKILL.md"));
  const encoded = new Request("https://fixture.test" + uploadPath, { method: "POST", body: form });
  const upload = { method: "POST", path: uploadPath, contentType: encoded.headers.get("content-type")!,
    body: new Uint8Array(await encoded.arrayBuffer()) } as const;
  const remove = { method: "POST", path: deletePath, contentType: "application/json",
    body: Buffer.from(JSON.stringify({ skill_id: personal.id })) } as const;
  for (const request of [upload, remove]) {
    assert.equal((await f.action(request)).status, 409);
    await assert.rejects(f.read(request), /Invalid official Web request/);
  }
  const { activationLease } = await readOfficialCapabilities(f.read, "1");
  f.rotate();
  for (const request of [upload, remove])
    assert.equal((await f.action({ ...request, capabilityLease: activationLease })).status, 409);

  for (const row of [shared, other])
    assert.equal((await f.fetch(deletePath, json({ skill_id: row.id }))).status, 404);
  assert.equal((await f.fetch(deletePath, json({ skill_id: personal.id, path: f.skills[0].path }))).status, 400);
  const foreign = organizationUuid("foreign");
  assert.equal((await f.fetch(uploadPath.replace(f.org, foreign), { method: "POST", body: form })).status, 404);
  assert.equal((await f.fetch(deletePath.replace(f.org, foreign), json({ skill_id: personal.id }))).status, 404);
  const uploaded = await f.fetch(uploadPath, { method: "POST", body: form });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const { skills } = await uploaded.json();
  assert.equal(skills[0].name, "from-web");
  assert.ok((await f.mine()).some((skill) => skill.id === skills[0].id));
  const installed = path.join(f.store.root, "codex-home/skills/from-web/SKILL.md");
  const replacement = "---\nname: from-web\ndescription: A test skill\n---\nReplacement from browser.\n";
  const replacementFile = new File([replacement], "SKILL.md");
  await assert.rejects(f.call("installSkillFiles", [{ name: replacementFile.name, data: new Uint8Array(await replacementFile.arrayBuffer()) }],
    { replace: true, upload: { target: { path: installed, name: "from-web" } } }), /Folders on the server/);
  const retry = new FormData();
  retry.append("file", replacementFile);
  retry.append("overwrite", "true");
  retry.append("replaced_skill_id", skills[0].id);
  const replaced = await f.fetch(f.base + "/skills/upload-skill?overwrite=true", { method: "POST", body: retry });
  assert.equal(replaced.status, 200, await replaced.clone().text());
  assert.equal((await replaced.json()).skill.id, skills[0].id);
  assert.equal(fs.readFileSync(installed, "utf8"), replacement);
  assert.equal((await f.fetch(deletePath, json({ skill_id: skills[0].id }))).status, 200);
  assert.ok(!(await f.mine()).some((skill) => skill.id === skills[0].id));
  assert.ok(f.skills.every((skill) => fs.existsSync(skill.path)));

  f.handlers.delete("deleteSkill");
  f.handlers.delete("installSkillFiles");
  assert.equal((await f.mine())[0].viewer.installed.can_remove, false);
  assert.equal((await f.fetch(deletePath, json({ skill_id: personal.id }))).status, 501);
  assert.equal((await f.fetch(uploadPath, { method: "POST", body: form })).status, 501);
});

test("the runner reassembles staged skill uploads and refuses an upload after account activation changes", async (t) => {
  const staged = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const f = fixture(t, (id, offset) => {
    assert.equal(offset, 0);
    reads.push(id);
    const bytes = staged.get(id);
    assert.ok(bytes);
    if (id === "retired") f.rotate();
    return encodeWireValue({ size: bytes.byteLength, bytes });
  });
  const form = new FormData();
  form.append("file", new File(["---\nname: from-web\ndescription: Test fixture\n---\n"], "SKILL.md"));
  const path = f.base + "/marketplaces/own-uploads/plugins/account-upload?overwrite=false";
  const encoded = new Request("https://fixture.test" + path, { method: "POST", body: form });
  const body = new Uint8Array(await encoded.arrayBuffer());
  staged.set("first", body.subarray(0, 100));
  staged.set("second", body.subarray(100));
  staged.set("retired", body);
  const { activationLease } = await readOfficialCapabilities(f.read, "1");
  const request = { method: "POST", path, contentType: encoded.headers.get("content-type"),
    capabilityLease: activationLease };
  const foreign = organizationUuid("foreign");
  const status = async (input: unknown) => {
    const result = await f.call("officialUiAction", input);
    assert.ok(result && typeof result === "object" && "status" in result);
    return result.status;
  };
  const retired = { ...request, body: { $upload: "retired" } };
  assert.equal(await status({ ...retired, path: path.replace(f.org, foreign) }), 404);
  assert.equal(await status({ ...retired, contentType: "application/json" }), 400);
  assert.deepEqual(reads, []);
  assert.equal(await status({ ...request, bodySegments: [{ $upload: "first" }, { $upload: "second" }] }), 200);
  const installed = (await f.mine()).find((skill) => skill.name === "from-web");
  assert.ok(installed);
  assert.equal((await f.fetch(f.base + "/skills/delete-skill", json({ skill_id: installed.id }))).status, 200);
  assert.equal(await status(retired), 409);
  assert.deepEqual(reads, ["first", "second", "retired"]);
  assert.equal((await f.mine()).find((skill) => skill.name === "from-web"), undefined);
});
