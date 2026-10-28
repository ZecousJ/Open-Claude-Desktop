import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import {
  isEditable,
  openLayer,
  typesIntoComposer,
} from "../../src/composer/type-to-focus";

const page = (body: string) =>
  parseHTML(`<html><body>${body}</body></html>`).document;

const key = (value: string, extra: Partial<Record<string, boolean>> = {}) => ({
  key: value,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  defaultPrevented: false,
  ...extra,
});

test("a character typed with nothing editable focused goes to the composer", () => {
  const doc = page(`<button id="row">Chat</button><div id="text">x</div>`);
  const row = doc.getElementById("row");
  assert.equal(typesIntoComposer(key("h"), doc.body, false), true);
  assert.equal(typesIntoComposer(key("h"), row, false), true);
  // Space presses a button; on plain text it types.
  assert.equal(typesIntoComposer(key(" "), row, false), false);
  assert.equal(
    typesIntoComposer(key(" "), doc.getElementById("text"), false),
    true,
  );
});

test("shortcuts, named keys, used keys and open layers keep their typing", () => {
  const doc = page("");
  for (const modifier of ["ctrlKey", "altKey", "metaKey"])
    assert.equal(
      typesIntoComposer(key("k", { [modifier]: true }), doc.body, false),
      false,
      modifier,
    );
  assert.equal(typesIntoComposer(key("Enter"), doc.body, false), false);
  assert.equal(typesIntoComposer(key("ArrowUp"), doc.body, false), false);
  assert.equal(
    typesIntoComposer(key("1", { defaultPrevented: true }), doc.body, false),
    false,
  );
  assert.equal(
    typesIntoComposer(key("a", { isComposing: true }), doc.body, false),
    false,
  );
  assert.equal(typesIntoComposer(key("a"), doc.body, true), false);
});

test("text fields, editors and textboxes are editable; buttons are not", () => {
  const doc = page(
    `<input id="i"><textarea id="t"></textarea><div id="c" contenteditable="true"></div><div id="r" role="textbox"></div><button id="b"></button>`,
  );
  for (const id of ["i", "t", "c", "r"])
    assert.equal(isEditable(doc.getElementById(id)), true, id);
  assert.equal(isEditable(doc.getElementById("b")), false);
  assert.equal(isEditable(null), false);
  assert.equal(
    typesIntoComposer(key("a"), doc.getElementById("t"), false),
    false,
  );
});

test("an open menu, list or dialog counts as a layer unless it is inert", () => {
  assert.equal(openLayer(page(`<div role="menu"></div>`)), true);
  assert.equal(openLayer(page(`<div role="listbox"></div>`)), true);
  assert.equal(openLayer(page(`<div role="dialog"></div>`)), true);
  assert.equal(
    openLayer(page(`<div inert><div role="dialog"></div></div>`)),
    false,
  );
  assert.equal(openLayer(page(`<div role="region"></div>`)), false);
});
