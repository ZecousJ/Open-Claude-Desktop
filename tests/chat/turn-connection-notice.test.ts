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
import { clayFrames } from "../../src/ui/clay-frames";
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

test("the working dots step through the measured frames", () => {
  assert.equal(clayFrames.breathe.length, 40);
  assert.equal(clayFrames.tumble.length, 60);
  for (const frame of [...clayFrames.breathe, ...clayFrames.tumble])
    assert.equal(frame.split(" ").length, 3);
  const html = renderToStaticMarkup(
    createElement(ClayMark, { motion: "tumble" }),
  );
  assert.match(html, /data-motion="tumble"/);
  assert.match(html, /height:1200px/);
  assert.match(html, /animation-duration:2s/);
  assert.match(html, /steps\(60\)/);
  assert.equal(html.match(/<circle/g)?.length, 180);
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
