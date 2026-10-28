import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation } from "../../shared/types";
import {
  HandedOffFrom,
  HandedOffHere,
} from "../../src/transcript/HandOffMarkers";

const conversation = (extra: Partial<Conversation>): Conversation => ({
  id: "c",
  title: "Next",
  mode: "code",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  ...extra,
});

test("a handed-off session links back to its source, by the stored title when it is gone", () => {
  const source = conversation({ id: "s", title: "Fix uploads" });
  const handed = conversation({
    handedOffFrom: { conversationId: "s", turnId: "t", title: "Old title" },
  });
  const linked = renderToStaticMarkup(
    createElement(HandedOffFrom, {
      conversation: handed,
      lookup: (id) => (id === "s" ? source : undefined),
      onOpen() {},
    }),
  );
  assert.match(linked, /Started by Claudex from Fix uploads/);
  assert.match(linked, /aria-label="Go to parent session Fix uploads"/);
  assert.match(linked, /<button/);
  const gone = renderToStaticMarkup(
    createElement(HandedOffFrom, {
      conversation: handed,
      lookup: () => undefined,
      onOpen() {},
    }),
  );
  assert.match(gone, /Started by Claudex from Old title/);
  assert.doesNotMatch(gone, /<button/);
  // Neither the parent nor a stored title: the marker says so, not "Untitled".
  const untitled = renderToStaticMarkup(
    createElement(HandedOffFrom, {
      conversation: conversation({
        handedOffFrom: { conversationId: "s", turnId: "t", title: "" },
      }),
      lookup: () => undefined,
      onOpen() {},
    }),
  );
  assert.match(untitled, /Started by Claudex from another session/);
  assert.doesNotMatch(untitled, /Untitled session/);
  assert.equal(
    renderToStaticMarkup(
      createElement(HandedOffFrom, {
        conversation: conversation({}),
        lookup: () => undefined,
        onOpen() {},
      }),
    ),
    "",
  );
});

test("the source shows each session it was handed off to under that turn only", () => {
  const next = conversation({ id: "n", title: "Next steps" });
  const archived = conversation({ id: "a", title: "Tried", archived: true });
  const source = conversation({
    id: "s",
    handOffs: [
      { conversationId: "n", turnId: "t2", createdAt: 2 },
      { conversationId: "a", turnId: "t2", createdAt: 3 },
      { conversationId: "gone", turnId: "t2", createdAt: 4 },
    ],
  });
  const lookup = (id: string) =>
    [next, archived].find((value) => value.id === id);
  const html = renderToStaticMarkup(
    createElement(HandedOffHere, {
      conversation: source,
      turnId: "t2",
      lookup,
      onOpen() {},
    }),
  );
  assert.match(html, /Forked here: Next steps/);
  assert.match(html, /Forked here: Tried/);
  assert.match(html, /Archived/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.equal(
    renderToStaticMarkup(
      createElement(HandedOffHere, {
        conversation: source,
        turnId: "t1",
        lookup,
        onOpen() {},
      }),
    ),
    "",
  );
});
