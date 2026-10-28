import { lex, type Node, parse } from "./xlsx-formula-parse";
import {
  type Value,
  FormulaError,
  err,
  isError,
  Range,
  type Result,
  type Workbook,
  colIndex,
  colName,
} from "./xlsx-formula-core";

/** Moves a shared formula's relative references by (rows, cols). */
export function shiftFormula(src: string, rows: number, cols: number) {
  if (!rows && !cols) return src;
  return src.replace(
    /("(?:[^"]|"")*")|(?<![\w$.])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![\w(])/g,
    (match, str, absCol, letters, absRow, digits) => {
      if (str) return str;
      const col = absCol ? colIndex(letters) : colIndex(letters) + cols;
      const row = absRow ? Number(digits) : Number(digits) + rows;
      if (col < 0 || row < 1) return "#REF!";
      return `${absCol}${colName(col)}${absRow}${row}`;
    },
  );
}

/* --------------------------------------------------------- evaluation */

const toNumber = (v: Value): number | FormulaError => {
  if (isError(v)) return v;
  if (v === null || v === "") return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  const n = Number(v.trim().replace(/,/g, ""));
  return v.trim() !== "" && Number.isFinite(n) ? n : err.value;
};
const toText = (v: Value): string | FormulaError => {
  if (isError(v)) return v;
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(Number(v.toPrecision(15)));
  return v;
};
const toBool = (v: Value): boolean | FormulaError => {
  if (isError(v)) return v;
  if (typeof v === "string") {
    const u = v.toUpperCase();
    if (u === "TRUE") return true;
    if (u === "FALSE") return false;
    return err.value;
  }
  return !!v;
};
const scalar = (r: Result): Value =>
  r instanceof Range ? (r.rows[0]?.[0] ?? null) : r;
const values = (r: Result): Value[] => (r instanceof Range ? r.flat : [r]);
const numbersOf = (args: Result[], direct = true) => {
  const out: number[] = [];
  for (const a of args) {
    if (a instanceof Range) {
      for (const v of a.flat) {
        if (isError(v)) throw v;
        if (typeof v === "number") out.push(v);
      }
    } else {
      if (isError(a)) throw a;
      if (a === null) continue;
      const n = direct ? toNumber(a) : typeof a === "number" ? a : null;
      if (isError(n)) throw n;
      if (n !== null) out.push(n);
    }
  }
  return out;
};

/** A criteria test as SUMIF and COUNTIF read it (">=10", "a*", 5). */
function criteria(c: Value): (v: Value) => boolean {
  if (typeof c === "number" || typeof c === "boolean")
    return (v) => v === c || (typeof v === "string" && v === String(c));
  const text = toText(c);
  if (isError(text)) return () => false;
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(text)!;
  const op = m[1] ?? "=";
  const rhs = m[2];
  const n = rhs.trim() !== "" ? Number(rhs) : NaN;
  if (Number.isFinite(n) && op !== "=" && op !== "<>")
    return (v) =>
      typeof v === "number" &&
      (op === "<" ? v < n : op === ">" ? v > n : op === "<=" ? v <= n : v >= n);
  const pattern = new RegExp(
    `^${rhs
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/~\*/g, "\u0001")
      .replace(/~\?/g, "\u0002")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
      .replace(/\u0001/g, "\\*")
      .replace(/\u0002/g, "\\?")}$`,
    "i",
  );
  const equal = (v: Value) =>
    Number.isFinite(n) && typeof v === "number"
      ? v === n
      : rhs === ""
        ? v === null || v === ""
        : typeof v === "string" && pattern.test(v);
  return op === "<>" ? (v) => !equal(v) : equal;
}

const dateSerial = (y: number, m: number, d: number) =>
  Date.UTC(y, m - 1, d) / 86400000 + 25569;
