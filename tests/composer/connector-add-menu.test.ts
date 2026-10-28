import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { ConnectorAddMenu } from "../../src/composer/ConnectorAddMenu";
import {
  readConnectorsEntry,
  requestConnectorsEntry,
  takeConnectorsEntry,
} from "../../src/settings/navigation";
import { routineDom } from "../support/routine-dom";

const labels = (root: ParentNode) =>
  [...root.querySelectorAll("button")].map(
    (button) =>
      button.querySelector("span:not([aria-hidden])")?.textContent ?? "",
  );

test("with the right to add a custom connector, Add connector opens Browse connectors and Add custom connector", async () => {
  const env = await routineDom();
  const calls: string[] = [];
  try {
    await env.render(
      h(ConnectorAddMenu, {
        sheet: true,
        canAddCustom: true,
        onBrowse: () => calls.push("browse"),
        onAddCustom: () => calls.push("custom"),
      }),
    );
    assert.deepEqual(labels(env.document.body), ["Add connector"]);
    const row = env.document.querySelector("button")!;
    assert.equal(row.getAttribute("aria-haspopup"), "menu");
    await act(async () => row.click());
    const panel = env.document.querySelector('[role="menu"]')!;
    assert.deepEqual(labels(panel), [
      "Browse connectors",
      "Add custom connector",
    ]);
    assert.ok(panel.querySelector('[data-icon="Library"]'));
    assert.ok(panel.querySelector('[data-icon="DotsHorizontal"]'));
    await act(async () => panel.querySelectorAll("button")[1]!.click());
    await act(async () => panel.querySelectorAll("button")[0]!.click());
    assert.deepEqual(calls, ["custom", "browse"]);
  } finally {
    await env.clean();
  }
});

test("without that right the row is Browse connectors alone, with no submenu", async () => {
  const env = await routineDom();
  const calls: string[] = [];
  try {
    await env.render(
      h(ConnectorAddMenu, {
        sheet: false,
        canAddCustom: false,
        onBrowse: () => calls.push("browse"),
        onAddCustom: () => calls.push("custom"),
      }),
    );
    assert.deepEqual(labels(env.document.body), ["Browse connectors"]);
    const row = env.document.querySelector("button")!;
    assert.equal(row.getAttribute("aria-haspopup"), null);
    assert.equal(env.document.querySelector(".composer-add-chevron"), null);
    await act(async () => row.click());
    assert.deepEqual(calls, ["browse"]);
  } finally {
    await env.clean();
  }
});

test("Settings opens Connectors on the entry the menu asked for, once", () => {
  assert.equal(readConnectorsEntry(), undefined);
  requestConnectorsEntry("discover");
  assert.equal(readConnectorsEntry(), "discover");
  assert.equal(takeConnectorsEntry(), "discover");
  assert.equal(readConnectorsEntry(), undefined);
});
