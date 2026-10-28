import { ChevronRight, Square, Trash2 } from "lucide-react";

/** The Background tasks panel's glyphs (Lucide): Trash at 16px, Stop and CaretRight at 12px. */
const glyphs = {
  Trash: [Trash2, 16],
  Stop: [Square, 12],
  CaretRight: [ChevronRight, 12],
} as const;

export function BackgroundGlyph({
  name,
  className,
}: {
  name: keyof typeof glyphs;
  className?: string;
}) {
  const [Icon, size] = glyphs[name];
  return (
    <Icon
      className={className ? `app-icon ${className}` : "app-icon"}
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
    />
  );
}
