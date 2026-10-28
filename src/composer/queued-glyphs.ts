import type { LucideIcon } from "lucide-react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  EllipsisVertical,
  GripHorizontal,
  X,
} from "lucide-react";

/** The queued-message bar's glyphs (Lucide), drawn at 16px. */
export const queuedGlyphs = {
  ArrowReturn: CornerDownLeft,
  X: X,
  DotsVertical: EllipsisVertical,
  Reorder: GripHorizontal,
  CaretDown: ChevronDown,
  CaretUp: ChevronUp,
  Check: Check,
} satisfies Record<string, LucideIcon>;

export type QueuedGlyphName = keyof typeof queuedGlyphs;
