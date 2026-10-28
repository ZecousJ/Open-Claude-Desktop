import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { Project } from "../../shared/types";
import { InstructionsDialog } from "../../src/collections/projects/ProjectInstructionsDialog";
import { AppContext, type AppController } from "../../src/app/AppContext";

const project: Project = {
  id: "project",
  name: "Research {projectName}",
  description: "",
  instructions: "Saved instructions",
  createdAt: 1,
};

test("project instructions match the live copy and sixteen-row CDS field", () => {
  const html = renderToStaticMarkup(
    createElement(InstructionsDialog, {
      project,
      onClose() {},
      async onSave() {},
    }),
  );
  const { document } = parseHTML(html);
  assert.equal(
    document.querySelector("h2")!.textContent,
    "Set project instructions",
  );
  assert.equal(
    document.querySelector("form > p")!.textContent,
    "Provide Claudex with relevant instructions and information for chats within Research {projectName}.\u00a0This will work alongside your profile instructions and the selected style in a chat.",
  );
  assert.equal(
    document.querySelector("a")!.getAttribute("href"),
    "/settings/account",
  );
  const field = document.querySelector("textarea")!;
  assert.equal(field.getAttribute("rows"), "16");
  assert.equal(field.getAttribute("aria-label"), "Set project instructions");
  assert.equal(
    field.getAttribute("placeholder"),
    "Think step by step and show reasoning for complex problems. Use specific examples.",
  );
  assert.ok(field.hasAttribute("required"));
  assert.equal(
    document.querySelector(".primary")!.textContent,
    "Save instructions",
  );
  assert.ok(document.querySelector(".primary")!.hasAttribute("disabled"));
  assert.equal(
    document.querySelector(".prj-instructions-add-tools")!.textContent,
    "Add tools",
  );
  assert.equal(document.querySelector("header button"), null);
  const css = readFileSync(
    "src/collections/projects/project-overview.css",
    "utf8",
  );
  assert.match(css, /max-height: 320px/);
  assert.match(css, /resize: none/);
});

test("instructions preserve whitespace, retry, clear, cancel, and save recommended tools separately", async (context) => {
  const diagnostic = context.mock.method(console, "error", () => {});
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
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const calls: string[] = [];
  const toolCalls: unknown[] = [];
  let closed = 0;
  const change = async (value: string) => {
    await act(() => {
      const field = document.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const submit = () =>
    act(async () => {
      document
        .querySelector("form")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        );
    });
  try {
    await act(() =>
      root.render(
        createElement(AppContext.Provider, {
          value: {
            snapshot: {
              settings: {
                mcpServers: {
                  Zebra: { command: "server" },
                  Alpha: { url: "https://example.com/mcp", enabled: false },
                },
              },
            },
          } as unknown as AppController,
          children: createElement(InstructionsDialog, {
            project: {
              ...project,
              tools: { connectors: ["Zebra", "missing"] },
            },
            onClose: () => {
              closed++;
            },
            onSave: async (value) => {
              calls.push(value);
              throw new Error("Save failed");
            },
            onSaveTools: async (value) => {
              toolCalls.push(value);
            },
          }),
        }),
      ),
    );
    await submit();
    assert.deepEqual(calls, []);
    await change("  Saved instructions  ");
    assert.equal(
      document.querySelector<HTMLButtonElement>(".primary")!.disabled,
      false,
    );
    await submit();
    assert.deepEqual(calls, ["  Saved instructions  "]);
    assert.equal(
      document.querySelector('[role="alert"]')!.textContent,
      "Error saving instructions, please try again later",
    );
    assert.equal(
      document.querySelector("textarea")!.value,
      "  Saved instructions  ",
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>(".primary")!.disabled,
      false,
    );
    assert.doesNotMatch(
      document.querySelector("main")!.textContent!,
      /Save failed/,
    );
    assert.equal(
      diagnostic.mock.calls[0].arguments[0],
      "Error saving project instructions",
    );
    assert.ok(diagnostic.mock.calls[0].arguments[1] instanceof Error);
    // The same untouched draft remains eligible for another attempt.
    await submit();
    assert.deepEqual(calls, [
      "  Saved instructions  ",
      "  Saved instructions  ",
    ]);
    assert.equal(
      document.querySelector<HTMLButtonElement>(".primary")!.disabled,
      false,
    );
    await change("");
    assert.equal(
      document.querySelector(".primary")!.textContent,
      "Clear instructions",
    );
    await submit();
    assert.deepEqual(calls, [
      "  Saved instructions  ",
      "  Saved instructions  ",
      "",
    ]);
    await change(" ");
    assert.equal(
      document.querySelector(".primary")!.textContent,
      "Save instructions",
    );
    await act(() =>
      document.querySelector<HTMLButtonElement>(".secondary")!.click(),
    );
    assert.equal(closed, 1);
    // Recommended tools show as tiles with Edit.
    assert.equal(
      document.querySelector(".prj-recommended-title")?.textContent,
      "Recommended Tools:",
    );
    assert.equal(document.querySelector(".prj-instructions-add-tools"), null);
    await act(() =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Edit recommended tools"]',
        )!
        .click(),
    );
    assert.equal(
      document.querySelector("h2")!.textContent,
      "Power your project with tools",
    );
    assert.equal(document.querySelector(".prj-tools-empty"), null);
    assert.equal(
      document.querySelector(".prj-tools-group h3")!.textContent,
      "Tools",
    );
    assert.equal(document.querySelector(".primary")!.textContent, "Save");
    assert.deepEqual(
      Array.from(document.querySelectorAll("input"), (input) =>
        input.getAttribute("aria-label"),
      ),
      ["Web search", "Research", "Alpha", "Zebra"],
    );
    assert.equal(
      document.querySelector<HTMLInputElement>('input[aria-label="Zebra"]')!
        .checked,
      true,
    );
    assert.equal(
      document.querySelectorAll(".prj-tools-group")[1].querySelector("h3")!
        .textContent,
      "Connectors",
    );
    await act(() => {
      const input = document.querySelector("input")!;
      input.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    await act(() =>
      document
        .querySelector('input[aria-label="Alpha"]')!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    await act(() =>
      document
        .querySelector('input[aria-label="Zebra"]')!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    await act(() =>
      document.querySelector<HTMLButtonElement>(".primary")!.click(),
    );
    assert.deepEqual(toolCalls, [
      { webSearch: true, connectors: ["missing", "Alpha"] },
    ]);
    assert.deepEqual(calls, [
      "  Saved instructions  ",
      "  Saved instructions  ",
      "",
    ]);
    assert.equal(closed, 2);
    await act(() =>
      document.querySelector<HTMLButtonElement>(".secondary")!.click(),
    );
    assert.equal(closed, 3);
    assert.equal(toolCalls.length, 1);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
