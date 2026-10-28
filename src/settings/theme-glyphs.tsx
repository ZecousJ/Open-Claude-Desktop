import { Monitor, Moon, Sun } from "lucide-react";

/** The Theme switch's glyphs (Lucide), drawn at 20px. */
const themeGlyphs = { Computer: Monitor, Sun, Moon } as const;

export function ThemeGlyph({ name }: { name: keyof typeof themeGlyphs }) {
  const Icon = themeGlyphs[name];
  return <Icon size={20} strokeWidth={1.75} aria-hidden="true" />;
}
