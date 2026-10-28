import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginUploadContents } from "../../src/plugins/PluginUploadDialog";
import { sendPluginArchive } from "../../src/plugins/plugin-archive";
import type { PluginUploadCommand } from "../../shared/plugin-upload";
import { previewPluginArchive } from "../../src/plugins/plugin-archive";
import JSZip from "jszip";

test("single-file preview reads the official manifest or top-level SKILL.md", async () => {
  const zip = new JSZip().file(
    "wrapper/.claude-plugin/plugin.json",
    JSON.stringify({ name: "notes", description: "Notes" }),
  );
  const file = new File(
    [await zip.generateAsync({ type: "arraybuffer" })],
    "notes.plugin",
  );
  assert.deepEqual(await previewPluginArchive(file), {
    name: "notes",
    description: "Notes",
    manifestName: "plugin.json",
  });
  const skill = new JSZip().file(
    "SKILL.md",
    "---\nname: notes\ndescription: Notes\nskills: ./skills/\n---\n",
  );
  assert.deepEqual(
    await previewPluginArchive(
      new File(
        [await skill.generateAsync({ type: "arraybuffer" })],
        "notes.zip",
      ),
    ),
    { name: "notes", description: "Notes", manifestName: "SKILL.md" },
  );
  assert.equal(
    await previewPluginArchive(new File(["not zip"], "notes.zip")),
    undefined,
  );
});

test("plugin upload shows official archive rules, multi-file picker and trust warning", () => {
  const html = renderToStaticMarkup(
    createElement(PluginUploadContents, { onClose() {}, onUploaded() {} }),
  );
  assert.match(
    html,
    /Add a plugin to your workspace from a .zip or .plugin archive/,
  );
  assert.match(html, /accept=".zip,.plugin"/);
  assert.match(html, /multiple=""/);
  assert.match(html, /Only .zip or .plugin files under 200 MB/);
  assert.match(html, /\.claude-plugin\/plugin.json manifest/);
  assert.match(html, /top-level SKILL.md/);
  assert.match(html, /Make sure you trust a plugin/);
  assert.match(html, /plugins are not controlled by Claudex/);
  assert.match(html, /Choose a file to continue/);
  assert.doesNotMatch(html, /Not available|not available/);
});

test("browser upload chunks payloads and cancels conflicts or stopped transfers", async () => {
  const previousWindow = globalThis.window;
  const previousReader = globalThis.FileReader;
  const calls: PluginUploadCommand[] = [];
  let conflict = false;
  Object.assign(globalThis, {
    window: {
      desktop: {
        uploadPlugin: async (input: PluginUploadCommand) => {
          calls.push(input);
          return input.action === "finish"
            ? conflict
              ? { id: "upload", conflict: "notes" }
              : { id: "upload", pluginId: "notes@personal" }
            : { id: "upload" };
        },
      },
    },
    FileReader: class {
      result = "";
      onload?: () => void;
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then((bytes) => {
          this.result = `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
          this.onload?.();
        });
      }
    },
  });
  try {
    const file = new File([new Uint8Array(1024 * 1024 + 10)], "notes.plugin");
    assert.equal((await sendPluginArchive(file)).pluginId, "notes@personal");
    assert.deepEqual(
      calls.map((input) => input.action),
      ["begin", "append", "append", "finish"],
    );
    const chunks = calls.filter((input) => input.action === "append");
    assert.equal(Buffer.from(chunks[0].data, "base64").length, 1024 * 1024);
    assert.equal(Buffer.from(chunks[1].data, "base64").length, 10);
    calls.length = 0;
    conflict = true;
    assert.equal(
      (await sendPluginArchive(new File(["zip"], "notes.zip"))).conflict,
      "notes",
    );
    assert.equal(calls.at(-1)?.action, "cancel");
    calls.length = 0;
    await assert.rejects(
      sendPluginArchive(file, false, () => true),
      /Upload stopped/,
    );
    assert.deepEqual(
      calls.map((input) => input.action),
      ["begin", "cancel"],
    );
  } finally {
    Object.assign(globalThis, {
      window: previousWindow,
      FileReader: previousReader,
    });
  }
});
