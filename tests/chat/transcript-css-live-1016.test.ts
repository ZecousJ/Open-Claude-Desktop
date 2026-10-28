import test from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../support/read-source";

// The chat transcript's sizes, from the live bundle crawled on 2026-10-16.
const markdown = readSource("src/transcript/transcript-markdown.css");

test("a user bubble is at most min(85%, 29.5rem) wide", () => {
  assert.match(
    markdown,
    /\.mode-chat \.user-message \{[^}]*max-width: min\(85%, 29\.5rem\);/,
  );
});

test("a sent picture keeps its proportions within 320px, 8px apart", () => {
  assert.match(
    markdown,
    /\.mode-chat \.message-attachments \{\s*gap: 8px;\s*align-items: flex-end;/,
  );
  assert.match(markdown, /max-height: 320px;/);
  assert.match(markdown, /calc\(50% - 4px\)/);
  assert.doesNotMatch(markdown, /158px/);
});

const layout = readSource("src/transcript/turn-layout.css");

test("the prompt edit box rests on a 10% ring and focuses with the accent ring", () => {
  assert.match(
    layout,
    /\.user-message\.is-editing \{[^}]*box-shadow: inset 0 0 0 1px var\(--cds-border\);/,
  );
  assert.match(
    layout,
    /\.is-editing:focus-within \{\s*box-shadow:\s*inset 0 0 0 1px var\(--bg\),\s*0 0 0 1px #2a78d6,\s*0 0 6px 1px rgb\(24 79 149 \/ 60%\);/,
  );
  assert.doesNotMatch(layout, /#51514d|#3f67a3/);
});

test("the prompt edit field scrolls past min(40svh, 24rem)", () => {
  assert.match(
    layout,
    /\.user-message textarea \{[^}]*max-height: min\(40svh, 24rem\);[^}]*overflow-y: auto;/,
  );
});

const prose = readSource("src/live-web/transcript.css");

test("a reply's text stops short of the right edge by the live clamp, and items start again from 0", () => {
  assert.match(
    prose,
    /--reply-text-stop: clamp\(0px, \(100% - 384px\) \* 0\.175, 56px\);/,
  );
  assert.match(
    prose,
    /:is\(li, dt, dd, td, th, details, figure\) \{\s*--reply-text-stop: 0px;/,
  );
  assert.match(prose, /padding: 0 var\(--reply-text-stop\) 0 2em;/);
  assert.doesNotMatch(prose, /32px 0 4px|0 32px/);
});

test("the Chat stylesheet leaves paragraph, heading and list spacing to the Prose flow", () => {
  assert.doesNotMatch(markdown, /margin: 0 0 16px|padding-left: 40px/);
  assert.doesNotMatch(markdown, /\.mode-chat \.markdown h[1-3] \{/);
});

test("table cells take .4375em .75em of the text's own line", () => {
  assert.match(
    prose,
    /\.markdown td \{\s*padding: 0\.4375em 0\.75em;\s*height: auto;/,
  );
});
