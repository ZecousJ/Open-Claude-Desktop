import type { LucideIcon } from "lucide-react";
import {
  Bot,
  ChevronRight,
  Clock,
  Cloud,
  Database,
  Ellipsis,
  File,
  Folder,
  GitBranch,
  LayoutList,
  Monitor,
  MousePointer2,
  Shapes,
  Square,
  Terminal,
} from "lucide-react";

/** The Code session rail's glyphs (Lucide) and the size each is drawn at. */
export const railGlyphs = {
  Cache: { icon: Database, size: 16 },
  ListCard: { icon: LayoutList, size: 16 },
  Computer: { icon: Monitor, size: 16 },
  Cloud: { icon: Cloud, size: 16 },
  Folder: { icon: Folder, size: 16 },
  GitBranch: { icon: GitBranch, size: 16 },
  Cursor: { icon: MousePointer2, size: 16 },
  File: { icon: File, size: 16 },
  Artifacts: { icon: Shapes, size: 16 },
  CommandLine: { icon: Terminal, size: 16 },
  AgentsSimple: { icon: Bot, size: 16 },
  Clock: { icon: Clock, size: 16 },
  Stop: { icon: Square, size: 12 },
  DotsHorizontal: { icon: Ellipsis, size: 16 },
  CaretRight: { icon: ChevronRight, size: 12 },
} satisfies Record<string, { icon: LucideIcon; size: number }>;

export type RailGlyph = keyof typeof railGlyphs;
