/**
 * Duplicate and Rename for skills and plugins: the folders are really copied,
 * the copies carry their new names, taken names are refused, and a plugin copy
 * lands in the runtime's personal marketplace and is installed (or taken back
 * out).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  duplicateSkillFolder,
  renameSkillFolder,
  skillName,
  withSkillName,
} from "../../electron/skills/skill-folder";
import {
  duplicatePluginFiles,
  personalMarketplace,
} from "../../electron/plugins/plugin-copy";
import { PluginService, type PluginRpc } from "../../electron/plugins/plugins";
import {
  copyName,
  pluginNameTaken,
  pluginSlug,
  renamedSkillPath,
  skillNameTaken,
} from "../../shared/duplicate-name";

const { NameCopyDialog } =
  await import("../../src/collections/customize/NameCopyDialog");
const { skillSlug } =
  await import("../../src/collections/customize/customize-list");

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "claudex-dup-"));

function skillFolder(root: string, name: string, extra = true) {
  const folder = path.join(root, name);
  fs.mkdirSync(path.join(folder, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(folder, "SKILL.md"),
    `---\nname: ${name}\ndescription: Does things\n---\n\nBody text.\n`,
  );
  if (extra)
    fs.writeFileSync(path.join(folder, "scripts", "run.sh"), "echo hi\n");
  return folder;
}

test("the copy's starting name and saved names follow the live dialog", () => {
  assert.equal(copyName("pdf"), "pdf-copy");
  assert.equal(copyName("a".repeat(70)), `${"a".repeat(59)}-copy`);
  assert.equal(copyName("linear", "Linear"), "Linear copy");
  assert.equal(copyName("linear", "Linear", "{name} 副本"), "Linear 副本");
  assert.equal(
    [...copyName("x", "L".repeat(80))].length <= 64,
    true,
    "a long display name is cut so the copy's name fits",
  );
  assert.equal(pluginSlug("  Linear Copy!! "), "linear-copy");
  assert.equal(pluginSlug("<>"), "");
  assert.equal(
    renamedSkillPath("/p/codex-home/skills/old/SKILL.md", "new"),
    "/p/codex-home/skills/new/SKILL.md",
  );
  assert.equal(
    renamedSkillPath("C:\\p\\skills\\old\\SKILL.md", "new"),
    "C:\\p\\skills\\new\\SKILL.md",
  );
});

test("withSkillName sets the front matter name, or adds one", () => {
  const md = "---\nname: old\ndescription: d\n---\n\nBody\n";
  assert.equal(skillName(withSkillName(md, "fresh")), "fresh");
  assert.match(withSkillName(md, "fresh"), /\n\nBody\n$/);
  assert.equal(skillName(withSkillName("Just text", "fresh")), "fresh");
  assert.equal(
    skillName(withSkillName("---\ndescription: d\n---\nBody", "fresh")),
    "fresh",
  );
});

test("Duplicate skill copies the whole folder under the new name", () => {
  const root = temp();
  const source = skillFolder(path.join(root, "system"), "pdf");
  const skills = path.join(root, "skills");
  const copy = duplicateSkillFolder(source, skills, "pdf-copy");
  assert.equal(copy, path.join(skills, "pdf-copy"));
  assert.equal(
    skillName(fs.readFileSync(path.join(copy, "SKILL.md"), "utf8")),
    "pdf-copy",
  );
  assert.equal(
    fs.readFileSync(path.join(copy, "scripts", "run.sh"), "utf8"),
    "echo hi\n",
  );
  // The original is untouched.
  assert.equal(
    skillName(fs.readFileSync(path.join(source, "SKILL.md"), "utf8")),
    "pdf",
  );
  assert.throws(
    () => duplicateSkillFolder(source, skills, "pdf-copy"),
    new RegExp(skillNameTaken.replace(".", "\\.")),
  );
  assert.throws(
    () => duplicateSkillFolder(source, skills, "Bad Name"),
    /lowercase letters/,
  );
  // No half-made folders are left behind.
  assert.deepEqual(
    fs.readdirSync(skills).filter((name) => name.startsWith(".")),
    [],
  );
});

test("Duplicate skill refuses folders with links", () => {
  const root = temp();
  const source = skillFolder(root, "linked");
  fs.symlinkSync("/etc/hosts", path.join(source, "hosts"));
  const skills = path.join(root, "skills");
  assert.throws(
    () => duplicateSkillFolder(source, skills, "linked-copy"),
    /links/,
  );
  assert.equal(fs.existsSync(path.join(skills, "linked-copy")), false);
});

test("Rename skill moves the folder and its SKILL.md name", () => {
  const root = temp();
  const skills = path.join(root, "skills");
  const folder = skillFolder(skills, "notes");
  skillFolder(skills, "taken", false);
  assert.throws(
    () => renameSkillFolder(folder, skills, "taken"),
    new RegExp(skillNameTaken.replace(".", "\\.")),
  );
  assert.throws(
    () => renameSkillFolder(folder, skills, "notes"),
    /different from the current one/,
  );
  const moved = renameSkillFolder(folder, skills, "meeting-notes");
  assert.equal(fs.existsSync(folder), false);
  assert.equal(
    skillName(fs.readFileSync(path.join(moved, "SKILL.md"), "utf8")),
    "meeting-notes",
  );
  assert.equal(fs.existsSync(path.join(moved, "scripts", "run.sh")), true);
});

function pluginFolder(root: string, name: string) {
  const folder = path.join(root, name);
  fs.mkdirSync(path.join(folder, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(folder, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      interface: { displayName: "Linear", category: "Productivity" },
    }),
  );
  fs.writeFileSync(path.join(folder, "README.md"), "readme");
  return folder;
}

test("a plugin copy goes to the personal marketplace with its new names", () => {
  const root = temp();
  const home = path.join(root, "home");
  const source = pluginFolder(path.join(root, "market", "plugins"), "linear");
  const written = duplicatePluginFiles(
    { folder: source, category: "Productivity", authPolicy: "ON_USE" },
    { name: "linear-copy", displayName: "Linear copy" },
    home,
  );
  const places = personalMarketplace(home);
  assert.equal(written.marketplacePath, places.file);
  const market = JSON.parse(fs.readFileSync(places.file, "utf8"));
  assert.equal(market.name, "personal");
  assert.deepEqual(market.plugins, [
    {
      name: "linear-copy",
      source: { source: "local", path: "./plugins/linear-copy" },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
      category: "Productivity",
    },
  ]);
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(places.plugins, "linear-copy", ".codex-plugin", "plugin.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.name, "linear-copy");
  assert.equal(manifest.interface.displayName, "Linear copy");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(
    fs.readFileSync(
      path.join(places.plugins, "linear-copy", "README.md"),
      "utf8",
    ),
    "readme",
  );
  // The source keeps its own name.
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(source, ".codex-plugin", "plugin.json"),
        "utf8",
      ),
    ).name,
    "linear",
  );
  assert.throws(
    () =>
      duplicatePluginFiles({ folder: source }, { name: "linear-copy" }, home),
    new RegExp(pluginNameTaken.replace(".", "\\.")),
  );
  assert.throws(
    () =>
      duplicatePluginFiles(
        { folder: source },
        { name: "linear-two", displayName: "<b>" },
        home,
      ),
    /< or >/,
  );
  written.undo();
  assert.equal(fs.existsSync(places.file), false, "a seeded file goes again");
  assert.equal(fs.existsSync(path.join(places.plugins, "linear-copy")), false);
});

test("undoing a copy keeps the rest of an existing personal marketplace", () => {
  const root = temp();
  const home = path.join(root, "home");
  const places = personalMarketplace(home);
  fs.mkdirSync(path.dirname(places.file), { recursive: true });
  fs.writeFileSync(
    places.file,
    JSON.stringify({ name: "mine", plugins: [{ name: "kept" }] }),
  );
  const source = pluginFolder(root, "linear");
  const written = duplicatePluginFiles(
    { folder: source },
    { name: "linear-copy" },
    home,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(places.file, "utf8")).plugins.map(
      (entry: { name: string }) => entry.name,
    ),
    ["kept", "linear-copy"],
  );
  written.undo();
  const after = JSON.parse(fs.readFileSync(places.file, "utf8"));
  assert.equal(after.name, "mine");
  assert.deepEqual(after.plugins, [{ name: "kept" }]);
});

function fakeRuntime(source: string, home: string, failInstall = false) {
  const calls: { method: string; params: any }[] = [];
  const rpc: PluginRpc = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "plugin/list") {
        const marketplaces: any[] = [
          {
            name: "openai-curated",
            path: "/m/.agents/plugins/marketplace.json",
            plugins: [
              {
                id: "linear@openai-curated",
                name: "linear",
                source: { type: "local", path: source },
                authPolicy: "ON_INSTALL",
                interface: { category: "Productivity" },
              },
              {
                id: "far@openai-curated",
                name: "far",
                source: { type: "git", url: "https://example.com/x.git" },
              },
            ],
          },
        ];
        const file = personalMarketplace(home).file;
        if (fs.existsSync(file))
          marketplaces.push({
            name: "personal",
            path: file,
            plugins: JSON.parse(fs.readFileSync(file, "utf8")).plugins.map(
              (entry: { name: string }) => ({
                id: `${entry.name}@personal`,
                name: entry.name,
              }),
            ),
          });
        return { marketplaces };
      }
      if (method === "plugin/install") {
        if (failInstall) throw new Error("install refused");
        return { appsNeedingAuth: [{ name: "Linear" }] };
      }
      return {};
    },
  };
  return { rpc, calls };
}

test("Duplicate plugin copies, then installs the copy from the personal marketplace", async () => {
  const root = temp();
  const home = path.join(root, "home");
  const source = pluginFolder(root, "linear");
  const { rpc, calls } = fakeRuntime(source, home);
  const service = new PluginService(async () => rpc);
  const result = await service.duplicate(
    "linear@openai-curated",
    { name: "linear-copy", displayName: "Linear copy" },
    home,
  );
  assert.deepEqual(result, {
    id: "linear-copy@personal",
    appsNeedingAuth: ["Linear"],
  });
  const install = calls.find((call) => call.method === "plugin/install");
  assert.deepEqual(install?.params, {
    pluginName: "linear-copy",
    marketplacePath: personalMarketplace(home).file,
  });
  await assert.rejects(
    service.duplicate("far@openai-curated", { name: "far-copy" }, home),
    /aren’t on this computer/,
  );
});

test("a copy the runtime will not install is taken back out", async () => {
  const root = temp();
  const home = path.join(root, "home");
  const source = pluginFolder(root, "linear");
  const service = new PluginService(
    async () => fakeRuntime(source, home, true).rpc,
  );
  await assert.rejects(
    service.duplicate("linear@openai-curated", { name: "linear-copy" }, home),
    /install refused/,
  );
  const places = personalMarketplace(home);
  assert.equal(fs.existsSync(places.file), false);
  assert.equal(fs.existsSync(path.join(places.plugins, "linear-copy")), false);
});

test("the name dialog proposes the copy's name and shows what it is saved as", () => {
  const html = renderToStaticMarkup(
    createElement(NameCopyDialog, {
      title: "Duplicate skill",
      action: "Duplicate",
      initialName: copyName("pdf"),
      slug: skillSlug,
      savedAs: "Saved as /",
      note: "The copy is added to your personal skills.",
      sameName: "pdf",
      sameMessage: "Choose a name different from the original.",
      onSubmit: async () => {},
      onClose: () => {},
    }),
  );
  assert.match(html, /value="pdf-copy"/);
  assert.match(html, /Saved as \/<b[^>]*>pdf-copy<\/b>/);
  assert.match(html, /The copy is added to your personal skills\./);
  assert.match(html, />Duplicate<\/span>/);
  // The original's own name is refused at once (Duplicate) …
  const same = renderToStaticMarkup(
    createElement(NameCopyDialog, {
      title: "Duplicate skill",
      action: "Duplicate",
      initialName: "pdf",
      slug: skillSlug,
      savedAs: "Saved as /",
      sameName: "pdf",
      sameMessage: "Choose a name different from the original.",
      onSubmit: async () => {},
      onClose: () => {},
    }),
  );
  assert.match(same, /Choose a name different from the original\./);
  assert.match(same, /<button class="primary " disabled=""/);
  // … and only after typing for Rename.
  const rename = renderToStaticMarkup(
    createElement(NameCopyDialog, {
      title: "Rename skill",
      action: "Rename",
      initialName: "pdf",
      slug: skillSlug,
      savedAs: "Saved as /",
      sameName: "pdf",
      sameMessage: "Choose a name different from the current one.",
      checkAfterEdit: true,
      onSubmit: async () => {},
      onClose: () => {},
    }),
  );
  assert.doesNotMatch(rename, /different from the current one/);
  assert.match(rename, /Saved as \/<b[^>]*>pdf<\/b>/);
});
