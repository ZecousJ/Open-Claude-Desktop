import type { ComponentType, SVGProps } from "react";
import {
  Activity,
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Gauge,
  Ghost,
  ListTodo,
  Menu,
  PanelLeft,
  type LucideIcon,
} from "lucide-react";
import * as glyphs from "./glyphs";
import { AppIcon } from "./app-icon";

/*
 * Interface icons, all Lucide (ISC): the glyphs.tsx ones and AppIcon names
 * under the names callers use, 16px unless a caller sets a size.
 */
export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/** A Lucide icon with an icon's props, `defaultSize` and a light stroke. */
function lucide(Glyph: LucideIcon, defaultSize = 16, defaultStroke = 1.5) {
  return function LucideIcon({
    size = defaultSize,
    strokeWidth = defaultStroke,
    ref: _ref,
    ...rest
  }: IconProps) {
    return (
      <Glyph
        size={size}
        strokeWidth={strokeWidth}
        aria-hidden="true"
        focusable="false"
        {...(rest as object)}
      />
    );
  };
}

type GlyphComponent = ComponentType<{ size?: number | string }>;

/** A glyph that takes an icon's props and `defaultSize`. */
function official(Glyph: GlyphComponent, defaultSize: number) {
  return function GlyphIcon({
    size = defaultSize,
    strokeWidth: _strokeWidth,
    ...rest
  }: IconProps) {
    return <Glyph size={size} {...(rest as object)} />;
  };
}

function officialFont(
  name: Parameters<typeof AppIcon>[0]["name"],
  defaultSize: number,
) {
  return function NamedIcon({
    size = defaultSize,
    strokeWidth: _strokeWidth,
    ...rest
  }: IconProps) {
    return <AppIcon {...rest} name={name} size={size} />;
  };
}

export const SidebarToggleIcon = lucide(PanelLeft);
export const BackIcon = lucide(ArrowLeft);
export const ForwardIcon = lucide(ArrowRight);
export const BriefcaseIcon = lucide(Briefcase);
export const PulseIcon = lucide(Activity);
export const NewWindowIcon = lucide(AppWindow);
export const UsageGaugeIcon = lucide(Gauge);
export const ExitIncognitoIcon = lucide(Ghost);

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

export const TasksIcon = lucide(ListTodo);
export const MenuIcon = lucide(Menu);
export const AppMenuIcon = lucide(Menu);

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
