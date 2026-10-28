/** PowerPoint (.pptx): each slide with its text boxes, pictures and tables in place (office-runtime.ts). */
import JSZip from "jszip";
import {
  decode,
  parse,
  all,
  first,
  children,
  attr,
  escape,
  readText,
  relations,
} from "./office-xml";

/* ---------------------------------------------------------------- pptx */

const emuPerPoint = 12700;

const mime = (path: string) =>
  ({
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    webp: "image/webp",
  })[path.split(".").pop()?.toLowerCase() ?? ""];

type Box = { x: number; y: number; w: number; h: number };

const boxOf = (node: Element | null): Box | undefined => {
  const xfrm = first(node, "xfrm");
  const off = first(xfrm, "off");
  const ext = first(xfrm, "ext");
  if (!off || !ext) return undefined;
  return {
    x: Number(off.getAttribute("x")),
    y: Number(off.getAttribute("y")),
    w: Number(ext.getAttribute("cx")),
    h: Number(ext.getAttribute("cy")),
  };
};

const placeholderKey = (shape: Element) => {
  const ph = first(first(shape, "nvPr"), "ph");
  if (!ph) return undefined;
  return {
    type: ph.getAttribute("type") ?? "body",
    idx: ph.getAttribute("idx") ?? "",
  };
};

const isTitle = (type: string) => type === "title" || type === "ctrTitle";

/** Placeholder shapes of a layout or master, by type and by index. */
function placeholders(doc: Document | undefined) {
  const byType = new Map<string, Element>();
  const byIdx = new Map<string, Element>();
  if (!doc) return { byType, byIdx };
  for (const shape of all(doc, "sp")) {
    const key = placeholderKey(shape);
    if (!key) continue;
    if (!byType.has(key.type)) byType.set(key.type, shape);
    if (key.idx) byIdx.set(key.idx, shape);
  }
  return { byType, byIdx };
}

/** Theme colours by scheme name, through the master's colour map. */
function schemeColors(
  theme: Document | undefined,
  master: Document | undefined,
) {
  const colors = new Map<string, string>();
  const scheme = first(theme, "clrScheme");
  for (const entry of scheme ? Array.from(scheme.children) : []) {
    const value =
      first(entry, "srgbClr")?.getAttribute("val") ??
      first(entry, "sysClr")?.getAttribute("lastClr");
    if (value) colors.set(entry.localName, value);
  }
  const map = first(master, "clrMap");
  for (const [alias, fallback] of [
    ["bg1", "lt1"],
    ["tx1", "dk1"],
    ["bg2", "lt2"],
    ["tx2", "dk2"],
  ]) {
    const target = map?.getAttribute(alias) ?? fallback;
    const value = colors.get(target);
    if (value) colors.set(alias, value);
  }
  return colors;
}

interface TextStyle {
  align?: string;
  bullet?: string | null;
  marL?: number;
  indent?: number;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
}

function colorOf(node: Element | null, colors: Map<string, string>) {
  const fill = node && children(node, "solidFill")[0];
  if (!fill) return undefined;
  const rgb = first(fill, "srgbClr")?.getAttribute("val");
  if (rgb) return rgb;
  const scheme = first(fill, "schemeClr")?.getAttribute("val");
  return scheme ? colors.get(scheme) : undefined;
}

const flag = (value: string | null) =>
  value === null ? undefined : value === "1" || value === "true";

export const number = (value: string | null) =>
  value === null || value === "" ? undefined : Number(value);

function runStyle(props: Element | null, colors: Map<string, string>) {
  if (!props) return {};
  return {
    size: number(props.getAttribute("sz")),
    bold: flag(props.getAttribute("b")),
    italic: flag(props.getAttribute("i")),
    color: colorOf(props, colors),
  } satisfies TextStyle;
}

function levelStyle(level: Element | null, colors: Map<string, string>) {
  if (!level) return {};
  const bullet = children(level, "buNone").length
    ? null
    : children(level, "buChar")[0]?.getAttribute("char");
  return {
    align: level.getAttribute("algn") ?? undefined,
    bullet,
    marL: number(level.getAttribute("marL")),
    indent: number(level.getAttribute("indent")),
    ...runStyle(children(level, "defRPr")[0] ?? null, colors),
  } satisfies TextStyle;
}

