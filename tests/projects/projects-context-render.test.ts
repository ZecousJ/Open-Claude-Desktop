import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { act, createElement as h } from "react";
import type { Project } from "../../shared/types";
import { InstructionsDialog } from "../../src/collections/projects/ProjectInstructionsDialog";
import { ProjectKnowledge } from "../../src/collections/projects/ProjectKnowledge";
import { KnowledgeList } from "../../src/collections/projects/KnowledgeList";
import { ProjectKnowledgeStore } from "../../electron/projects/project-knowledge";
import { ProjectKnowledgeUploads } from "../../electron/projects/project-knowledge-uploads";
import { routineDom } from "../support/routine-dom";

const project: Project = {
  id: "p",
  name: "Actual project",
  description: "",
  instructions: "Saved instructions",
  createdAt: 1,
};
const readonly: Project = {
  ...project,
  capabilities: { canEditInstructions: false, canEditKnowledgeBase: false },
};
async function ready(context: test.TestContext, assertion: () => void) {
  await context.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    assertion();
  });
}
function setup(context: test.TestContext, readOnly = false) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "projects-b33-ui-")),
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = { ...(readOnly ? readonly : project) };
  const store = new ProjectKnowledgeStore(root, () => [record]);
  const owner = {};
  const uploads = new ProjectKnowledgeUploads(store, { owner: () => owner });
  return { root, store, uploads, record };
}
async function environment(
  context: test.TestContext,
  backend: ReturnType<typeof setup>,
) {
  const errors: unknown[] = [],
    calls: string[] = [];
  const env = await routineDom(
    {
      listProjectKnowledge: async () => backend.uploads.list("p"),
      readProjectKnowledge: async (id, name) => {
        calls.push("read");
        return backend.store.read(id, name);
      },
      stageProjectKnowledgeFiles: async (id, files) => {
        calls.push("stage");
        return backend.uploads.stageFiles(id, files);
      },
      previewProjectKnowledgeEncoding: async (id, pending, encoding) => {
        calls.push("preview");
        return backend.uploads.previewEncoding(id, pending, encoding);
      },
      confirmProjectKnowledgeEncoding: async (id, pending, encoding) => {
        calls.push("confirm");
        return backend.uploads.confirmEncoding(id, pending, encoding);
      },
      removeProjectKnowledgePending: async (id, pending) => {
        calls.push("remove-pending");
        return backend.uploads.removePending(id, pending);
      },
      addProjectKnowledgeFiles: async () => {
        throw Error("Advertised protocol must use real staged upload");
      },
      removeProjectKnowledge: async () => {
        calls.push("remove");
        throw Error("Readonly mutation attempted");
      },
      listProjectKnowledgeDriveConnectors: async () => [],
      listProjectKnowledgeMcpServers: async () => [],
      listProjectKnowledgeRepositories: async () => [],
    },
    { jsdom: true },
  );
  const originalRaf = Object.getOwnPropertyDescriptor(
      globalThis,
      "requestAnimationFrame",
    ),
    originalCancel = Object.getOwnPropertyDescriptor(
      globalThis,
      "cancelAnimationFrame",
    );
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: env.window.requestAnimationFrame.bind(env.window),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: env.window.cancelAnimationFrame.bind(env.window),
  });
  return {
    ...env,
    errors,
    calls,
    renderKnowledge: () =>
      env.render(
        h(ProjectKnowledge, {
          projectId: "p",
          onError: (error) => errors.push(error),
        }),
      ),
    clean: async () => {
      await env.clean();
      if (originalRaf)
        Object.defineProperty(globalThis, "requestAnimationFrame", originalRaf);
      if (originalCancel)
        Object.defineProperty(
          globalThis,
          "cancelAnimationFrame",
          originalCancel,
        );
    },
  };
}

