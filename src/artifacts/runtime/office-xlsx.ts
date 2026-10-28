/** Excel (.xlsx): the sheets as the original's spreadsheet viewer draws them (office-runtime.ts). */
import JSZip from "jszip";
import { evaluate, shiftFormula } from "./xlsx-formula";
import { FormulaError, type Value } from "./xlsx-formula-core";
import {
  decode,
  parse,
  all,
  first,
  attr,
  escape,
  readText,
  relations,
} from "./office-xml";
import {
  fontStack,
  Style,
  readTheme,
  readStyles,
  formatValue,
} from "./office-xlsx-styles";

/* ---------------------------------------------------------------- xlsx */

/*
 * Drawn as the original's spreadsheet viewer draws a workbook: a white sheet in
 * every theme; the cells take the file's fonts, fills, borders, alignment,
 * number formats, column widths and row heights. Its conversions: a point of
 * type is 1.2px (lines 1.4 times that), a point of row height 1.3px (default
 * 16pt), a column of width w is floor((256w + 21) / 256 × 6) × 1.17px (default
 * 76.05px). Grid lines are hair (0.5px) #d8d9e5, borders thin and hair 0.5px,
 * medium 1.5px, thick 3px. Text is #282b3e by default, 4px in from the cell's
 * sides, at its foot unless aligned. Headers are 18px tall and 25px wide,
 * Calibri 11 #282b3e on #f5f5f5 with medium #d8d9e5 rims.
 */

const columnName = (index: number) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

const columnIndex = (letters: string) =>
  letters.split("").reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

const cellPosition = (ref: string) => {
  const match = /^\$?([A-Z]+)\$?(\d+)$/.exec(ref);
  return match
    ? { col: columnIndex(match[1]), row: Number(match[2]) - 1 }
    : undefined;
};

const maxRows = 2000;

const maxCols = 100;

const ink = "#282b3e";

const pointPx = 1.2;

const rowPointPx = 1.3;

const columnPx = (chars: number) =>
  chars <= 0 ? 0 : Math.floor(((256 * chars + 21) / 256) * 6) * 1.17;

const defaultColumn = (Math.floor(((256 * 10 + 21) / 256) * 6) + 5) * 1.17;

interface Cell {
  text: string;
  /** What the formula bar shows: the formula, or the value. */
  source: string;
  kind: "text" | "number" | "bool" | "error";
  style: number;
  value: Value;
  formula?: string;
  /** Saved without its result: worked out when the workbook is read. */
  pending?: boolean;
}

interface Sheet {
  name: string;
  rows: Map<number, Map<number, Cell>>;
  width: number;
  height: number;
  merges: { row: number; col: number; rows: number; cols: number }[];
  columnWidths: Map<number, number>;
  columnStyles: Map<number, number>;
  rowHeights: Map<number, number>;
  rowStyles: Map<number, number>;
  defaultRow: number;
  defaultColumn: number;
  gridLines: boolean;
}

