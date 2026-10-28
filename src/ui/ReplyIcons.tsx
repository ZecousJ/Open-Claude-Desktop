import { AppIcon, type AppIconName } from "./app-icon";

/* The reply toolbar's glyphs (Lucide, through AppIcon), 16px. */
const glyph = (name: AppIconName, size?: number) => (
  <span className="reply-glyph reply-font-glyph">
    <AppIcon name={name} size={size} />
  </span>
);

export function ReplyCopyIcon() {
  return glyph("Copy");
}

export function ReplyReadAloudIcon() {
  return glyph("Speaker");
}

export function ReplyThumbUpIcon({ filled = false }: { filled?: boolean }) {
  return glyph(filled ? "ThumbsUpFilled" : "ThumbsUp");
}

export function ReplyThumbDownIcon({ filled = false }: { filled?: boolean }) {
  return glyph(filled ? "ThumbsDownFilled" : "ThumbsDown");
}

export function ReplyPauseIcon() {
  return glyph("Pause");
}

export function ReplyRetryIcon() {
  return glyph("ArrowClockwise");
}

export function ReplyEditIcon({ size = 14 }: { size?: number }) {
  return glyph("Edit", size);
}
