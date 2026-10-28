import type { CSSProperties } from "react";
import { sheetGlyphs, type SheetGlyph } from "./sheet-glyphs";

/**
 * The sheet card's tile, as the original draws the artifact and file blocks: a
 * tinted page standing in a 56px square, cut by the card's lower edge, with the
 * kind's glyph; on a card that opens, a second sheet waits behind it and the
 * page carries the kind's marks. Hovering the card (data-sheet-kind on it)
 * lifts the page, swings the sheet behind it out and draws the marks
 * (sheet-card.css).
 */
export type SheetKind =
  | "doc"
  | "txt"
  | "markdown"
  | "pdf"
  | "sheet"
  | "csv"
  | "code"
  | "json"
  | "html"
  | "slides"
  | "image"
  | "archive"
  | "generic";

export type SheetTint =
  "gray" | "blue" | "green" | "yellow" | "orange" | "violet" | "magenta";

export interface SheetLook {
  kind: SheetKind;
  tint: SheetTint;
  glyph: SheetGlyph;
}

const extensionOf = (name: string) => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ext === name.toLowerCase() ? "" : ext;
};

// The original's extension sets (file kinds, then its code languages).
const archives = new Set(["zip", "tar", "gz", "bz2", "xz", "7z", "rar", "tgz"]);
const presentations = new Set(["ppt", "pptx"]);
const data = new Set(["jsonl", "parquet", "db", "sqlite", "sqlite3"]);
const tables = new Set(["csv", "tsv"]);
const code = new Set(
  "js.jsx.gs.ts.tsx.py.rb.go.rs.c.cpp.h.hpp.java.kt.swift.sh.bash.zsh.json.yaml.yml.toml.xml.html.css.scss.sql.graphql.proto.lua.r.cs.vue.pl.php.htm.xhtml".split(
    ".",
  ),
);
const documents = new Set(
  "pdf.md.markdown.txt.log.rtf.doc.docx.odt.pages.rst.tex.epub.mp4.mov.webm.mkv.avi.m4v.ogv.3gp.mp3.wav.ogg.oga.opus.flac.aac.m4a.wma.aiff".split(
    ".",
  ),
);
const images = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "webp",
  "svg",
  "ico",
]);
const languages = new Set(
  "python.javascript.typescript.java.csharp.go.rust.ruby.php.swift.kotlin.dart.scala.perl.elixir.haskell.clojure.r.groovy.bash.css.scss.less.sql.graphql.json.html.plaintext".split(
    ".",
  ),
);

type Family = "archive" | "preso" | "data" | "sheet" | "code" | "image" | "doc";

function familyOf(ext: string): Family {
  if (archives.has(ext)) return "archive";
  if (presentations.has(ext)) return "preso";
  if (data.has(ext)) return "data";
  if (tables.has(ext) || ext === "xls" || ext === "xlsx") return "sheet";
  if (code.has(ext)) return "code";
  if (images.has(ext) || ext === "mermaid" || ext === "mmd") return "image";
  if (documents.has(ext)) return "doc";
  if (languages.has(ext)) return "code";
  return "doc";
}

const familyGlyph: Record<Family, SheetGlyph> = {
  archive: "Archive",
  preso: "Slides",
  data: "Database",
  sheet: "Spreadsheet",
  code: "Code",
  image: "Image",
  doc: "File",
};
const glyphTint: Partial<Record<SheetGlyph, SheetTint>> = {
  File: "blue",
  Note: "blue",
  Spreadsheet: "green",
  Database: "green",
  Code: "yellow",
  Slides: "orange",
  Artifacts: "violet",
  Globe: "violet",
  Image: "violet",
  Scroll: "violet",
};
const glyphKind: Partial<Record<SheetGlyph, SheetKind>> = {
  File: "doc",
  Note: "markdown",
  Spreadsheet: "sheet",
  Database: "sheet",
  Code: "code",
  Slides: "slides",
  Artifacts: "html",
  Globe: "html",
  Image: "image",
  Archive: "archive",
};
const byExtension: Record<string, { kind: SheetKind; tint?: SheetTint }> = {
  txt: { kind: "txt", tint: "gray" },
  md: { kind: "markdown", tint: "gray" },
  markdown: { kind: "markdown", tint: "gray" },
  pdf: { kind: "pdf", tint: "gray" },
  csv: { kind: "csv" },
  tsv: { kind: "csv" },
  json: { kind: "json" },
  html: { kind: "html", tint: "magenta" },
  htm: { kind: "html", tint: "magenta" },
  xhtml: { kind: "html", tint: "magenta" },
};
const extensionGlyph: Record<string, SheetGlyph> = {
  md: "Note",
  markdown: "Note",
  html: "Globe",
  htm: "Globe",
  xhtml: "Globe",
};

/** How the original draws a file's card: its marks, tint and glyph. */
export function sheetLookOf(name: string): SheetLook {
  const ext = extensionOf(name);
  const known = byExtension[ext];
  const glyph = extensionGlyph[ext] ?? familyGlyph[familyOf(ext)];
  return {
    kind: known?.kind ?? glyphKind[glyph] ?? "generic",
    tint: known?.tint ?? glyphTint[glyph] ?? "gray",
    glyph,
  };
}

