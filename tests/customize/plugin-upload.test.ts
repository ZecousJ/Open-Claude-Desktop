import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  extractPluginArchive,
  PluginUploads,
} from "../../electron/plugins/plugin-upload";
import { personalMarketplace } from "../../electron/plugins/plugin-copy";
import {
  acceptsPluginArchive,
  pluginArchiveLimit,
  pluginArchiveRule,
  pluginManifestRule,
} from "../../shared/plugin-upload";
import { pluginUploadInput } from "../../shared/plugin-upload-input";
import { PluginService } from "../../electron/plugins/plugins";
import {
  webMethodKind,
  webRemoteRunnerMethods,
} from "../../shared/web-bridge-methods";

async function archive(
  name = "notes",
  prefix = "",
  body = "Plugin instructions",
) {
  const zip = new JSZip();
  zip.file(
    `${prefix}.claude-plugin/plugin.json`,
    JSON.stringify({ name, description: "Notes", skills: "./skills/" }),
  );
  zip.file(`${prefix}skills/notes/SKILL.md`, body);
  return zip.generateAsync({ type: "nodebuffer" });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-upload-test-"));
  const home = path.join(root, "user");
  const calls: Array<{ method: string; params: any }> = [];
  let fail = false;
  const uploads = new PluginUploads(async () => ({
    call: async (method, params: any) => {
      calls.push({ method, params });
      if (method === "plugin/list") return { marketplaces: [] };
      if (method === "plugin/install" && fail) throw Error("install failed");
      return {};
    },
  }));
  const begin = async (bytes: Buffer, name = "notes.plugin") => {
    const { id } = await uploads.command({ action: "begin", name }, root, home);
    for (let offset = 0; offset < bytes.length; offset += 32)
      await uploads.command(
        {
          action: "append",
          id,
          data: bytes.subarray(offset, offset + 32).toString("base64"),
        },
        root,
        home,
      );
    return id;
  };
  return {
    root,
    home,
    uploads,
    calls,
    begin,
    fail: () => {
      fail = true;
    },
    cleanup: () => fs.rmSync(root, { force: true, recursive: true }),
  };
}

test("plugin archives use the official two extensions and 200 MiB limit", () => {
  for (const name of ["notes.zip", "notes.plugin", "NOTES.PLUGIN"])
    assert.equal(
      acceptsPluginArchive({ name, size: pluginArchiveLimit }),
      true,
    );
  for (const name of ["notes.md", "notes.skill", "notes.plugin.exe"])
    assert.equal(acceptsPluginArchive({ name, size: 1 }), false);
  assert.equal(
    acceptsPluginArchive({ name: "notes.zip", size: pluginArchiveLimit + 1 }),
    false,
  );
  assert.equal(
    pluginUploadInput.safeParse({
      action: "append",
      id: "../other",
      data: "YQ==",
    }).success,
    false,
  );
  assert.equal(
    pluginUploadInput.safeParse({
      action: "append",
      id: "00000000-0000-4000-8000-000000000001",
      data: "!",
    }).success,
    false,
  );
});

test("web uploads use the shared runner handler and discover only the account's private marketplace", async () => {
  assert.equal(webMethodKind("uploadPlugin"), "remote-runner");
  assert.ok(webRemoteRunnerMethods.includes("uploadPlugin"));
  const calls: unknown[] = [];
  const plugins = new PluginService(
    async () => ({
      call: async (_method, params) => {
        calls.push(params);
        return { marketplaces: [] };
      },
    }),
    () => "/users/private/codex-home",
  );
  await plugins.list();
  assert.deepEqual(calls, [{ cwds: ["/users/private/codex-home"] }]);
});

test("upload persists an official archive and installs its runtime manifest", async () => {
  const setup = fixture();
  try {
    const id = await setup.begin(await archive("notes", "package/"));
    assert.deepEqual(
      await setup.uploads.command(
        { action: "finish", id },
        setup.root,
        setup.home,
      ),
      { id, pluginId: "notes@personal" },
    );
    const places = personalMarketplace(setup.home);
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(places.plugins, "notes/.codex-plugin/plugin.json"),
          "utf8",
        ),
      ).name,
      "notes",
    );
    assert.equal(
      fs.readFileSync(
        path.join(places.plugins, "notes/skills/notes/SKILL.md"),
        "utf8",
      ),
      "Plugin instructions",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(places.file, "utf8")).plugins[0].name,
      "notes",
    );
    assert.deepEqual(setup.calls.at(-1), {
      method: "plugin/install",
      params: { pluginName: "notes", marketplacePath: places.file },
    });
    assert.equal(
      fs.existsSync(path.join(setup.root, "plugin-uploads", id)),
      false,
    );
  } finally {
    setup.cleanup();
  }
});

test("duplicate names require an explicit replace and failed replacement rolls back", async () => {
  const setup = fixture();
  try {
    const first = await setup.begin(await archive());
    await setup.uploads.command(
      { action: "finish", id: first },
      setup.root,
      setup.home,
    );
    const second = await setup.begin(await archive("notes", "", "Replacement"));
    assert.equal(
      (
        await setup.uploads.command(
          { action: "finish", id: second },
          setup.root,
          setup.home,
        )
      ).conflict,
      "notes",
    );
    setup.fail();
    await assert.rejects(
      setup.uploads.command(
        { action: "finish", id: second, overwrite: true },
        setup.root,
        setup.home,
      ),
      /install failed/,
    );
    assert.equal(
      fs.readFileSync(
        path.join(
          personalMarketplace(setup.home).plugins,
          "notes/skills/notes/SKILL.md",
        ),
        "utf8",
      ),
      "Plugin instructions",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(personalMarketplace(setup.home).file, "utf8"))
        .plugins.length,
      1,
    );
  } finally {
    setup.cleanup();
  }
});

