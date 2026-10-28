import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { JSDOM } from "jsdom";
import { SkipAllApprovalsDialog } from "../../src/composer/SkipAllApprovalsDialogImpl";
import { mcpServerStates } from "../../electron/connectors/mcp-config-file";

test("a server's annotations decide whether a tool reads or writes", () => {
  const [state] = mcpServerStates(
    { docs: { url: "https://docs.test/mcp" } },
    true,
    new Map(),
    [
      {
        name: "docs",
        tools: {
          read: { name: "read", annotations: { readOnlyHint: true } },
          edit: { name: "edit", annotations: { readOnlyHint: false } },
          bare: { name: "bare" },
        },
      },
    ],
  );
  const access = Object.fromEntries(
    state.toolList!.map((tool) => [tool.name, tool.access]),
  );
  assert.equal(access.read, "readOnly");
  assert.equal(access.edit, "write");
  assert.equal(access.bare, undefined);
});

test("Skip all approvals lists each connector with a caret that opens its tools, marked Read-only or Write/delete", async () => {
  const dom = new JSDOM("<html><body><main></main></body></html>", {
    url: "https://app.test/",
  });
  const { window } = dom;
  (window as unknown as { desktop: unknown }).desktop = {
    mcpServers: async () => ({
      servers: [
        {
          name: "Docs",
          state: "ready",
          tools: 3,
          toolList: [
            {
              name: "read_doc",
              description: "",
              enabled: true,
              access: "readOnly",
            },
            {
              name: "edit_doc",
              description: "",
              enabled: true,
              access: "write",
            },
            {
              name: "list_docs",
              description: "",
              enabled: true,
              approval: "approve",
            },
            { name: "off", description: "", enabled: false },
          ],
        },
      ],
    }),
  };
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
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
  const root = createRoot(window.document.querySelector("main")!);
  try {
    await act(async () =>
      root.render(
        createElement(SkipAllApprovalsDialog, {
          onCancel() {},
          onConfirm() {},
          connectors: ["Docs"],
        }),
      ),
    );
    await act(async () => {});
    const row = window.document.querySelector<HTMLButtonElement>(
      ".skip-approvals-connector",
    )!;
    assert.equal(row.getAttribute("aria-expanded"), "false");
    assert.match(row.textContent ?? "", /Docs\s*3 tools/);
    assert.equal(window.document.querySelector(".skip-approvals-tools"), null);
    await act(async () => row.click());
    assert.equal(row.getAttribute("aria-expanded"), "true");
    assert.doesNotMatch(row.textContent ?? "", /tools/);
    assert.ok(row.querySelector(".skip-approvals-caret.open"));
    const tools = [
      ...window.document.querySelectorAll(".skip-approvals-tools > li"),
    ].map((item) => item.textContent);
    assert.equal(
      tools.join("|"),
      "edit_docWrite/delete|read_docRead-only|list_docsAlready allowed",
    );
  } finally {
    await act(async () => root.unmount());
    window.close();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
