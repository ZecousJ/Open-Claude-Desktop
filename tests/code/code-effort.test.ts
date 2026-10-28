import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  codeEffortIndexAt,
  codeEffortLabels,
  codeEffortLevels,
  codeEffortPull,
  effortForMode,
} from "../../shared/code-effort";
import { chatEffortLabels, chatEffortLevels } from "../../shared/chat-effort";
import {
  createTwinkle,
  exponentialEasing,
  fieldCells,
  fieldColor,
  fieldRows,
  profileAt,
  twinkleHolds,
  twinkleNext,
  twinkleOffsets,
  twinkleShares,
} from "../../src/composer/code/code-effort-field";
import {
  rollLabel,
  settleLabel,
} from "../../src/composer/code/code-effort-labels";

test("Code effort slider maps pointer positions to six stable stops, including Ultracode", () => {
  const left = 100,
    width = 196;
  assert.deepEqual(
    codeEffortLevels.map((_, index) =>
      codeEffortIndexAt(left + 8 + ((width - 16) * index) / 5, left, width),
    ),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(codeEffortIndexAt(-100, left, width), 0);
  assert.equal(codeEffortIndexAt(1000, left, width), 5);
  assert.equal(codeEffortLabels[codeEffortLevels[5]], "Ultracode");
});

test("Code turns use their own reasoning effort without changing Chat and Cowork", () => {
  const settings = { effort: "low" as const, codeEffort: "max" as const };
  assert.equal(effortForMode(settings, "chat"), "low");
  assert.equal(effortForMode(settings, "cowork"), "low");
  assert.equal(effortForMode(settings, "code"), "max");
});

test("Chat and Cowork offer Extra and Max while keeping Ultracode exclusive to Code", () => {
  assert.deepEqual(chatEffortLevels, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(chatEffortLabels.xhigh, "Extra");
  assert.equal(chatEffortLabels.max, "Max");
  assert.equal(
    effortForMode({ effort: "xhigh", codeEffort: "ultra" }, "chat"),
    "xhigh",
  );
  assert.equal(
    effortForMode({ effort: "max", codeEffort: "ultra" }, "cowork"),
    "max",
  );
  assert.equal(
    effortForMode({ effort: "max", codeEffort: "ultra" }, "code"),
    "ultra",
  );
});

test("Dragging holds each stop a little past the midpoint, Ultracode more", () => {
  const left = 100,
    width = 196;
  const at = (progress: number) => left + 8 + ((width - 16) * progress) / 5;
  // Ordinary stops change ~2px past the midpoint, in both directions.
  assert.equal(codeEffortIndexAt(at(3.53), left, width, 3), 3);
  assert.equal(codeEffortIndexAt(at(3.57), left, width, 3), 4);
  assert.equal(codeEffortIndexAt(at(3.47), left, width, 4), 4);
  assert.equal(codeEffortIndexAt(at(3.43), left, width, 4), 3);
  // From Max, 4.6 still holds Max; 4.75 enters Ultracode.
  assert.equal(codeEffortIndexAt(at(4.6), left, width, 4), 4);
  assert.equal(codeEffortIndexAt(at(4.68), left, width, 4), 4);
  assert.equal(codeEffortIndexAt(at(4.75), left, width, 4), 5);
  // Once in Ultracode, it holds down to 4.38.
  assert.equal(codeEffortIndexAt(at(4.4), left, width, 5), 5);
  assert.equal(codeEffortIndexAt(at(4.36), left, width, 5), 4);
  // A fresh press or a jump from further left still needs the Ultracode push.
  assert.equal(codeEffortIndexAt(at(4.6), left, width), 4);
  assert.equal(codeEffortIndexAt(at(4.6), left, width, 1), 4);
  assert.equal(codeEffortIndexAt(at(4.8), left, width, 1), 5);
});

test("The pressed thumb follows the pointer on a capped rubber band", () => {
  assert.equal(codeEffortPull(0, 2), 0);
  assert.ok(Math.abs(codeEffortPull(2, 2) - 1.03) < 0.05);
  assert.ok(Math.abs(codeEffortPull(-5, 2) + 2.33) < 0.05);
  assert.ok(Math.abs(codeEffortPull(26, 2) - 4.2) < 0.05);
  assert.ok(Math.abs(codeEffortPull(-26, 2) + 4.2) < 0.05);
  // Never past the track ends.
  assert.equal(codeEffortPull(-10, 0), 0);
  assert.equal(codeEffortPull(10, 5), 0);
  assert.ok(codeEffortPull(-10, 5) < -3);
});

test("Ultracode field cells sit on a 4px lattice anchored to the track end", () => {
  const cells = fieldCells(196, 7);
  assert.deepEqual(cells, fieldCells(196, 7));
  // Cells start at x = 4k + 3 on the 196px track...
  assert.ok(cells.every(({ x }) => x >= 0 && x % 4 === 3));
  assert.equal(cells.length, 48 * fieldRows);
  assert.deepEqual(
    [...new Set(cells.map(({ y }) => y))],
    [0.5, 4.5, 8.5, 12.5, 16.5],
  );
  // ...and keep their distance from the right end at other widths (2097af56).
  const wide = fieldCells(197.6, 7);
  assert.ok(wide.every(({ x }) => Math.abs(((197.6 - x) % 4) - 1) < 1e-9));
});

test("Ultracode twinkle is a deterministic stepped walk with the measured statistics", () => {
  assert.equal(twinkleNext.length, twinkleOffsets.length);
  assert.equal(twinkleHolds.length, twinkleOffsets.length);
  const cells = 145;
  const a = createTwinkle(cells, 29);
  const b = createTwinkle(cells, 29);
  const frames: Uint8Array[] = [];
  for (let tick = 0; tick < 900; tick++) frames.push(a(tick).slice());
  assert.deepEqual(b(500), frames[500]);
  // Seeking back replays from the seed.
  assert.deepEqual(a(120), frames[120]);
  // Changes arrive in every frame, ~0.1 per cell (reference: 13.6 +- 4.1
  // for 145 lit cells, no frame without one).
  const changes = frames
    .slice(301)
    .map(
      (frame, i) =>
        frame.filter((level, cell) => level !== frames[300 + i][cell]).length,
    );
  const mean = changes.reduce((sum, n) => sum + n, 0) / changes.length;
  assert.ok(mean > 11 && mean < 17, `changes ${mean}`);
  assert.ok(Math.min(...changes) > 0);
  // Time shares per level stay near the reference's.
  const counts = twinkleOffsets.map(() => 0);
  for (const frame of frames.slice(300))
    for (const level of frame) counts[level]++;
  const total = counts.reduce((sum, n) => sum + n, 0);
  counts.forEach((count, level) =>
    assert.ok(
      Math.abs(count / total - twinkleShares[level]) < 0.05,
      `level ${level}: ${count / total}`,
    ),
  );
});

test("Twinkle levels shift the base violet in every channel", () => {
  assert.equal(fieldColor("#695c82", 0, 1), "rgb(105 92 130 / 1.000)");
  assert.equal(fieldColor("#695c82", 20, 1), "rgb(124 112 151 / 1.000)");
  assert.equal(fieldColor("#695c82", -8, 1), "rgb(97 84 122 / 1.000)");
  assert.equal(fieldColor("#695c82", 20, 0), "transparent");
});

test("The field profile dims cells toward the track start but keeps flashes visible", () => {
  assert.equal(profileAt(0), 0);
  assert.equal(profileAt(100), 0.451);
  assert.equal(profileAt(180), 1);
  assert.ok(Math.abs(profileAt(104) - 0.502) < 1e-9);
  // Composited over the bare track (#363636), the base keeps the profile...
  const shown = (fill: string, channel: number) => {
    const [, r, g, b, a] = fill.match(/rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/)!;
    const value = Number([r, g, b][channel]);
    return 0x36 + (value - 0x36) * Number(a);
  };
  const base = shown(fieldColor("#695c82", 0, 0.3), 1);
  assert.ok(Math.abs(base - (0x36 + (0x5c - 0x36) * 0.3)) < 1);
  // ...while a +21 flash keeps ~0.6 of its lit-part size.
  const flash = shown(fieldColor("#695c82", 21, 0.3), 1) - base;
  assert.ok(flash > 11 && flash < 15, `flash ${flash}`);
  // Dimmed cells never go darker than the bare track.
  assert.ok(shown(fieldColor("#695c82", -20, 0.05), 1) >= 0x36);
});

test("Ultracode front easing approaches 1 exponentially and is monotonic", () => {
  const easing = exponentialEasing(3600, 1000);
  assert.match(easing, /^linear\(0, .*, 1\)$/);
  const values = [...easing.matchAll(/(\d\.\d{4}) ([\d.]+)%/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i][0] > values[i - 1][0]);
    assert.ok(values[i][1] > values[i - 1][1]);
  }
  // 993ms into the sweep the front has covered ~65% of its travel, as
  // measured in R-0330.
  const points = [[0, 0], ...values.map(([v, p]) => [v, p / 100]), [1, 1]];
  const u = 993 / 3600;
  const i = points.findIndex(([, p]) => p >= u);
  const [v0, p0] = points[i - 1];
  const [v1, p1] = points[i];
  const at = v0 + ((v1 - v0) * (u - p0)) / (p1 - p0);
  assert.ok(Math.abs(at - 0.65) < 0.03, `front progress ${at}`);
});

test("The effort label rolls on every level change and settles once per layer", () => {
  let layers = rollLabel(
    [{ id: 0, level: "medium", phase: "steady", direction: "up" }],
    "high",
    1,
    true,
  );
  assert.deepEqual(
    layers.map(({ level, phase, direction }) => [level, phase, direction]),
    [
      ["medium", "out", "up"],
      ["high", "in", "up"],
    ],
  );
  // A quick second change drops the older outgoing layer: at most two show.
  layers = rollLabel(layers, "xhigh", 2, true);
  assert.deepEqual(
    layers.map(({ level, phase }) => [level, phase]),
    [
      ["high", "out"],
      ["xhigh", "in"],
    ],
  );
  // Going back down rolls the other way.
  assert.equal(rollLabel(layers, "high", 3, true)[1].direction, "down");
  // Each layer runs several animations; repeated end events are harmless.
  layers = settleLabel(layers, 2);
  layers = settleLabel(layers, 2);
  layers = settleLabel(layers, 1);
  assert.deepEqual(
    layers.map(({ level, phase }) => [level, phase]),
    [["xhigh", "steady"]],
  );
  // Opening the panel (or a change while closed) shows the label directly.
  assert.deepEqual(
    rollLabel(layers, "ultra", 4, false).map(({ phase }) => phase),
    ["steady"],
  );
});

test("Dark twinkle steps fade with the profile, flashes much less", () => {
  const shown = (fill: string) => {
    const [, g, a] = fill.match(/rgb\(\d+ (\d+) \d+ \/ ([\d.]+)\)/)!;
    return 0x36 + (Number(g) - 0x36) * Number(a);
  };
  const base = shown(fieldColor("#695c82", 0, 0.3));
  assert.ok(Math.abs(shown(fieldColor("#695c82", -20, 0.3)) - base + 6) < 1);
  assert.ok(shown(fieldColor("#695c82", 35, 0.3)) - base > 20);
});

const catalogItem = (id: string, efforts: string[]) => ({
  id,
  displayName: id,
  description: "",
  badges: [],
  sort: 0,
  hidden: false,
  isDefault: false,
  efforts,
  fast: false,
  usageHint: "",
});

test("Code effort levels follow the model's catalog efforts; Ultracode needs Max", async () => {
  const { codeEffortsFor, nearestSupportedEffort, stepSupportedEffort } =
    await import("../../src/composer/code/code-effort-support");
  const catalog = {
    defaultModel: null,
    items: [
      catalogItem("mid", ["low", "medium", "high"]),
      catalogItem("top", ["medium", "high", "xhigh", "max"]),
      catalogItem("none", ["minimal"]),
    ],
  } as any;
  const mid = codeEffortsFor(catalog, "mid");
  assert.deepEqual(mid, ["low", "medium", "high"]);
  const top = codeEffortsFor(catalog, "top");
  assert.deepEqual(top, ["medium", "high", "xhigh", "max", "ultra"]);
  // No catalog, no entry, or nothing usable: every level.
  assert.deepEqual(codeEffortsFor(null, "mid"), codeEffortLevels);
  assert.deepEqual(codeEffortsFor(catalog, "other"), codeEffortLevels);
  assert.deepEqual(codeEffortsFor(catalog, "none"), codeEffortLevels);
  // A drag onto Ultracode settles on High; the keys stop at the last level.
  assert.equal(nearestSupportedEffort(5, mid), 2);
  assert.equal(nearestSupportedEffort(1, mid), 1);
  assert.equal(stepSupportedEffort(2, 1, mid), 2);
  assert.equal(stepSupportedEffort(2, -1, mid), 1);
  assert.equal(nearestSupportedEffort(0, top), 1);
});

test("Ultracode's leading edge: cells light as the front reaches them, plus a small random delay", async () => {
  const { frontJitter, frontJitterMs, frontReach, frontTiming } =
    await import("../../src/composer/code/code-effort-field");
  const width = 188;
  // At the thumb the front arrives as soon as it starts; farther left, later.
  assert.equal(frontReach(width, width), frontTiming.delay);
  const near = frontReach(160, width),
    far = frontReach(40, width);
  assert.ok(near > frontTiming.delay && near < far);
  assert.ok(far <= frontTiming.delay + frontTiming.duration);
  assert.equal(frontReach(10, width), Infinity);
  // Exponential approach: the first 30px pass faster than 30px near the end.
  assert.ok(
    frontReach(width - 30, width) - frontTiming.delay <
      frontReach(48, width) - frontReach(78, width),
  );
  const jitter = frontJitter(200, 43);
  assert.equal(jitter.length, 200);
  assert.ok(jitter.every((value) => value >= 0 && value < frontJitterMs));
  assert.ok(new Set(jitter.map((value) => Math.round(value / 10))).size >= 5);
  assert.deepEqual(frontJitter(5, 43), jitter.slice(0, 5));
});