async function readWorkbook(
  zip: JSZip,
): Promise<{ sheets: Sheet[]; styles: Style[] }> {
  const workbook = await readText(zip, "xl/workbook.xml");
  if (!workbook) throw new Error("This file has no workbook.");
  const rels = await relations(zip, "xl/workbook.xml");
  const theme = await readTheme(zip);
  const styles = await readStyles(zip, theme);
  const sharedXml = await readText(zip, "xl/sharedStrings.xml");
  const shared = sharedXml
    ? all(parse(sharedXml), "si").map((si) =>
        all(si, "t")
          .filter((t) => t.parentElement?.localName !== "rPh")
          .map((t) => t.textContent ?? "")
          .join(""),
      )
    : [];
  const date1904 =
    first(parse(workbook), "workbookPr")?.getAttribute("date1904") === "1";
  const sheets: Sheet[] = [];
  for (const entry of all(parse(workbook), "sheet")) {
    if (
      entry.getAttribute("state") === "hidden" ||
      entry.getAttribute("state") === "veryHidden"
    )
      continue;
    const target = rels.get(attr(entry, "r:id") ?? "")?.target;
    const xml = target && (await readText(zip, target));
    if (!xml) continue;
    const doc = parse(xml);
    const format = first(doc, "sheetFormatPr");
    const defaultRow =
      (Number(format?.getAttribute("defaultRowHeight")) || 16) * rowPointPx;
    const defaultChars = Number(format?.getAttribute("defaultColWidth"));
    const baseChars = Number(format?.getAttribute("baseColWidth"));
    const sheetDefaultColumn = defaultChars
      ? columnPx(defaultChars)
      : baseChars
        ? (Math.floor(((256 * baseChars + 21) / 256) * 6) + 5) * 1.17
        : defaultColumn;
    const rows = new Map<number, Map<number, Cell>>();
    const rowHeights = new Map<number, number>();
    const rowStyles = new Map<number, number>();
    let width = 0;
    let height = 0;
    for (const row of all(doc, "row")) {
      const r = Number(row.getAttribute("r")) - 1;
      if (!(r >= 0) || r >= maxRows) continue;
      if (row.getAttribute("hidden") === "1") rowHeights.set(r, 0);
      else if (row.getAttribute("ht"))
        rowHeights.set(r, Number(row.getAttribute("ht")) * rowPointPx);
      if (row.getAttribute("customFormat") === "1" && row.getAttribute("s"))
        rowStyles.set(r, Number(row.getAttribute("s")));
      if (row.getAttribute("ht") || row.getAttribute("hidden") === "1")
        height = Math.max(height, r + 1);
    }
    const sharedFormulas = new Map<
      string,
      { formula: string; row: number; col: number }
    >();
    for (const cell of all(doc, "c")) {
      const at = cellPosition(cell.getAttribute("r") ?? "");
      if (!at || at.row >= maxRows || at.col >= maxCols) continue;
      const type = cell.getAttribute("t");
      const style = Number(cell.getAttribute("s") ?? 0);
      const v = first(cell, "v");
      const raw = v?.textContent ?? "";
      const f = first(cell, "f");
      let formula = f?.textContent ?? "";
      const si = f?.getAttribute("si");
      if (
        f?.getAttribute("t") === "shared" &&
        si !== null &&
        si !== undefined
      ) {
        const master = sharedFormulas.get(si);
        if (formula)
          sharedFormulas.set(si, { formula, row: at.row, col: at.col });
        else if (master)
          formula = shiftFormula(
            master.formula,
            at.row - master.row,
            at.col - master.col,
          );
      }
      let value: Value = null;
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr")
        value = all(cell, "t")
          .map((t) => t.textContent ?? "")
          .join("");
      else if (type === "str") value = raw;
      else if (type === "b") value = raw === "" ? null : raw === "1";
      else if (type === "e") value = new FormulaError(raw);
      else if (raw !== "") {
        const n = Number(raw);
        value = Number.isFinite(n) ? n + (date1904 ? 1462 : 0) : raw;
      }
      const pending = !!formula && (!v || (raw === "" && type !== "str"));
      if (value === null && !formula && !style) continue;
      if (!rows.has(at.row)) rows.set(at.row, new Map());
      rows.get(at.row)!.set(at.col, {
        text: "",
        source: formula
          ? `=${formula}`
          : typeof value === "boolean"
            ? value
              ? "TRUE"
              : "FALSE"
            : value === null
              ? ""
              : String(value),
        kind: "text",
        style,
        value,
        formula: formula || undefined,
        pending,
      });
      width = Math.max(width, at.col + 1);
      height = Math.max(height, at.row + 1);
    }
    const merges = all(doc, "mergeCell").flatMap((merge) => {
      const [from, to] = (merge.getAttribute("ref") ?? "").split(":");
      const a = cellPosition(from ?? "");
      const b = cellPosition(to ?? from ?? "");
      if (!a || !b || a.row >= maxRows || a.col >= maxCols) return [];
      width = Math.max(width, Math.min(b.col, maxCols - 1) + 1);
      height = Math.max(height, Math.min(b.row, maxRows - 1) + 1);
      return [
        {
          row: a.row,
          col: a.col,
          rows: Math.min(b.row, maxRows - 1) - a.row + 1,
          cols: Math.min(b.col, maxCols - 1) - a.col + 1,
        },
      ];
    });
    const columnWidths = new Map<number, number>();
    const columnStyles = new Map<number, number>();
    for (const col of all(doc, "col")) {
      const min = Number(col.getAttribute("min")) - 1;
      const max = Math.min(Number(col.getAttribute("max")) - 1, maxCols - 1);
      const chars = Number(col.getAttribute("width"));
      const hidden = col.getAttribute("hidden") === "1";
      for (let i = min; i <= max; i++) {
        if (hidden) columnWidths.set(i, 0);
        else if (Number.isFinite(chars) && chars > 0)
          columnWidths.set(i, columnPx(chars));
        if (col.getAttribute("style"))
          columnStyles.set(i, Number(col.getAttribute("style")));
      }
    }
    sheets.push({
      name: entry.getAttribute("name") ?? `Sheet${sheets.length + 1}`,
      rows,
      width: Math.max(width, 1),
      height: Math.max(height, 1),
      merges,
      columnWidths,
      columnStyles,
      rowHeights,
      rowStyles,
      defaultRow,
      defaultColumn: sheetDefaultColumn,
      gridLines: first(doc, "sheetView")?.getAttribute("showGridLines") !== "0",
    });
  }
  workOut(sheets, styles);
  return { sheets, styles };
}

