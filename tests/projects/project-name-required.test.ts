import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { parseHTML } from "linkedom";
import { ProjectEditorDialog } from "../../src/dialogs/ProjectEditorDialog";
import type { Project } from "../../shared/types";

const blank: Project = {
  id: "new",
  name: "",
  description: "",
  instructions: "",
  createdAt: 1,
};

test("Create project with no name shows 'Project name is required' under the field", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  (document as unknown as { oninput: null }).oninput = null;
  Object.assign(window, {
    desktop: {
      onEvent() {
        return () => {};
      },
    },
  });
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame: () => {},
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
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const saves: Project[] = [];
  function Harness() {
    const [draft, setDraft] = useState(blank);
    return createElement(ProjectEditorDialog, {
      project: draft,
      isExisting: false,
      coworkCreation: false,
      onChange: setDraft,
      onClose() {},
      async onSave(value) {
        saves.push(value);
      },
      async onChooseFolder() {
        return null;
      },
      onError() {},
      onArchive() {},
      onDelete() {},
    });
  }
  try {
    await act(() => root.render(createElement(Harness)));
    const field = () =>
      document.querySelector<HTMLInputElement>("input:not([type=file])")!;
    assert.equal(document.querySelector(".prj-field-error"), null);
    await act(async () => {
      document
        .querySelector("form")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    const error = document.querySelector(".prj-field-error")!;
    assert.equal(error.textContent, "Project name is required");
    assert.equal(error.getAttribute("role"), "alert");
    assert.equal(field().getAttribute("aria-invalid"), "true");
    assert.equal(field().getAttribute("aria-describedby"), error.id);
    assert.equal(saves.length, 0);
    const input = field();
    // LinkeDOM gives an input with no type attribute no type, which React does
    // not take for a text field.
    input.setAttribute("type", "text");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "Garden");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(document.querySelector(".prj-field-error"), null);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
