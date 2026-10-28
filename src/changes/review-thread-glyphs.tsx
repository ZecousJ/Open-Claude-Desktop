import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  ChevronUp,
  Diff,
  MessageCircle,
  Check,
  SquareArrowOutUpRight,
  X,
  type LucideIcon,
} from "lucide-react";

/** The review threads' glyphs (Lucide) and the size each is drawn at. */
export const reviewThreadGlyphs = {
  Chat: { size: 16, icon: MessageCircle },
  Check: { size: 16, icon: Check },
  ArrowUp: { size: 16, icon: ArrowUp },
  ArrowDown: { size: 16, icon: ArrowDown },
  ArrowOutSquare: { size: 16, icon: SquareArrowOutUpRight },
  CaretUp: { size: 16, icon: ChevronUp },
  CaretRight: { size: 12, icon: ChevronRight },
  GitDiff: { size: 12, icon: Diff },
  X: { size: 16, icon: X },
} satisfies Record<string, { size: number; icon: LucideIcon }>;

export type ReviewThreadGlyph = keyof typeof reviewThreadGlyphs;

export function ThreadIcon({ name }: { name: ReviewThreadGlyph }) {
  const { size, icon: Icon } = reviewThreadGlyphs[name];
  return (
    <Icon
      className="app-icon"
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
    />
  );
}
