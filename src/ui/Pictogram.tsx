import {
  Blocks,
  FilePlus,
  PenLine,
  Plug,
  Puzzle,
  Search,
  Send,
  Shapes,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import "./pictogram.css";

/**
 * The empty states' and callouts' pictograms: a Lucide glyph on a soft
 * disc in the pictogram colour, its lines in the text colour, 96px at "md".
 */
const pictograms = {
  HandBlocks: Blocks,
  HandWriting: PenLine,
  ObjectShapes: Shapes,
  ObjectAlert: TriangleAlert,
  ObjectPaperAirplane: Send,
  ObjectPuzzle: Puzzle,
  ObjectPlugOutlet: Plug,
  ObjectDocumentAdd: FilePlus,
  ObjectMagnifier: Search,
} satisfies Record<string, LucideIcon>;

export type PictogramName = keyof typeof pictograms;

export function Pictogram({
  name,
  size = 96,
  className,
}: {
  name: PictogramName;
  size?: number;
  className?: string;
}) {
  const Icon = pictograms[name];
  return (
    <svg
      className={className ? `pictogram ${className}` : "pictogram"}
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      aria-hidden="true"
    >
      <circle className="pictogram-highlight" cx={48} cy={48} r={40} />
      <Icon x={26} y={26} size={44} strokeWidth={1.5} color="currentColor" />
    </svg>
  );
}
