import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { ProjectDetailsDialog } from "../../src/dialogs/ProjectDetailsDialog";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { routineDom } from "../support/routine-dom";
import type { Project } from "../../shared/types";

const original: Project = {
  id: "edit-project",
  name: "Original",
  description: "Original description",
  instructions: "Original instructions",
  createdAt: 1,
  cwd: "/actual/folder",
  icon: "Book",
};
async function setup(save: (p: Project) => Promise<void>) {
  const env = await routineDom({}, { jsdom: true });
  const old = new Map(
    ["innerWidth", "innerHeight"].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  Object.defineProperty(globalThis, "innerWidth", {
    configurable: true,
    value: 1280,
  });
  Object.defineProperty(globalThis, "innerHeight", {
    configurable: true,
    value: 800,
  });
  const reference: { current: AppController | undefined } = {
      current: undefined,
    },
    scope = {};
  const errors: unknown[] = [],
    closes: string[] = [];
  const owner = {
    accountId: "details-owner",
    controllerScope: scope,
    currentController: reference,
    snapshot: { projects: [original] },
    report: (e: unknown) => errors.push(e),
  } as unknown as AppController;
  reference.current = owner;
  await env.render(
    h(
      AppContext.Provider,
      { value: owner },
      h(ProjectDetailsDialog, {
        project: original,
        onSave: save,
        onClose: () => {
          closes.push("close");
        },
      }),
    ),
  );
  return {
    ...env,
    owner,
    reference,
    scope,
    errors,
    closes,
    async clean() {
      await env.clean();
      for (const [k, v] of old) {
        if (v) Object.defineProperty(globalThis, k, v);
        else Reflect.deleteProperty(globalThis, k);
      }
    },
  };
}

test("actual Edit details edits both fields and merges only them into the latest authoritative project", async () => {
  const saved: Project[] = [],
    env = await setup(async (p) => {
      saved.push(p);
    });
  try {
    assert.equal(
      env.document.querySelector(".modal h2")?.textContent,
      "Edit details",
    );
    assert.equal(env.document.querySelector("input")?.value, "Original");
    assert.equal(
      env.document.querySelector("textarea")?.value,
      "Original description",
    );
    await env.change("input", "  New name  ");
    await env.change("textarea", "New description\n第二行");
    const current = {
      ...original,
      instructions: "Concurrent instruction edit",
      defaultModel: "actual-model",
      color: "blue",
    };
    env.reference.current = {
      ...env.owner,
      snapshot: { projects: [current] },
    } as unknown as AppController;
    await env.event(env.document.querySelector("form")!, "submit");
    assert.deepEqual(saved, [
      { ...current, name: "New name", description: "New description\n第二行" },
    ]);
    assert.equal(original.description, "Original description");
    assert.deepEqual(env.closes, ["close"]);
  } finally {
    await env.clean();
  }
});

test("a real failed save keeps both drafts and can retry; an empty name cannot save", async () => {
  let fail = true;
  const saved: Project[] = [],
    env = await setup(async (p) => {
      if (fail) throw new Error("actual refusal");
      saved.push(p);
    });
  try {
    await env.change("input", " ");
    await env.event(env.document.querySelector("form")!, "submit");
    assert.equal(saved.length, 0);
    assert.equal(env.errors.length, 0);
    await env.change("input", "Retry name");
    await env.change("textarea", "Draft survives");
    await env.event(env.document.querySelector("form")!, "submit");
    assert.equal(env.errors.length, 1);
    assert.equal(
      env.document.querySelector("textarea")?.value,
      "Draft survives",
    );
    assert.deepEqual(env.closes, []);
    fail = false;
    await env.event(env.document.querySelector("form")!, "submit");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].description, "Draft survives");
  } finally {
    await env.clean();
  }
});

for (const change of [
  "account",
  "controller",
  "bridge",
  "deleted",
  "no-controller",
] as const)
  test(`retained Edit details rejects ${change} before the first save RPC`, async () => {
    const saved: Project[] = [],
      env = await setup(async (p) => {
        saved.push(p);
      });
    try {
      await env.change("textarea", "Must not cross an owner");
      if (change === "account")
        env.reference.current = { ...env.owner, accountId: "other-owner" };
      if (change === "controller")
        env.reference.current = { ...env.owner, controllerScope: {} };
      if (change === "bridge") env.window.desktop = { ...env.window.desktop };
      if (change === "deleted")
        env.reference.current = {
          ...env.owner,
          snapshot: { projects: [] },
        } as unknown as AppController;
      if (change === "no-controller") env.reference.current = undefined;
      await env.event(env.document.querySelector("form")!, "submit");
      assert.equal(saved.length, 0);
    } finally {
      await env.clean();
    }
  });

test("a delayed old save cannot close a replacement dialog after owner retirement", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    env = await setup(async () => gate);
  try {
    await env.event(env.document.querySelector("form")!, "submit");
    assert.equal(
      env.document
        .querySelector('button[type="submit"]')
        ?.getAttribute("aria-busy"),
      "true",
    );
    env.reference.current = {
      ...env.owner,
      accountId: "new-owner",
      controllerScope: {},
    };
    await act(async () => release());
    assert.deepEqual(env.closes, []);
  } finally {
    release();
    await env.clean();
  }
});