const fromSerial = (n: number) => new Date(Math.round((n - 25569) * 86400000));
const roundTo = (n: number, digits: number, mode: "round" | "up" | "down") => {
  const f = 10 ** digits;
  const x = Math.abs(n) * f;
  const r =
    mode === "round"
      ? Math.round(x + 1e-9)
      : mode === "up"
        ? Math.ceil(x - 1e-9)
        : Math.floor(x + 1e-9);
  return (Math.sign(n) * r) / f;
};

export function evaluate(
  formula: string,
  book: Workbook,
  sheet: string,
  here: { row: number; col: number },
  random: () => number,
): Value {
  let tree: Node;
  try {
    tree = parse(lex(formula));
  } catch (e) {
    return isError(e) ? e : err.value;
  }
  const range = (node: Extract<Node, { k: "ref" }>): Result => {
    const name = node.sheet ?? sheet;
    const size = book.size(name);
    if (!size) return err.ref;
    const a = node.a;
    const b = node.b ?? node.a;
    const r1 = a.wholeCol ? 0 : Math.min(a.row, b.row);
    const r2 = a.wholeCol ? size.rows - 1 : Math.max(a.row, b.row);
    const c1 = a.wholeRow ? 0 : Math.min(a.col, b.col);
    const c2 = a.wholeRow ? size.cols - 1 : Math.max(a.col, b.col);
    if (!node.b && !a.wholeCol && !a.wholeRow)
      return book.value(name, a.row, a.col);
    const rows: Value[][] = [];
    for (let r = r1; r <= Math.min(r2, r1 + 9999); r++) {
      const row: Value[] = [];
      for (let c = c1; c <= Math.min(c2, c1 + 199); c++)
        row.push(book.value(name, r, c));
      rows.push(row);
    }
    return new Range(rows);
  };
  const ev = (node: Node): Result => {
    switch (node.k) {
      case "lit":
        return node.v;
      case "ref":
        return range(node);
      case "un": {
        const n = toNumber(scalar(ev(node.x)));
        return isError(n) ? n : node.op === "-" ? -n : n;
      }
      case "pct": {
        const n = toNumber(scalar(ev(node.x)));
        return isError(n) ? n : n / 100;
      }
      case "bin":
        return binary(node.op, scalar(ev(node.l)), scalar(ev(node.r)));
      case "call":
        try {
          return call(node.name, node.args);
        } catch (e) {
          return isError(e) ? e : err.value;
        }
    }
  };
  const binary = (op: string, l: Value, r: Value): Value => {
    if (isError(l)) return l;
    if (isError(r)) return r;
    if (op === "&") return `${toText(l)}${toText(r)}`;
    if (["=", "<>", "<", ">", "<=", ">="].includes(op)) {
      const rank = (v: Value) =>
        typeof v === "number" || v === null ? 0 : typeof v === "string" ? 1 : 2;
      let cmp: number;
      const lv = l === null ? (typeof r === "string" ? "" : 0) : l;
      const rv = r === null ? (typeof l === "string" ? "" : 0) : r;
      if (rank(lv) !== rank(rv)) cmp = rank(lv) - rank(rv);
      else if (typeof lv === "string" && typeof rv === "string")
        cmp =
          lv.toLowerCase() < rv.toLowerCase()
            ? -1
            : lv.toLowerCase() > rv.toLowerCase()
              ? 1
              : 0;
      else cmp = Number(lv) - Number(rv);
      return op === "="
        ? cmp === 0
        : op === "<>"
          ? cmp !== 0
          : op === "<"
            ? cmp < 0
            : op === ">"
              ? cmp > 0
              : op === "<="
                ? cmp <= 0
                : cmp >= 0;
    }
    const a = toNumber(l);
    const b = toNumber(r);
    if (isError(a)) return a;
    if (isError(b)) return b;
    switch (op) {
      case "+":
        return a + b;
      case "-":
        return a - b;
      case "*":
        return a * b;
      case "/":
        return b === 0 ? err.div0 : a / b;
      case "^":
        return a ** b;
    }
    return err.value;
  };
  const arg = (args: Node[], i: number): Value =>
    args[i] ? scalar(ev(args[i])) : null;
  const num = (args: Node[], i: number, fallback?: number): number => {
    if (!args[i] && fallback !== undefined) return fallback;
    const n = toNumber(arg(args, i));
    if (isError(n)) throw n;
    return n;
  };
  const text = (args: Node[], i: number): string => {
    const t = toText(arg(args, i));
    if (isError(t)) throw t;
    return t;
  };
  const rangeOf = (args: Node[], i: number): Range => {
    const r = ev(args[i]);
    return r instanceof Range ? r : new Range([[r]]);
  };
  const lookup = (key: Value, list: Value[], exact: boolean) => {
    if (exact) {
      if (typeof key !== "string") return list.findIndex((v) => v === key);
      const wild = /[*?~]/.test(key) ? criteria(`=${key}`) : undefined;
      return list.findIndex(
        (v) =>
          typeof v === "string" &&
          (wild ? wild(v) : v.toLowerCase() === key.toLowerCase()),
      );
    }
    let found = -1;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v === null) continue;
      const c = binary("<=", v, key);
      if (c === true) found = i;
      else break;
    }
    return found;
  };
  const call = (name: string, args: Node[]): Result => {
    const all = () => args.map(ev);
    switch (name) {
      case "SUM":
        return numbersOf(all()).reduce((a, b) => a + b, 0);
      case "PRODUCT":
        return numbersOf(all()).reduce((a, b) => a * b, 1);
      case "AVERAGE": {
        const ns = numbersOf(all());
        return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : err.div0;
      }
      case "MIN": {
        const ns = numbersOf(all());
        return ns.length ? Math.min(...ns) : 0;
      }
      case "MAX": {
        const ns = numbersOf(all());
        return ns.length ? Math.max(...ns) : 0;
      }
      case "MEDIAN": {
        const ns = numbersOf(all()).sort((a, b) => a - b);
        if (!ns.length) return err.num;
        const m = ns.length >> 1;
        return ns.length % 2 ? ns[m] : (ns[m - 1] + ns[m]) / 2;
      }
      case "COUNT":
        return all()
          .flatMap(values)
          .filter((v) => typeof v === "number").length;
      case "COUNTA":
        return all()
          .flatMap(values)
          .filter((v) => v !== null && v !== "").length;
      case "COUNTBLANK":
        return all()
          .flatMap(values)
          .filter((v) => v === null || v === "").length;
      case "LARGE":
      case "SMALL": {
        const ns = numbersOf([ev(args[0])]).sort((a, b) =>
          name === "LARGE" ? b - a : a - b,
        );
        const k = num(args, 1);
        return ns[k - 1] ?? err.num;
      }
      case "RANK":
      case "RANK.EQ": {
        const n = num(args, 0);
        const ns = numbersOf([ev(args[1])]);
        const asc = num(args, 2, 0) !== 0;
        if (!ns.includes(n)) return err.na;
        return ns.filter((v) => (asc ? v < n : v > n)).length + 1;
      }
      case "IF": {
        const c = toBool(arg(args, 0));
        if (isError(c)) return c;
        return c
          ? args[1]
            ? ev(args[1])
            : true
          : args[2]
            ? ev(args[2])
            : false;
      }
      case "IFS":
        for (let i = 0; i + 1 < args.length; i += 2) {
          const c = toBool(arg(args, i));
          if (isError(c)) return c;
          if (c) return ev(args[i + 1]);
        }
        return err.na;
      case "IFERROR": {
        const v = ev(args[0]);
        return isError(scalar(v)) ? ev(args[1]) : v;
      }
      case "IFNA": {
        const v = ev(args[0]);
        const s = scalar(v);
        return isError(s) && s.code === "#N/A" ? ev(args[1]) : v;
      }
      case "AND":
      case "OR":
      case "XOR": {
        const bs = all()
          .flatMap(values)
          .filter((v) => v !== null)
          .map((v) => toBool(v));
        const bad = bs.find(isError);
        if (bad) return bad;
        const n = bs.filter(Boolean).length;
        return name === "AND"
          ? n === bs.length
          : name === "OR"
            ? n > 0
            : n % 2 === 1;
      }
      case "NOT": {
        const b = toBool(arg(args, 0));
        return isError(b) ? b : !b;
      }
      case "TRUE":
        return true;
      case "FALSE":
        return false;
      case "ROUND":
        return roundTo(num(args, 0), num(args, 1, 0), "round");
      case "ROUNDUP":
        return roundTo(num(args, 0), num(args, 1, 0), "up");
      case "ROUNDDOWN":
      case "TRUNC":
        return roundTo(num(args, 0), num(args, 1, 0), "down");
      case "INT":
        return Math.floor(num(args, 0));
      case "ABS":
        return Math.abs(num(args, 0));
      case "SIGN":
        return Math.sign(num(args, 0));
      case "MOD": {
        const d = num(args, 1);
        if (d === 0) return err.div0;
        const n = num(args, 0);
        return n - d * Math.floor(n / d);
      }
      case "POWER":
        return num(args, 0) ** num(args, 1);
      case "SQRT": {
        const n = num(args, 0);
        return n < 0 ? err.num : Math.sqrt(n);
      }
      case "EXP":
        return Math.exp(num(args, 0));
      case "LN":
        return Math.log(num(args, 0));
      case "LOG10":
        return Math.log10(num(args, 0));
      case "PI":
        return Math.PI;
      case "CEILING":
      case "CEILING.MATH": {
        const s = num(args, 1, 1) || 1;
        return Math.ceil(num(args, 0) / s - 1e-9) * s;
      }
      case "FLOOR":
      case "FLOOR.MATH": {
        const s = num(args, 1, 1) || 1;
        return Math.floor(num(args, 0) / s + 1e-9) * s;
      }
      case "RAND":
        return random();
      case "RANDBETWEEN": {
        const lo = Math.ceil(num(args, 0));
        const hi = Math.floor(num(args, 1));
        return hi < lo ? err.num : lo + Math.floor(random() * (hi - lo + 1));
      }
      case "SUMPRODUCT": {
        const rs = args.map((_, i) => rangeOf(args, i).flat);
        let total = 0;
        for (let i = 0; i < (rs[0]?.length ?? 0); i++)
          total += rs.reduce(
            (p, r) => p * (typeof r[i] === "number" ? (r[i] as number) : 0),
            1,
          );
        return total;
      }
      case "SUMIF":
      case "AVERAGEIF":
      case "COUNTIF": {
        const test = criteria(arg(args, 1));
        const keys = rangeOf(args, 0).flat;
        if (name === "COUNTIF") return keys.filter(test).length;
        const sums = args[2] ? rangeOf(args, 2).flat : keys;
        const picked = keys
          .map((k, i) => (test(k) ? sums[i] : null))
          .filter((v): v is number => typeof v === "number");
        if (name === "SUMIF") return picked.reduce((a, b) => a + b, 0);
        return picked.length
          ? picked.reduce((a, b) => a + b, 0) / picked.length
          : err.div0;
      }
      case "SUMIFS":
      case "AVERAGEIFS":
      case "MAXIFS":
      case "MINIFS":
      case "COUNTIFS": {
        const start = name === "COUNTIFS" ? 0 : 1;
        const pairs: { keys: Value[]; test: (v: Value) => boolean }[] = [];
        for (let i = start; i + 1 < args.length; i += 2)
          pairs.push({
            keys: rangeOf(args, i).flat,
            test: criteria(arg(args, i + 1)),
          });
        const length = pairs[0]?.keys.length ?? 0;
        const hit = (i: number) =>
          pairs.every((p) => p.test(p.keys[i] ?? null));
        if (name === "COUNTIFS")
          return Array.from({ length }, (_, i) => i).filter(hit).length;
        const target = rangeOf(args, 0).flat;
        const picked = target.filter(
          (v, i) => hit(i) && typeof v === "number",
        ) as number[];
        if (name === "SUMIFS") return picked.reduce((a, b) => a + b, 0);
        if (name === "MAXIFS") return picked.length ? Math.max(...picked) : 0;
        if (name === "MINIFS") return picked.length ? Math.min(...picked) : 0;
        return picked.length
          ? picked.reduce((a, b) => a + b, 0) / picked.length
          : err.div0;
      }
      case "CHOOSE": {
        const k = Math.floor(num(args, 0));
        return k >= 1 && k < args.length ? ev(args[k]) : err.value;
      }
      case "INDEX": {
        const r = rangeOf(args, 0);
        let row = num(args, 1, 1);
        let col = num(args, 2, 1);
        if (r.rows.length === 1 && !args[2]) [row, col] = [1, row];
        return r.rows[row - 1]?.[col - 1] ?? err.ref;
      }
      case "MATCH": {
        const list = rangeOf(args, 1).flat;
        const type = num(args, 2, 1);
        const i = lookup(arg(args, 0), list, type === 0);
        return i < 0 ? err.na : i + 1;
      }
      case "VLOOKUP":
      case "HLOOKUP": {
        const table = rangeOf(args, 1);
        const n = num(args, 2);
        const exact = args[3] ? toBool(arg(args, 3)) === false : false;
        const rows =
          name === "VLOOKUP"
            ? table.rows
            : (table.rows[0]?.map((_, c) => table.rows.map((r) => r[c])) ?? []);
        const i = lookup(
          arg(args, 0),
          rows.map((r) => r[0] ?? null),
          exact,
        );
        return i < 0 ? err.na : (rows[i]?.[n - 1] ?? err.ref);
      }
      case "XLOOKUP": {
        const keys = rangeOf(args, 1).flat;
        const results = rangeOf(args, 2).flat;
        const i = lookup(arg(args, 0), keys, true);
        return i < 0
          ? args[3]
            ? ev(args[3])
            : err.na
          : (results[i] ?? err.na);
      }
      case "ROW":
        return args[0] && args[0].k === "ref"
          ? args[0].a.row + 1
          : here.row + 1;
      case "COLUMN":
        return args[0] && args[0].k === "ref"
          ? args[0].a.col + 1
          : here.col + 1;
      case "ROWS":
        return rangeOf(args, 0).rows.length;
      case "COLUMNS":
        return rangeOf(args, 0).rows[0]?.length ?? 0;
      case "CONCATENATE":
      case "CONCAT":
        return all()
          .flatMap(values)
          .map((v) => {
            const t = toText(v);
            if (isError(t)) throw t;
            return t;
          })
          .join("");
      case "TEXTJOIN": {
        const sep = text(args, 0);
        const skip = toBool(arg(args, 1)) === true;
        return args
          .slice(2)
          .map(ev)
          .flatMap(values)
          .filter((v) => !(skip && (v === null || v === "")))
          .map((v) => String(toText(v)))
          .join(sep);
      }
      case "LEN":
        return [...text(args, 0)].length;
      case "LEFT":
        return [...text(args, 0)].slice(0, num(args, 1, 1)).join("");
      case "RIGHT": {
        const chars = [...text(args, 0)];
        const n = num(args, 1, 1);
        return n ? chars.slice(-n).join("") : "";
      }
      case "MID":
        return [...text(args, 0)]
          .slice(num(args, 1) - 1, num(args, 1) - 1 + num(args, 2))
          .join("");
      case "UPPER":
        return text(args, 0).toUpperCase();
      case "LOWER":
        return text(args, 0).toLowerCase();
      case "PROPER":
        return text(args, 0)
          .toLowerCase()
          .replace(/(^|[^a-z])([a-z])/g, (_, a, b) => a + b.toUpperCase());
      case "TRIM":
        return text(args, 0).trim().replace(/ +/g, " ");
      case "REPT":
        return text(args, 0).repeat(Math.max(0, Math.floor(num(args, 1))));
      case "SUBSTITUTE":
        return text(args, 0).split(text(args, 1)).join(text(args, 2));
      case "REPLACE": {
        const s = [...text(args, 0)];
        s.splice(num(args, 1) - 1, num(args, 2), text(args, 3));
        return s.join("");
      }
      case "FIND":
      case "SEARCH": {
        const hay = text(args, 1);
        const needle = text(args, 0);
        const from = num(args, 2, 1) - 1;
        const i =
          name === "FIND"
            ? hay.indexOf(needle, from)
            : hay.toLowerCase().indexOf(needle.toLowerCase(), from);
        return i < 0 ? err.value : i + 1;
      }
      case "TEXT": {
        const v = arg(args, 0);
        const n = toNumber(v);
        return isError(n) ? String(toText(v)) : book.format(n, text(args, 1));
      }
      case "VALUE": {
        const n = toNumber(arg(args, 0));
        return n;
      }
      case "N": {
        const v = arg(args, 0);
        return typeof v === "number" ? v : typeof v === "boolean" ? +v : 0;
      }
      case "ISBLANK":
        return arg(args, 0) === null;
      case "ISNUMBER":
        return typeof arg(args, 0) === "number";
      case "ISTEXT":
        return typeof arg(args, 0) === "string";
      case "ISERROR":
        return isError(arg(args, 0));
      case "ISNA": {
        const v = arg(args, 0);
        return isError(v) && v.code === "#N/A";
      }
      case "NA":
        return err.na;
      case "TODAY": {
        const d = new Date();
        return dateSerial(d.getFullYear(), d.getMonth() + 1, d.getDate());
      }
      case "NOW": {
        const d = new Date();
        return (
          dateSerial(d.getFullYear(), d.getMonth() + 1, d.getDate()) +
          (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400
        );
      }
      case "DATE":
        return dateSerial(num(args, 0), num(args, 1), num(args, 2));
      case "YEAR":
        return fromSerial(num(args, 0)).getUTCFullYear();
      case "MONTH":
        return fromSerial(num(args, 0)).getUTCMonth() + 1;
      case "DAY":
        return fromSerial(num(args, 0)).getUTCDate();
      case "HOUR":
        return Math.floor((num(args, 0) % 1) * 24 + 1e-9);
      case "MINUTE":
        return Math.floor(((num(args, 0) * 1440) % 60) + 1e-9);
      case "WEEKDAY": {
        const d = fromSerial(num(args, 0)).getUTCDay();
        const type = num(args, 1, 1);
        return type === 2
          ? ((d + 6) % 7) + 1
          : type === 3
            ? (d + 6) % 7
            : d + 1;
      }
      case "EDATE": {
        const d = fromSerial(num(args, 0));
        return dateSerial(
          d.getUTCFullYear(),
          d.getUTCMonth() + 1 + num(args, 1),
          d.getUTCDate(),
        );
      }
      case "EOMONTH": {
        const d = fromSerial(num(args, 0));
        return dateSerial(
          d.getUTCFullYear(),
          d.getUTCMonth() + 2 + num(args, 1),
          0,
        );
      }
      case "DAYS":
        return Math.floor(num(args, 0)) - Math.floor(num(args, 1));
      case "DATEDIF": {
        const a = fromSerial(num(args, 0));
        const b = fromSerial(num(args, 1));
        const unit = text(args, 2).toUpperCase();
        const months =
          (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
          b.getUTCMonth() -
          a.getUTCMonth() -
          (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
        return unit === "Y"
          ? Math.floor(months / 12)
          : unit === "M"
            ? months
            : Math.floor(num(args, 1)) - Math.floor(num(args, 0));
      }
    }
    return err.name;
  };
  const result = ev(tree);
  return scalar(result);
}
