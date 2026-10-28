import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Turn } from "../../shared/types";
import {
  setStreamConnected,
  useStreamConnection,
} from "../../src/app/connection";
import { TurnConnectionNotice } from "../../src/transcript/TurnConnectionNotice";
import { ClayMark } from "../../src/ui/ClayMark";
import { modeInstructions } from "../../electron/engine/instructions";

const turn = (status: Turn["status"]): Turn =>
  ({
    id: "t1",
    prompt: "hi",
    attachments: [],
    items: [],
    status,
    createdAt: 1,
  }) as Turn;

test("the connection store tells lost from back and keeps when it was lost", () => {
  let seen: unknown;
  const Probe = () => {
    seen = useStreamConnection();
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  assert.deepEqual(seen, { connected: true });
  setStreamConnected(false, 5);
  renderToStaticMarkup(createElement(Probe));
  assert.deepEqual(seen, { connected: false, lostAt: 5 });
  setStreamConnected(true, 9);
  renderToStaticMarkup(createElement(Probe));
  assert.deepEqual(seen, { connected: true, lostAt: 5 });
});

test("a finished turn never shows the connection notice", () => {
  setStreamConnected(false);
  assert.equal(
    renderToStaticMarkup(
      createElement(TurnConnectionNotice, { turn: turn("completed") }),
    ),
    "",
  );
  setStreamConnected(true);
});

test("the working mark is the knot, paced by what the turn does", () => {
  const html = renderToStaticMarkup(
    createElement(ClayMark, { motion: "tumble" }),
  );
  assert.match(html, /class="clay-mark" data-kind="tumble"/);
  assert.equal(html.match(/<path/g)?.length, 6);
});

test("Chat is told to make artifacts as files, not to paste them", () => {
  const chat = modeInstructions("chat");
  assert.match(
    chat,
    /create it as a new file in the current working directory/,
  );
  assert.match(chat, /without repeating its contents/);
  assert.match(chat, /without network access/);
  assert.doesNotMatch(modeInstructions("code"), /artifact/);
});
