import JSZip from "jszip";
import { markdownToHtml } from "../ui/markdown-html";
import { documentFilename } from "../../shared/artifact-document";
import type { Artifact } from "../ui/ArtifactTypes";
import { markdownFence } from "./ArtifactSource";

const xml = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

export async function documentContent(artifact: Artifact) {
  if (artifact.blob) {
    if (!artifact.sourceDigest) throw new Error("Unable to export document.");
    const base64 = await window.desktop.readGeneratedFile(
      artifact.sourceDigest,
    );
    const bytes = Uint8Array.from(atob(base64), (character) =>
      character.charCodeAt(0),
    );
    const mammoth = await import("mammoth");
    const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
    const document = new DOMParser().parseFromString(result.value, "text/html");
    return { html: result.value, markdown: documentMarkdown(document.body) };
  }
  return {
    markdown: artifact.content,
    html: await markdownToHtml(artifact.content),
  };
}

export function documentMarkdown(node: Node): string {
  if (node.nodeType === 3)
    return (node.textContent ?? "").replace(/([\\`*_[\]])/g, "\\$1");
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  const text = Array.from(node.childNodes, documentMarkdown).join("");
  switch (element.tagName.toLowerCase()) {
    case "script":
    case "style":
      return "";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `${"#".repeat(Number(element.tagName[1]))} ${text}\n\n`;
    case "p":
      return `${text}\n\n`;
    case "strong":
    case "b":
      return `**${text}**`;
    case "em":
    case "i":
      return `*${text}*`;
    case "br":
      return "\n";
    case "li":
      return `- ${text.trim()}\n`;
    case "ul":
    case "ol":
      return `${text}\n`;
    case "blockquote":
      return `${text
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    case "pre": {
      const source = element.textContent ?? "";
      const fence = markdownFence(source);
      return `${fence}\n${source}\n${fence}\n\n`;
    }
    case "code":
      return `\`${text}\``;
    case "a": {
      const href = element.getAttribute("href") ?? "";
      return /^(https?:|mailto:)/i.test(href)
        ? `[${text}](${href.replace(/\(/g, "%28").replace(/\)/g, "%29")})`
        : text;
    }
    case "tr":
      return `| ${Array.from(element.children, (cell) => documentMarkdown(cell).trim().replace(/\|/g, "\\|")).join(" | ")} |\n`;
    case "table": {
      const rows = Array.from(element.querySelectorAll("tr"));
      if (!rows.length) return "";
      return `${documentMarkdown(rows[0])}| ${Array.from(rows[0].children, () => "---").join(" | ")} |\n${rows.slice(1).map(documentMarkdown).join("")}\n`;
    }
    default:
      return text;
  }
}

export async function documentDocx(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const links: { id: string; href: string }[] = [];
  const inline = (node: Node, properties = ""): string => {
    if (node.nodeType === 3)
      return (node.textContent ?? "")
        .split("\n")
        .map(
          (line) =>
            `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(line)}</w:t></w:r>`,
        )
        .join("<w:r><w:br/></w:r>");
    if (node.nodeType !== 1) return "";
    const tag = (node as Element).tagName.toLowerCase();
    if (tag === "script" || tag === "style") return "";
    if (tag === "br") return "<w:r><w:br/></w:r>";
    if (tag === "a") {
      const href = (node as Element).getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(href)) {
        const id = `link${links.length + 1}`;
        links.push({ id, href });
        return `<w:hyperlink r:id="${id}">${Array.from(node.childNodes, (child) => inline(child, properties)).join("")}</w:hyperlink>`;
      }
    }
    if (tag === "img")
      return `<w:r><w:t>${xml((node as Element).getAttribute("alt") ?? "")}</w:t></w:r>`;
    const extra = /^(strong|b)$/.test(tag)
      ? "<w:b/>"
      : /^(em|i)$/.test(tag)
        ? "<w:i/>"
        : tag === "del"
          ? "<w:strike/>"
          : tag === "code"
            ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>'
            : "";
    return Array.from(node.childNodes, (child) =>
      inline(child, properties + extra),
    ).join("");
  };
  const blocks = (parent: Element): string =>
    Array.from(parent.childNodes, (node): string => {
      if (node.nodeType === 3)
        return node.textContent?.trim() ? `<w:p>${inline(node)}</w:p>` : "";
      if (node.nodeType !== 1) return "";
      const element = node as Element;
      const tag = element.tagName.toLowerCase();
      if (tag === "script" || tag === "style") return "";
      if (tag === "table")
        return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${Array.from(element.querySelectorAll("tr"), (row) => `<w:tr>${Array.from(row.children, (cell) => `<w:tc>${blocks(cell) || "<w:p/>"}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
      if (tag === "ul" || tag === "ol")
        return Array.from(
          element.children,
          (item, index) =>
            `<w:p><w:r><w:t xml:space="preserve">${tag === "ol" ? `${index + 1}. ` : "• "}</w:t></w:r>${inline(item)}</w:p>`,
        ).join("");
      if (/^(div|section|article|blockquote|thead|tbody)$/.test(tag))
        return blocks(element);
      const heading = /^h[1-6]$/.test(tag)
        ? `<w:pPr><w:pStyle w:val="Heading${tag[1]}"/><w:outlineLvl w:val="${Number(tag[1]) - 1}"/></w:pPr>`
        : "";
      return `<w:p>${heading}${inline(element)}</w:p>`;
    }).join("");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${blocks(document.body)}<w:sectPr/></w:body></w:document>`,
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${Array.from({ length: 6 }, (_, index) => `<w:style w:type="paragraph" w:styleId="Heading${index + 1}"><w:name w:val="heading ${index + 1}"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>`).join("")}</w:styles>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${links.map(({ id, href }) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(href)}" TargetMode="External"/>`).join("")}</Relationships>`,
  );
  return zip.generateAsync({ type: "base64", compression: "DEFLATE" });
}

export async function exportDocument(
  artifact: Artifact,
  format: "docx" | "pdf" | "md",
  title = artifact.name,
) {
  if (format === "docx" && artifact.blob && artifact.sourceDigest)
    return window.desktop.saveGeneratedFile(
      artifact.sourceDigest,
      documentFilename(title, format),
    );
  const { html, markdown } = await documentContent(artifact);
  if (format === "pdf") return window.desktop.exportDocumentPdf(title, html);
  const filename = documentFilename(title, format);
  return format === "md"
    ? window.desktop.saveArtifact(filename, markdown)
    : window.desktop.saveArtifactBytes(filename, await documentDocx(html));
}
