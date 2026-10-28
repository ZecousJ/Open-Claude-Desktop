import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { act, createElement as h } from "react";
import { EditorView } from "@codemirror/view";
import JSZip from "jszip";
import { CreatePluginDialog } from "../../src/plugins/CreatePluginDialog";
import {
  initialPluginFiles,
  pluginArchiveFiles,
  pluginDraftPathError,
  pluginSkillSeed,
} from "../../src/plugins/plugin-create-files";
import { PluginUploads } from "../../electron/plugins/plugin-upload";
import { personalMarketplace } from "../../electron/plugins/plugin-copy";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { routineDom } from "../support/routine-dom";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";
import type { PluginUploadCommand } from "../../shared/plugin-upload";

test.before(preloadMarkdownRenderer);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function fixture(bridge: Partial<Window["desktop"]> = {}) {
  const copied: string[] = [];
  const env = await routineDom(
    {
      copyText: async (text) => {
        copied.push(text);
      },
      ...bridge,
    },
    { jsdom: true },
  );
  const globals = {
    Window: env.window.Window,
    innerWidth: 1280,
    innerHeight: 720,
    FileReader: class {
      result = "";
      onload?: () => void;
      onerror?: () => void;
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then(
          (data) => {
            this.result = `data:application/octet-stream;base64,${Buffer.from(data).toString("base64")}`;
            this.onload?.();
          },
          () => this.onerror?.(),
        );
      }
    },
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  let closed = 0,
    created = 0;
  const app = {
    accountId: "owner-a",
    controllerScope: {},
    currentController: { current: undefined },
  } as unknown as AppController;
  app.currentController!.current = app;
  const view = () =>
    h(
      AppContext.Provider,
      { value: app },
      h(CreatePluginDialog, {
        onClose: () => {
          closed++;
        },
        onCreated: () => {
          created++;
        },
      }),
    );
  await env.render(view());
  const query = <T extends Element = HTMLElement>(selector: string) => {
    const value = env.document.querySelector<T>(selector);
    assert.ok(value, selector);
    return value;
  };
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++)
      await act(async () => new Promise((r) => setTimeout(r, 5)));
    assert.ok(predicate());
  };
  const editor = () => {
    const value = EditorView.findFromDOM(query(".cm-editor"));
    assert.ok(value);
    return value;
  };
  const edit = async (text: string) =>
    act(async () => {
      const view = editor();
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    });
  const add = async (file: string) => {
    await env.click(".plugin-bundle-add");
    await env.change('[aria-label="New file path"]', file);
    await env.click(".plugin-bundle-path > button");
  };
  return {
    ...env,
    app,
    copied,
    query,
    until,
    editor,
    edit,
    add,
    closed: () => closed,
    created: () => created,
    renderCurrent: () => env.render(view()),
    async clean() {
      await env.clean();
      for (const [key, value] of previous) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("account create opens the file editor with the exact starter, no Close, real tree resizing and inert Preview", async (t) => {
  const env = await fixture();
  t.after(env.clean);
  assert.equal(
    env.query('[role="dialog"]').getAttribute("aria-label"),
    "Create a plugin",
  );
  assert.equal(env.document.querySelector('[aria-label="Close"]'), null);
  assert.equal(
    env.editor().state.doc.toString(),
    '---\nname: ""\n---\n\n# \n\n',
  );
  assert.equal(
    env.query('[role="separator"]').getAttribute("aria-valuenow"),
    "244",
  );
  await env.event(env.query('[role="separator"]'), "keydown", {
    key: "ArrowRight",
    shiftKey: true,
  });
  assert.equal(
    env.query('[role="separator"]').getAttribute("aria-valuenow"),
    "276",
  );
  await env.event(env.query('[role="separator"]'), "keydown", { key: "Home" });
  assert.equal(
    env.query('[role="separator"]').getAttribute("aria-valuenow"),
    "160",
  );
  await env.event(env.query('[role="separator"]'), "keydown", { key: "Enter" });
  assert.equal(
    env.query('[role="separator"]').getAttribute("aria-valuenow"),
    "244",
  );
  await env.edit(
    '---\nname: "draft"\n---\n\n# Preview heading\n<script>window.BAD=true</script>',
  );
  const preview = [...env.document.querySelectorAll("button")].find(
    (b) => b.textContent === "Preview",
  )!;
  await env.event(preview, "click");
  await env.until(() =>
    Boolean(env.document.querySelector(".plugin-bundle-preview h1")),
  );
  assert.equal(
    env.query(".plugin-bundle-preview h1").textContent,
    "Preview heading",
  );
  assert.equal(
    env.document.querySelector(".plugin-bundle-preview script"),
    null,
  );
  const code = [...env.document.querySelectorAll("button")].find(
    (b) => b.textContent === "Code",
  )!;
  await env.event(code, "click");
  assert.match(env.editor().state.doc.toString(), /window.BAD/);
  await env.click('[aria-label="Copy code"]');
  assert.deepEqual(env.copied, [env.editor().state.doc.toString()]);
});

test("lazy editor overrides shared absolute resize positioning without changing the global handle", async (t) => {
  const env = await fixture();
  t.after(env.clean);
  const style = env.document.createElement("style");
  style.textContent = [
    "../../src/ui/resize-handle.css",
    "../../src/plugins/plugin-create.css",
  ]
    .map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8"))
    .join("\n");
  env.document.head.append(style);
  const handle = env.query('[role="separator"]');
  assert.equal(env.window.getComputedStyle(handle).position, "relative");
  assert.equal(
    env.window.getComputedStyle(env.query(".plugin-bundle-file")).gridColumn,
    "3",
  );
});

test("adding, renaming, duplicates, unsafe paths and deleting operate on actual editor files", async (t) => {
  const env = await fixture();
  t.after(env.clean);
  await env.add("scripts/run.py");
  await env.edit('print("saved")\n');
  const rename = env.query(".plugin-bundle-filename");
  await env.event(rename, "click");
  await env.change('[aria-label="Rename file path"]', "scripts/execute.py");
  await env.click(".plugin-bundle-path > button");
  assert.equal(
    env.document.querySelector('[aria-label="scripts/run.py"]'),
    null,
  );
  assert.ok(env.document.querySelector('[aria-label="scripts/execute.py"]'));
  assert.equal(env.editor().state.doc.toString(), 'print("saved")\n');
  for (const name of [
    "../escape.txt",
    "/absolute.txt",
    "scripts/EXECUTE.py",
    "scripts",
  ]) {
    await env.click(".plugin-bundle-add");
    await env.change('[aria-label="New file path"]', name);
    await env.click(".plugin-bundle-path > button");
    assert.ok(env.document.querySelector('.plugin-bundle-path [role="alert"]'));
    await env.event(env.query('[aria-label="New file path"]'), "keydown", {
      key: "Escape",
    });
  }
  assert.equal(env.closed(), 0);
  await env.click('[aria-label="Delete"]');
  assert.equal(
    env.document.querySelector('[aria-label="scripts/execute.py"]'),
    null,
  );
  assert.equal(env.editor().state.doc.toString(), pluginSkillSeed());
});

test("Cancel, Escape and backdrop confirm unsaved changes and Keep editing preserves the same file draft", async (t) => {
  const env = await fixture();
  t.after(env.clean);
  await env.edit("# Keep my unsaved text");
  for (const action of ["cancel", "escape", "backdrop"]) {
    if (action === "cancel")
      await env.event(
        [...env.document.querySelectorAll("button")].find(
          (b) => b.textContent === "Cancel",
        )!,
        "click",
      );
    else if (action === "escape")
      await env.event(env.document, "keydown", { key: "Escape" });
    else await env.event(env.query(".overlay"), "mousedown");
    assert.equal(
      env.query('[role="alertdialog"]').getAttribute("aria-label"),
      "Discard this draft?",
    );
    assert.equal(env.closed(), 0);
    await env.event(
      [...env.document.querySelectorAll("button")].find(
        (b) => b.textContent === "Keep editing",
      )!,
      "click",
    );
    assert.equal(env.editor().state.doc.toString(), "# Keep my unsaved text");
  }
  await env.event(env.document, "keydown", { key: "Escape" });
  await env.event(
    [...env.document.querySelectorAll("button")].find(
      (b) => b.textContent === "Discard",
    )!,
    "click",
  );
  assert.equal(env.closed(), 1);
});

test("actual multi-file ZIP uses the existing upload protocol and reaches the real private plugin store", async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "plugin-create-b36-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const commands: PluginUploadCommand[] = [];
  const chunks: Buffer[] = [];
  const uploads = new PluginUploads(
    async () =>
      ({
        call: async (method: string) =>
          method === "plugin/list"
            ? { marketplaces: [] }
            : { id: "deal-desk@personal" },
      }) as never,
  );
  t.after(() => uploads.close());
  const env = await fixture({
    uploadPlugin: async (command) => {
      commands.push(command);
      if (command.action === "append")
        chunks.push(Buffer.from(command.data, "base64"));
      return uploads.command(command, path.join(root, "account"), home);
    },
  });
  t.after(env.clean);
  await env.change('input[maxlength="64"]', "Deal Desk");
  const description = env.document.querySelectorAll<HTMLInputElement>(
    ".plugin-create-metadata input",
  )[1];
  await env.event(description, "focus");
  await env.change(
    ".plugin-create-metadata label:nth-child(2) input",
    "Reviews contracts",
  );
  await env.edit(
    '---\nname: "old"\ncustom: true\n---\n\n# Instructions\nDo the actual work.',
  );
  await env.add("scripts/check.py");
  await env.edit('print("included")\n');
  await env.add("references/notes.md");
  await env.edit("# Private notes\nkept verbatim");
  await env.event(env.query("form"), "submit");
  await env.until(() => env.created() === 1);
  assert.equal(env.closed(), 1);
  assert.deepEqual(
    commands.map((c) => c.action),
    ["begin", "append", "finish"],
  );
  const zip = await JSZip.loadAsync(Buffer.concat(chunks));
  assert.deepEqual(Object.keys(zip.files).sort(), [
    ".claude-plugin/plugin.json",
    "references/notes.md",
    "scripts/check.py",
    "skills/deal-desk/SKILL.md",
  ]);
  assert.deepEqual(
    JSON.parse(await zip.file(".claude-plugin/plugin.json")!.async("string")),
    {
      name: "deal-desk",
      description: "Reviews contracts",
      skills: "./skills/",
    },
  );
  const installed = path.join(personalMarketplace(home).plugins, "deal-desk");
  assert.equal(
    fs.readFileSync(path.join(installed, "scripts/check.py"), "utf8"),
    'print("included")\n',
  );
  const skill = fs.readFileSync(
    path.join(installed, "skills/deal-desk/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /name: "deal-desk"/);
  assert.equal(skill.match(/^name\s*:/gm)?.length, 1);
  assert.doesNotMatch(skill, /name: "old"/);
  assert.match(skill, /description: "Reviews contracts"/);
  assert.match(skill, /custom: true/);
  assert.match(skill, /Do the actual work/);
  assert.equal(
    fs.readFileSync(path.join(installed, "references/notes.md"), "utf8"),
    "# Private notes\nkept verbatim",
  );
});

test("save failure/conflict keeps every edited file and a retry does not overwrite an existing plugin", async (t) => {
  const actions: string[] = [];
  let attempt = 0;
  const env = await fixture({
    uploadPlugin: async (command) => {
      actions.push(command.action);
      if (command.action === "finish") {
        attempt++;
        if (attempt === 1) throw Error("Synthetic transport failure");
        return { id: "stage", conflict: "notes" };
      }
      return { id: "stage" };
    },
  });
  t.after(env.clean);
  await env.change('input[maxlength="64"]', "notes");
  await env.add("scripts/helper.py");
  await env.edit("retained");
  for (const expected of [
    "Synthetic transport failure",
    "You already have a plugin with that name. Choose a different one.",
  ]) {
    await env.event(env.query("form"), "submit");
    await env.until(
      () =>
        env.document.querySelector(".plugin-create-error")?.textContent ===
        expected,
    );
    assert.equal(env.editor().state.doc.toString(), "retained");
    assert.equal(env.created(), 0);
    assert.equal(env.closed(), 0);
  }
  assert.deepEqual(actions, [
    "begin",
    "append",
    "finish",
    "cancel",
    "begin",
    "append",
    "finish",
    "cancel",
  ]);
});

test("a pending save cannot dismiss or duplicate and a retired controller receives no result or continuation", async (t) => {
  const finish = deferred<{ id: string; pluginId: string }>();
  const actions: string[] = [];
  const env = await fixture({
    uploadPlugin: async (command) => {
      actions.push(command.action);
      return command.action === "finish" ? finish.promise : { id: "stage" };
    },
  });
  t.after(env.clean);
  await env.change('input[maxlength="64"]', "notes");
  await env.event(env.query("form"), "submit");
  await env.until(() => actions.includes("finish"));
  await env.event(env.query("form"), "submit");
  await env.event(env.document, "keydown", { key: "Escape" });
  assert.equal(env.closed(), 0);
  assert.equal(
    env.query<HTMLInputElement>('input[maxlength="64"]').disabled,
    true,
  );
  env.app.currentController!.current = { ...env.app, accountId: "owner-b" };
  await act(async () =>
    finish.resolve({ id: "stage", pluginId: "notes@personal" }),
  );
  assert.equal(env.created(), 0);
  assert.equal(env.closed(), 0);
  assert.deepEqual(actions, ["begin", "append", "finish"]);
});

test("archive normalization preserves custom manifests and namespaces while rejecting collisions before any RPC", () => {
  const archive = pluginArchiveFiles(
    [
      ...initialPluginFiles(),
      {
        path: ".claude-plugin/plugin.json",
        content: '{"name":"old","version":"1.0","custom":true}',
      },
      {
        path: "skills/notes/SKILL.md",
        content: "---\nname: old\n---\n\n# Owned skill",
      },
    ],
    "Notes",
    "Description",
  );
  assert.equal(
    archive.some((f) => f.path === "skills/skill/SKILL.md"),
    false,
  );
  assert.equal(
    archive.filter((f) => f.path === "skills/notes/SKILL.md").length,
    1,
  );
  assert.deepEqual(
    JSON.parse(
      archive.find((f) => f.path === ".claude-plugin/plugin.json")!.content,
    ),
    {
      name: "notes",
      version: "1.0",
      custom: true,
      description: "Description",
      skills: "./skills/",
    },
  );
  const block = pluginArchiveFiles(
    [
      {
        path: "skills/skill/SKILL.md",
        content:
          "---\nname : old\ndescription: |\n  before\n\n  later\ncustom: true\n---\n\n# Body",
      },
    ],
    "New name",
    "",
  );
  const normalized = block.find(
    (file) => file.path === "skills/new-name/SKILL.md",
  )!.content;
  assert.equal(normalized.match(/^name\s*:/gm)?.length, 1);
  assert.match(normalized, /name: "new-name"/);
  assert.doesNotMatch(normalized, /description:|before|later/);
  assert.match(normalized, /custom: true/);
  assert.throws(
    () =>
      pluginArchiveFiles(
        [{ path: ".claude-plugin", content: "collision" }],
        "notes",
        "",
      ),
    /already exists/,
  );
  assert.throws(
    () =>
      pluginArchiveFiles(
        [{ path: ".claude-plugin/plugin.json", content: "[]" }],
        "notes",
        "",
      ),
    /JSON object/,
  );
  for (const value of [
    "../x",
    "x/../y",
    "C:/x",
    "\\host\\x",
    "x//y",
    "x.",
    "x/ ",
  ])
    assert.ok(pluginDraftPathError(value, []), value);
  assert.ok(pluginDraftPathError("A.TXT", [{ path: "a.txt", content: "" }]));
  assert.throws(
    () =>
      pluginArchiveFiles(
        [
          { path: "same", content: "" },
          { path: "same", content: "" },
        ],
        "notes",
        "",
      ),
    /already exists/,
  );
});
