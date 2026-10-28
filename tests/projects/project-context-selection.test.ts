import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectContextSelection } from "../../src/collections/projects/ProjectContextSelection";

test("the selection bar has one select-all checkbox, with no second Select all button", () => {
  const render = (selected: string[]) =>
    renderToStaticMarkup(
      createElement(ProjectContextSelection, {
        busy: false,
        cancelSelection() {},
        removeSelected() {},
        scope: ["a", "b"],
        selected: new Set(selected),
        setSelected() {},
      }),
    );
  const none = render([]);
  assert.equal((none.match(/type="checkbox"/g) ?? []).length, 1);
  assert.match(none, /aria-label="Select all"/);
  assert.doesNotMatch(none, />Select all</);
  assert.doesNotMatch(render(["a", "b"]), />Deselect all</);
  assert.match(render(["a"]), /1 selected/);
});