/** Works out the formulas saved without results, then each cell's text. */
function workOut(sheets: Sheet[], styles: Style[]) {
  const byName = new Map(
    sheets.map((sheet) => [sheet.name.toLowerCase(), sheet]),
  );
  const busy = new Set<Cell>();
  const random = () => Math.random();
  const book = {
    size: (name: string) => {
      const sheet = byName.get(name.toLowerCase());
      return sheet && { rows: sheet.height, cols: sheet.width };
    },
    format: (value: number, code: string) => formatValue(value, code),
    value: (name: string, row: number, col: number): Value => {
      const sheet = byName.get(name.toLowerCase());
      const cell = sheet?.rows.get(row)?.get(col);
      if (!sheet || !cell) return null;
      if (cell.pending) {
        if (busy.has(cell)) return new FormulaError("#REF!");
        busy.add(cell);
        cell.value = evaluate(
          cell.formula!,
          book,
          sheet.name,
          { row, col },
          random,
        );
        busy.delete(cell);
        cell.pending = false;
      }
      return cell.value;
    },
  };
  for (const sheet of sheets)
    for (const [row, cells] of sheet.rows)
      for (const [col, cell] of cells) {
        const value = book.value(sheet.name, row, col);
        if (typeof value === "number") {
          cell.kind = "number";
          cell.text = Number.isFinite(value)
            ? formatValue(value, styles[cell.style]?.format ?? "General")
            : "#NUM!";
        } else if (typeof value === "boolean") {
          cell.kind = "bool";
          cell.text = value ? "TRUE" : "FALSE";
        } else if (value instanceof FormulaError) {
          cell.kind = "error";
          cell.text = value.code;
        } else cell.text = value ?? "";
      }
}

const borderWidths: Record<string, string> = {
  hair: "0.5px solid",
  thin: "0.5px solid",
  dotted: "0.5px dotted",
  dashed: "0.5px dashed",
  dashDot: "0.5px dashed",
  dashDotDot: "0.5px dashed",
  medium: "1.5px solid",
  mediumDashed: "1.5px dashed",
  mediumDashDot: "2px dashed",
  mediumDashDotDot: "1.5px dashed",
  slantDashDot: "1px dashed",
  thick: "3px solid",
  double: "3px double",
};

let measurer: CanvasRenderingContext2D | null | undefined;

const measure = (text: string, font: string) => {
  measurer ??= document.createElement("canvas").getContext("2d");
  if (!measurer) return text.length * 7;
  measurer.font = font;
  return measurer.measureText(text).width;
};

function cellCss(style: Style | undefined, kind: Cell["kind"] | undefined) {
  const font = style?.font;
  const px = Math.round((font?.size ?? 11) * pointPx);
  const css: string[] = [
    `font:${font?.italic ? "italic " : ""}${font?.bold ? "bold " : ""}${px}px/${Math.round(px * 1.4)}px ${fontStack(font?.name)}`,
  ];
  if (font?.color) css.push(`color:${font.color}`);
  const lines = [
    font?.underline && "underline",
    font?.strike && "line-through",
  ].filter(Boolean);
  if (lines.length) css.push(`text-decoration:${lines.join(" ")}`);
  if (style?.fill) css.push(`background:${style.fill}`);
  let align = style?.horizontal;
  if (!align || align === "general")
    align =
      kind === "number"
        ? "right"
        : kind === "bool" || kind === "error"
          ? "center"
          : "left";
  if (align === "centerContinuous") align = "center";
  if (align === "distributed" || align === "justify" || align === "fill")
    align = "left";
  css.push(`text-align:${align}`);
  const vertical =
    style?.vertical === "center"
      ? "middle"
      : style?.vertical === "top"
        ? "top"
        : "bottom";
  css.push(`vertical-align:${vertical}`);
  if (style?.wrap) css.push("white-space:pre-wrap;word-break:break-word");
  if (style?.indent)
    css.push(
      `padding-${align === "right" ? "right" : "left"}:${4 + style.indent * 9}px`,
    );
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const border = style?.borders[side];
    if (border)
      css.push(
        `border-${side}:${borderWidths[border.style] ?? "0.5px solid"} ${border.color}`,
      );
  }
  return { css: css.join(";"), font: css[0].slice(5), align };
}

