import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import type { Project } from "../../shared/types";
import type { ProjectCreationCapabilities } from "../../shared/project-access";
import type { ProjectCreation } from "../../src/dialogs/ProjectCreateDialog";
import { ProjectEditorDialog } from "../../src/dialogs/ProjectEditorDialog";
import { HostContext } from "../../src/host/HostContext";
import { desktopHost } from "../../shared/host";
import { routineDom } from "../support/routine-dom";
const project: Project = {
  id: "new-project",
  name: "Bundle",
  description: "Goals",
  instructions: "",
  createdAt: 1,
};
const capabilities: ProjectCreationCapabilities = {
  routing: "classic",
  contextFiles: true,
  contextText: true,
  localFolders: false,
  educationSuggestions: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function environment(api: object = {}) {
  const env = await routineDom(
    {
      projectCreationCapabilities: async () => capabilities,
      memoryStatus: async () => ({ available: false }),
      ...api,
    } as never,
    { jsdom: true },
  );
  const globals = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
  };
  const saved = new Map(
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
  const errors: unknown[] = [],
    savedCreates: { project: Project; creation?: ProjectCreation }[] = [];
  let closed = 0;
  const props = {
    project,
    isExisting: false,
    onChange() {},
    onClose() {
      closed++;
    },
    onSave: async (project: Project, creation?: ProjectCreation) => {
      savedCreates.push({ project, creation });
    },
    onChooseFolder: async () => null,
    onError: (error: unknown) => errors.push(error),
    onArchive() {},
    onDelete() {},
  };
  const render = (patch: Partial<typeof props> = {}) =>
    env.render(
      h(
        HostContext.Provider,
        { value: desktopHost },
        h(ProjectEditorDialog, { ...props, ...patch }),
      ),
    );
  return {
    ...env,
    props,
    errors,
    savedCreates,
    closed: () => closed,
    render,
    async pick(file: File) {
      const picker = env.document.querySelector<HTMLInputElement>(
        '[data-testid="create-project-context-files"]',
      )!;
      Object.defineProperty(picker, "files", {
        configurable: true,
        value: [file, file],
      });
      await env.event(picker, "change");
    },
    async clean() {
      await env.clean();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("desktop folders do not select legacy Cowork creation; classic context uses actual capabilities", async () => {
  const env = await environment();
  try {
    env.window.desktop = {
      ...env.window.desktop,
      projectCreationCapabilities: async () => ({
        ...capabilities,
        localFolders: true,
      }),
    } as never;
    await env.render();
    assert.equal(
      env.document.querySelector("h2")?.textContent,
      "Create a project",
    );
    assert.match(
      env.document.body.textContent ?? "",
      /What are you working on\?/,
    );
    assert.ok(
      env.document.querySelector("button") &&
        [...env.document.querySelectorAll("button")].some(
          (button) => button.lastChild?.textContent === "Add context",
        ),
    );
    assert.ok(
      env.document.querySelector(
        '[data-testid="create-project-context-files"]',
      ),
    );
    assert.doesNotMatch(
      env.document.body.textContent ?? "",
      /over to Cowork|Start from scratch|Use a folder/,
    );
    env.window.desktop = {
      ...env.window.desktop,
      projectCreationCapabilities: async () => ({
        ...capabilities,
        contextFiles: false,
        contextText: false,
      }),
    } as never;
    await env.render();
    assert.equal(
      env.document.querySelector(
        '[data-testid="create-project-context-files"]',
      ),
      null,
    );
    assert.doesNotMatch(env.document.body.textContent ?? "", /Text context/);
    assert.equal(env.savedCreates.length, 0);
  } finally {
    await env.clean();
  }
});

test("one atomic create carries selected context, preserves it on failure and reuses its operation id on retry", async () => {
  const env = await environment(),
    first = deferred<void>();
  const calls: { project: Project; creation?: ProjectCreation }[] = [];
  const onSave = async (project: Project, creation?: ProjectCreation) => {
    calls.push({ project, creation });
    if (calls.length === 1) await first.promise;
  };
  try {
    await env.render({ onSave });
    const file = new env.window.File(["hello"], "notes.txt", {
      type: "text/plain",
      lastModified: 1,
    });
    await env.pick(file);
    const form = env.document.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(
        new env.window.Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new env.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].creation?.files, []);
    assert.equal(calls[0].creation?.contextFiles?.length, 1);
    assert.equal(calls[0].creation?.contextFiles?.[0], file);
    assert.equal(calls[0].creation?.contextText, undefined);
    assert.ok(calls[0].creation?.operationId);
    assert.match(env.document.body.textContent ?? "", /Creating project/);
    await env.event(env.document, "keydown", { key: "Escape" });
    assert.equal(env.closed(), 0);
    await act(async () => first.reject(new Error("Context extraction failed")));
    assert.equal(env.errors.length, 1);
    assert.match(
      env.document.querySelector('[role="alert"]')?.textContent ?? "",
      /Context extraction failed/,
    );
    assert.ok(env.document.querySelector('[aria-label="Remove notes.txt"]'));
    await env.event(form, "submit");
    assert.equal(calls.length, 2);
    assert.equal(
      calls[1].creation?.operationId,
      calls[0].creation?.operationId,
    );
  } finally {
    await env.clean();
  }
});

test("capability failure has a real retry and a retired capability reply cannot enable another host's context", async () => {
  let reads = 0;
  const old = deferred<ProjectCreationCapabilities>();
  const env = await environment({
    projectCreationCapabilities: () => {
      reads++;
      return reads === 1 ? Promise.reject(new Error("offline")) : old.promise;
    },
  });
  try {
    await env.render();
    assert.match(
      env.document.body.textContent ?? "",
      /Couldn’t load project options/,
    );
    assert.equal(env.document.querySelector("form"), null);
    const retry = [...env.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    )!;
    await env.event(retry, "click");
    assert.equal(reads, 2);
    env.window.desktop = {
      ...env.window.desktop,
      projectCreationCapabilities: async () => ({
        ...capabilities,
        contextFiles: false,
        contextText: false,
      }),
    } as never;
    await env.render();
    await act(async () => old.resolve(capabilities));
    assert.equal(
      env.document.querySelector(
        '[data-testid="create-project-context-files"]',
      ),
      null,
    );
  } finally {
    await env.clean();
  }
});

test("retired create errors and captured submit callbacks cannot affect a replacement account", async () => {
  const env = await environment(),
    pending = deferred<void>();
  let creates = 0;
  const onSave = async () => {
    creates++;
    await pending.promise;
  };
  try {
    await env.render({ onSave });
    await env.pick(
      new env.window.File(["Old private context"], "private-notes.txt", {
        lastModified: 1,
      }),
    );
    const form = env.document.querySelector("form")!;
    const key = Object.keys(form).find((key) =>
      key.startsWith("__reactProps$"),
    )!;
    const submit = (
      form as unknown as Record<
        string,
        { onSubmit(event: { preventDefault(): void }): void }
      >
    )[key].onSubmit;
    await env.event(form, "submit");
    assert.equal(creates, 1);
    env.window.desktop = { ...env.window.desktop };
    await env.render({ onSave });
    assert.equal(
      env.document.querySelector('[aria-label="Remove private-notes.txt"]'),
      null,
    );
    await act(async () => {
      submit({ preventDefault() {} });
      pending.reject(new Error("Old account failure"));
    });
    assert.equal(creates, 1);
    assert.deepEqual(env.errors, []);
    assert.doesNotMatch(
      env.document.body.textContent ?? "",
      /Old account failure|Old private context/,
    );
  } finally {
    await env.clean();
  }
});

test("only an explicit supported legacy-local routing retains the old local chooser", async () => {
  const env = await environment({
    projectCreationCapabilities: async () => ({
      ...capabilities,
      routing: "legacy-local",
      localFolders: true,
    }),
  });
  try {
    await env.render();
    assert.ok(env.document.querySelector(".prj-create-options"));
    assert.match(env.document.body.textContent ?? "", /Start from scratch/);
  } finally {
    await env.clean();
  }
});

test("classic context uses the measured official column, glyph and 28px control without an extra icon picker", async () => {
  const env = await environment();
  try {
    const style = env.document.createElement("style");
    style.textContent = readFileSync(
      new URL("../../src/dialogs/project-classic-context.css", import.meta.url),
      "utf8",
    );
    env.document.head.append(style);
    await env.render();
    const button =
      env.document.querySelector<HTMLButtonElement>(".prj-context-add")!;
    assert.ok(button);
    const css = env.window.getComputedStyle(button);
    assert.equal(css.height, "28px");
    assert.equal(css.fontSize, "14px");
    assert.equal(css.gap, "6px");
    assert.equal(css.paddingLeft, "10px");
    assert.ok(button.querySelector('[aria-hidden="true"]'));
    assert.equal(
      env.window.getComputedStyle(
        env.document.querySelector(".prj-create-context")!,
      ).flexDirection,
      "column",
    );
    assert.equal(
      env.document.querySelector(".prj-create-name .prj-settings"),
      null,
    );
  } finally {
    await env.clean();
  }
});
