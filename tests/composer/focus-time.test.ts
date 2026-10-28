import test from "node:test";
import assert from "node:assert/strict";
import {
  durationLabel,
  inQuietHours,
  quietEndLabel,
} from "../../src/focus/focus-time";

// 2026-09-28 is a Monday.
const at = (day: number, hh: number, mm = 0) =>
  new Date(2026, 8, 27 + day, hh, mm);

test("quiet hours: a night belongs to the day it starts on", () => {
  const quiet = { days: [1], start: "22:00", end: "07:00" };
  assert.equal(inQuietHours(quiet, at(1, 23)), true); // Monday night
  assert.equal(inQuietHours(quiet, at(2, 6, 59)), true); // Tuesday morning
  assert.equal(inQuietHours(quiet, at(2, 7)), false);
  assert.equal(inQuietHours(quiet, at(1, 6)), false); // Monday morning is Sunday's
  assert.equal(inQuietHours(quiet, at(2, 23)), false); // Tuesday not chosen
});

test("quiet hours within a day, the whole day, and none", () => {
  const day = { days: [0, 6], start: "09:00", end: "17:30" };
  assert.equal(inQuietHours(day, at(0, 9)), true);
  assert.equal(inQuietHours(day, at(0, 17, 30)), false);
  assert.equal(inQuietHours(day, at(1, 12)), false);
  assert.equal(
    inQuietHours({ days: [3], start: "00:00", end: "00:00" }, at(3, 15)),
    true,
  );
  assert.equal(
    inQuietHours({ days: [], start: "22:00", end: "07:00" }, at(1, 23)),
    false,
  );
  assert.equal(inQuietHours(undefined, at(1, 23)), false);
});

test("labels", () => {
  assert.equal(
    quietEndLabel({ days: [1], start: "22:00", end: "07:00" }),
    "7:00 AM",
  );
  assert.equal(durationLabel(90), "1 hr 30 min");
  assert.equal(durationLabel(45), "45 min");
  assert.equal(durationLabel(120), "2 hr");
});
