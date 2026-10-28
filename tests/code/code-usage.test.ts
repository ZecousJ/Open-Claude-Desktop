import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation, Turn } from "../../shared/types";
import {
  activityGrid,
  codeUsage,
  compactTokens,
  heatLevel,
  heatTip,
  tokenComparison,
} from "../../src/code-home/usageStats";

const day = 86_400_000;
const now = new Date(2026, 8, 25, 12).getTime();
const turn = (daysAgo: number, input = 0, output = 0): Turn => ({
  id: `t${daysAgo}-${input}-${output}`,
  prompt: "",
  attachments: [],
  items: [],
  status: "completed",
  createdAt: now - daysAgo * day,
  inputTokens: input,
  outputTokens: output,
});
const conversation = (
  id: string,
  mode: Conversation["mode"],
  model: string,
  turns: Turn[],
  usage?: Conversation["usage"],
): Conversation => ({
  id,
  title: id,
  mode,
  model,
  providerId: "p",
  pinned: false,
  archived: false,
  createdAt: 0,
  updatedAt: now,
  turns,
  usage,
});

test("a range counts only its own turns, so 7 days never has more than 7 active days", () => {
  const long = conversation(
    "long",
    "code",
    "A",
    Array.from({ length: 12 }, (_, i) => turn(i, 10, 90)),
  );
  const week = codeUsage([long], "7d", now);
  assert.equal(week.activeDays, 7);
  assert.equal(week.tokens, 700);
  assert.equal(week.daily.length, 7);
  assert.equal(codeUsage([long], "all", now).activeDays, 12);
});

test("only Code conversations count, and models are ranked by share", () => {
  const usage = codeUsage(
    [
      conversation("a", "code", "Big", [turn(0, 100, 900)]),
      conversation("b", "code", "Small", [turn(1, 0, 250)]),
      conversation("chat", "chat", "Chat", [turn(0, 5_000, 5_000)]),
    ],
    "30d",
    now,
  );
  assert.equal(usage.sessions, 2);
  assert.deepEqual(
    usage.models.map((m) => [m.model, m.input, m.output, m.share]),
    [
      ["Big", 100, 900, 0.8],
      ["Small", 0, 250, 0.2],
    ],
  );
  assert.equal(usage.favoriteModel, "Big");
  assert.equal(usage.daily.at(-1)?.byModel.Big, 1000);
});

test("threads without per-turn counts contribute their totals on their last day", () => {
  const old = conversation("old", "code", "A", [turn(3), turn(2)], {
    inputTokens: 1_000,
    outputTokens: 4_000,
    totalTokens: 5_000,
  });
  const usage = codeUsage([old], "7d", now);
  assert.equal(usage.tokens, 5_000);
  assert.equal(usage.daily.at(-3)?.byModel.A, 5_000);
});

test("the Overview comparison picks among the books the total reaches, by the roll", () => {
  // 2.4M reaches all ten books (up to War and Peace at 730k).
  assert.equal(
    tokenComparison(2_400_000, 0.99),
    "You’ve used ~3× more tokens than War and Peace.",
  );
  assert.equal(
    tokenComparison(2_400_000, 0.5),
    "You’ve used ~15× more tokens than Pride and Prejudice.",
  );
  assert.equal(
    tokenComparison(60_200_000, 0),
    "You’ve used ~2736× more tokens than The Little Prince.",
  );
  // Fewer books are in reach for a small total; under twice a book's length it reads "about as many".
  assert.equal(
    tokenComparison(100_000, 0.5),
    "You’ve used ~2× more tokens than Animal Farm.",
  );
  assert.equal(
    tokenComparison(100_000, 0.99),
    "You’ve used about as many tokens as The Great Gatsby.",
  );
  assert.equal(
    tokenComparison(30_000, 0.5),
    "You’ve used about as many tokens as The Little Prince.",
  );
  assert.equal(tokenComparison(21_999), undefined);
  assert.equal(tokenComparison(0), undefined);
});

test("token counts are compact with a lower-case k, no trailing .0 and a B step", () => {
  assert.equal(compactTokens(999), "999");
  assert.equal(compactTokens(4000), "4k");
  assert.equal(compactTokens(320_800), "320.8k");
  assert.equal(compactTokens(999_960), "1M");
  assert.equal(compactTokens(80_900_000), "80.9M");
  assert.equal(compactTokens(2_000_000_000), "2B");
  assert.equal(compactTokens(1_234_000_000), "1.2B");
});

test("the heatmap shades each day against the busiest one, and leaves the future blank", () => {
  assert.equal(heatLevel(0, 10), 0);
  assert.equal(heatLevel(1, 10), 1);
  assert.equal(heatLevel(3, 10), 2);
  assert.equal(heatLevel(5, 10), 2);
  assert.equal(heatLevel(8, 10), 4);
  assert.equal(heatLevel(10, 10), 4);
  assert.equal(heatLevel(5, 0), 0);
  // The grid runs on to Saturday.
  const grid = activityGrid([], now);
  assert.equal(grid.length, 182);
  assert.deepEqual(
    grid.slice(-2).map((cell) => cell.future),
    [false, true],
  );
});

test("a heatmap day's tooltip reads date — count", () => {
  assert.equal(heatTip(new Date(2026, 9, 3), 12), "Oct 3 — 12");
  assert.equal(heatTip(new Date(2026, 0, 31), 1234), "Jan 31 — 1,234");
});

test("the Models chart tooltip lists a day's tokens per model in legend order", async () => {
  const { dayRows } = await import("../../src/code-home/ModelChart");
  const models = [
    { model: "big", input: 10, output: 5, share: 0.8 },
    { model: "small", input: 1, output: 1, share: 0.2 },
  ];
  const rows = dayRows(
    { date: new Date(2026, 8, 20), byModel: { small: 300, big: 1200, "": 50 } },
    models,
  );
  assert.deepEqual(
    rows.map((row) => [row.model, row.tokens]),
    [
      ["big", 1200],
      ["small", 300],
      ["All models", 50],
    ],
  );
  assert.notEqual(rows[0].color, rows[1].color);
  assert.deepEqual(
    dayRows({ date: new Date(2026, 8, 21), byModel: {} }, models),
    [],
  );
});
