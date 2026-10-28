import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { NameCopyDialog } from "../../src/collections/customize/NameCopyDialog";
import { routineDom } from "../support/routine-dom";

for (const outcome of ["success", "failure", "unmount"] as const)
  test(`name operations settle without stale dialog callbacks after ${outcome}`, async (t) => {
    const e = await routineDom({}, { jsdom: true });
    t.after(e.clean);
    let current = true,
      closed = 0,
      finished = 0;
    let resolve!: () => void, reject!: (error: Error) => void;
    const operation = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    await e.render(
      h(NameCopyDialog, {
        title: "Duplicate plugin",
        action: "Duplicate",
        initialName: "copy",
        slug: (text) => text,
        savedAs: "Saved as ",
        isCurrent: () => current,
        onSubmit: () =>
          operation.finally(() => {
            finished++;
          }),
        onClose: () => {
          closed++;
        },
      }),
    );
    await e.event(e.document.querySelector("form")!, "submit");
    assert.equal(e.document.querySelector("input")?.disabled, true);
    if (outcome === "unmount") await e.render(h("div", {}, "Replacement page"));
    else current = false;
    await act(async () => {
      if (outcome === "failure") reject(new Error("Old account failure"));
      else resolve();
      await operation.catch(() => {});
    });
    assert.equal(finished, 1);
    assert.equal(closed, 0);
    assert.equal(e.document.querySelector('[role="alert"]'), null);
    assert.doesNotMatch(
      e.document.body.textContent ?? "",
      /Old account failure/,
    );
  });
