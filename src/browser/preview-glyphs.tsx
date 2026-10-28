import {
  Check,
  Copy,
  DatabaseZap,
  Globe,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

/**
 * The preview pane's glyphs (Lucide): Globe and Warning at 28px for the
 * start page and the failed card, Globe and Cache at 24px, Cache at 16px for
 * the stopped row, Copy and Check at 16px.
 */
const glyphs = {
  GlobeXl: { size: 28, icon: Globe },
  WarningXl: { size: 28, icon: TriangleAlert },
  Cache: { size: 16, icon: DatabaseZap },
  Warning: { size: 16, icon: TriangleAlert },
  Copy: { size: 16, icon: Copy },
  Check: { size: 16, icon: Check },
  GlobeLg: { size: 24, icon: Globe },
  CacheLg: { size: 24, icon: DatabaseZap },
} satisfies Record<string, { size: number; icon: LucideIcon }>;

export type PreviewGlyphName = keyof typeof glyphs;

export function PreviewGlyph({
  name,
  box,
  className,
}: {
  name: PreviewGlyphName;
  /** Draws the glyph at this size instead of its own. */
  box?: number;
  className?: string;
}) {
  const { size, icon: Icon } = glyphs[name];
  return (
    <Icon
      className={className ? `app-icon ${className}` : "app-icon"}
      size={box ?? size}
      strokeWidth={1.75}
      aria-hidden="true"
    />
  );
}
