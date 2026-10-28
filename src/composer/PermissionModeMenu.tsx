import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { permissionGlyphs20 } from "./permission-glyphs-20";
import "./permission-mode-menu.css";

export type ModeRow = {
  id: string;
  title: string;
  description: string;
  glyph: keyof typeof permissionGlyphs20;
  checked: boolean;
  /** Greyed with this reason (Bypass without a folder). */
  disabledReason?: string;
  /** Said in the row's tooltip instead of its description. */
  note?: string;
  onSelect: () => void;
};

function Glyph({ name }: { name: keyof typeof permissionGlyphs20 }) {
  const Icon = permissionGlyphs20[name];
  return <Icon size={20} strokeWidth={1.5} aria-hidden="true" />;
}

/**
 * The permission picker's menu: one row per mode with its 20px glyph and a
 * radio check, its description in a tooltip at the row's end; no caption.
 * Loaded when first opened.
 */
export default function PermissionModeMenu({
  rows,
  position,
  anchor,
  onClose,
  inlineDescriptions = false,
  sessionScoped = false,
}: {
  rows: ModeRow[];
  position: MenuPosition;
  anchor: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  inlineDescriptions?: boolean;
  sessionScoped?: boolean;
}) {
  const entries: MenuEntry[] = rows.map((row) => ({
    label: row.title,
    icon: inlineDescriptions ? undefined : <Glyph name={row.glyph} />,
    checked: row.checked,
    checkedRole: "radio" as const,
    disabled: Boolean(row.disabledReason),
    title: row.disabledReason,
    description: inlineDescriptions ? (row.note ?? row.description) : undefined,
    tooltip: inlineDescriptions ? undefined : (row.note ?? row.description),
    onSelect: row.onSelect,
  }));
  return (
    <Menu
      label="Permission mode"
      className={`permission-mode-menu${inlineDescriptions ? " web-code-permission-menu" : ""}`}
      bodyClassName={
        inlineDescriptions ? "web-code-permission-body" : undefined
      }
      entries={
        inlineDescriptions
          ? [
              {
                heading: sessionScoped
                  ? "Permissions · this session"
                  : "Permission mode",
              },
              ...entries,
            ]
          : entries
      }
      position={position}
      width={inlineDescriptions ? 261 : 200}
      anchors={[anchor]}
      onClose={onClose}
    />
  );
}
