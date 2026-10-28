import { Fragment, isValidElement, type ReactNode } from "react";

/**
 * Markdown with a line break kept as a line break (the original copies with
 * `breaks: true`): a hard break is added to each line that continues a
 * paragraph, except inside fenced code.
 */
export function withHardBreaks(markdown: string): string {
  const lines = markdown.split("\n");
  let fence = "";
  return lines
    .map((line, at) => {
      const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (opening) {
        if (!fence) fence = opening[0];
        else if (opening[0] === fence) fence = "";
        return line;
      }
      const next = lines[at + 1];
      if (fence || !line.trim() || next === undefined || !next.trim())
        return line;
      return /  $/.test(line) ? line : `${line}  `;
    })
    .join("\n");
}

const voidTags = new Set(["br", "hr", "img", "input", "col", "wbr"]);
const attributeNames: Record<string, string> = {
  className: "class",
  htmlFor: "for",
  colSpan: "colspan",
  rowSpan: "rowspan",
};
const escapeText = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (value: string) =>
  escapeText(value).replace(/"/g, "&quot;");

function styleText(style: Record<string, unknown>) {
  return Object.entries(style)
    .filter(
      ([, value]) => typeof value === "string" || typeof value === "number",
    )
    .map(
      ([name, value]) =>
        `${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${value}`,
    )
    .join(";");
}

/**
 * The HTML of the element tree react-markdown makes: plain elements, text
 * and fragments, which is all it makes without custom components.
 */
export function elementsToHtml(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (typeof node === "string" || typeof node === "number")
    return escapeText(String(node));
  if (Array.isArray(node)) return node.map(elementsToHtml).join("");
  if (!isValidElement(node)) return "";
  const { type } = node;
  const { children, ...props } = node.props as {
    children?: ReactNode;
    [name: string]: unknown;
  };
  if (type === Fragment) return elementsToHtml(children);
  if (typeof type !== "string") return elementsToHtml(children);
  const attributes = Object.entries(props)
    .map(([name, value]) => {
      if (value === false || value === null || value === undefined) return "";
      const written = attributeNames[name] ?? name;
      if (name === "style" && typeof value === "object")
        return ` style="${escapeAttribute(styleText(value as Record<string, unknown>))}"`;
      if (typeof value === "function" || typeof value === "object") return "";
      return value === true
        ? ` ${written}`
        : ` ${written}="${escapeAttribute(String(value))}"`;
    })
    .join("");
  return voidTags.has(type)
    ? `<${type}${attributes}/>`
    : `<${type}${attributes}>${elementsToHtml(children)}</${type}>`;
}

/**
 * A reply as the HTML a rich-text field takes on paste: headings, lists,
 * tables and code blocks keep their form. It loads with the first copy,
 * not with the page, and goes through the reply renderer's own parser and
 * GitHub-flavoured extensions (raw HTML in the text stays text).
 */
export async function markdownToHtml(markdown: string): Promise<string> {
  const [{ MarkdownAsync }, gfm, cjk] = await Promise.all([
    import("react-markdown"),
    import("remark-gfm"),
    import("remark-cjk-friendly"),
  ]);
  return elementsToHtml(
    await MarkdownAsync({
      children: withHardBreaks(markdown),
      remarkPlugins: [gfm.default, cjk.default],
    }),
  );
}
