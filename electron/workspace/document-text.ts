/**
 * The text of an attached document (PDF, Word, PowerPoint, Excel), so the
 * model reads it the way it reads an attached text file. Nothing is sent
 * anywhere: the file is read where it was stored (this computer or the
 * runner). Pictures in the document are not described; a document with no
 * text (a scan) says so.
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { epubText } from "./document-epub";

/** The most text a document gives the model; the rest is cut with a note. */
export const maxDocumentChars = 400_000;

type ReadOptions =
  { mode: "model" } | { mode: "complete"; signal?: AbortSignal };
type DocumentReader = (data: Buffer, options: ReadOptions) => Promise<string>;

function section(
  title: string,
  text: string,
  placeholder: string,
  options: ReadOptions,
) {
  return text
    ? `## ${title}\n${text}`
    : options.mode === "model"
      ? `## ${title}\n${placeholder}`
      : "";
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
function decode(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name[0] === "#")
      return String.fromCodePoint(
        name[1] === "x" || name[1] === "X"
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10),
      );
    return entities[name] ?? whole;
  });
}

const numbered = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

function officeXml(source: string) {
  const invalid = () => {
    throw Error("Invalid Office markup.");
  };
  return new DOMParser({
    errorHandler: { error: invalid, fatalError: invalid },
  }).parseFromString(source, "application/xml");
}

function archiveTarget(part: string, href: string) {
  const target = decodeURIComponent(href);
  return target.startsWith("/")
    ? target.slice(1)
    : path.posix.join(path.posix.dirname(part), target);
}

async function officeRelationships(zip: JSZip, part: string) {
  const rels = path.posix.join(
    path.posix.dirname(part),
    "_rels",
    path.posix.basename(part) + ".rels",
  );
  const source = await zip.file(rels)?.async("string");
  return source
    ? Array.from(officeXml(source).getElementsByTagNameNS("*", "Relationship"))
    : [];
}

function relationshipId(element: Element) {
  return Array.from(element.attributes).find(
    (attribute) => attribute.namespaceURI && attribute.localName === "id",
  )?.value;
}

async function relationshipTargets(zip: JSZip, part: string) {
  return new Map(
    (await officeRelationships(zip, part)).map((relationship) => [
      relationship.getAttribute("Id"),
      relationship.getAttribute("Target"),
    ]),
  );
}

function slideText(source: string, notes = false) {
  const document = officeXml(source);
  if (notes) {
    for (const shape of Array.from(
      document.getElementsByTagNameNS("*", "sp"),
    )) {
      const placeholder = shape.getElementsByTagNameNS("*", "ph").item(0);
      if (placeholder?.getAttribute("type") === "sldNum")
        shape.parentNode?.removeChild(shape);
    }
  }
  return Array.from(document.getElementsByTagNameNS("*", "p"), (paragraph) =>
    Array.from(
      paragraph.getElementsByTagNameNS("*", "t"),
      (run) => run.textContent ?? "",
    ).join(""),
  )
    .filter((line) => line.trim())
    .join("\n");
}

