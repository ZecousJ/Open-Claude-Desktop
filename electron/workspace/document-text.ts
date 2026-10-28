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

/** The most text a document gives the model; the rest is cut with a note. */
export const maxDocumentChars = 400_000;

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

/** The text runs of an Office XML part, a paragraph per line. */
function xmlText(xml: string, run: string, paragraph: string) {
  const out: string[] = [];
  const paragraphs = xml.split(new RegExp(`</${paragraph}>`));
  const runs = new RegExp(`<${run}(?:\\s[^>]*)?>([^<]*)</${run}>`, "g");
  for (const part of paragraphs) {
    let line = "";
    for (const match of part.matchAll(runs)) line += decode(match[1]!);
    if (line.trim()) out.push(line);
  }
  return out.join("\n");
}

const numbered = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

async function pptxText(data: Buffer) {
  const zip = await JSZip.loadAsync(data);
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => numbered(a) - numbered(b));
  const parts: string[] = [];
  for (const [index, name] of slides.entries()) {
    const text = xmlText(await zip.file(name)!.async("string"), "a:t", "a:p");
    const notesName = `ppt/notesSlides/notesSlide${numbered(name)}.xml`;
    const notesFile = zip.file(notesName);
    const notes = notesFile
      ? xmlText(await notesFile.async("string"), "a:t", "a:p")
          // A notes page repeats the slide number as its only text.
          .replace(/^\d+$/m, "")
          .trim()
      : "";
    parts.push(
      `## Slide ${index + 1}\n${text || "(no text)"}${notes ? `\n\nNotes:\n${notes}` : ""}`,
    );
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

async function xlsxText(data: Buffer) {
  const zip = await JSZip.loadAsync(data);
  const shared: string[] = [];
  const sharedFile = zip.file("xl/sharedStrings.xml");
  if (sharedFile)
    for (const si of (await sharedFile.async("string")).split("</si>")) {
      let text = "";
      for (const m of si.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g))
        text += decode(m[1]!);
      shared.push(text);
    }
  shared.pop();
  // Sheet names in workbook order, matched to their files by relationship.
  const workbook = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const rels =
    (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target)
      targets.set(
        id,
        target.startsWith("/") ? target.slice(1) : `xl/${target}`,
      );
  }
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: decode(/name="([^"]*)"/.exec(m[0])?.[1] ?? "Sheet"),
    file: targets.get(/r:id="([^"]+)"/.exec(m[0])?.[1] ?? "") ?? "",
  }));
  const parts: string[] = [];
  for (const sheet of sheets) {
    const xml = await zip.file(sheet.file)?.async("string");
    if (!xml) continue;
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of row[1]!.matchAll(
        /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
      )) {
        const attrs = cell[1]!;
        const body = cell[2] ?? "";
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const type = /t="([^"]+)"/.exec(attrs)?.[1];
        const value = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        let text = "";
        if (type === "s" && value !== undefined)
          text = shared[Number(value)] ?? "";
        else if (type === "inlineStr")
          text = [...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)]
            .map((m) => decode(m[1]!))
            .join("");
        else if (value !== undefined) text = decode(value);
        const at = ref ? column(ref) : cells.length;
        while (cells.length < at) cells.push("");
        cells[at] = text.replace(/[\t\n\r]+/g, " ");
      }
      if (cells.some((c) => c.trim())) rows.push(cells.join("\t"));
    }
    parts.push(`## Sheet: ${sheet.name}\n${rows.join("\n") || "(empty)"}`);
  }
  return parts.join("\n\n");
}

async function pdfText(data: Buffer) {
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
  const doc = await task.promise;
  const pages: string[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
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
      pages.push(`## Page ${n}\n${text.trim() || "(no text)"}`);
      if (pages.join("").length > maxDocumentChars) break;
    }
  } finally {
    await task.destroy();
  }
  return pages.join("\n\n");
}

const readers: Record<string, (data: Buffer) => Promise<string>> = {
  pptx: pptxText,
  docx: docxText,
  xlsx: xlsxText,
  pdf: pdfText,
};

/** The document's text, cut at `maxDocumentChars`; throws a plain sentence when it can't be read. */
export async function documentText(file: string, name = file): Promise<string> {
  const extension = path.extname(name).slice(1).toLowerCase();
  const read = readers[extension];
  if (!read)
    throw new Error(
      `${path.basename(name)} isn't a document Claudex can read.`,
    );
  let text: string;
  try {
    text = await read(fs.readFileSync(file));
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
