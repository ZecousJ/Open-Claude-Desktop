import type { RefObject } from "react";
import { Menu, type MenuPosition } from "../ui/Menu";
import type { CodeListView } from "./code-list-view";
import { codeListMenuEntries } from "./code-list-menu-entries";

export function CodeListPopup({
  value,
  onChange,
  onNewSection,
  onViewAll,
  classify,
  position,
  anchor,
  frame,
  onClose,
}: {
  value: CodeListView;
  onChange: (value: CodeListView) => void;
  onNewSection: () => void;
  onViewAll: () => void;
  classify: boolean;
  position: MenuPosition;
  anchor: RefObject<HTMLButtonElement | null>;
  frame: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  return (
    <Menu
      label="Group and sort"
      className="code-list-menu"
      submenuClassName="code-list-menu"
      size="regular"
      width={200}
      position={position}
      anchors={[anchor]}
      frameRef={frame}
      entries={codeListMenuEntries(
        value,
        onChange,
        onNewSection,
        onViewAll,
        classify,
      )}
      onClose={onClose}
    />
  );
}
