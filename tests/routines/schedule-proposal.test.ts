import test from "node:test";
import assert from "node:assert/strict";
import {
  scheduleProposalFrom,
  scheduleProposalPrompt,
} from "../../electron/engine/schedule-proposal";
import { proposeSchedule } from "../../shared/routine-proposals";

test("the model's JSON becomes the task, however it is wrapped", () => {
  const answer =
    'Sure!\n```json\n{"name":"Morning brief","instructions":"Summarize my day.","repeat":{"kind":"weekdays","time":"08:00"}}\n```';
  assert.deepEqual(scheduleProposalFrom("every weekday at 8", answer), {
    name: "Morning brief",
    prompt: "Summarize my day.",
    repeat: { kind: "weekdays", time: "08:00" },
  });
});

test("an unusable answer falls back to reading the words", () => {
  const words = "every weekday at 8am summarize my email";
  const fallback = scheduleProposalFrom(words, undefined);
  assert.equal(fallback.repeat.kind, "weekdays");
  for (const bad of [
    "no json here",
    '{"name":"","instructions":"x","repeat":{"kind":"daily","time":"09:00"}}',
    '{"name":"A","instructions":"x","repeat":{"kind":"daily","time":"25:00"}}',
    '{"name":"A","instructions":"x"}',
    "{not json}",
  ])
    assert.deepEqual(scheduleProposalFrom(words, bad), fallback, bad);
});

test("the prompt carries the request and the allowed schedules", () => {
  const prompt = scheduleProposalPrompt("weekly on Friday at 4pm");
  assert.equal(prompt.input, "weekly on Friday at 4pm");
  assert.match(prompt.instructions, /"kind":"weekly"/);
});

const NOW = new Date(2026, 9, 13, 12, 30, 0).getTime();
const at = (month: number, day: number, hour: number, minute = 0) =>
  new Date(2026, month, day, hour, minute).getTime();

test("a single run is read from the words: tomorrow, in N hours, a named date or day", () => {
  const once = (text: string) => proposeSchedule(text, NOW);
  assert.deepEqual(once("tomorrow at 3pm summarize my inbox").repeat, {
    kind: "once",
    at: at(9, 14, 15),
  });
  assert.equal(
    once("tomorrow at 3pm summarize my inbox").name,
    "Summarize my inbox",
  );
  assert.deepEqual(once("remind me in 2 hours to stretch").repeat, {
    kind: "once",
    at: NOW + 2 * 3_600_000,
  });
  assert.deepEqual(once("check the build in 45 minutes").repeat, {
    kind: "once",
    at: NOW + 45 * 60_000,
  });
  assert.deepEqual(once("on Oct 20 at 9:30 send the report").repeat, {
    kind: "once",
    at: at(9, 20, 9, 30),
  });
  // A date already gone this year is next year's.
  assert.deepEqual(once("on Jan 5 review taxes").repeat, {
    kind: "once",
    at: new Date(2027, 0, 5, 9, 0).getTime(),
  });
  assert.deepEqual(once("once on friday at 4pm check CI").repeat, {
    kind: "once",
    at: at(9, 16, 16),
  });
  assert.deepEqual(once("tonight check the deploy").repeat, {
    kind: "once",
    at: at(9, 13, 20),
  });
  // Repeating words win, and a moment that has passed is not a run.
  assert.equal(once("every day, tomorrow's news at 8").repeat.kind, "daily");
  assert.equal(once("every friday at 4pm check CI").repeat.kind, "weekly");
  assert.equal(once("today at 9am write notes").repeat.kind, "daily");
});

test("the model can name a single run, and a moment already past falls back to the words", () => {
  const answer = (when: string) =>
    `{"name":"Remind","instructions":"Say hi.","repeat":{"kind":"once","at":"${when}"}}`;
  assert.deepEqual(
    scheduleProposalFrom(
      "tomorrow at 3pm say hi",
      answer("2026-10-14T15:00"),
      NOW,
    ).repeat,
    { kind: "once", at: at(9, 14, 15) },
  );
  const stale = scheduleProposalFrom(
    "tomorrow at 3pm say hi",
    answer("2026-10-01T15:00"),
    NOW,
  );
  assert.deepEqual(stale, proposeSchedule("tomorrow at 3pm say hi", NOW));
  assert.deepEqual(
    scheduleProposalFrom("tomorrow at 3pm say hi", answer("tomorrow"), NOW),
    proposeSchedule("tomorrow at 3pm say hi", NOW),
  );
  const prompt = scheduleProposalPrompt("tomorrow at 3pm", NOW);
  assert.match(prompt.instructions, /"kind":"once"/);
  assert.match(prompt.instructions, /2026-10-13T12:30/);
});
