import { useId, type ReactNode } from "react";
import { Pencil as PencilGlyph } from "./glyphs";
import { surface } from "../../shared/host";
import { Anthropicon, type AnthropiconName } from "./anthropicons";

/* The web draws the original's glyphs (its icon font at 16px, weight
   533.25; live claude.ai, 2026-10-01). */
const web = surface === "web";
const fontGlyph = (name: AnthropiconName) => (
  <span className="reply-glyph reply-font-glyph">
    <Anthropicon name={name} />
  </span>
);

/* Hand-drawn 16px reply toolbar glyphs. Copy and Retry were traced from the 1x
   normalized-command-hover-007 toolbar (stroke about 1px); the two thumbs from
   R-0437-0452-0467 (2.629 px/CSS: ink 9.9 x 11 CSS, up centred 0.57 above and
   down 0.57 below the glyph centre, down = up mirrored). No original asset is used. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="reply-glyph"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Two offset rounded squares; the upper-left square sits in front. */
export function ReplyCopyIcon() {
  return web ? fontGlyph("Copy") : <DrawnCopyIcon />;
}
function DrawnCopyIcon() {
  const mask = useId();
  return (
    <Glyph>
      <mask id={mask}>
        <rect width="16" height="16" fill="#fff" />
        <rect x="3" y="1.5" width="10" height="10" rx="2.4" fill="#000" />
      </mask>
      <rect x="4" y="2.5" width="8" height="8" rx="1.8" />
      <rect
        x="7"
        y="5.5"
        width="8"
        height="8"
        rx="1.8"
        mask={`url(#${mask})`}
      />
    </Glyph>
  );
}

/** Read aloud: a speaker with two sound arcs, on the same grid and stroke. */
export function ReplyReadAloudIcon() {
  if (web) return fontGlyph("Speaker");
  return (
    <Glyph>
      <path d="M2.6 6.4h2l3-2.4v8l-3-2.4h-2z" />
      <path d="M10.1 6.3a2.6 2.6 0 0 1 0 3.4M11.9 4.7a5 5 0 0 1 0 6.6" />
    </Glyph>
  );
}

/* A chosen rating swaps to the original's ThumbsUpFilled / ThumbsDownFilled
   glyph and takes the accent ink (chat-transcript.css; live claude.ai bundle,
   2026-10-12). */
export function ReplyThumbUpIcon({ filled = false }: { filled?: boolean }) {
  if (web) return fontGlyph(filled ? "ThumbsUpFilled" : "ThumbsUp");
  return (
    <Glyph>
      <path
        fill={filled ? "currentColor" : undefined}
        d="M7.15 3.23Q7.19 2.54 8.10 2.54Q9.01 2.54 9.05 3.23L9.01 6.16Q9.01 6.57 9.45 6.57L11.53 6.57Q12.37 6.57 12.37 7.53L12.26 9.73L11.57 11.75Q11.31 12.32 10.54 12.32L4.34 12.32Q3.68 12.32 3.68 11.63L3.68 7.68Q3.68 7.26 4.08 6.95L7.15 3.23z"
      />
    </Glyph>
  );
}

export function ReplyThumbDownIcon({ filled = false }: { filled?: boolean }) {
  if (web) return fontGlyph(filled ? "ThumbsDownFilled" : "ThumbsDown");
  return (
    <Glyph>
      <path
        fill={filled ? "currentColor" : undefined}
        d="M7.15 12.77Q7.19 13.46 8.10 13.46Q9.01 13.46 9.05 12.77L9.01 9.84Q9.01 9.43 9.45 9.43L11.53 9.43Q12.37 9.43 12.37 8.47L12.26 6.27L11.57 4.25Q11.31 3.68 10.54 3.68L4.34 3.68Q3.68 3.68 3.68 4.37L3.68 8.32Q3.68 8.74 4.08 9.05L7.15 12.77z"
      />
    </Glyph>
  );
}

/** Pause (read aloud while it speaks): the font's glyph on the web, else two bars on the toolbar grid. */
export function ReplyPauseIcon() {
  if (web) return fontGlyph("Pause");
  return (
    <Glyph>
      <rect
        x="4.5"
        y="3.5"
        width="2.4"
        height="9"
        rx="0.8"
        fill="currentColor"
      />
      <rect
        x="9.1"
        y="3.5"
        width="2.4"
        height="9"
        rx="0.8"
        fill="currentColor"
      />
    </Glyph>
  );
}

export function ReplyRetryIcon() {
  if (web) return fontGlyph("ArrowClockwise");
  return (
    <Glyph>
      <path d="M13.3 11.7A5.6 5.6 0 1 1 14.2 5.4" />
      <path d="M14.8 2.6v3.8H11" />
    </Glyph>
  );
}

/** Edit (a user message's pencil): the original's glyph on the web. */
export function ReplyEditIcon({ size = 14 }: { size?: number }) {
  return web ? fontGlyph("Edit") : <PencilGlyph size={size} />;
}
