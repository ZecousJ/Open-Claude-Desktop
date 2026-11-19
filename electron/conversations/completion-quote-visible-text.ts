/** A deliberately narrow projection for DOM-selected, inline Markdown quotes.
 * This is not a general renderer or a claim of parity with every official UI
 * extension. The raw-source match remains the caller's first choice. */
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { cjkEmphasis } from "../../scripts/official-ui-cjk-emphasis.mjs";

const maxSourceCharacters = 64 * 1024;
const maxNodes = 4096;
const maxDepth = 32;
const ambiguousWhitespace = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
type Node = {
  type?: unknown;
  value?: unknown;
  children?: unknown;
  position?: {
    start?: { line?: number; offset?: number };
    end?: { line?: number; offset?: number };
  };
};

/** Returns separate eligible top-level paragraphs, never joined across blocks.
 * Each must be single-line and contain only known inline nodes. Unsupported
 * paragraphs/blocks have no projection and must not authorize a quote. */
export function completionQuoteVisibleParagraphs(
  source: string,
): string[] | undefined {
  if (source.length > maxSourceCharacters) return undefined;

  let projected: string[] | undefined;
  const capture = () => (tree: unknown) => {
    let visited = 0;
    const inline = (value: unknown, depth: number): string | undefined => {
      if (
        ++visited > maxNodes ||
        depth > maxDepth ||
        !value ||
        typeof value !== "object"
      )
        return undefined;
      const node = value as Node;
      if (node.type === "text" || node.type === "inlineCode")
        return typeof node.value === "string" &&
          !ambiguousWhitespace.test(node.value)
          ? node.value
          : undefined;
      if (
        !["emphasis", "strong", "delete", "link"].includes(String(node.type)) ||
        !Array.isArray(node.children)
      )
        return undefined;
      const parts = node.children.map((child) => inline(child, depth + 1));
      return parts.every((part): part is string => part !== undefined)
        ? parts.join("")
        : undefined;
    };
    const root = tree as Node | null;
    if (root?.type === "root" && Array.isArray(root.children)) {
      // A raw HTML block can affect the visibility of surrounding content in
      // other renderers. Do not claim that adjacent paragraphs are independent.
      if (
        root.children.some((child) => (child as Node | null)?.type === "html")
      )
        return { type: "root" as const, children: [] };
      const paragraphs: string[] = [];
      for (const child of root.children) {
        const paragraph = child as Node | null;
        if (
          paragraph?.type !== "paragraph" ||
          !Array.isArray(paragraph.children)
        )
          continue;
        const start = paragraph.position?.start,
          end = paragraph.position?.end;
        if (
          !start ||
          !end ||
          start.line !== end.line ||
          start.offset === undefined ||
          end.offset === undefined
        )
          continue;
        const raw = source.slice(start.offset, end.offset);
        if (
          ambiguousWhitespace.test(raw) ||
          // These alternate math delimiters are not parsed by remark-math.
          // Refuse them instead of flattening escaped math punctuation.
          raw.includes("\\(") ||
          raw.includes("\\[")
        )
          continue;
        const parts = paragraph.children.map((child) => inline(child, 0));
        if (parts.every((part): part is string => part !== undefined))
          paragraphs.push(parts.join(""));
      }
      if (visited <= maxNodes && paragraphs.length) projected = paragraphs;
    }
    // Use the existing declared parser dependencies without rendering source
    // HTML, constructing source components, following links, or touching a DOM.
    return { type: "root" as const, children: [] };
  };
  try {
    Markdown({
      children: source,
      remarkPlugins: [[remarkGfm, { singleTilde: false }], remarkMath, cjkEmphasis, capture],
    });
    return projected;
  } catch {
    return undefined;
  }
}