export const merge = (...styles: TextStyle[]) => {
  const out: TextStyle = {};
  for (const style of styles)
    for (const [key, value] of Object.entries(style))
      if (value !== undefined) Object.assign(out, { [key]: value });
  return out;
};

/**
 * One text box's paragraphs. `lists` are the list-style elements it inherits,
 * weakest first (master text style, master and layout placeholder, its own).
 */
function paragraphs(
  body: Element | null,
  lists: (Element | null)[],
  colors: Map<string, string>,
  emuToCqw: number,
) {
  if (!body) return "";
  const scale =
    (Number(
      first(first(body, "bodyPr"), "normAutofit")?.getAttribute("fontScale"),
    ) || 100000) / 100000;
  const cqw = (emu: number) => `${(emu * emuToCqw).toFixed(3)}cqw`;
  return children(body, "p")
    .map((p) => {
      const pPr = children(p, "pPr")[0] ?? null;
      const level = Number(pPr?.getAttribute("lvl") ?? 0) + 1;
      const style = merge(
        { size: 1800 },
        ...lists.map((list) =>
          levelStyle(list && children(list, `lvl${level}pPr`)[0], colors),
        ),
        levelStyle(pPr, colors),
      );
      const runs = Array.from(p.children)
        .filter((c) => c.localName === "r" || c.localName === "fld")
        .map((run) => {
          const own = merge(style, runStyle(first(run, "rPr"), colors));
          const css = [
            `font-size:${cqw((own.size! / 100) * scale * emuPerPoint)}`,
            own.bold ? "font-weight:700" : "",
            own.italic ? "font-style:italic" : "",
            own.color ? `color:#${own.color}` : "",
          ]
            .filter(Boolean)
            .join(";");
          return `<span style="${css}">${escape(first(run, "t")?.textContent ?? "")}</span>`;
        })
        .join("");
      const empty = `<span style="font-size:${cqw((style.size! / 100) * scale * emuPerPoint)}">&nbsp;</span>`;
      const textAlign =
        style.align === "ctr"
          ? "center"
          : style.align === "r"
            ? "right"
            : style.align === "just"
              ? "justify"
              : "left";
      const css = [
        `text-align:${textAlign}`,
        style.marL ? `padding-left:${cqw(style.marL)}` : "",
        style.indent ? `text-indent:${cqw(style.indent)}` : "",
      ]
        .filter(Boolean)
        .join(";");
      const bullet =
        runs && style.bullet
          ? `<span class="bullet" style="${(style.indent ?? 0) < 0 ? `width:${cqw(-style.indent!)};` : ""}font-size:${cqw((style.size! / 100) * scale * emuPerPoint)}">${escape(style.bullet)}</span>`
          : "";
      return `<p style="${css}">${bullet}${runs || empty}</p>`;
    })
    .join("");
}

