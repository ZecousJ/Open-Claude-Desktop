import {
  FileText,
  LayoutDashboard,
  Palette,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import "./template-artwork.css";

export type TemplateArtworkKind = "docs" | "slides" | "design" | "dashboard";

const glyphs: Record<TemplateArtworkKind, LucideIcon> = {
  docs: FileText,
  slides: Presentation,
  design: Palette,
  dashboard: LayoutDashboard,
};

/** A template's 136×96 tile: its glyph on a wash of the kind's hue. */
export function TemplateArtwork({ kind }: { kind: TemplateArtworkKind }) {
  const Glyph = glyphs[kind];
  return (
    <span
      className="artifacts-make-art"
      data-artwork-kind={kind}
      aria-hidden="true"
    >
      <span className="artifacts-template-clip">
        <span className="artifacts-template-gradient" />
        <Glyph
          className="artifacts-template-glyph"
          size={36}
          strokeWidth={1.5}
        />
      </span>
    </span>
  );
}
