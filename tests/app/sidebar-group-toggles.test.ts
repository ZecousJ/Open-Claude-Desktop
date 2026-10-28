import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import {
  collapseAllGroups,
  groupToggles,
  groupViewOptions,
  toggleGroups,
} from "../../src/sidebar/group-toggles";

/**
 * A list like the sidebar's: Pinned and Recents headings, two Code group
 * headings inside Recents, and a heading in a closing (inert) section.
 * Each toggle turns its own aria-expanded over when pressed.
 */
function sidebar(states: Record<string, boolean>, inert: string[] = []) {
  const { document } = parseHTML(
    `<html><body><div id="list">${Object.keys(states)
      .map(
        (id) =>
          `<div${inert.includes(id) ? " inert" : ""}><button id="${id}" data-group-toggle="" aria-expanded="${states[id]}"></button></div>`,
      )
      .join("")}<button id="more"></button></div></body></html>`,
  );
  const presses: string[] = [];
  for (const button of document.querySelectorAll("[data-group-toggle]"))
    button.addEventListener("click", () => {
      presses.push(button.id);
      button.setAttribute(
        "aria-expanded",
        String(button.getAttribute("aria-expanded") !== "true"),
      );
    });
  return { document, list: document.getElementById("list")!, presses };
}

test("the view group offers Collapse all while a heading is open and Expand all while one is shut", () => {
  const open = sidebar({ pinned: true, recent: true });
  assert.deepEqual(groupViewOptions(open.list), {
    canCollapse: true,
    canExpand: false,
  });
  const mixed = sidebar({ pinned: false, recent: true });
  assert.deepEqual(groupViewOptions(mixed.list), {
    canCollapse: true,
    canExpand: true,
  });
  const shut = sidebar({ pinned: false, recent: false });
  assert.deepEqual(groupViewOptions(shut.list), {
    canCollapse: false,
    canExpand: true,
  });
  assert.deepEqual(groupViewOptions(null), {
    canCollapse: false,
    canExpand: false,
  });
});

test("a heading in a closing section is left alone", () => {
  const { list } = sidebar({ pinned: true, today: true }, ["today"]);
  assert.deepEqual(
    groupToggles(list, "expanded").map((toggle) => toggle.id),
    ["pinned"],
  );
});

test("Expand all presses only the shut headings, inner ones first", () => {
  const { list, presses } = sidebar({
    pinned: false,
    recent: false,
    today: true,
    older: false,
  });
  toggleGroups(list, "collapsed");
  assert.deepEqual(presses, ["older", "recent", "pinned"]);
  assert.equal(groupToggles(list, "collapsed").length, 0);
});

test("Collapse all shuts every open heading and moves focus off a heading that went away", () => {
  const { document, list, presses } = sidebar({
    pinned: true,
    recent: true,
    today: true,
    older: true,
  });
  const opener = document.getElementById("older")!;
  let frame: (() => void) | undefined;
  collapseAllGroups(list, opener, (run) => (frame = run));
  assert.deepEqual(presses, ["older", "today", "recent", "pinned"]);
  // The section closed around the opener: the last heading above it that
  // is still on screen takes focus.
  opener.parentElement!.setAttribute("inert", "");
  document.getElementById("today")!.parentElement!.setAttribute("inert", "");
  let focused = "";
  for (const id of ["pinned", "recent"])
    document.getElementById(id)!.focus = () => (focused = id);
  frame?.();
  assert.equal(focused, "recent");
});

test("Collapse all leaves focus alone when the opener is still on screen", () => {
  const { document, list } = sidebar({ pinned: true, recent: true });
  const opener = document.getElementById("recent")!;
  let frame: (() => void) | undefined;
  collapseAllGroups(list, opener, (run) => (frame = run));
  let moved = false;
  document.getElementById("pinned")!.focus = () => (moved = true);
  frame?.();
  assert.equal(moved, false);
});
