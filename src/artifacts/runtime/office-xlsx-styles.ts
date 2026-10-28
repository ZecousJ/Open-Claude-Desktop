/** Excel (.xlsx) cell styles, theme colours and number formats (office-xlsx.ts). */
import JSZip from "jszip";
import { parse, all, first, children, readText } from "./office-xml";

/** The original's font stacks for the faces workbooks use most. */
const fontStacks: Record<string, string> = {
  calibri:
    'Calibri, Carlito, Candara, Segoe, "Segoe UI", Frutiger, "Frutiger Linotype", "Dejavu Sans", "Helvetica Neue", Helvetica, "Liberation Sans", Arial, "Arial Nova", sans-serif',
  aptos:
    'Aptos, Arial, "Arial Nova", "Helvetica Neue", Helvetica, "Liberation Sans", sans-serif',
  arial:
    'Arial, "Arial Nova", "Helvetica Neue", Helvetica, "Liberation Sans", sans-serif',
  "segoe ui":
    '"Segoe UI", Segoe, Frutiger, "Frutiger Linotype", "Dejavu Sans", "Helvetica Neue", Helvetica, "Liberation Sans", Arial, "Arial Nova", sans-serif',
  "times new roman": '"Times New Roman", Times, "Liberation Serif", serif',
  cambria:
    'Cambria, "Cambria Math", Caladea, "Hoefler Text", "Liberation Serif", "Times New Roman", Times, serif',
};

export const fontStack = (name: string | undefined) => {
  const face = (name ?? "Calibri").replace(/\(\w+\)/, "").trim();
  const key = face.toLowerCase();
  if (fontStacks[key]) return fontStacks[key];
  if (key === "aptos narrow") return `"Aptos Narrow", ${fontStacks.calibri}`;
  return /[ ,]/.test(face) ? `"${face}"` : face || fontStacks.calibri;
};

/** Excel's 64 indexed colours. */
const indexed =
  "000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF 000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333".split(
    " ",
  );

const defaultTheme = [
  "FFFFFF",
  "000000",
  "E8E8E8",
  "0E2841",
  "156082",
  "E97132",
  "196B24",
  "0F9ED5",
  "A02B93",
  "4EA72E",
  "467886",
  "96607D",
];

function applyTint(hex: string, tint: number) {
  if (!tint) return hex;
  const n = parseInt(hex, 16);
  let r = (n >> 16) / 255,
    g = ((n >> 8) & 255) / 255,
    b = (n & 255) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0,
    s = 0,
    l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h =
      max === r
        ? (g - b) / d + (g < b ? 6 : 0)
        : max === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) r = g = b = l;
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  return [r, g, b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
}

function sheetColor(node: Element | null | undefined, theme: string[]) {
  if (!node || node.getAttribute("auto") === "1") return undefined;
  let hex: string | undefined;
  const rgb = node.getAttribute("rgb");
  const themeIndex = node.getAttribute("theme");
  const index = node.getAttribute("indexed");
  if (rgb) hex = rgb.length === 8 ? rgb.slice(2) : rgb;
  else if (themeIndex !== null) hex = theme[Number(themeIndex)];
  else if (index !== null) {
    if (index === "64" || index === "65") return undefined;
    hex = indexed[Number(index)];
  }
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  return `#${applyTint(hex, Number(node.getAttribute("tint") ?? 0))}`;
}

interface Font {
  name?: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color?: string;
}

interface Border {
  style: string;
  color: string;
}

export interface Style {
  font: Font;
  fill?: string;
  borders: Partial<Record<"top" | "right" | "bottom" | "left", Border>>;
  horizontal?: string;
  vertical?: string;
  wrap: boolean;
  indent: number;
  format: string;
}

const builtinFormats: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "m/d/yyyy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yyyy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;(#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;(#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mm:ss.0",
  48: "##0.0E+0",
  49: "@",
};

export async function readTheme(zip: JSZip) {
  const xml = await readText(zip, "xl/theme/theme1.xml");
  if (!xml) return defaultTheme;
  const scheme = first(parse(xml), "clrScheme");
  if (!scheme) return defaultTheme;
  const value = (name: string) => {
    const slot = Array.from(scheme.children).find((c) => c.localName === name);
    const color = slot?.children[0];
    return (
      color?.getAttribute("lastClr") ?? color?.getAttribute("val") ?? undefined
    );
  };
  // Theme indices put the light colours first.
  return [
    "lt1",
    "dk1",
    "lt2",
    "dk2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hlink",
    "folHlink",
  ].map((name, i) => value(name) ?? defaultTheme[i]);
}

