import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import type { Turn } from "../../shared/types";
import {
  registerConnectionCheck,
  setStreamConnected,
} from "../../src/app/connection";
import { TurnConnectionNotice } from "../../src/transcript/TurnConnectionNotice";
import { routineDom } from "../support/routine-dom";

const turn = {
  id: "t1",
  prompt: "hi",
  attachments: [],
  items: [],
  status: "inProgress",
  createdAt: 1,
} as unknown as Turn;

// The words follow what Check now found, as the original's do: not whether
// the stream is back.
test("the connection notice is a banner whose words follow the check's verdict", async () => {
  const env = await routineDom();
  let outcome: "none" | "fail" = "none";
  registerConnectionCheck(async () => {
    if (outcome === "fail") throw new Error("offline");
  });
  try {
    await env.render(h(TurnConnectionNotice, { turn }));
    assert.equal(env.document.querySelector(".reply-banner"), null);
    await act(async () => setStreamConnected(false, 1));
    const text = () =>
      env.document.querySelector(".reply-banner-text")?.textContent;
    assert.match(text() ?? "", /^Connection lost\./);
    assert.equal(
      env.document.querySelector(".reply-banner")?.getAttribute("role"),
      "status",
    );
    // The stream coming back says nothing about the reply.
    await act(async () => setStreamConnected(true, 2));
    assert.match(text() ?? "", /^Connection lost\./);
    await env.click(".reply-banner-action");
    assert.match(text() ?? "", /^No reply yet\./);
    outcome = "fail";
    await env.click(".reply-banner-action");
    assert.match(text() ?? "", /^Couldn’t check for a reply\./);
  } finally {
    registerConnectionCheck(undefined);
    await act(async () => setStreamConnected(true, 3));
    await env.clean();
  }
});
