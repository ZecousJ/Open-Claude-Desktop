import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import type { TaskBacklogItem } from "../../shared/task-backlog";

test("task suggestions reject a missing or malformed bridge response without crashing the session", async () => {
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
  let response: unknown;
  let failure: Error | undefined;
  window.desktop = {
    getTaskBacklog: async () => {
      if (failure) throw failure;
      return response;
    },
  } as unknown as Window["desktop"];
  Object.assign(globalThis, {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const oldError = console.error;
  const diagnostics: unknown[][] = [];
  console.error = (...values: unknown[]) => {
    diagnostics.push(values);
  };
  const { createRoot } = await import("react-dom/client");
  const { TaskSuggestions } =
    await import("../../src/code-home/TaskSuggestions");
  const root = createRoot(document.getElementById("root")!);
  const failures: unknown[] = [];
  let key = 0;
  const render = () =>
    act(async () => {
      root.render(
        createElement(TaskSuggestions, {
          cwd: `/fixture/task-backlog-${key++}`,
          onPrompt() {},
          onError: (error) => failures.push(error),
        }),
      );
    });
  try {
    const row = {
      id: "backlog-one",
      cwd: "/fixture",
      source: "dismissed" as const,
      title: "Fix tests",
      prompt: "Fix the failing tests",
      suggestedAt: 1,
      filedAt: 2,
    } satisfies TaskBacklogItem;
    for (const invalid of [
      undefined,
      null,
      {},
      [undefined],
      [{ id: "bad" }],
      ...[null, 1, {}, []].map((tldr) => [{ ...row, tldr }]),
    ]) {
      response = invalid;
      const before = failures.length;
      await render();
      assert.equal(failures.length, before + 1);
      assert.equal(document.querySelector(".task-suggestion-row"), null);
    }
    assert.ok(
      diagnostics.some(
        (values) => values[0] === "getTaskBacklog returned an invalid response",
      ),
    );

    // An actual empty list is valid; it is distinct from a missing fixture method.
    response = [];
    const beforeEmpty = failures.length;
    await render();
    assert.equal(failures.length, beforeEmpty);
    assert.equal(document.querySelector(".task-suggestion-row"), null);

    response = [row];
    await render();
    assert.ok(document.querySelector(".task-suggestion-row"));
    assert.equal(failures.length, beforeEmpty);
    response = [{ ...row, tldr: "Repair the failing checks" }];
    await render();
    assert.ok(document.querySelector(".task-suggestion-row"));
    assert.equal(failures.length, beforeEmpty);

    failure = new Error("Runner is unavailable");
    await render();
    assert.equal(failures.at(-1), failure);
    assert.equal(document.querySelector(".task-suggestion-row"), null);
  } finally {
    await act(async () => root.unmount());
    console.error = oldError;
    Object.assign(globalThis, previous);
  }
});

test("suggested tasks are rows of the start card list, folded past three, each deletable", async () => {
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
  const make = (id: string): TaskBacklogItem => ({
    id,
    cwd: "/fixture",
    source: "dismissed",
    title: `Task ${id}`,
    prompt: `Do ${id}`,
    suggestedAt: 1,
    filedAt: 2,
  });
  const rows = ["a", "b", "c", "d"].map(make);
  const dismissed: [string, boolean][] = [];
  window.desktop = {
    getTaskBacklog: async () => rows,
    dismissTaskBacklogItem: async (id: string, taken: boolean) => {
      dismissed.push([id, taken]);
      return true;
    },
  } as unknown as Window["desktop"];
  Object.assign(globalThis, {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { TaskSuggestions } =
    await import("../../src/code-home/TaskSuggestions");
  const root = createRoot(document.getElementById("root")!);
  const prompts: string[] = [];
  try {
    await act(async () => {
      root.render(
        createElement(TaskSuggestions, {
          cwd: "/fixture/rows",
          onPrompt: (prompt) => prompts.push(prompt),
        }),
      );
    });
    const list = document.querySelector("ul.next-steps")!;
    assert.ok(list);
    const listed = [...list.querySelectorAll(".task-suggestion-row")];
    assert.equal(listed.length, 3, "two tasks and one folded group");
    assert.equal(
      listed[0].querySelector(".next-step-title")?.textContent,
      "Task a",
    );
    assert.equal(
      listed[2].querySelector(".next-step-title")?.textContent,
      "2 more suggested tasks",
    );
    assert.equal(document.querySelector(".task-suggestions-trigger"), null);
    await act(async () =>
      listed[1]
        .querySelector(".next-step-dismiss button")!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.deepEqual(dismissed, [["b", false]]);
    await act(async () =>
      listed[0]
        .querySelector(".next-step-row")!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.deepEqual(prompts, ["Do a"]);
    assert.deepEqual(dismissed.at(-1), ["a", true]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});