test("cancellation and account isolation never install partial uploads", async () => {
  const setup = fixture();
  try {
    const id = await setup.begin(await archive());
    await assert.rejects(
      setup.uploads.command(
        { action: "finish", id },
        `${setup.root}-other`,
        setup.home,
      ),
      /Upload failed/,
    );
    await setup.uploads.command(
      { action: "cancel", id },
      setup.root,
      setup.home,
    );
    await assert.rejects(
      setup.uploads.command({ action: "finish", id }, setup.root, setup.home),
      /Upload failed/,
    );
    assert.equal(setup.calls.length, 0);
    await assert.rejects(
      setup.begin(Buffer.from("bad"), "notes.md"),
      (error: Error) => error.message === pluginArchiveRule,
    );
  } finally {
    setup.cleanup();
  }
});

test("missing manifests, invalid names, traversal, and symlinks are rejected", async () => {
  const setup = fixture();
  try {
    const empty = await new JSZip().generateAsync({ type: "nodebuffer" });
    await assert.rejects(
      extractPluginArchive(empty, path.join(setup.root, "empty")),
      (error: Error) => error.message === pluginManifestRule,
    );
    await assert.rejects(
      extractPluginArchive(
        await archive("../outside"),
        path.join(setup.root, "bad"),
      ),
      (error: Error) => error.message === pluginManifestRule,
    );
    const zip = await JSZip.loadAsync(await archive());
    zip.file("../outside", "escape");
    await assert.rejects(
      extractPluginArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        path.join(setup.root, "escape"),
      ),
      (error: Error) => error.message === pluginManifestRule,
    );
    zip.remove("../outside");
    zip.file("link", "../outside", { unixPermissions: 0o120777 });
    await assert.rejects(
      extractPluginArchive(
        await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }),
        path.join(setup.root, "link"),
      ),
      (error: Error) => error.message === pluginManifestRule,
    );
    assert.equal(fs.existsSync(path.join(setup.root, "outside")), false);
    await assert.rejects(
      extractPluginArchive(Buffer.from("not zip"), setup.root),
      /Invalid zip file/,
    );
  } finally {
    setup.cleanup();
  }
});

test("top-level SKILL.md can declare plugin components", async () => {
  const setup = fixture();
  try {
    const zip = new JSZip().file(
      "SKILL.md",
      '---\nname: notes\nskills: "./skills/"\n---\nNotes',
    );
    zip.file("skills/notes/SKILL.md", "Notes");
    const id = await setup.begin(
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    assert.equal(
      (
        await setup.uploads.command(
          { action: "finish", id },
          setup.root,
          setup.home,
        )
      ).pluginId,
      "notes@personal",
    );
  } finally {
    setup.cleanup();
  }
});

test("the twenty-upload cap is account scoped and cancellation releases a slot", async () => {
  const setup = fixture();
  try {
    const ids: string[] = [];
    for (let index = 0; index < 20; index++)
      ids.push(
        (
          await setup.uploads.command(
            { action: "begin", name: "notes.zip" },
            setup.root,
            setup.home,
          )
        ).id,
      );
    await assert.rejects(
      setup.uploads.command(
        { action: "begin", name: "notes.zip" },
        setup.root,
        setup.home,
      ),
      /20 plugin files/,
    );
    await setup.uploads.command(
      { action: "cancel", id: ids[0] },
      setup.root,
      setup.home,
    );
    assert.ok(
      (
        await setup.uploads.command(
          { action: "begin", name: "notes.zip" },
          setup.root,
          setup.home,
        )
      ).id,
    );
    assert.ok(
      (
        await setup.uploads.command(
          { action: "begin", name: "notes.zip" },
          path.join(setup.root, "other-account"),
          setup.home,
        )
      ).id,
    );
  } finally {
    setup.cleanup();
  }
});

test("account deactivation removes unfinished archives", async () => {
  const setup = fixture();
  try {
    const id = await setup.begin(await archive());
    await setup.uploads.close();
    assert.equal(
      fs.existsSync(path.join(setup.root, "plugin-uploads", id)),
      false,
    );
    await assert.rejects(
      setup.uploads.command({ action: "finish", id }, setup.root, setup.home),
      /Upload failed/,
    );
    assert.equal(setup.calls.length, 0);
  } finally {
    setup.cleanup();
  }
});

test("component paths cannot escape the archive and runtime manifests cannot override validation", async () => {
  const setup = fixture();
  try {
    const zip = await JSZip.loadAsync(await archive());
    zip.file(
      ".claude-plugin/plugin.json",
      JSON.stringify({ name: "notes", skills: "../outside" }),
    );
    await assert.rejects(
      extractPluginArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        path.join(setup.root, "escape-component"),
      ),
      (error: Error) => error.message === pluginManifestRule,
    );
    zip.file(
      ".claude-plugin/plugin.json",
      JSON.stringify({ name: "notes", skills: "./skills/" }),
    );
    zip.file(
      ".codex-plugin/plugin.json",
      JSON.stringify({ name: "outside", skills: "/outside" }),
    );
    const folder = path.join(setup.root, "runtime");
    await extractPluginArchive(
      await zip.generateAsync({ type: "nodebuffer" }),
      folder,
    );
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(folder, ".codex-plugin/plugin.json"), "utf8"),
      ),
      { name: "notes", skills: "./skills/" },
    );
  } finally {
    setup.cleanup();
  }
});