test("17: genuine readonly capability renders Project instructions, readonly field and only Close; archived owned projects remain editable", async (context) => {
  let saves = 0,
    closed = 0;
  const env = await routineDom({}, { jsdom: true });
  try {
    await env.render(
      h(InstructionsDialog, {
        project: readonly,
        onSave: async () => {
          saves++;
        },
        onClose: () => {
          closed++;
        },
      }),
    );
    assert.equal(
      env.document.querySelector("h2")?.textContent,
      "Project instructions",
    );
    assert.equal(env.document.querySelector("textarea")!.readOnly, true);
    assert.equal(env.document.querySelector("textarea")!.rows, 16);
    assert.equal(env.document.querySelector(".primary"), null);
    assert.equal(
      env.document.querySelector(".prj-instructions-add-tools"),
      null,
    );
    assert.deepEqual(
      [...env.document.querySelectorAll(".button-row button")].map(
        (button) => button.textContent,
      ),
      ["Close"],
    );
    await env.event(env.document.querySelector("form")!, "submit");
    assert.equal(saves, 0);
    await env.click(".button-row button");
    assert.equal(closed, 1);
    await env.render(
      h(InstructionsDialog, {
        project: { ...project, archivedAt: 1 },
        onSave: async () => {
          saves++;
        },
        onClose() {},
      }),
    );
    assert.equal(env.document.querySelector("textarea")!.readOnly, false);
    assert.ok(env.document.querySelector(".primary"));
  } finally {
    await env.clean();
  }
});

test("17: a retained editable submit callback cannot save after effective rights become readonly", async (context) => {
  let saves = 0;
  const env = await routineDom({}, { jsdom: true });
  try {
    const view = (record: Project) =>
      h(InstructionsDialog, {
        project: record,
        onSave: async () => {
          saves++;
        },
        onClose() {},
      });
    await env.render(view(project));
    await env.change("textarea", "Unsaved draft");
    const form = env.document.querySelector("form")!,
      key = Object.getOwnPropertyNames(form).find((name) =>
        name.startsWith("__reactProps$"),
      )!;
    const submit = (form as any)[key].onSubmit;
    await env.render(view(readonly));
    await act(async () => submit({ preventDefault() {} }));
    assert.equal(saves, 0);
    assert.equal(env.document.querySelector("textarea")!.readOnly, true);
  } finally {
    await env.clean();
  }
});

test("22: readonly context retains search and inert preview while Add, Select, sync and removal actions are absent", async (context) => {
  const backend = setup(context);
  backend.store.add("p", [
    {
      name: "reference.html",
      data: Buffer.from("<script>window.executed=true</script>Reference text"),
    },
  ]);
  backend.record.capabilities = readonly.capabilities;
  const env = await environment(context, backend);
  try {
    await env.renderKnowledge();
    await ready(context, () =>
      assert.ok(
        env.document.querySelector('button[aria-label="Search files"]'),
      ),
    );
    assert.equal(
      env.document.querySelector('button[aria-label="Add to context"]'),
      null,
    );
    assert.equal(env.document.querySelector(".prj-context-select"), null);
    assert.equal(env.document.querySelector(".prj-context-more"), null);
    await env.click('button[aria-label="Search files"]');
    await env.change('input[aria-label="Search files"]', "missing");
    assert.ok(env.document.querySelector(".prj-context-no-matches"));
    await env.change('input[aria-label="Search files"]', "");
    await env.click('button[aria-label="reference.html"]');
    await ready(context, () =>
      assert.ok(env.document.querySelector('[role="dialog"]')),
    );
    await ready(context, () =>
      assert.ok(
        env.document
          .querySelector('[role="dialog"] pre')
          ?.textContent?.includes("Reference text"),
      ),
    );
    assert.equal((env.window as any).executed, undefined);
    assert.deepEqual(env.calls, ["read"]);
    assert.deepEqual(env.errors, []);
  } finally {
    await env.clean();
  }
});

