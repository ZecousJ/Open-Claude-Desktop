import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ResponseStatusAnnouncer,
  responseAnnouncement,
} from "../../src/conversation/ResponseStatusAnnouncer";

test("the reply status line names the start, the end and a stop", () => {
  assert.equal(responseAnnouncement(true, false), "Claudex is responding");
  assert.equal(
    responseAnnouncement(false, false),
    "Claudex finished the response",
  );
  assert.equal(
    responseAnnouncement(false, true),
    "Claudex’s response was interrupted.",
  );
});

test("the status line is a hidden, empty status region until a reply changes", () => {
  const html = renderToStaticMarkup(
    createElement(ResponseStatusAnnouncer, {
      conversationId: "c1",
      streaming: true,
      userStopped: false,
    }),
  );
  assert.match(html, /role="status"/);
  assert.match(html, /class="sr-only"/);
  assert.match(html, /><\/div>$/);
});