function sheetTable(sheet: Sheet, styles: Style[]) {
  const covered = new Set<string>();
  const spans = new Map<string, { rows: number; cols: number }>();
  for (const merge of sheet.merges) {
    spans.set(`${merge.row}:${merge.col}`, merge);
    for (let r = 0; r < merge.rows; r++)
      for (let c = 0; c < merge.cols; c++)
        if (r || c) covered.add(`${merge.row + r}:${merge.col + c}`);
  }
  const width = (c: number) => sheet.columnWidths.get(c) ?? sheet.defaultColumn;
  // Empty rows and columns run on past the data, as in the original's grid.
  const columnCount = Math.min(Math.max(sheet.width, 26), maxCols);
  const rowCount = Math.min(Math.max(sheet.height, 100), maxRows);
  const cols = Array.from({ length: columnCount }, (_, i) => i);
  let html = `<table class="${sheet.gridLines ? "lines" : ""}"><colgroup><col class="n">${cols
    .map((c) => `<col style="width:${width(c).toFixed(2)}px">`)
    .join("")}</colgroup><thead><tr><th class="n"></th>${cols
    .map((c) => `<th${width(c) ? "" : ' class="hidden"'}>${columnName(c)}</th>`)
    .join("")}</tr></thead><tbody>`;
  for (let r = 0; r < rowCount; r++) {
    const row = sheet.rows.get(r);
    const rowHeight = sheet.rowHeights.get(r) ?? sheet.defaultRow;
    html += `<tr style="height:${rowHeight.toFixed(2)}px"${rowHeight ? "" : ' class="hidden"'}><th class="n">${r + 1}</th>`;
    for (let c = 0; c < columnCount; c++) {
      const key = `${r}:${c}`;
      if (covered.has(key)) continue;
      const span = spans.get(key);
      const cell = row?.get(c);
      const styleIndex =
        cell?.style ?? sheet.rowStyles.get(r) ?? sheet.columnStyles.get(c) ?? 0;
      const style = styles[styleIndex];
      const { css, font, align } = cellCss(style, cell?.kind);
      let colspan = span?.cols ?? 1;
      // Text runs on over the empty cells beside it, as in Excel.
      if (
        !span &&
        cell?.text &&
        cell.kind === "text" &&
        !style?.wrap &&
        align === "left"
      ) {
        let room = width(c) - 8;
        const need = measure(cell.text, font);
        while (room < need && c + colspan < columnCount) {
          const next = c + colspan;
          const nextKey = `${r}:${next}`;
          const neighbour = row?.get(next);
          const nextStyle = styles[neighbour?.style ?? 0];
          if (
            neighbour?.text ||
            spans.has(nextKey) ||
            covered.has(nextKey) ||
            nextStyle?.fill ||
            Object.keys(nextStyle?.borders ?? {}).length
          )
            break;
          room += width(next);
          colspan++;
        }
      }
      for (let k = 1; k < colspan && !span; k++) covered.add(`${r}:${c + k}`);
      const ref = `${columnName(c)}${r + 1}`;
      html += `<td data-ref="${ref}"${cell ? ` data-source="${escape(cell.source)}"` : ""}${span ? ` rowspan="${span.rows}"` : ""}${colspan > 1 ? ` colspan="${colspan}"` : ""} style="${escape(css)}">${escape(cell?.text ?? "")}</td>`;
      c += colspan - 1;
    }
    html += "</tr>";
  }
  return `${html}</tbody></table>`;
}

export async function renderXlsx(base64: string, root: HTMLElement) {
  const zip = await JSZip.loadAsync(decode(base64));
  const { sheets, styles } = await readWorkbook(zip);
  if (!sheets.length) throw new Error("This workbook has no sheets.");
  const frame = document.createElement("div");
  frame.className = "sheet";
  const bar = document.createElement("div");
  bar.className = "fx";
  bar.innerHTML = `<span class="prefix">fx</span><span class="ref"></span><span class="formula"></span>`;
  const refView = bar.querySelector<HTMLElement>(".ref")!;
  const formulaView = bar.querySelector<HTMLElement>(".formula")!;
  const grid = document.createElement("div");
  grid.className = "grid";
  const foot = document.createElement("nav");
  let selected: HTMLElement | null = null;
  const select = (cell: HTMLElement | null) => {
    selected?.classList.remove("selected");
    selected = cell;
    cell?.classList.add("selected");
    refView.textContent = cell?.dataset.ref ?? "";
    refView.hidden = !cell;
    formulaView.textContent = cell?.dataset.source ?? "";
  };
  grid.addEventListener("click", (event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>(
      "td[data-ref]",
    );
    if (cell) select(cell);
  });
  const show = (index: number) => {
    grid.innerHTML = sheetTable(sheets[index], styles);
    select(null);
    foot
      .querySelectorAll("button")
      .forEach((button, i) =>
        button.setAttribute("aria-selected", String(i === index)),
      );
  };
  sheets.forEach((sheet, index) => {
    const button = document.createElement("button");
    button.textContent = sheet.name;
    button.onclick = () => show(index);
    foot.append(button);
  });
  frame.append(bar, grid, foot);
  root.append(frame);
  show(0);
}
