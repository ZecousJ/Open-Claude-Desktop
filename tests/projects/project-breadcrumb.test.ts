import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import type { Project } from "../../shared/types";

test("project breadcrumb renames inline, saves once, cancels, and rolls back failures", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  (document as unknown as { oninput: null }).oninput = null;
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
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
  const prototype = window.HTMLInputElement.prototype;
  const select = Object.getOwnPropertyDescriptor(prototype, "select");
  const focus = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "focus",
  );
  let focused: HTMLElement | undefined;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  let selected = 0;
  prototype.select = () => {
    selected++;
  };
  try {
    const { createRoot } = await import("react-dom/client");
    const { ProjectBreadcrumb } =
      await import("../../src/collections/projects/ProjectBreadcrumb");
    const root = createRoot(document.querySelector("main")!);
    let project: Project = {
      id: "project",
      name: "Original",
      description: "Description",
      instructions: "Instructions",
      createdAt: 1,
    };
    const calls: Project[] = [];
    const errors: unknown[] = [];
    let back = 0;
    let backHref: string | undefined;
    let reject: ((error: unknown) => void) | undefined;
    const render = () =>
      root.render(
        createElement(ProjectBreadcrumb, {
          project,
          backHref,
          onBack: () => {
            back++;
          },
          onSave: (next) => {
            calls.push(next);
            return new Promise<void>((_resolve, fail) => {
              reject = fail;
            });
          },
          onError: (error) => {
            errors.push(error);
          },
        }),
      );
    const name = () =>
      document.querySelector<HTMLButtonElement>(".prj-crumb-name")!;
    const input = () => document.querySelector<HTMLInputElement>("input")!;
    const open = async () => {
      await act(() => name().click());
      assert.equal(input().getAttribute("aria-label"), "Project name");
      assert.equal(input().value, project.name);
    };
    const change = async (value: string) => {
      await act(() => {
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
          input(),
          value,
        );
        input().dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    };
    const key = async (value: string, composing = false) => {
      const event = new window.Event("keydown", {
        bubbles: true,
        cancelable: true,
      });
      Object.assign(event, { key: value, isComposing: composing });
      await act(() => input().dispatchEvent(event));
      return event;
    };
    try {
      await act(render);
      await act(() =>
        document.querySelector<HTMLButtonElement>("nav > button")!.click(),
      );
      assert.equal(back, 1);
      assert.equal(name().getAttribute("aria-label"), "Rename Original");
      await open();
      assert.equal(selected, 1);
      assert.equal(focused, input());
      await act(() =>
        input().dispatchEvent(new window.Event("focusout", { bubbles: true })),
      );
      assert.ok(input());
      assert.equal(calls.length, 0);
      await change("  Renamed  ");
      assert.equal((await key("Enter", true)).defaultPrevented, false);
      assert.ok(input());
      assert.equal(calls.length, 0);
      assert.equal((await key("Enter")).defaultPrevented, true);
      assert.equal(focused, name());
      assert.deepEqual(calls, [{ ...project, name: "Renamed" }]);
      assert.equal(name().textContent, "Renamed");
      const failure = new Error("Save failed");
      await act(async () => {
        reject!(failure);
      });
      assert.equal(name().textContent, "Original");
      assert.deepEqual(errors, [failure]);

      await open();
      await change("Cancelled");
      assert.equal((await key("Escape")).defaultPrevented, true);
      assert.equal(focused, name());
      assert.equal(name().textContent, "Original");
      assert.equal(calls.length, 1);
      for (const value of ["   ", " Original "]) {
        await open();
        await change(value);
        await key("Enter");
      }
      assert.equal(calls.length, 1);

      await open();
      await change("Blurred");
      await new Promise((resolve) => setTimeout(resolve, 260));
      await act(() =>
        input().dispatchEvent(new window.Event("focusout", { bubbles: true })),
      );
      assert.deepEqual(calls.at(-1), { ...project, name: "Blurred" });
      assert.equal(calls.length, 2);
      assert.equal(name().textContent, "Blurred");
      project = { ...project, name: "Blurred" };
      await act(render);
      assert.equal(name().textContent, "Blurred");

      backHref = "/projects";
      await act(render);
      const link = document.querySelector<HTMLAnchorElement>("nav > a")!;
      assert.equal(link.getAttribute("href"), "/projects");
      const click = async (modifiers: Record<string, unknown>) => {
        const event = new window.Event("click", {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(event, { button: 0, ...modifiers });
        await act(() => link.dispatchEvent(event));
        return event;
      };
      assert.equal((await click({ metaKey: true })).defaultPrevented, false);
      assert.equal((await click({ ctrlKey: true })).defaultPrevented, false);
      assert.equal((await click({ button: 1 })).defaultPrevented, false);
      assert.equal(back, 1);
      assert.equal((await click({})).defaultPrevented, true);
      assert.equal(back, 2);
    } finally {
      await act(() => root.unmount());
    }
  } finally {
    if (select) Object.defineProperty(prototype, "select", select);
    else Reflect.deleteProperty(prototype, "select");
    if (focus)
      Object.defineProperty(window.HTMLElement.prototype, "focus", focus);
    else Reflect.deleteProperty(window.HTMLElement.prototype, "focus");
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
