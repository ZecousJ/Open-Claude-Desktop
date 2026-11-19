import type { ComponentType, ReactNode, SVGProps } from "react";
import * as glyphs from "./glyphs";
import { Anthropicon } from "./anthropicons";

/*
 * Interface icons. The ones the original's icon font has a glyph for are that
 * glyph (live claude.ai bundle, 2026-10-16, shared-frame-6654oR3-.js: the
 * Anthropicons table), under the names callers already use; the rest are
 * traced from 2x captures of the original app. Each traced icon sits on a
 * 16px grid with 1px strokes on half-pixel coordinates, so it renders as
 * crisply as the original (lucide's 24px grid scaled to 15px gives blurry
 * 1.25px strokes). Shapes were fitted with scripts/fidelity/iconfit.py; the
 * error noted on each is the normalized pixel difference from the capture.
 */
export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({
  size = 16,
  strokeWidth = 1,
  children,
  ...rest
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

type GlyphComponent = ComponentType<{ size?: number | string }>;

/** An icon-font glyph that takes a traced icon's props and 16px default. */
function official(Glyph: GlyphComponent, defaultSize: number) {
  return function OfficialIcon({
    size = defaultSize,
    strokeWidth: _strokeWidth,
    ...rest
  }: IconProps) {
    return <Glyph size={size} {...(rest as object)} />;
  };
}

function officialFont(
  name: Parameters<typeof Anthropicon>[0]["name"],
  defaultSize: number,
) {
  return function OfficialFontIcon({
    size = defaultSize,
    strokeWidth: _strokeWidth,
    ...rest
  }: IconProps) {
    return <Anthropicon {...rest} name={name} size={size} />;
  };
}

/** Sidebar toggle: panel with a left column (error 0.038). */
export function SidebarToggleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path d="M6.5 2.5v11" />
    </Icon>
  );
}

/** Back arrow (0.106). */
export function BackIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.5 4 3.5 8l4 4M3.5 8h9" />
    </Icon>
  );
}

/** Forward arrow (0.141). */
export function ForwardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.5 4l4 4-4 4M12.5 8h-9" />
    </Icon>
  );
}

/** Customize: briefcase (0.083). */
export function BriefcaseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="5.5" width="11" height="7" rx="1.5" />
      <path d="M5.5 5.5v-1a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1M2.5 8.5h11" />
    </Icon>
  );
}

/** Service status: a pulse line, drawn like the sidebar's other line icons. */
export function PulseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M1.75 8.5h2.5l1.75-4 3 7.5 1.75-3.5h3.5" />
    </Icon>
  );
}

/** Window with an inset corner, shown on the hovered New row; thin 0.75px strokes (0.106). */
export function NewWindowIcon({ strokeWidth = 0.75, ...props }: IconProps) {
  return (
    <Icon strokeWidth={strokeWidth} {...props}>
      <rect x="4.625" y="4.625" width="6.75" height="6.75" rx="0.75" />
      <path d="M8.375 10.875 8.5 8.375h2.875" />
    </Icon>
  );
}

/** Weekly usage gauge: an open-bottom ring around a drop (R-0338; 0.111). */
export function UsageGaugeIcon({ strokeWidth = 0.95, ...props }: IconProps) {
  return (
    <Icon strokeWidth={strokeWidth} {...props}>
      <path d="M3.32 13.44A6.46 6.46 0 1 1 12.68 13.44" />
      <path
        fill="currentColor"
        d="M9.37 9.25 8 6.43 6.63 9.25A1.52 1.52 0 1 0 9.37 9.25Z"
      />
    </Icon>
  );
}

/** Exit incognito: a 10px cross (R-0003 Exit incognito capture). */
export function ExitIncognitoIcon({ strokeWidth = 1.25, ...props }: IconProps) {
  return (
    <Icon strokeWidth={strokeWidth} {...props}>
      <path d="M3 3 13 13M13 3 3 13" />
    </Icon>
  );
}

/**
 * New while a conversation is open (R-0012, visible in R-0083): an 18px
 * #2c2c2a disc behind a 9px plus, centred where the plain plus sits.
 */
export function CircledPlusIcon() {
  return (
    <svg
      className="circled-plus"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="9" cy="9" r="9" />
      <path
        d="M9 4.5v9M4.5 9h9"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A checklist (one ticked row, two open boxes): a task in the Active list. */
export function TasksIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 4.25l1 1 2-2M7.5 4.5h6M7.5 8.5h6M7.5 12.5h6" />
      <rect x="2.5" y="7.25" width="2.5" height="2.5" rx=".5" />
      <rect x="2.5" y="11.25" width="2.5" height="2.5" rx=".5" />
    </Icon>
  );
}

/** Three lines: opens the sidebar drawer on a narrow screen (web). */
export function MenuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </Icon>
  );
}

/** Three lines, the last shorter: the Windows window's app menu (≡). */
export function AppMenuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7.5" />
    </Icon>
  );
}

// Glyphs of the icon font under the hand-drawn icons' names.
export const ChevronDownIcon = official(glyphs.ChevronDown, 16);
export const SearchIcon = official(glyphs.Search, 16);
export const FilterIcon = official(glyphs.Filter, 16);
export const GearIcon = official(glyphs.Settings, 16);
export const FolderIcon = official(glyphs.Folder, 16);
export const FolderPlusIcon = official(glyphs.FolderPlus, 16);
export const InfoIcon = official(glyphs.Info, 16);
export const ScrollIcon = official(glyphs.ScrollText, 16);
export const ClockIcon = official(glyphs.Clock, 16);
export const ChatsIcon = official(glyphs.MessagesSquare, 16);
export const CodeIcon = official(glyphs.Code, 16);
export const GlobeIcon = official(glyphs.Globe, 16);
export const LaptopIcon = official(glyphs.Laptop, 16);
export const CloudIcon = official(glyphs.Cloud, 16);
export const PlusIcon = official(glyphs.Plus, 16);
export const CloseIcon = official(glyphs.X, 16);
export const CloseSmallIcon = official(glyphs.X, 16);
export const DownloadTrayIcon = official(glyphs.Download, 16);
export const PageSearchIcon = official(glyphs.Search, 20);
export const PageFilterIcon = official(glyphs.Filter, 20);
export const ProjectsIcon = officialFont("Projects", 16);
export const ArtifactsIcon = officialFont("Artifacts", 16);
export const LogOutIcon = officialFont("Logout", 16);
export const KeyIcon = officialFont("Key", 16);
export const UsageIcon = officialFont("UsageGaugeMiddle", 16);
