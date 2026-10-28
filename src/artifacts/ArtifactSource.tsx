import { Fragment, cloneElement, isValidElement, type ReactNode } from "react";
import { MarkdownRenderer as ReactMarkdown } from "../ui/MarkdownRenderer";
import { useRehypeHighlight } from "../ui/lazy-highlight";
import type { Artifact } from "../ui/ArtifactTypes";

/**
 * One line's pieces as siblings: tokens from different spans can carry the
 * same line key, so each piece is keyed by its place in the line.
 */
const keyedParts = (parts: ReactNode[]) =>
  parts.map((part, j) => <Fragment key={j}>{part}</Fragment>);

// Preserve token spans across newlines without interpreting source as HTML.
export function highlightedLines(node: ReactNode): ReactNode[][] {
  const result: ReactNode[][] = [[]];
  for (const child of Array.isArray(node) ? node : [node]) {
    let lines: ReactNode[][];
    if (typeof child === "string" || typeof child === "number")
      lines = String(child)
        .split("\n")
        .map((text) => [text]);
    else if (isValidElement<{ children?: ReactNode }>(child))
      lines = highlightedLines(child.props.children).map((parts, i) => [
        cloneElement(child, { key: i }, ...keyedParts(parts)),
      ]);
    else if (Array.isArray(child)) lines = highlightedLines(child);
    else lines = [[child]];
    result[result.length - 1].push(...lines[0]);
    result.push(...lines.slice(1));
  }
  return result;
}

export function markdownFence(content: string) {
  return "`".repeat(
    Math.max(3, ...[...content.matchAll(/`+/g)].map((m) => m[0].length + 1)),
  );
}

/**
 * Spaces and tabs as marked spans, for Show whitespace (R-1077): each keeps
 * its own width and CSS draws a dot or an arrow over it.
 */
export function markWhitespace(node: ReactNode): ReactNode {
  if (typeof node === "string")
    return node.split(/([ \t])/).map((part, i) =>
      part === " " || part === "\t" ? (
        <span key={i} className={part === " " ? "file-ws" : "file-ws tab"}>
          {part}
        </span>
      ) : (
        part
      ),
    );
  if (Array.isArray(node))
    return node.map((child, i) => (
      <Fragment key={i}>{markWhitespace(child)}</Fragment>
    ));
  if (isValidElement<{ children?: ReactNode }>(node))
    return cloneElement(node, undefined, markWhitespace(node.props.children));
  return node;
}

/** Numbered, highlighted source lines (the Code view). */
export function ArtifactSource({
  artifact,
  showWhitespace = false,
  onLineSelect,
}: {
  artifact: Artifact;
  /** Code sessions' Show whitespace option. */
  showWhitespace?: boolean;
  onLineSelect?: (line: number) => void;
}) {
  const fence = markdownFence(artifact.content);
  const highlight = useRehypeHighlight();
  return (
    <div
      className="file-source"
      data-language={artifact.language}
      aria-label="File source"
    >
      <ReactMarkdown
        rehypePlugins={highlight ? [highlight] : []}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ children }) => (
            <div className="file-source-lines">
              {highlightedLines(children)
                .slice(0, -1)
                .map((line, i) => (
                  <div className="file-source-line" key={i}>
                    {onLineSelect ? (
                      <button
                        type="button"
                        onClick={() => onLineSelect(i)}
                        aria-label={`${i + 1}`}
                      >
                        {i + 1}
                      </button>
                    ) : (
                      <span aria-hidden="true">{i + 1}</span>
                    )}
                    <code>
                      {showWhitespace
                        ? markWhitespace(keyedParts(line))
                        : keyedParts(line)}
                    </code>
                  </div>
                ))}
            </div>
          ),
        }}
      >{`${fence}${artifact.language}\n${artifact.content}\n${fence}`}</ReactMarkdown>
    </div>
  );
}
