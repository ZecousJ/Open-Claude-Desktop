import { useRef, useState } from "react";
import { MoreVertical } from "../ui/glyphs";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import type { FilePreferences } from "./file-preferences";
import { t } from "../i18n";
import {
  setTreePosition,
  treePositionText,
  treePositions,
  useTreePosition,
} from "./tree-position";

/** O16/cccc2cf0a:10629–10730; current native menu captured in round eight. */
export function FilesSettings({
  preferences,
  onChange,
  treeOpen,
  onTreeChange,
  writable,
}: {
  preferences: FilePreferences;
  onChange: (patch: Partial<FilePreferences>) => void;
  treeOpen: boolean;
  onTreeChange: (open: boolean) => void;
  writable: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const treePosition = useTreePosition();
  const [position, setPosition] = useState<MenuPosition>();
  const check = (
    key: Exclude<keyof FilePreferences, "tabSize">,
    label: string,
  ): MenuEntry => ({
    label,
    checked: preferences[key],
    checkedRole: "checkbox",
    keepOpen: true,
    onSelect: () => onChange({ [key]: !preferences[key] }),
  });
  const entries: MenuEntry[] = [
    {
      label: "Show file tree",
      checked: treeOpen,
      checkedRole: "checkbox",
      keepOpen: true,
      onSelect: () => onTreeChange(!treeOpen),
    },
    // Where the tree sits, shared with the Changes pane's file list.
    {
      label: "File tree position",
      value: treePositionText(treePosition),
      submenu: treePositions.map((choice) => ({
        label: treePositionText(choice),
        noTranslate: true,
        checked: choice === treePosition,
        checkedRole: "radio" as const,
        keepOpen: true,
        onSelect: () => setTreePosition(choice),
      })),
    },
    { separator: true },
    check("previewTabs", "Preview tabs"),
    ...(writable
      ? [check("autoSave", "Auto save"), check("tabIndents", "Tab key indents")]
      : []),
    { separator: true },
    check("wordWrap", "Word wrap"),
    check("indentGuides", "Indent guides"),
    check("showWhitespace", "Show whitespace"),
    check("scrollPastEnd", "Scroll past end"),
    {
      label: "Tab size",
      value: String(preferences.tabSize),
      submenu: ([2, 4, 8] as const).map((size) => ({
        label: String(size),
        checked: size === preferences.tabSize,
        checkedRole: "radio",
        keepOpen: true,
        onSelect: () => onChange({ tabSize: size }),
      })),
    },
  ];
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="changes-icon-button"
        aria-label={t("Files settings")}
        title={t("Files settings")}
        aria-haspopup="menu"
        aria-expanded={!!position}
        onClick={() => {
          if (position) return setPosition(undefined);
          const r = anchor.current!.getBoundingClientRect();
          setPosition({ right: innerWidth - r.right, top: r.bottom + 4 });
        }}
      >
        <MoreVertical size={16} />
      </button>
      {position && (
        <Menu
          label="Files settings"
          entries={entries}
          position={position}
          anchors={[anchor]}
          width={224}
          size="regular"
          onClose={() => setPosition(undefined)}
        />
      )}
    </>
  );
}
