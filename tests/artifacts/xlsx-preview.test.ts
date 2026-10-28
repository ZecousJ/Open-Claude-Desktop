import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluate,
  shiftFormula,
} from "../../src/artifacts/runtime/xlsx-formula";
import { type Value } from "../../src/artifacts/runtime/xlsx-formula-core";
import { formatValue } from "../../src/artifacts/runtime/office-xlsx-styles";

const cells: Record<string, Value> = {
  A1: 1,
  A2: 2,
  A3: 3,
  B1: "x",
  B2: "y",
  B3: "z",
  C1: 10,
  C2: 20,
  C3: 30,
};
const book = {
  size: () => ({ rows: 3, cols: 3 }),
  format: formatValue,
  value: (_sheet: string, row: number, col: number) =>
    cells[`${String.fromCharCode(65 + col)}${row + 1}`] ?? null,
};
const run = (formula: string) =>
  String(evaluate(formula, book, "Sheet1", { row: 5, col: 0 }, () => 0.5));

test("formulas saved without results are worked out as Excel does", () => {
  assert.equal(run("1+2*3"), "7");
  assert.equal(run("-2^2"), "4");
  assert.equal(run("SUM(A1:A3)+C1"), "16");
  assert.equal(run('IF(A2>1,"是","否")'), "是");
  assert.equal(run('A1&"-"&B1'), "1-x");
  assert.equal(run("VLOOKUP(2,A1:C3,3,FALSE)"), "20");
  assert.equal(run('COUNTIF(A1:A3,">=2")'), "2");
  assert.equal(run('CHOOSE(MOD(7,5)+1,"a","b","c")'), "c");
  assert.equal(run("RANDBETWEEN(1,100)"), "51");
  assert.equal(run("1/0"), "#DIV/0!");
  assert.equal(run("NOTAFUNC(1)"), "#NAME?");
  assert.equal(run("DATE(2026,10,1)"), "46296");
  assert.equal(
    shiftFormula('SUM(A1:B2)+$C$1+Sheet2!D4+"A1"', 2, 1),
    'SUM(B3:C4)+$C$1+Sheet2!E6+"A1"',
  );
});

test("number formats", () => {
  assert.equal(formatValue(1234.5, "#,##0.00"), "1,234.50");
  assert.equal(formatValue(0.256, "0.0%"), "25.6%");
  assert.equal(formatValue(90, '"¥"#,##0'), "¥90");
  assert.equal(formatValue(90, "[$¥-804]#,##0.00"), "¥90.00");
  assert.equal(formatValue(-5, "0;(0)"), "(5)");
  assert.equal(formatValue(46296, "yyyy/m/d"), "2026/10/1");
  assert.equal(formatValue(46296, 'yyyy"年"m"月"d"日"'), "2026年10月1日");
  assert.equal(formatValue(0.5, "h:mm"), "12:00");
  assert.equal(formatValue(0.1 + 0.2, "General"), "0.3");
});
