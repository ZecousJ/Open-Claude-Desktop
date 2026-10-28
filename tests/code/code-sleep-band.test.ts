import { test } from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../../shared/types";
import {
  resumeWindowMs,
  settleSleep,
  sleepResume,
  turnProgress,
} from "../../src/code-sleep/sleep-band";

const slept = { suspendedAt: 1_000, wakeAt: 10_000 };
function session(status: string, updatedAt = 20_000, text = "a"): Conversation {
  return {
    id: `c-${status}-${text}`,
    mode: "code",
    updatedAt,
    turns: [{ id: "t", createdAt: 500, status, items: [{ text }] }],
  } as unknown as Conversation;
}

test("a turn still running right after waking will pick up", () => {
  const c = session("inProgress");
  const before = turnProgress(c.turns[0]);
  assert.equal(sleepResume(c, slept, before, slept.wakeAt + 1_000), "expected");
});

test("progress after waking means it picked up", () => {
  const before = turnProgress(session("inProgress").turns[0]);
  const later = session("inProgress", 20_000, "ab");
  assert.equal(
    sleepResume(later, slept, before, slept.wakeAt + 2_000),
    "resumed",
  );
});

test("no progress for the resume window means it could not", () => {
  const c = session("inProgress");
  const before = turnProgress(c.turns[0]);
  assert.equal(
    sleepResume(c, slept, before, slept.wakeAt + resumeWindowMs),
    "needed",
  );
});

test("an error after waking could not; a turn that finished picked up", () => {
  assert.equal(sleepResume(session("failed"), slept, undefined, 0), "needed");
  // The engine ends a turn it tears down as interrupted; the transcript says
  // so, and the band agrees rather than claiming it picked up.
  assert.equal(
    sleepResume(session("interrupted"), slept, undefined, 0),
    "needed",
  );
  assert.equal(
    sleepResume(session("interrupted", 5_000), slept, undefined, 0),
    null,
  );
  assert.equal(
    sleepResume(session("completed"), slept, undefined, 0),
    "resumed",
  );
});

test("a turn that ended before the sleep, a later turn, or a dismissed band shows nothing", () => {
  assert.equal(
    sleepResume(session("completed", 900), slept, undefined, 0),
    null,
  );
  const later = session("inProgress");
  (later.turns[0] as { createdAt: number }).createdAt = 5_000;
  assert.equal(sleepResume(later, slept, undefined, 0), null);
  const dismissed = session("failed", 20_000, "z");
  settleSleep(dismissed.id, slept);
  assert.equal(sleepResume(dismissed, slept, undefined, 0), null);
  assert.equal(
    sleepResume(
      { ...session("failed"), mode: "chat" } as Conversation,
      slept,
      undefined,
      0,
    ),
    null,
  );
});