/** An artifact (HTML or SVG made by the reply): the Artifacts glyph, grey. */
export const artifactLook: SheetLook = {
  kind: "html",
  tint: "gray",
  glyph: "Artifacts",
};

type Mark =
  | {
      part: "rule";
      x: number;
      y: number;
      w: number;
      d?: number;
      dur?: number;
      stamp?: boolean;
      steps?: number;
    }
  | {
      part: "fill";
      x: number;
      y: number;
      w: number;
      h: number;
      o: number;
      d?: number;
      stamp?: boolean;
    }
  | { part: "dot"; x: number; y: number; d?: number }
  | {
      part: "caret";
      x: number;
      y: number;
      h: number;
      d?: number;
      dur?: number;
      ride?: number;
      steps?: number;
    }
  | {
      part: "svg";
      x: number;
      y: number;
      w: number;
      h: number;
      path: string;
      dur?: number;
    }
  | { part: "reveal"; d?: number; dur?: number; parts: Mark[] }
  | { part: "hash"; x: number; y: number }
  | { part: "sweep"; x: number; y: number }
  | {
      part: "tight";
      x: number;
      y: number;
      w: number;
      h: number;
      path: string;
      tx: number;
      ty: number;
    }
  | { part: "zip"; x: number; y: number };

const row = (y: number): Mark[] => [
  { part: "rule", x: 3, y, w: 5 },
  { part: "rule", x: 11, y, w: 5 },
  { part: "rule", x: 19, y, w: 5 },
];

/** Each kind's marks on the page, as the original places them (28×18). */
const marks: Record<Exclude<SheetKind, "generic">, Mark[]> = {
  doc: [
    { part: "rule", x: 3, y: 4, w: 22, dur: 260 },
    { part: "rule", x: 3, y: 9, w: 11, d: 110, dur: 220 },
  ],
  txt: [{ part: "caret", x: 4, y: 3, h: 7 }],
  markdown: [
    { part: "hash", x: 3, y: 1.5 },
    { part: "rule", x: 11, y: 4, w: 16, d: 55 },
    { part: "dot", x: 5, y: 9.5, d: 125 },
    { part: "rule", x: 9, y: 10, w: 12, d: 125 },
  ],
  pdf: [
    { part: "rule", x: 2, y: 1, w: 11 },
    { part: "rule", x: 2, y: 5, w: 11, d: 45 },
    { part: "rule", x: 2, y: 9, w: 9, d: 90 },
    { part: "rule", x: 16, y: 1, w: 10, d: 30 },
    { part: "rule", x: 16, y: 5, w: 10, d: 75 },
    { part: "rule", x: 16, y: 9, w: 7, d: 120 },
  ],
  sheet: [
    {
      part: "svg",
      x: 2,
      y: 2,
      w: 24,
      h: 11,
      path: "M0.5 9.5 L5 6 L9 8 L14 2.5 L18.5 5.5 L23.5 1",
      dur: 320,
    },
  ],
  csv: [
    { part: "reveal", dur: 180, parts: row(2) },
    { part: "reveal", dur: 180, d: 90, parts: row(6) },
    { part: "reveal", dur: 180, d: 180, parts: row(10) },
  ],
  code: [
    { part: "rule", x: 3, y: 3, w: 12, stamp: true },
    { part: "rule", x: 3, y: 9, w: 16, d: 60, dur: 360, steps: 8 },
    { part: "caret", x: 3, y: 6.5, h: 5, d: 60, ride: 16, steps: 8, dur: 360 },
  ],
  json: [
    { part: "rule", x: 3, y: 4, w: 12, dur: 220 },
    { part: "rule", x: 8, y: 9, w: 12, d: 100, dur: 220 },
  ],
  html: [
    { part: "fill", x: 3, y: 2, w: 22, h: 3, o: 0.3, stamp: true },
    { part: "rule", x: 3, y: 9, w: 15, d: 90, dur: 240 },
  ],
  slides: [{ part: "sweep", x: 9, y: 2 }],
  image: [
    {
      part: "tight",
      x: 6,
      y: 2,
      w: 5,
      h: 5,
      path: "M0.5 4.5V0.5H4.5",
      tx: -3,
      ty: -2,
    },
    {
      part: "tight",
      x: 17,
      y: 2,
      w: 5,
      h: 5,
      path: "M0.5 0.5H4.5V4.5",
      tx: 3,
      ty: -2,
    },
    {
      part: "tight",
      x: 17,
      y: 9,
      w: 5,
      h: 5,
      path: "M4.5 0.5V4.5H0.5",
      tx: 3,
      ty: 2,
    },
    {
      part: "tight",
      x: 6,
      y: 9,
      w: 5,
      h: 5,
      path: "M4.5 4.5H0.5V0.5",
      tx: -3,
      ty: 2,
    },
  ],
  archive: [{ part: "zip", x: 11, y: 1 }],
};