test("20: rendered durable pending chooser previews all source charsets, cancellation keeps bytes, and Confirm stores actual UTF8 through the helper", async (context) => {
  const backend = setup(context);
  const staged = await backend.uploads.stageFiles("p", [
    { name: "legacy.txt", data: Buffer.from([0x63, 0x61, 0x66, 0xe9]) },
  ]);
  const env = await environment(context, backend);
  try {
    await env.renderKnowledge();
    await ready(context, () =>
      assert.ok(
        [...env.document.querySelectorAll("button")].some(
          (button) => button.textContent === "Choose how to read this file",
        ),
      ),
    );
    const choose = () =>
      env.event(
        [...env.document.querySelectorAll("button")].find(
          (button) => button.textContent === "Choose how to read this file",
        )!,
        "click",
      );
    await choose();
    await ready(context, () =>
      assert.ok(
        env.document.querySelector('select[aria-label="Select file encoding"]'),
      ),
    );
    assert.equal(env.document.querySelectorAll("select option").length, 12);
    await ready(context, () =>
      assert.equal(
        env.document.querySelector(".prj-knowledge-encoding pre")?.textContent,
        "caf�",
      ),
    );
    await env.click(".prj-knowledge-encoding .secondary");
    assert.equal(backend.uploads.list("p").pending[0].id, staged.pending[0].id);
    await choose();
    await ready(context, () =>
      assert.ok(env.document.querySelector(".prj-knowledge-encoding select")),
    );
    const select = env.document.querySelector("select")!;
    select.value = "windows-1252";
    await env.event(select, "change");
    await ready(context, () =>
      assert.equal(
        env.document.querySelector(".prj-knowledge-encoding pre")?.textContent,
        "café",
      ),
    );
    await act(async () =>
      env.document
        .querySelector<HTMLButtonElement>(".prj-knowledge-encoding .primary")!
        .click(),
    );
    await ready(context, () =>
      assert.equal(backend.uploads.list("p").pending.length, 0),
    );
    assert.ok(env.calls.includes("confirm"));
    const read = backend.store.read("p", "legacy.txt");
    if (read.kind === "text") assert.equal(read.text, "café");
    else assert.fail("Confirmed text must be UTF8");
    assert.deepEqual(env.errors, []);
  } finally {
    await env.clean();
  }
});

test("20: actual file-input interaction uses the advertised staged protocol and leaves an undecodable file in the chooser state", async (context) => {
  const backend = setup(context),
    env = await environment(context, backend);
  try {
    await env.renderKnowledge();
    await ready(context, () =>
      assert.ok(
        env.document.querySelector(
          'button[aria-label="Add to context"]:not(:disabled)',
        ),
      ),
    );
    const input =
      env.document.querySelector<HTMLInputElement>('input[type="file"]')!;
    assert.ok(
      input.accept.includes(".docx"),
      "only a real advertised extractor broadens the accepted types",
    );
    const data = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    const file = {
      name: "from-input.txt",
      type: "text/plain",
      size: data.length,
      webkitRelativePath: "",
      arrayBuffer: async () => data.buffer,
    };
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    await env.event(input, "change");
    await ready(context, () =>
      assert.equal(backend.uploads.list("p").pending.length, 1),
    );
    await ready(context, () =>
      assert.ok(
        [...env.document.querySelectorAll("button")].some(
          (button) => button.textContent === "Choose how to read this file",
        ),
      ),
    );
    assert.deepEqual(env.calls, ["stage"]);
    assert.equal(backend.store.list("p").files.length, 0);
    assert.deepEqual(env.errors, []);
  } finally {
    await env.clean();
  }
});

test("20: the rendered extracting state shows a busy upload row without premature retry or removal controls", async () => {
  const env = await routineDom({}, { jsdom: true });
  try {
    await env.render(
      h(KnowledgeList, {
        files: [],
        waiting: [
          { id: "live", name: "live.pptx", bytes: 50, status: "extracting" },
        ],
        busy: false,
        onPick() {},
        onRemove() {},
      }),
    );
    assert.ok(
      env.document.querySelector(
        '.prj-context-pending-choice[aria-busy="true"]',
      ),
    );
    assert.ok(env.document.querySelector(".spin"));
    assert.ok(env.document.body.textContent?.includes("Uploading..."));
    assert.equal(env.document.querySelector("button"), null);
    assert.equal(env.document.querySelector('[role="alert"]'), null);
  } finally {
    await env.clean();
  }
});
