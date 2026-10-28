import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import type { Item, Turn } from "../../shared/types";
import { workingTreeDiff } from "../../scripts/preview/agent-tool-fixtures";
import {
  clearDiffFile,
  pendingDiffFile,
  requestDiffFile,
  sameDiffFile,
} from "../../src/changes/diff-file-request";

test("a file row names its file; the See all row opens the turn's changes as a whole", async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML(
    '<html><body><main id="root"></main></body></html>',
  );
  Object.assign(globalThis, {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { CodeTurnChanges } =
    await import("../../src/code-tools/CodeFileChange");
  const root = createRoot(document.getElementById("root")!);
  const turn = {
    id: "t",
    prompt: "",
    attachments: [],
    createdAt: 1,
    status: "completed",
    items: [{ id: "d", type: "diff", text: workingTreeDiff() }],
  } as unknown as Turn;
  const opened: (string | undefined)[][] = [];
  try {
    await act(async () => {
      root.render(
        createElement(CodeTurnChanges, {
          turn,
          onOpen: (...args: (string | undefined)[]) => opened.push(args),
        }),
      );
    });
    const click = (button: Element) =>
      act(async () => {
        button.dispatchEvent(new window.Event("click", { bubbles: true }));
      });
    const rows = [...document.querySelectorAll(".turn-edits-open")];
    await click(rows[0]);
    await click(rows[1]);
    await click(rows[2]);
    assert.deepEqual(opened, [["app.js"], ["utils.js"], []]);
    assert.equal(
      document.querySelector(".turn-edits-title")?.textContent,
      "Edited 2 files",
    );
    assert.equal(rows[2].textContent, "See all");
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

test("a requested diff file waits for its conversation and matches a path relative to the folder", () => {
  const events: string[] = [];
  const target = new EventTarget();
  const previous = globalThis.window;
  Object.assign(globalThis, {
    window: Object.assign(target, {
      dispatchEvent: (event: Event) => {
        events.push(event.type);
        return true;
      },
    }),
  });
  try {
    requestDiffFile("c1", "/work/app/src/a.ts");
    assert.deepEqual(events, ["claudex:diff-file"]);
    assert.equal(pendingDiffFile("c1"), "/work/app/src/a.ts");
    assert.equal(pendingDiffFile("other"), undefined);
    clearDiffFile();
    assert.equal(pendingDiffFile("c1"), undefined);
  } finally {
    Object.assign(globalThis, { window: previous });
  }
  assert.ok(sameDiffFile("/work/app/src/a.ts", "src/a.ts"));
  assert.ok(sameDiffFile("src\\a.ts", "src/a.ts"));
  assert.ok(!sameDiffFile("/work/app/src/ba.ts", "a.ts"));
});

test("the filename of a single-file edit row is a link into the diff pane, only inside a session", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { CodeFileChange } =
    await import("../../src/code-tools/CodeFileChange");
  const { AppContext } = await import("../../src/app/AppContext");
  const item = {
    id: "e",
    type: "fileChange",
    status: "completed",
    lifecycleStatus: "completed",
    changes: [{ path: "/p/app.js", kind: { type: "update" }, diff: "a\n" }],
  } as unknown as Item;
  const bare = renderToStaticMarkup(createElement(CodeFileChange, { item }));
  assert.match(bare, /<span class="code-file-name">app\.js<\/span>/);
  const inSession = renderToStaticMarkup(
    createElement(
      AppContext.Provider,
      {
        value: {
          active: { id: "c" },
          setPanel() {},
          setArtifact() {},
        } as never,
      },
      createElement(CodeFileChange, { item }),
    ),
  );
  assert.match(
    inSession,
    /<button type="button" class="code-file-name code-file-link">app\.js<\/button>/,
  );
});

test("a session without a folder ends a turn with file cards: type, name and size", async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML(
    '<html><body><main id="root"></main></body></html>',
  );
  Object.assign(window, {
    desktop: {
      codeGitStatus: async () => ({ state: "not-git", ahead: 0, behind: 0 }),
    },
  });
  Object.assign(globalThis, {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { CodeTurnChanges } =
    await import("../../src/code-tools/CodeFileChange");
  const { AppContext } = await import("../../src/app/AppContext");
  const root = createRoot(document.getElementById("root")!);
  const turn = {
    id: "t",
    prompt: "",
    attachments: [],
    createdAt: 1,
    status: "completed",
    items: [
      {
        id: "e",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "/s/pelican.html", kind: { type: "add" }, diff: "a\n" },
        ],
        generatedFiles: [
          {
            id: "g",
            name: "pelican.html",
            path: "/s/pelican.html",
            language: "html",
            operation: "create",
            state: "ready",
            bytes: 21299,
          },
        ],
      },
    ],
  } as unknown as Turn;
  const opened: (string | undefined)[] = [];
  try {
    await act(async () => {
      root.render(
        createElement(
          AppContext.Provider,
          {
            value: {
              active: {
                id: "c-norepo",
                mode: "code",
                cwd: "/p/workspace/sessions/c885e6e9-bb32-4b40-b255-9f8c4b906c92",
                environment: { kind: "local" },
              },
            } as never,
          },
          createElement(CodeTurnChanges, {
            turn,
            onOpen: (path?: string) => opened.push(path),
          }),
        ),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const card = document.querySelector(".turn-file-card");
    assert.ok(card, "a file card");
    assert.equal(document.querySelector(".turn-edits-card"), null);
    assert.equal(card!.querySelector(".turn-file-badge")?.textContent, "HTML");
    assert.equal(
      card!.querySelector(".turn-file-name")?.textContent,
      "pelican.html",
    );
    assert.equal(card!.querySelector(".turn-file-size")?.textContent, "20.8KB");
    await act(async () => {
      card!.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    assert.deepEqual(opened, ["/s/pelican.html"]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});
