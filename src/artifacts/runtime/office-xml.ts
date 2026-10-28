/** Reading the zip and XML parts shared by the Excel and PowerPoint previews (office-runtime.ts). */
import JSZip from "jszip";

export const decode = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export const parse = (xml: string) =>
  new DOMParser().parseFromString(xml, "application/xml");

export const all = (node: Document | Element, name: string) =>
  Array.from(node.getElementsByTagNameNS("*", name));

export const first = (
  node: Document | Element | null | undefined,
  name: string,
) => (node ? (node.getElementsByTagNameNS("*", name)[0] ?? null) : null);

export const children = (node: Element, name: string) =>
  Array.from(node.children).filter((child) => child.localName === name);

export const attr = (node: Element | null, name: string) =>
  node?.getAttribute(name) ??
  node?.getAttributeNS(
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    name.replace(/^r:/, ""),
  ) ??
  null;

export const escape = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );

export async function readText(zip: JSZip, path: string) {
  const file = zip.file(path);
  return file ? file.async("string") : undefined;
}

/** A part's relationships: id -> target path inside the archive. */
export async function relations(zip: JSZip, part: string) {
  const slash = part.lastIndexOf("/");
  const folder = part.slice(0, slash + 1);
  const xml = await readText(
    zip,
    `${folder}_rels/${part.slice(slash + 1)}.rels`,
  );
  const map = new Map<string, { target: string; type: string }>();
  if (!xml) return map;
  for (const rel of all(parse(xml), "Relationship")) {
    const target = rel.getAttribute("Target") ?? "";
    map.set(rel.getAttribute("Id") ?? "", {
      target: resolve(folder, target),
      type: rel.getAttribute("Type") ?? "",
    });
  }
  return map;
}

function resolve(folder: string, target: string) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (folder + target).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}
