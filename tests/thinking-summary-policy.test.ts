import test from "node:test";
import assert from "node:assert/strict";
import {
  thinkingSummaryForTurn,
  thinkingSummariesNotice,
  visibleThinkingSummary,
} from "../shared/thinking-summaries";
import type { Conversation, Settings } from "../shared/types";
const c = (patch: Partial<Conversation> = {}): Conversation =>
  ({ id: "c", mode: "code", turns: [], ...patch }) as Conversation;
const settings = { ccdThinkingSummaryOnDemand: true } as Settings;
for (const [wanted, expected] of [
  [true, "auto"],
  [false, "none"],
  [undefined, "none"],
] as const)
  test(`local Code summary request wanted=${wanted} is ${expected}`, () => {
    assert.deepEqual(
      thinkingSummaryForTurn(c({ thinkingSummariesWanted: wanted }), settings),
      { summary: expected },
    );
  });
for (const patch of [
  { mode: "chat" },
  { mode: "cowork" },
  { cloudHosted: true },
  { cloudEnvironmentId: "cloud" },
] as Partial<Conversation>[])
  test("summary request policy does not override other modes or cloud mirrors", () => {
    assert.deepEqual(
      thinkingSummaryForTurn(
        c({ thinkingSummariesWanted: true, ...patch }),
        settings,
      ),
      {},
    );
  });
test("SSH Code requests summaries according to the saved session preference", () => {
  const conversation = c({ environment: { kind: "ssh", hostId: "saved" } });
  assert.deepEqual(thinkingSummaryForTurn(conversation, settings), { summary: "none" });
  conversation.thinkingSummariesWanted = true;
  assert.deepEqual(thinkingSummaryForTurn(conversation, settings), { summary: "auto" });
});
test("Cloud Code requests summaries on a model with published support", () => {
  const conversation = c({ environment: { kind: "space", spaceId: "space" } });
  assert.deepEqual(thinkingSummaryForTurn(conversation, settings, true), { summary: "auto" });
  assert.deepEqual(thinkingSummaryForTurn(conversation, settings, false), {});
  assert.deepEqual(thinkingSummaryForTurn({ ...conversation, mode: "chat" }, settings, true), {});
});
test("disabled on-demand preserves upstream default without removing stored preference", () => {
  const conversation = c({ thinkingSummariesWanted: true });
  assert.deepEqual(
    thinkingSummaryForTurn(conversation, {
      ...settings,
      ccdThinkingSummaryOnDemand: false,
    }),
    {},
  );
  assert.equal(conversation.thinkingSummariesWanted, true);
});
test("owned Runner Code requests public summaries from a supporting model", () => {
  const conversation = c({
    environment: { kind: "space", spaceId: "fixture" },
    cloudEnvironmentId: "default",
  });
  assert.deepEqual(thinkingSummaryForTurn(conversation, settings, true), {
    summary: "auto",
  });
  assert.deepEqual(thinkingSummaryForTurn(conversation, settings, false), {});
  assert.deepEqual(
    thinkingSummaryForTurn(
      { ...conversation, cloudHosted: true },
      settings,
      true,
    ),
    {},
  );
  assert.deepEqual(
    thinkingSummaryForTurn({ ...conversation, mode: "cowork" }, settings, true),
    {},
  );
});
test("next-response notice requires visible local history without an actual public summary", () => {
  const conversation = c({ turns: [{ items: [] }] as any });
  assert.equal(thinkingSummariesNotice(conversation, settings, true), true);
  assert.equal(thinkingSummariesNotice(conversation, settings, false), false);
  assert.equal(thinkingSummariesNotice(c(), settings, true), false);
  conversation.turns[0].items = [
    {
      type: "reasoning",
      id: "r",
      summary: [null, "  "],
      content: ["raw"],
    } as any,
  ];
  assert.equal(thinkingSummariesNotice(conversation, settings, true), true);
  conversation.turns[0].items[0].summary = ["Public"];
  assert.equal(thinkingSummariesNotice(conversation, settings, true), false);
  assert.deepEqual(visibleThinkingSummary({ summary: "invalid" as any }), []);
});