export async function readStyles(
  zip: JSZip,
  theme: string[],
): Promise<Style[]> {
  const xml = await readText(zip, "xl/styles.xml");
  const plain: Style = {
    font: {
      size: 11,
      bold: false,
      italic: false,
      underline: false,
      strike: false,
    },
    borders: {},
    wrap: false,
    indent: 0,
    format: "General",
  };
  if (!xml) return [plain];
  const doc = parse(xml);
  const formats = new Map<number, string>();
  for (const f of all(doc, "numFmt"))
    formats.set(
      Number(f.getAttribute("numFmtId")),
      f.getAttribute("formatCode") ?? "",
    );
  const on = (node: Element, name: string) => {
    const el = children(node, name)[0];
    return (
      !!el &&
      el.getAttribute("val") !== "0" &&
      el.getAttribute("val") !== "false"
    );
  };
  const fonts: Font[] = children(
    first(doc, "fonts") ?? doc.documentElement,
    "font",
  ).map((font) => ({
    name: children(font, "name")[0]?.getAttribute("val") ?? undefined,
    size: Number(children(font, "sz")[0]?.getAttribute("val") ?? 11) || 11,
    bold: on(font, "b"),
    italic: on(font, "i"),
    underline:
      !!children(font, "u")[0] &&
      children(font, "u")[0].getAttribute("val") !== "none",
    strike: on(font, "strike"),
    color: sheetColor(children(font, "color")[0], theme),
  }));
  const fills = children(
    first(doc, "fills") ?? doc.documentElement,
    "fill",
  ).map((fill) => {
    const pattern = children(fill, "patternFill")[0];
    if (pattern) {
      const type = pattern.getAttribute("patternType") ?? "none";
      if (type === "none") return undefined;
      return (
        sheetColor(children(pattern, "fgColor")[0], theme) ??
        sheetColor(children(pattern, "bgColor")[0], theme)
      );
    }
    const stop = first(fill, "stop");
    return sheetColor(first(stop, "color"), theme);
  });
  const borders = children(
    first(doc, "borders") ?? doc.documentElement,
    "border",
  ).map((border) => {
    const out: Style["borders"] = {};
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const el = children(border, side)[0];
      const style = el?.getAttribute("style");
      if (el && style && style !== "none")
        out[side] = {
          style,
          color: sheetColor(children(el, "color")[0], theme) ?? "#000000",
        };
    }
    return out;
  });
  const xfs = children(first(doc, "cellXfs") ?? doc.documentElement, "xf");
  if (!xfs.length) return [{ ...plain, font: fonts[0] ?? plain.font }];
  return xfs.map((xf) => {
    const align = children(xf, "alignment")[0];
    const numFmt = Number(xf.getAttribute("numFmtId") ?? 0);
    return {
      font:
        fonts[Number(xf.getAttribute("fontId") ?? 0)] ?? fonts[0] ?? plain.font,
      fill: fills[Number(xf.getAttribute("fillId") ?? 0)],
      borders: borders[Number(xf.getAttribute("borderId") ?? 0)] ?? {},
      horizontal: align?.getAttribute("horizontal") ?? undefined,
      vertical: align?.getAttribute("vertical") ?? undefined,
      wrap:
        align?.getAttribute("wrapText") === "1" ||
        align?.getAttribute("wrapText") === "true",
      indent: Number(align?.getAttribute("indent") ?? 0),
      format:
        formats.get(numFmt) ??
        builtinFormats[numFmt] ??
        (numFmt >= 27 && numFmt <= 36
          ? "yyyy/m/d"
          : numFmt >= 50 && numFmt <= 58
            ? "yyyy/m/d"
            : "General"),
    };
  });
}

/* Number formats: the common sections, literals, percent, decimals,
   thousands and dates; anything else shows as General. */