type Vars = CSSProperties & Record<`--${string}`, string | number>;

function place(mark: {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  o?: number;
  d?: number;
  dur?: number;
}): Vars {
  const style: Vars = {};
  if (mark.x !== undefined) style["--sheet-card-x"] = `${mark.x}px`;
  if (mark.y !== undefined) style["--sheet-card-y"] = `${mark.y}px`;
  if (mark.w !== undefined) style["--sheet-card-w"] = `${mark.w}px`;
  if (mark.h !== undefined) style["--sheet-card-h"] = `${mark.h}px`;
  if (mark.o !== undefined) style["--sheet-card-o"] = String(mark.o);
  if (mark.d !== undefined) style["--sheet-card-d"] = `${mark.d}ms`;
  if (mark.dur !== undefined) style["--sheet-card-dur"] = `${mark.dur}ms`;
  return style;
}

const steps = (n: number) => `steps(${n}, jump-none)`;

function MarkPart({ mark }: { mark: Mark }) {
  switch (mark.part) {
    case "dot":
      return (
        <span className="sheet-card-part sheet-card-dot" style={place(mark)} />
      );
    case "rule":
    case "fill": {
      const typed = mark.part === "rule" && mark.steps !== undefined;
      return (
        <span
          className={[
            "sheet-card-part",
            mark.part === "rule" ? "sheet-card-rule" : "sheet-card-fill",
            mark.stamp && "sheet-card-stamp",
            typed && "sheet-card-typed",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{
            ...place(mark),
            ...(typed && { "--sheet-card-steps": steps(mark.steps!) }),
          }}
        />
      );
    }
    case "caret":
      return (
        <span
          className={`sheet-card-part sheet-card-caret${mark.ride !== undefined ? " sheet-card-ride" : ""}`}
          style={{
            ...place(mark),
            ...(mark.ride !== undefined && {
              "--sheet-card-w": `${mark.ride}px`,
              "--sheet-card-steps": steps(mark.steps ?? 1),
            }),
          }}
        />
      );
    case "svg":
      return (
        <svg
          className="sheet-card-part sheet-card-svg"
          style={place({ x: mark.x, y: mark.y, dur: mark.dur })}
          width={mark.w}
          height={mark.h}
          viewBox={`0 0 ${mark.w} ${mark.h}`}
        >
          <path className="sheet-card-stroke" pathLength={1} d={mark.path} />
        </svg>
      );
    case "reveal":
      return (
        <span
          className="sheet-card-part sheet-card-group"
          style={
            {
              ...place({ d: mark.d, dur: mark.dur }),
              "--sheet-card-steps": steps(mark.parts.length + 1),
            } as Vars
          }
        >
          {mark.parts.map((part, index) => (
            <MarkPart key={index} mark={part} />
          ))}
        </span>
      );
    case "hash":
      return (
        <span className="sheet-card-part sheet-card-hash" style={place(mark)}>
          <span className="sheet-card-tick" />
          <span className="sheet-card-tick" />
          <span className="sheet-card-tick" />
          <span className="sheet-card-tick" />
        </span>
      );
    case "sweep":
      return (
        <span
          className="sheet-card-part sheet-card-sweep sheet-card-stamp"
          style={place(mark)}
        />
      );
    case "tight":
      return (
        <svg
          className="sheet-card-part sheet-card-svg sheet-card-static sheet-card-tight"
          style={
            {
              ...place({ x: mark.x, y: mark.y }),
              "--sheet-card-tx": `${mark.tx}px`,
              "--sheet-card-ty": `${mark.ty}px`,
            } as Vars
          }
          width={mark.w}
          height={mark.h}
          viewBox={`0 0 ${mark.w} ${mark.h}`}
        >
          <path className="sheet-card-stroke" pathLength={1} d={mark.path} />
        </svg>
      );
    case "zip":
      return (
        <span className="sheet-card-part sheet-card-zip" style={place(mark)}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className="sheet-card-tick"
              style={{ "--sheet-card-i": i } as Vars}
            />
          ))}
        </span>
      );
  }
}

export function SheetGlyphIcon({ glyph }: { glyph: SheetGlyph }) {
  const Icon = sheetGlyphs[glyph];
  return <Icon size={20} strokeWidth={1.5} aria-hidden="true" />;
}

/**
 * The 56px tile. `openable`: the card opens something, so the sheet behind
 * and the marks are drawn (the original leaves both out otherwise).
 */
export function SheetTile({
  look,
  openable,
}: {
  look: SheetLook;
  openable: boolean;
}) {
  return (
    <span className="sheet-card-tile" aria-hidden="true">
      {openable && <span className="sheet-card-under" />}
      <span className="sheet-card-page">
        {openable && look.kind !== "generic" && (
          <span className="sheet-card-marks">
            {marks[look.kind].map((mark, index) => (
              <MarkPart key={index} mark={mark} />
            ))}
          </span>
        )}
        <span className="sheet-card-glyph">
          <SheetGlyphIcon glyph={look.glyph} />
        </span>
      </span>
    </span>
  );
}
