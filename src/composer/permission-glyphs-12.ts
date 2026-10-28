import { Code, Hand, ScrollText, TriangleAlert, Zap } from "lucide-react";

/**
 * The permission picker's mode glyphs (Lucide): Manual Hand, Accept edits
 * Code, Plan Scroll, Auto Lightning, Bypass permissions Warning. The
 * trigger draws them at 12px.
 */
export const permissionGlyphs12 = {
  Hand,
  Code,
  Scroll: ScrollText,
  Lightning: Zap,
  Warning: TriangleAlert,
};
