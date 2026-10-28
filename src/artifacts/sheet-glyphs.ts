import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Code,
  Database,
  FileText,
  Globe,
  Image,
  Presentation,
  ScrollText,
  Shapes,
  Sheet,
  StickyNote,
} from "lucide-react";

/** The file kinds' glyphs (Lucide), drawn at 20px by the sheet card. */
export const sheetGlyphs = {
  File: FileText,
  Note: StickyNote,
  Spreadsheet: Sheet,
  Database: Database,
  Code: Code,
  Slides: Presentation,
  Globe: Globe,
  Image: Image,
  Archive: Archive,
  Scroll: ScrollText,
  Artifacts: Shapes,
} satisfies Record<string, LucideIcon>;

export type SheetGlyph = keyof typeof sheetGlyphs;
