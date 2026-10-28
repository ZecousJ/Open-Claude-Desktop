import {
  CircleAlert,
  CircleHelp,
  Clock,
  GitBranch,
  Hand,
  MessageSquare,
} from "lucide-react";

/** The Next steps rows' glyphs (Lucide), 16px. */
export const nextStepGlyphs = {
  GitBranch,
  Help: CircleHelp,
  Hand16: Hand,
  Clock16: Clock,
  WarningCircle: CircleAlert,
  Comment: MessageSquare,
};

export type NextStepGlyph = keyof typeof nextStepGlyphs;

export function NextStepIcon({ name }: { name: NextStepGlyph }) {
  const Icon = nextStepGlyphs[name];
  return (
    <Icon
      className="app-icon"
      size={16}
      strokeWidth={1.75}
      aria-hidden="true"
    />
  );
}
