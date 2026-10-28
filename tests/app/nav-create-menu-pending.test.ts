import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { createNavCreateMenu } from "../../src/sidebar/NavCreateMenu";
import { onScheduleRequest } from "../../src/collections/routines/schedule-request";
import { routineDom } from "../support/routine-dom";

async function environment() {
  const env = await routineDom({
    routineCapabilities: async () => ({
      remote: false,
      email: false,
      slack: false,
      setupWithChat: true,
    }),
  });
  const saved = new Map(
    ["innerWidth", "innerHeight", "CustomEvent"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "innerWidth", {
    configurable: true,
    value: 1440,
  });
  Object.defineProperty(globalThis, "innerHeight", {
    configurable: true,
    value: 900,
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    writable: true,
    value: env.window.CustomEvent,
  });
  const prototype = env.window.HTMLElement.prototype;
  const scroll = Object.getOwnPropertyDescriptor(prototype, "scrollIntoView");
  prototype.scrollIntoView = () => {};
  return {
    ...env,
    async clean() {
      await env.clean();
      if (scroll) Object.defineProperty(prototype, "scrollIntoView", scroll);
      else Reflect.deleteProperty(prototype, "scrollIntoView");
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

for (const kind of ["artifacts", "scheduled"] as const) {
  for (const dismiss of ["Escape", "outside", "trigger"] as const)
    test(`${kind}: ${dismiss} cancels a genuinely pending popup without a late portal or focus`, async () => {
      const env = await environment();
      let release!: (
        module: typeof import("../../src/sidebar/NavCreatePopup"),
      ) => void;
      let loads = 0;
      const Shell = createNavCreateMenu(() => {
        loads++;
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      try {
        await env.render(h(Shell, { kind }));
        const button =
          env.document.querySelector<HTMLButtonElement>(".main-nav-create")!;
        button.focus();
        const content = button.innerHTML;
        assert.equal(loads, 0, "the eager trigger does not load its popup");
        await env.event(button, "click");
        assert.equal(loads, 1);
        assert.equal(button.getAttribute("aria-expanded"), "true");
        assert.equal(env.document.querySelector('[role="menu"]'), null);
        assert.equal(button.innerHTML, content);
        if (dismiss === "Escape")
          await env.event(env.document, "keydown", { key: "Escape" });
        else if (dismiss === "outside")
          await env.event(env.document.body, "pointerdown");
        else await env.event(button, "click");
        assert.equal(button.getAttribute("aria-expanded"), "false");
        await act(async () => {
          release(await import("../../src/sidebar/NavCreatePopup"));
        });
        assert.equal(env.document.querySelector('[role="menu"]'), null);
        assert.equal(env.document.activeElement, button);
        assert.equal(env.document.querySelector(".main-nav-create"), button);
        assert.equal(button.innerHTML, content);

        // The cached popup may be deliberately reopened after cancellation.
        await env.event(button, "click");
        assert.equal(loads, 1);
        const menu = env.document.querySelector('[role="menu"]')!;
        assert.ok(menu);
        assert.equal(menu.parentElement, env.document.body);
        await env.event(menu, "keydown", { key: "Escape" });
        assert.equal(env.document.querySelector('[role="menu"]'), null);
        assert.equal(button.getAttribute("aria-expanded"), "false");
      } finally {
        await env.clean();
      }
    });

  test(`${kind}: the mounted real menu owns inside presses and performs its existing action`, async () => {
    const env = await environment();
    let release!: (
      module: typeof import("../../src/sidebar/NavCreatePopup"),
    ) => void;
    const Shell = createNavCreateMenu(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const calls: unknown[] = [];
    env.window.desktop.createBlankArtifact = async (input) => {
      calls.push(["create", input.kind]);
      return {
        conversation: {
          id: "created",
          blankArtifact: {
            id: "actual-file",
            kind: input.kind,
            name: "Untitled",
            file: "document.html",
            createdAt: 1,
          },
          turns: [],
        },
        document: {},
      } as never;
    };
    const off = onScheduleRequest((request) =>
      calls.push(["schedule", request]),
    );
    const app = {
      accountId: "test",
      controllerScope: {},
      page: "chat",
      draftSession: "draft",
      text: "",
      providerId: "fixture",
      model: "Opus 5.5",
      report: (error: unknown) => {
        throw error;
      },
      upsert: () => calls.push(["upsert"]),
      setArtifact: () => calls.push(["artifact"]),
      setMode: () => calls.push(["mode"]),
      setActiveId: () => calls.push(["active"]),
      setArtifactRouteId: () => calls.push(["route"]),
      mode: "chat",
      sidebarView: { phone: false, open: true },
      newChat: (mode: string) => calls.push(["new", mode]),
      setText: (text: string) => calls.push(["text", text]),
      setPage: (page: string) => calls.push(["page", page]),
    } as unknown as AppController;
    try {
      await env.render(
        h(AppContext.Provider, { value: app }, h(Shell, { kind })),
      );
      const button =
        env.document.querySelector<HTMLButtonElement>(".main-nav-create")!;
      await env.event(button, "click");
      await act(async () => {
        release(await import("../../src/sidebar/NavCreatePopup"));
      });
      const menu = env.document.querySelector('[role="menu"]')!;
      const item = menu.querySelector('[role="menuitem"]')!;
      await env.event(item, "pointerdown");
      assert.equal(env.document.querySelector('[role="menu"]'), menu);
      assert.equal(button.getAttribute("aria-expanded"), "true");
      await env.event(item, "click");
      assert.equal(env.document.querySelector('[role="menu"]'), null);
      assert.deepEqual(
        calls,
        kind === "artifacts"
          ? [
              ["create", "docs"],
              ["upsert"],
              ["active"],
              ["mode"],
              ["artifact"],
              ["route"],
              ["page", "artifact"],
            ]
          : [["new", "chat"]],
      );
    } finally {
      off();
      await env.clean();
    }
  });
}

test("a pending nav popup cannot mount after its sidebar control unmounts", async () => {
  const env = await environment();
  let release!: (
    module: typeof import("../../src/sidebar/NavCreatePopup"),
  ) => void;
  const Shell = createNavCreateMenu(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  try {
    await env.render(h(Shell, { kind: "artifacts" }));
    await env.click(".main-nav-create");
    await env.render(h("div", null, "Other mode"));
    await act(async () => {
      release(await import("../../src/sidebar/NavCreatePopup"));
    });
    assert.equal(env.document.querySelector('[role="menu"]'), null);
    assert.equal(env.document.querySelector(".main-nav-create"), null);
  } finally {
    await env.clean();
  }
});
