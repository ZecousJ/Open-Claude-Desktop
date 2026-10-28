import test from "node:test";
import assert from "node:assert/strict";
import { diffTexts } from "../../src/diff/text-diff";
import type { DiffFile } from "../../src/diff/diff-model";

/** Builds the new text back from the old one and a diff, to prove the diff is complete. */
function apply(before: string, file: DiffFile) {
  const old = before === "" ? [] : before.split("\n");
  const out: string[] = [];
  let at = 0;
  for (const hunk of file.hunks) {
    const start = hunk.oldLines ? hunk.oldStart - 1 : hunk.oldStart;
    while (at < start) out.push(old[at++]);
    for (const line of hunk.lines) {
      if (line.kind === "add") out.push(line.text);
      else {
        assert.equal(old[at], line.text, "the diff quotes the old lines");
        at++;
        if (line.kind === "context") out.push(line.text);
      }
    }
  }
  while (at < old.length) out.push(old[at++]);
  return out.join("\n");
}

test("equal texts have no hunks", () => {
  const file = diffTexts("a\nb\nc\n", "a\nb\nc\n", "x.txt");
  assert.deepEqual(file?.hunks, []);
  assert.equal(file?.additions, 0);
  // Only the line endings differ: still nothing to show.
  assert.deepEqual(diffTexts("a\nb\n", "a\r\nb\r\n", "x.txt")?.hunks, []);
});

test("a change is a numbered hunk with three lines of context", () => {
  const before = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  const after = before.replace("line 6", "line six");
  const file = diffTexts(before, after, "notes.txt")!;
  assert.equal(file.path, "notes.txt");
  assert.equal(file.additions, 1);
  assert.equal(file.deletions, 1);
  assert.equal(file.hunks.length, 1);
  const [hunk] = file.hunks;
  assert.deepEqual(
    [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines],
    [3, 7, 3, 7],
  );
  const kinds = hunk.lines.map((line) => line.kind);
  assert.deepEqual(kinds, [
    "context",
    "context",
    "context",
    "del",
    "add",
    "context",
    "context",
    "context",
  ]);
  const del = hunk.lines.find((line) => line.kind === "del")!;
  assert.deepEqual([del.oldNo, del.text], [6, "line 6"]);
  assert.equal(apply(before, file), after);
});

test("far apart changes make separate hunks and close ones share one", () => {
  const base = Array.from({ length: 40 }, (_, i) => `row ${i}`);
  const edit = (...at: number[]) =>
    base.map((row, i) => (at.includes(i) ? `${row}!` : row)).join("\n");
  assert.equal(diffTexts(edit(), edit(2, 30), "f")!.hunks.length, 2);
  assert.equal(diffTexts(edit(), edit(2, 7), "f")!.hunks.length, 1);
});

test("insertions, deletions and an empty side are complete diffs", () => {
  const cases: [string, string][] = [
    ["", "a\nb"],
    ["a\nb", ""],
    ["a\nb\nc", "a\nc"],
    ["a\nc", "a\nb\nc"],
    ["one\ntwo\nthree\nfour", "uno\ntwo\ntres\nfour\ncinco"],
    ["x\ny\nz", "z\ny\nx"],
  ];
  for (const [before, after] of cases) {
    const file = diffTexts(before, after, "t")!;
    assert.ok(file, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    if (before === "") assert.equal(file.deletions, 0);
    if (after === "") assert.equal(file.additions, 0);
    const lines = (text: string) => (text === "" ? [] : text.split("\n"));
    const built = apply(before, file);
    assert.deepEqual(lines(built), lines(after));
  }
});

test("a rewrite of changed words marks them for emphasis", () => {
  const file = diffTexts("const size = 10;\n", "const size = 12;\n", "a.ts")!;
  const del = file.hunks[0].lines.find((line) => line.kind === "del");
  assert.ok(del?.changed?.length);
});

test("texts that differ too much are refused, not guessed", () => {
  const many = (prefix: string) =>
    Array.from({ length: 1200 }, (_, i) => `${prefix}${i}`).join("\n");
  assert.equal(diffTexts(many("a"), many("b"), "big"), undefined);
  // The same limit can be raised.
  const small = diffTexts("1\n2\n3", "4\n5\n6", "s", { maxEdits: 2 });
  assert.equal(small, undefined);
  assert.ok(diffTexts("1\n2\n3", "4\n5\n6", "s", { maxEdits: 6 }));
});

test("random edits always give a diff that rebuilds the new text", () => {
  let seed = 7;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const text = () =>
    Array.from({ length: next(30) }, () => "abcd"[next(4)]).join("\n");
  for (let round = 0; round < 300; round++) {
    const before = text(),
      after = text();
    const file = diffTexts(before, after, "r")!;
    const lines = (value: string) => (value === "" ? [] : value.split("\n"));
    assert.deepEqual(
      lines(apply(before, file)),
      lines(after),
      `${before} -> ${after}`,
    );
  }
});