async function pptxText(data: Buffer, options: ReadOptions) {
  const zip = await JSZip.loadAsync(data);
  const presentation = "ppt/presentation.xml";
  const source = await zip.file(presentation)?.async("string");
  const targets = await relationshipTargets(zip, presentation);
  const slides = source
    ? Array.from(
        officeXml(source).getElementsByTagNameNS("*", "sldId"),
        (slide) => {
          const target = targets.get(relationshipId(slide) ?? "");
          if (!target) throw Error("Missing presentation slide.");
          return archiveTarget(presentation, target);
        },
      )
    : Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => numbered(a) - numbered(b));
  const parts: string[] = [];
  for (const [index, name] of slides.entries()) {
    if (options.mode === "complete") options.signal?.throwIfAborted();
    const slide = zip.file(name);
    if (!slide) throw Error("Missing presentation slide.");
    const text = slideText(await slide.async("string"));
    const noteTarget = (await officeRelationships(zip, name))
      .find((entry) => entry.getAttribute("Type")?.endsWith("/notesSlide"))
      ?.getAttribute("Target");
    const notesFile = noteTarget
      ? zip.file(archiveTarget(name, noteTarget))
      : source
        ? null
        : zip.file(`ppt/notesSlides/notesSlide${numbered(name)}.xml`);
    if (noteTarget && !notesFile) throw Error("Missing presentation notes.");
    let notes = notesFile
      ? slideText(await notesFile.async("string"), true)
      : "";
    if (!source) notes = notes.replace(/^\d+$/m, "").trim();
    const body = [
      text || (options.mode === "model" && notes ? "(no text)" : ""),
      notes && `Notes:\n${notes}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const part = section(`Slide ${index + 1}`, body, "(no text)", options);
    if (part) parts.push(part);
  }
  return parts.join("\n\n");
}

async function docxText(data: Buffer) {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: data });
  return result.value.replace(/\n{3,}/g, "\n\n").trim();
}

/** Column letters of a cell reference ("AB12" → 27). */
function column(ref: string) {
  let n = 0;
  for (const c of /^[A-Z]+/.exec(ref)?.[0] ?? "A")
    n = n * 26 + c.charCodeAt(0) - 64;
  return n - 1;
}

async function xlsxText(data: Buffer, options: ReadOptions) {
  const zip = await JSZip.loadAsync(data);
  const sharedFile = zip.file("xl/sharedStrings.xml");
  const runText = (xml: string) =>
    Array.from(
      xml.matchAll(/<(?:[\w.-]+:)?t(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?t>/g),
      (run) => decode(run[1]!),
    ).join("");
  const shared = sharedFile
    ? Array.from(
        (await sharedFile.async("string")).matchAll(
          /<(?:[\w.-]+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?si>)/g,
        ),
        (item) => runText(item[1] ?? ""),
      )
    : [];
  const workbook = "xl/workbook.xml";
  const source = await zip.file(workbook)?.async("string");
  if (!source) throw Error("Missing workbook.");
  const targets = await relationshipTargets(zip, workbook);
  const sheets = Array.from(
    officeXml(source).getElementsByTagNameNS("*", "sheet"),
  );
  const parts: string[] = [];
  for (const sheet of sheets) {
    if (options.mode === "complete") options.signal?.throwIfAborted();
    const target = targets.get(relationshipId(sheet) ?? "");
    const xml =
      target &&
      (await zip.file(archiveTarget(workbook, target))?.async("string"));
    if (!xml) {
      if (options.mode === "complete") throw Error("Missing workbook sheet.");
      continue;
    }
    const rows: string[] = [];
    for (const row of xml.matchAll(
      /<(?:[\w.-]+:)?row\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?row>)/g,
    )) {
      const cells: string[] = [];
      for (const cell of (row[1] ?? "").matchAll(
        /<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/g,
      )) {
        const attrs = cell[1]!;
        const body = cell[2] ?? "";
        const ref = /\br=["']([A-Z]+)\d+["']/.exec(attrs)?.[1];
        const type = /\bt=["']([^"']+)["']/.exec(attrs)?.[1];
        const value = /<(?:[\w.-]+:)?v>([^<]*)<\/(?:[\w.-]+:)?v>/.exec(
          body,
        )?.[1];
        let text = "";
        if (type === "s" && value !== undefined)
          text = shared[Number(value)] ?? "";
        else if (type === "inlineStr") text = runText(body);
        else if (value) text = decode(value);
        else {
          const formula =
            /<(?:[\w.-]+:)?f(?:\s[^>]*)?>([^<]+)<\/(?:[\w.-]+:)?f>/.exec(
              body,
            )?.[1];
          if (formula) text = "=" + decode(formula);
        }
        const at = ref ? column(ref) : cells.length;
        while (cells.length < at) cells.push("");
        cells[at] = text.replace(/[\t\n\r]+/g, " ");
      }
      if (cells.some((c) => c.trim())) rows.push(cells.join("\t"));
    }
    const part = section(
      `Sheet: ${sheet.getAttribute("name") ?? "Sheet"}`,
      rows.join("\n"),
      "(empty)",
      options,
    );
    if (part) parts.push(part);
  }
  return parts.join("\n\n");
}

async function pdfText(data: Buffer, options: ReadOptions) {
  // The worker's code in this process: pdf.js looks for it on globalThis
  // before it tries to load a worker file, which a bundle doesn't have.
  const worker: unknown =
    await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker ??= worker;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    // Only the text is read: no font warnings in the log.
    verbosity: 0,
  });
  const pages: string[] = [];
  let chars = 0;
  try {
    const doc = await task.promise;
    for (let n = 1; n <= doc.numPages; n++) {
      if (options.mode === "complete") options.signal?.throwIfAborted();
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items as {
        str?: string;
        hasEOL?: boolean;
      }[]) {
        text += item.str ?? "";
        if (item.hasEOL) text += "\n";
      }
      const part = section(`Page ${n}`, text.trim(), "(no text)", options);
      if (part) pages.push(part);
      chars += part.length;
      if (options.mode === "model" && chars > maxDocumentChars) break;
    }
  } finally {
    await task.destroy();
  }
  return pages.join("\n\n");
}

const readers: Record<string, DocumentReader> = {
  pptx: pptxText,
  docx: docxText,
  xlsx: xlsxText,
  pdf: pdfText,
};

export function completeDocumentTextData(
  data: Buffer,
  extension: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (extension === "epub") return epubText(data, signal);
  const read = readers[extension];
  if (!read) throw Error("Unsupported document format.");
  return read(data, { mode: "complete", signal });
}

/** The document's text, cut at `maxDocumentChars`; throws a plain sentence when it can't be read. */
export async function documentTextData(
  data: Buffer,
  name: string,
): Promise<string> {
  const extension = path.extname(name).slice(1).toLowerCase();
  const read = readers[extension];
  if (!read)
    throw new Error(
      `${path.basename(name)} isn't a document Claudex can read.`,
    );
  let text: string;
  try {
    text = await read(data, { mode: "model" });
  } catch {
    throw new Error(
      `${path.basename(name)} couldn't be read. It may be damaged or protected with a password.`,
    );
  }
  if (!text.replace(/##[^\n]*|\(no text\)|\(empty\)/g, "").trim())
    return "(This document has no text Claudex can read, for example a scan or only pictures.)";
  return text.length > maxDocumentChars
    ? `${text.slice(0, maxDocumentChars)}\n\n(The rest of the document was cut: it is longer than Claudex reads at once.)`
    : text;
}

export async function documentText(file: string, name = file): Promise<string> {
  if (!readers[path.extname(name).slice(1).toLowerCase()])
    throw new Error(
      `${path.basename(name)} isn't a document Claudex can read.`,
    );
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    throw new Error(
      `${path.basename(name)} couldn't be read. It may be damaged or protected with a password.`,
    );
  }
  return documentTextData(data, name);
}
