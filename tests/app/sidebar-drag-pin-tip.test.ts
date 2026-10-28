import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  dragPinTipKey,
  dragPinTipSeen,
  dragPinTipText,
  markDragPinTipSeen,
  offersDragPinTip,
} from "../../src/sidebar/drag-pin-tip";
import { dragPinTipPlacement } from "../../src/sidebar/DragPinTip";
import { collapseWidth } from "../../src/sidebar/sidebar-visibility";

const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
};

test("a pin from the menu offers the tip only while it is unseen and the sidebar is an open column", () => {
  const wide = collapseWidth() + 200;
  const base = { pinning: true, seen: false, sidebarShown: true, width: wide };
  assert.equal(offersDragPinTip(base), true);
  // Unpinning, a tip already dismissed, a hidden or peeking sidebar, or a
  // window narrower than the collapse width: no tip.
  assert.equal(offersDragPinTip({ ...base, pinning: false }), false);
  assert.equal(offersDragPinTip({ ...base, seen: true }), false);
  assert.equal(offersDragPinTip({ ...base, sidebarShown: false }), false);
  assert.equal(
    offersDragPinTip({ ...base, width: collapseWidth() - 1 }),
    false,
  );
});

test("closing the tip marks it seen for good", () => {
  const store = memory();
  assert.equal(dragPinTipSeen(store), false);
  markDragPinTipSeen(store);
  assert.equal(store.values.get(dragPinTipKey), "1");
  assert.equal(dragPinTipSeen(store), true);
});

test("storage that refuses reads or writes leaves the tip unseen without throwing", () => {
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(dragPinTipSeen(broken), false);
  assert.doesNotThrow(() => markDragPinTipSeen(broken));
  assert.equal(dragPinTipSeen(undefined), false);
});

test("the tip names the rows of the list it sits in", () => {
  assert.equal(
    dragPinTipText("chat"),
    "Tip: you can drag chats here to pin them",
  );
  assert.equal(
    dragPinTipText("code"),
    "Tip: you can drag sessions here to pin them",
  );
  assert.equal(
    dragPinTipText("cowork"),
    "Tip: you can drag tasks here to pin them",
  );
});

test("the card sits 10px right of the heading, centred on it, its arrow on the heading", () => {
  const view = { width: 1200, height: 800 };
  const size = { width: 260, height: 62 };
  const box = { top: 200, bottom: 226, right: 248 };
  const place = dragPinTipPlacement(box, size, view);
  assert.equal(place.left, 258);
  assert.equal(place.top, 213 - 31);
  assert.equal(place.arrow, 31);
  // Near the top of the window the card stays 8px in and the arrow follows
  // the heading, kept 16px off the card's corner.
  const high = dragPinTipPlacement(
    { top: 0, bottom: 20, right: 248 },
    size,
    view,
  );
  assert.equal(high.top, 8);
  assert.equal(high.arrow, 30);
  // A card too short for the arrow's padding keeps it in the middle.
  const short = dragPinTipPlacement(box, { width: 260, height: 44 }, view);
  assert.equal(short.arrow, 22);
});

test("the global field rules step the rim on hover and turn it red when invalid, below any class rule", () => {
  const css = readFileSync("src/styles/00-foundation.css", "utf8");
  assert.match(css, /--field-rim:\s*var\(--alpha-2\)/);
  assert.match(css, /--field-rim-hover:\s*var\(--alpha-3\)/);
  assert.match(css, /--field-invalid:\s*var\(--focus-danger\)/);
  assert.match(css, /border:\s*1px solid var\(--field-rim\);/);
  // The hover and invalid rules wrap their states in :where() so they weigh
  // no more than the element name.
  assert.match(
    css,
    /textarea:where\(:hover:not\(:focus, :disabled, \[aria-invalid="true"\]\)\)/,
  );
  assert.match(
    css,
    /input:where\(\[aria-invalid="true"\]\),\s*textarea:where\(\[aria-invalid="true"\]\),\s*select:where\(\[aria-invalid="true"\]\)\s*\{\s*border-color: var\(--field-invalid\);/,
  );
  assert.match(
    css,
    /input:focus:where\(\[aria-invalid="true"\]\)[\s\S]*?box-shadow: 0 0 6px 1px var\(--focus-danger-glow\);/,
  );
  // The hover rule comes after the base rule and before the focus rule.
  const base = css.indexOf("border: 1px solid var(--field-rim);");
  const hover = css.indexOf("border-color: var(--field-rim-hover);");
  const focus = css.indexOf("border-color: var(--field-focus);");
  assert.ok(base < hover && hover < focus);
});
