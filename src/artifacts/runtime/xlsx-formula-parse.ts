import { FormulaError, err, colIndex, parseRef } from "./xlsx-formula-core";
import type { Value, Ref } from "./xlsx-formula-core";

/* ------------------------------------------------------------- lexing */

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "err"; v: string }
  | { t: "ref"; sheet?: string; a: Ref; b?: Ref }
  | { t: "fn"; v: string }
  | { t: "op"; v: string }
  | { t: "(" }
  | { t: ")" }
  | { t: "," };

export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const peek = (s: string) => src.startsWith(s, i);
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      i++;
      continue;
    }
    if (c === '"') {
      let s = "";
      i++;
      while (i < src.length) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          break;
        }
        s += src[i++];
      }
      i++;
      out.push({ t: "str", v: s });
      continue;
    }
    if (c === "#") {
      const m =
        /^#(DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!|GETTING_DATA)/i.exec(
          src.slice(i),
        );
      if (m) {
        out.push({ t: "err", v: m[0].toUpperCase() });
        i += m[0].length;
        continue;
      }
    }
    if (c === "(" || c === ")" || c === "," || c === ";") {
      out.push(c === "(" ? { t: "(" } : c === ")" ? { t: ")" } : { t: "," });
      i++;
      continue;
    }
    if (peek("<=") || peek(">=") || peek("<>")) {
      out.push({ t: "op", v: src.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>%".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    // A sheet name, quoted or not, before a reference.
    let sheet: string | undefined;
    let rest = src.slice(i);
    const quoted = /^'((?:[^']|'')+)'!/.exec(rest);
    const bare = /^([A-Za-z_\u00C0-\uFFFF][\w.\u00C0-\uFFFF]*)!/.exec(rest);
    if (quoted || bare) {
      const m = (quoted ?? bare)!;
      sheet = quoted ? m[1].replace(/''/g, "'") : m[1];
      i += m[0].length;
      rest = src.slice(i);
    }
    const range =
      /^(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?(?![\w(])/.exec(
        rest,
      ) ?? null;
    if (range) {
      const a = parseRef(range[1]);
      const b = range[2] ? parseRef(range[2]) : undefined;
      if (a) {
        out.push({ t: "ref", sheet, a, b });
        i += range[0].length;
        continue;
      }
    }
    const cols = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})(?![\w(])/.exec(rest);
    if (cols) {
      out.push({
        t: "ref",
        sheet,
        a: {
          row: 0,
          col: colIndex(cols[1]),
          absRow: true,
          absCol: true,
          wholeCol: true,
        },
        b: {
          row: 0,
          col: colIndex(cols[2]),
          absRow: true,
          absCol: true,
          wholeCol: true,
        },
      });
      i += cols[0].length;
      continue;
    }
    const rows = /^\$?(\d+):\$?(\d+)(?![\w(])/.exec(rest);
    if (rows) {
      out.push({
        t: "ref",
        sheet,
        a: {
          row: Number(rows[1]) - 1,
          col: 0,
          absRow: true,
          absCol: true,
          wholeRow: true,
        },
        b: {
          row: Number(rows[2]) - 1,
          col: 0,
          absRow: true,
          absCol: true,
          wholeRow: true,
        },
      });
      i += rows[0].length;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(rest);
    if (num) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_][\w.]*/.exec(rest);
    if (word) {
      const name = word[0]
        .toUpperCase()
        .replace(/^_XLFN\./, "")
        .replace(/^_XLWS\./, "");
      i += word[0].length;
      if (src[i] === "(") out.push({ t: "fn", v: name });
      else if (name === "TRUE" || name === "FALSE")
        out.push({ t: "bool", v: name === "TRUE" });
      else out.push({ t: "err", v: "#NAME?" });
      continue;
    }
    throw err.value;
  }
  return out;
}

export /* ------------------------------------------------------------ parsing */

type Node =
  | { k: "lit"; v: Value }
  | { k: "ref"; sheet?: string; a: Ref; b?: Ref }
  | { k: "un"; op: string; x: Node }
  | { k: "bin"; op: string; l: Node; r: Node }
  | { k: "pct"; x: Node }
  | { k: "call"; name: string; args: Node[] };

const binding: Record<string, number> = {
  "=": 1,
  "<>": 1,
  "<": 1,
  ">": 1,
  "<=": 1,
  ">=": 1,
  "&": 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
  "^": 5,
};

export function parse(tokens: Token[]): Node {
  let i = 0;
  const next = () => tokens[i++];
  const peek = () => tokens[i];
  function primary(): Node {
    const t = next();
    if (!t) throw err.value;
    switch (t.t) {
      case "num":
        return { k: "lit", v: t.v };
      case "str":
        return { k: "lit", v: t.v };
      case "bool":
        return { k: "lit", v: t.v };
      case "err":
        return { k: "lit", v: new FormulaError(t.v) };
      case "ref":
        return { k: "ref", sheet: t.sheet, a: t.a, b: t.b };
      case "op":
        if (t.v === "-" || t.v === "+")
          return { k: "un", op: t.v, x: expr(5.5) };
        throw err.value;
      case "(": {
        const x = expr(0);
        if (next()?.t !== ")") throw err.value;
        return x;
      }
      case "fn": {
        next();
        const args: Node[] = [];
        if (peek()?.t === ")") next();
        else
          for (;;) {
            if (peek()?.t === "," || peek()?.t === ")")
              args.push({ k: "lit", v: null });
            else args.push(expr(0));
            const sep = next();
            if (sep?.t === ")") break;
            if (sep?.t !== ",") throw err.value;
          }
        return { k: "call", name: t.v, args };
      }
      default:
        throw err.value;
    }
  }
  function expr(min: number): Node {
    let left = primary();
    for (;;) {
      const t = peek();
      if (t?.t === "op" && t.v === "%") {
        next();
        left = { k: "pct", x: left };
        continue;
      }
      if (t?.t !== "op" || binding[t.v] === undefined) return left;
      const power = binding[t.v];
      if (power <= min) return left;
      next();
      left = {
        k: "bin",
        op: t.v,
        l: left,
        r: expr(t.v === "^" ? power - 0.5 : power),
      };
    }
  }
  const node = expr(0);
  if (i < tokens.length) throw err.value;
  return node;
}
