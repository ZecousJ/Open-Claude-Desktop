import {
  Briefcase,
  Calculator,
  Rocket,
  Server,
  ShoppingCart,
  type LucideIcon,
} from "lucide-react";
import {
  BookOpen,
  ChartColumn,
  ChartLine,
  CodeXml,
  Database,
  FileText,
  Globe,
  History,
  Landmark,
  LayoutGrid,
  Megaphone,
  Palette,
  Users,
  Zap,
} from "../../ui/glyphs";
import { ScrollIcon } from "../../ui/icons";
import type { DirectoryIcon } from "../../../shared/directory-icon";

const glyphs: Record<DirectoryIcon, LucideIcon> = {
  code: CodeXml,
  chart: ChartColumn,
  calculator: Calculator,
  book: BookOpen,
  file: FileText,
  layout: LayoutGrid,
  server: Server,
  cart: ShoppingCart,
  rocket: Rocket,
  briefcase: Briefcase,
  palette: Palette,
  megaphone: Megaphone,
  landmark: Landmark,
  database: Database,
  history: History,
  users: Users,
  zap: Zap,
  globe: Globe,
  scroll: ScrollIcon as unknown as LucideIcon,
  linechart: ChartLine,
};

/** The lucide glyph of a catalogue icon (Customize draws its own tiles). */
export function directoryGlyph(icon: DirectoryIcon): LucideIcon {
  return glyphs[icon];
}

/** A catalogue entry's icon in the 36px tile the directory cards use. */
export function DirectoryTile({ icon }: { icon: DirectoryIcon }) {
  const Glyph = glyphs[icon];
  return (
    <span className="settings-list-tile directory-tile" aria-hidden="true">
      <Glyph size={17} strokeWidth={1.5} />
    </span>
  );
}

/**
 * The stepped puzzle piece: an outlined notched head over a filled three-step
 * base, 69×77. `line` is the stroke width on screen (2px on the Extensions
 * page, 1.3px at 0.69 beside Add your first plugins, as measured), kept when
 * `scale` shrinks it.
 */
function PuzzleArt({
  className,
  scale = 1,
  line = 1.5,
}: {
  className: string;
  scale?: number;
  /** Line width on screen in px. */
  line?: number;
}) {
  return (
    <svg
      className={className}
      width={71 * scale}
      height={79 * scale}
      viewBox="-1 -1 71 79"
      fill="none"
      stroke="currentColor"
      strokeWidth={line / scale}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M0 .8H68.8V37.5H55V25H43.5V12.5H25V25H13.8V37.5H0Z" />
      <path
        className="directory-illustration-fill"
        d="M25 37.5H43.8V48.8H55V61.3H68.3V76.8H.8V62.5H13.8V48.8H25Z"
      />
    </svg>
  );
}

/** The piece over "No extensions installed". */
export function ExtensionsIllustration() {
  return (
    <PuzzleArt
      className="directory-illustration directory-extensions-art"
      line={2.1}
    />
  );
}

/** The same piece at 0.69 beside "Add your first plugins". */
export function PluginsIllustration() {
  return (
    <PuzzleArt
      className="directory-illustration directory-plugins-art"
      scale={0.69}
      line={1.4}
    />
  );
}

/**
 * The table with a trend badge on the Discover banner: the original's
 * hand-drawn table has a narrow first column, a wide second and a medium third,
 * and its badge (35px at 1x) sits inside the table's lower right corner,
 * measured from R-1116 (W840, 1x). One viewBox unit is 1.72px of a 1x page at
 * the Customize size (165px wide).
 */
export function BannerIllustration() {
  return (
    <svg
      className="directory-banner-art"
      width="96"
      height="52"
      viewBox="0 4 96 52"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 8h61.5L69 52H6z" />
      <path d="M6 19.6h62M6 30.9h62.6M6 41.3h63M18.6 8v44M45.7 8v44" />
      <circle
        className="directory-illustration-fill"
        cx="55"
        cy="41.5"
        r="10.2"
      />
      <path d="M49 43.6l3-3.6 3 3 4.2-5.2M56.4 37.6h3v3" />
    </svg>
  );
}
