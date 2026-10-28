/**
 * Works out the formulas a workbook saved without their results (files
 * written by scripts: openpyxl never stores them), as the original's
 * spreadsheet viewer calculates them. The common operators and functions;
 * anything else is #NAME?.
 */

export type Value = number | string | boolean | FormulaError | null;

export class FormulaError {
  constructor(readonly code: string) {}
  toString() {
    return this.code;
  }
}

export const err = {
  div0: new FormulaError("#DIV/0!"),
  value: new FormulaError("#VALUE!"),
  ref: new FormulaError("#REF!"),
  name: new FormulaError("#NAME?"),
  na: new FormulaError("#N/A"),
  num: new FormulaError("#NUM!"),
};

export const isError = (v: unknown): v is FormulaError =>
  v instanceof FormulaError;

/** A rectangle of values (a range, or an array result). */
export class Range {
  constructor(readonly rows: Value[][]) {}
  get flat() {
    return this.rows.flat();
  }
}

export type Result = Value | Range;

export interface Workbook {
  /** The value of a cell (its formula worked out first); null when empty. */
  value(sheet: string, row: number, col: number): Value;
  /** The size of a sheet, so whole-column ranges stop at the data. */
  size(sheet: string): { rows: number; cols: number } | undefined;
  format(value: number, code: string): string;
}

export interface Ref {
  row: number;
  col: number;
  absRow: boolean;
  absCol: boolean;
  wholeCol?: boolean;
  wholeRow?: boolean;
}

export const colIndex = (letters: string) =>
  letters
    .toUpperCase()
    .split("")
    .reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

export const colName = (index: number) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

const refPart = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/;

export function parseRef(text: string): Ref | undefined {
  const m = refPart.exec(text);
  if (!m || m[0].length !== text.length) return undefined;
  return {
    absCol: !!m[1],
    col: colIndex(m[2]),
    absRow: !!m[3],
    row: Number(m[4]) - 1,
  };
}