export async function renderPptx(base64: string, root: HTMLElement) {
  const zip = await JSZip.loadAsync(decode(base64));
  const presentation = await readText(zip, "ppt/presentation.xml");
  if (!presentation) throw new Error("This file has no slides.");
  const doc = parse(presentation);
  const size = first(doc, "sldSz");
  const cx = Number(size?.getAttribute("cx")) || 12192000;
  const cy = Number(size?.getAttribute("cy")) || 6858000;
  const emuToCqw = 100 / cx;
  const rels = await relations(zip, "ppt/presentation.xml");
  const pct = (value: number, total: number) =>
    `${((value / total) * 100).toFixed(3)}%`;
  const parsed = new Map<string, Document | undefined>();
  const load = async (path: string | undefined) => {
    if (!path) return undefined;
    if (!parsed.has(path)) {
      const xml = await readText(zip, path);
      parsed.set(path, xml ? parse(xml) : undefined);
    }
    return parsed.get(path);
  };
  const related = async (part: string | undefined, kind: string) =>
    part
      ? [...(await relations(zip, part)).values()].find((r) =>
          r.type.endsWith(`/${kind}`),
        )?.target
      : undefined;
  for (const id of all(doc, "sldId")) {
    const path = rels.get(attr(id, "r:id") ?? "")?.target;
    const slide = await load(path);
    if (!path || !slide) continue;
    const slideRels = await relations(zip, path);
    const layoutPath = [...slideRels.values()].find((r) =>
      r.type.endsWith("/slideLayout"),
    )?.target;
    const masterPath = await related(layoutPath, "slideMaster");
    const master = await load(masterPath);
    const colors = schemeColors(
      await load(await related(masterPath, "theme")),
      master,
    );
    const layoutShapes = placeholders(await load(layoutPath));
    const masterShapes = placeholders(master);
    const textStyles = first(master, "txStyles");
    /** The layout and master placeholders a slide placeholder inherits from. */
    const sources = (shape: Element) => {
      const key = placeholderKey(shape);
      if (!key) return [];
      const layout =
        (key.idx && layoutShapes.byIdx.get(key.idx)) ||
        layoutShapes.byType.get(key.type);
      const masterType = isTitle(key.type) ? "title" : "body";
      const inMaster =
        masterShapes.byType.get(key.type) ??
        masterShapes.byType.get(masterType);
      return [layout, inMaster].filter((s): s is Element => !!s);
    };
    const element = document.createElement("section");
    element.className = "slide";
    element.style.aspectRatio = `${cx} / ${cy}`;
    let html = "";
    const tree = first(slide, "spTree");
    for (const shape of tree ? Array.from(tree.children) : []) {
      const inherited = sources(shape);
      const box =
        boxOf(first(shape, "spPr")) ??
        boxOf(shape) ??
        inherited.map((s) => boxOf(first(s, "spPr"))).find(Boolean);
      if (!box) continue;
      const place = `left:${pct(box.x, cx)};top:${pct(box.y, cy)};width:${pct(box.w, cx)};height:${pct(box.h, cy)}`;
      if (shape.localName === "sp") {
        const key = placeholderKey(shape);
        const base = first(
          textStyles,
          !key ? "otherStyle" : isTitle(key.type) ? "titleStyle" : "bodyStyle",
        );
        const body = first(shape, "txBody");
        const lists = [
          base,
          ...[...inherited]
            .reverse()
            .map((s) => first(first(s, "txBody"), "lstStyle")),
          first(body, "lstStyle"),
        ];
        const anchor = [body, ...inherited.map((s) => first(s, "txBody"))]
          .map((b) => first(b, "bodyPr")?.getAttribute("anchor"))
          .find(Boolean);
        const justify =
          anchor === "ctr"
            ? "center"
            : anchor === "b"
              ? "flex-end"
              : "flex-start";
        const fill = colorOf(first(shape, "spPr"), colors);
        // bodyPr insets default to 0.1 in left and right, 0.05 in top and bottom.
        html += `<div class="box text" style="${place};padding:${((45720 / cx) * 100).toFixed(3)}cqw ${((91440 / cx) * 100).toFixed(3)}cqw;justify-content:${justify}${fill ? `;background:#${fill}` : ""}">${paragraphs(body, lists, colors, emuToCqw)}</div>`;
      } else if (shape.localName === "pic") {
        const embed = attr(first(shape, "blip"), "r:embed");
        const target = embed ? slideRels.get(embed)?.target : undefined;
        const type = target && mime(target);
        const file = target && type ? zip.file(target) : null;
        if (file && type)
          html += `<img class="box" style="${place}" src="data:${type};base64,${await file.async("base64")}" alt="">`;
      } else if (shape.localName === "graphicFrame") {
        const table = first(shape, "tbl");
        if (!table) continue;
        const other = first(textStyles, "otherStyle");
        const rows = children(table, "tr")
          .map(
            (tr) =>
              `<tr>${children(tr, "tc")
                .map(
                  (tc) =>
                    `<td>${paragraphs(first(tc, "txBody"), [other], colors, emuToCqw)}</td>`,
                )
                .join("")}</tr>`,
          )
          .join("");
        html += `<div class="box" style="${place}"><table>${rows}</table></div>`;
      }
    }
    element.innerHTML = html;
    root.append(element);
  }
  if (!root.children.length)
    throw new Error("This presentation has no slides.");
}
