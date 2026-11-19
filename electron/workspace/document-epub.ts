import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";

const block =
  /^(address|article|aside|blockquote|br|caption|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul)$/;

async function archiveXml(
  zip: JSZip,
  file: string,
  mime: "application/xml" | "text/html",
) {
  const source = zip.file(file);
  if (!source) throw Error("Missing EPUB file.");
  const invalid = () => {
    throw Error("Invalid EPUB markup.");
  };
  return new DOMParser({
    errorHandler: { error: invalid, fatalError: invalid },
  }).parseFromString(await source.async("string"), mime);
}

function archivePath(packageFile: string, href: string) {
  const entry = decodeURIComponent(href.split(/[?#]/, 1)[0]);
  if (!entry) throw Error("Missing EPUB chapter path.");
  return entry.startsWith("/")
    ? entry.slice(1)
    : path.posix.join(path.posix.dirname(packageFile), entry);
}

function chapterText(root: Element) {
  const lines: string[] = [];
  function visit(node: Node) {
    if (node.nodeType === 3 || node.nodeType === 4) {
      lines.push((node.nodeValue ?? "").replace(/\s+/g, " "));
    } else if (node.nodeType === 1) {
      const name = node.nodeName.split(":").pop() ?? "";
      if (name === "script" || name === "style") return;
      const separate = block.test(name);
      if (separate) lines.push("\n");
      for (let child = node.firstChild; child; child = child.nextSibling)
        visit(child);
      if (separate) lines.push("\n");
      else if (name === "td" || name === "th") lines.push(" ");
    }
  }
  visit(root);
  return lines
    .join("")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim();
}

export async function epubText(data: Buffer, signal?: AbortSignal) {
  const zip = await JSZip.loadAsync(data);
  const container = await archiveXml(
    zip,
    "META-INF/container.xml",
    "application/xml",
  );
  const packageFile = container
    .getElementsByTagNameNS("*", "rootfile")
    .item(0)
    ?.getAttribute("full-path");
  if (!packageFile) throw Error("Missing EPUB package.");
  const book = await archiveXml(zip, packageFile, "application/xml");
  const manifest = book.getElementsByTagNameNS("*", "manifest").item(0);
  const spine = book.getElementsByTagNameNS("*", "spine").item(0);
  if (!manifest || !spine) throw Error("Missing EPUB reading order.");
  const entries = new Map(
    Array.from(manifest.getElementsByTagNameNS("*", "item"), (item) => [
      item.getAttribute("id"),
      item.getAttribute("href"),
    ]),
  );
  const chapters: string[] = [];
  for (const item of Array.from(spine.getElementsByTagNameNS("*", "itemref"))) {
    signal?.throwIfAborted();
    const href = entries.get(item.getAttribute("idref"));
    if (!href) throw Error("Missing EPUB chapter.");
    const chapter = await archiveXml(
      zip,
      archivePath(packageFile, href),
      "text/html",
    );
    const body = chapter.getElementsByTagNameNS("*", "body").item(0);
    const svg =
      chapter.documentElement.localName === "svg" && chapter.documentElement;
    if (!body && !svg) throw Error("Invalid EPUB chapter.");
    const text = body
      ? chapterText(body)
      : svg
        ? Array.from(svg.getElementsByTagNameNS("*", "text"), (element) =>
            chapterText(element),
          ).join("\n")
        : "";
    if (text) chapters.push(text);
  }
  return chapters.join("\n\n");
}
