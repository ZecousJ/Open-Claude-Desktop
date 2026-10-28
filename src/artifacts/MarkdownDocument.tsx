import { Suspense, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "../ui/Markdown";
import "./file-viewer-panel.css";
import { lazyPiece } from "../ui/lazy-piece";

/** The contents rail, loaded for a document that has headings to list. */
const MarkdownRail = lazyPiece(() => import("./MarkdownRail"));

/**
 * A Markdown file in the viewer, laid out as in the reference design.
 * A conversation's Markdown artifact reads in a 768px column (16px
 * above and below, 24px before and 64px after the text; 24px and 44px from
 * 768px wide) with no contents rail. A document from a Code or Cowork session
 * reads in the document column (a 540px measure at the Medium transcript text
 * size, 504px or 576px at Small or Large, side padding growing with the panel
 * from 20px to 64px, 32–56px above and 96px below) and, once it has three
 * headings, gets the contents rail in its left margin (MarkdownRail.tsx).
 */
export function MarkdownDocument({
  text,
  asDocument = false,
}: {
  text: string;
  /** A Code or Cowork session's document: the document column and its rail. */
  asDocument?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [headed, setHeaded] = useState(false);
  // Whether the document has enough headings for a rail; the rail reads
  // which ones count.
  useLayoutEffect(() => {
    setHeaded(
      asDocument &&
        (body.current?.querySelectorAll("h1, h2, h3").length ?? 0) >= 3,
    );
  }, [text, asDocument]);
  const content = (
    <div ref={body} className="markdown">
      <Markdown text={text} />
    </div>
  );
  if (!asDocument)
    return (
      <div ref={scroller} className="file-preview artifact-markdown-preview">
        {content}
      </div>
    );
  return (
    <div
      ref={scroller}
      className="file-preview artifact-markdown-preview is-document"
    >
      <div className="markdown-document-column">
        {headed && (
          <Suspense fallback={null}>
            <MarkdownRail text={text} scroller={scroller} body={body} />
          </Suspense>
        )}
        {content}
      </div>
    </div>
  );
}
