import { ArrowRight, ChartColumn, Settings } from "lucide-react";

/** The usage popover's glyphs (Lucide): ArrowRight at 12px, Chart and Settings at 16px. */
const glyphs = {
  ArrowRight: [ArrowRight, 12],
  Chart: [ChartColumn, 16],
  Settings: [Settings, 16],
} as const;

export function UsageGlyph({ name }: { name: keyof typeof glyphs }) {
  const [Icon, size] = glyphs[name];
  return (
    <Icon
      className="app-icon"
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
    />
  );
}
