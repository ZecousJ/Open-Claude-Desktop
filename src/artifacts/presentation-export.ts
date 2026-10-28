import JSZip from "jszip";
import type { Artifact } from "../ui/ArtifactTypes";
import { documentFilename } from "../../shared/artifact-document";

const drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
const presentation =
  "http://schemas.openxmlformats.org/presentationml/2006/main";
const relationships =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const xml = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const group =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

export interface PresentationSlide {
  title: string;
  paragraphs: string[];
}

export function presentationSlides(artifact: Artifact): PresentationSlide[] {
  if (artifact.language.toLowerCase() === "html") {
    const document = new DOMParser().parseFromString(
      artifact.content,
      "text/html",
    );
    document
      .querySelectorAll("script,style,nav,button")
      .forEach((element) => element.remove());
    const selected = Array.from(
      document.querySelectorAll("[data-slide],.slide"),
    );
    const slides = selected.filter(
      (element) =>
        !selected.some((other) => other !== element && other.contains(element)),
    );
    return (slides.length ? slides : [document.body]).map((element) => {
      const heading = element.querySelector("h1,h2,h3");
      const title = heading?.textContent?.trim() ?? artifact.name;
      heading?.remove();
      const paragraphs = Array.from(
        element.querySelectorAll("p,li,h1,h2,h3,h4,blockquote,pre"),
      )
        .filter((node) => !node.parentElement?.closest("p,li,blockquote,pre"))
        .map((node) => node.textContent?.trim() ?? "")
        .filter(Boolean);
      return {
        title,
        paragraphs: paragraphs.length
          ? paragraphs
          : [element.textContent?.trim() ?? ""],
      };
    });
  }
  return artifact.content
    .split(/^\s*---\s*$/m)
    .filter((part) => part.trim())
    .map((part) => {
      const lines = part
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.trim());
      return {
        title: lines.shift()?.replace(/^#{1,6}\s+/, "") ?? artifact.name,
        paragraphs: lines.map((line) =>
          line.replace(/^#{1,6}\s+/, "").replace(/\*\*([^*]+)\*\*/g, "$1"),
        ),
      };
    });
}

function textShape(
  id: number,
  name: string,
  lines: string[],
  top: number,
  height: number,
  size: number,
) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="548640" y="${top}"/><a:ext cx="11094720" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${lines.map((line) => `<a:p><a:r><a:rPr lang="en-US" sz="${size}"/><a:t xml:space="preserve">${xml(line)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
}

/** Individual decks can export to PowerPoint. */
export async function presentationBytes(slides: PresentationSlide[]) {
  if (!slides.length) throw new Error("The request failed.");
  const zip = new JSZip();
  const rels = (items: [string, string, string][]) =>
    declaration +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${relationships}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
  const roots = `xmlns:a="${drawing}" xmlns:r="${relationships}" xmlns:p="${presentation}"`;
  const types: [string, string][] = [
    ["presentation", "presentation.main"],
    ["slideMasters/slideMaster1", "slideMaster"],
    ["slideLayouts/slideLayout1", "slideLayout"],
  ];
  slides.forEach((slide, index) => {
    const number = index + 1;
    types.push([`slides/slide${number}`, "slide"]);
    zip.file(
      `ppt/slides/slide${number}.xml`,
      declaration +
        `<p:sld ${roots}><p:cSld><p:spTree>${group}${textShape(2, "Title", [slide.title], 365760, 914400, 3200)}${textShape(3, "Content", slide.paragraphs, 1463040, 4846320, 2000)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    );
    zip.file(
      `ppt/slides/_rels/slide${number}.xml.rels`,
      rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
    );
  });
  zip.file(
    "[Content_Types].xml",
    declaration +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${types.map(([name, type]) => `<Override PartName="/ppt/${name}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${type}+xml"/>`).join("")}</Types>`,
  );
  zip.file(
    "_rels/.rels",
    rels([["rId1", "officeDocument", "ppt/presentation.xml"]]),
  );
  zip.file(
    "ppt/presentation.xml",
    declaration +
      `<p:presentation ${roots}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    rels([
      ["rIdMaster", "slideMaster", "slideMasters/slideMaster1.xml"],
      ...slides.map((_, index): [string, string, string] => [
        `rId${index + 1}`,
        "slide",
        `slides/slide${index + 1}.xml`,
      ]),
    ]),
  );
  zip.file(
    "ppt/slideMasters/slideMaster1.xml",
    declaration +
      `<p:sldMaster ${roots}><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
  );
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
  );
  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    declaration +
      `<p:sldLayout ${roots} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  );
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
  );
  return zip.generateAsync({ type: "base64", compression: "DEFLATE" });
}

export async function exportPresentation(
  artifact: Artifact,
  title = artifact.name,
) {
  const bytes =
    artifact.blob && artifact.sourceDigest
      ? await window.desktop.readGeneratedFile(artifact.sourceDigest)
      : await presentationBytes(presentationSlides(artifact));
  return window.desktop.saveArtifactBytes(
    documentFilename(title, "pptx"),
    bytes,
  );
}
