import { Globe, SquareArrowOutUpRight } from "lucide-react";

/** Fetch icons (Lucide), 16px. */
const icons = { Globe, ArrowOutSquare: SquareArrowOutUpRight };

export function WebFetchIcon({ name }: { name: keyof typeof icons }) {
  const Icon = icons[name];
  return <Icon size={16} strokeWidth={1.75} aria-hidden="true" />;
}