const general = (v: number) => {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e11) return String(v);
  const text = String(Number(v.toPrecision(10)));
  return text.length > 11 && Math.abs(v) >= 1e11
    ? v.toExponential(5).replace("e+", "E+")
    : text;
};

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const days = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function formatDate(serial: number, code: string) {
  const ms = Math.round((serial - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return general(serial);
  const ampm = /AM\/PM|A\/P/i.test(code);
  const hours = d.getUTCHours();
  const tokens =
    code.match(
      /"[^"]*"|\\.|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|A\/P|\[h+\]|\[m+\]|\[s+\]|0+|./gi,
    ) ?? [];
  let out = "";
  tokens.forEach((token, i) => {
    const lower = token.toLowerCase();
    const near = (step: number) => {
      for (let j = i + step; j >= 0 && j < tokens.length; j += step) {
        const t = tokens[j].toLowerCase();
        if (/^[hs]/.test(t) || /^\[[hs]/.test(t)) return t;
        if (/^[ymd]/.test(t)) return "";
      }
      return "";
    };
    const minute =
      lower.startsWith("m") &&
      lower.length <= 2 &&
      (/^h|^\[h/.test(near(-1)) || /^s/.test(near(1)));
    const pad = (n: number, w: number) => String(n).padStart(w, "0");
    if (token.startsWith('"')) out += token.slice(1, -1);
    else if (token.startsWith("\\")) out += token.slice(1);
    else if (lower === "yyyy") out += d.getUTCFullYear();
    else if (lower === "yy") out += pad(d.getUTCFullYear() % 100, 2);
    else if (minute)
      out += lower === "mm" ? pad(d.getUTCMinutes(), 2) : d.getUTCMinutes();
    else if (lower === "mmmmm") out += months[d.getUTCMonth()][0];
    else if (lower === "mmmm") out += months[d.getUTCMonth()];
    else if (lower === "mmm") out += months[d.getUTCMonth()].slice(0, 3);
    else if (lower === "mm") out += pad(d.getUTCMonth() + 1, 2);
    else if (lower === "m") out += d.getUTCMonth() + 1;
    else if (lower === "dddd") out += days[d.getUTCDay()];
    else if (lower === "ddd") out += days[d.getUTCDay()].slice(0, 3);
    else if (lower === "dd") out += pad(d.getUTCDate(), 2);
    else if (lower === "d") out += d.getUTCDate();
    else if (lower === "hh" || lower === "h") {
      const h = ampm ? hours % 12 || 12 : hours;
      out += lower === "hh" ? pad(h, 2) : h;
    } else if (lower === "ss") out += pad(d.getUTCSeconds(), 2);
    else if (lower === "s") out += d.getUTCSeconds();
    else if (lower === "am/pm") out += hours < 12 ? "AM" : "PM";
    else if (lower === "a/p") out += hours < 12 ? "A" : "P";
    else if (/^\[h+\]$/.test(lower)) out += Math.floor(serial * 24);
    else if (/^\[m+\]$/.test(lower)) out += Math.floor(serial * 1440);
    else if (/^\[s+\]$/.test(lower)) out += Math.floor(serial * 86400);
    else if (/^0+$/.test(token))
      out += pad(
        Math.floor((ms % 1000) / 10 ** (3 - token.length)),
        token.length,
      );
    else out += token;
  });
  return out;
}

export function formatValue(value: number, code: string) {
  if (!code || /^general$/i.test(code)) return general(value);
  const sections = code.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  let section = sections[0];
  let v = value;
  if (value < 0 && sections[1] !== undefined) {
    section = sections[1];
    v = -value;
  } else if (value === 0 && sections[2] !== undefined) section = sections[2];
  section = section
    .replace(/\[\$([^\]-]*)(-[^\]]*)?\]/g, (_, sym: string) =>
      sym ? `"${sym}"` : "",
    )
    .replace(
      /\[(?:Red|Black|Blue|Cyan|Green|Magenta|White|Yellow|Color\s*\d+|[<>=][^\]]*)\]/gi,
      "",
    );
  const bare = section.replace(/"[^"]*"|\\./g, "");
  if (/general/i.test(bare))
    return section
      .replace(/general/i, general(v))
      .replace(/"([^"]*)"/g, "$1")
      .replace(/\\(.)/g, "$1");
  if (/[ymdhs]/i.test(bare) && !/[0#?]/.test(bare.replace(/\.0+/, "")))
    return formatDate(value, section);
  if (!/[0#?]/.test(bare))
    return section
      .replace(/"([^"]*)"/g, "$1")
      .replace(/\\(.)/g, "$1")
      .replace(/[_*]./g, "");
  if (/E[+-]/i.test(bare)) {
    const digits = (/\.([0#]+)E/i.exec(bare)?.[1] ?? "").length;
    return v
      .toExponential(digits)
      .toUpperCase()
      .replace(/E([+-])(\d)$/, "E$10$2");
  }
  if (bare.includes("%")) v *= 100;
  const decimals = /\.([0#?]+)/.exec(bare)?.[1] ?? "";
  const fixed = decimals.replace(/[#?]/g, "").length;
  const optional = decimals.length - fixed;
  let number = v.toFixed(decimals.length);
  if (optional)
    number = number
      .replace(new RegExp(`0{1,${optional}}$`), "")
      .replace(/\.$/, "");
  if (bare.includes(",")) {
    const [whole, fraction] = number.split(".");
    number =
      whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
      (fraction ? `.${fraction}` : "");
  }
  const minInt = (/([0]+)(?:[.,]|$)/.exec(bare.replace(/,/g, ""))?.[1] ?? "")
    .length;
  if (!minInt) number = number.replace(/^0(?=\.)/, "");
  // Literals and padding around the number placeholder.
  let placed = false;
  let out = "";
  for (const token of section.match(/"[^"]*"|\\.|_.|\*.|[0#?,.]+|%|./g) ?? []) {
    if (token.startsWith('"')) out += token.slice(1, -1);
    else if (token.startsWith("\\")) out += token.slice(1);
    else if (token.startsWith("_")) out += " ";
    else if (token.startsWith("*")) continue;
    else if (/^[0#?,.]+$/.test(token)) {
      if (!placed) out += number;
      placed = true;
    } else out += token;
  }
  return value < 0 && sections[1] === undefined ? `-${out}` : out;
}
