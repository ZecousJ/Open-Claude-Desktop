import { useRef, useState } from "react";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { below } from "./SimulatorScreens";

/** One of the row's menus. */
export interface SimulatorMenu {
  key: "edit" | "device" | "view";
  label: string;
  entries: MenuEntry[];
  /** Runs as the menu opens (Device reads the current appearance). */
  onOpen?: () => void;
}

function MenuTrigger({
  menu,
  disabled,
}: {
  menu: SimulatorMenu;
  disabled: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<MenuPosition>();
  return (
    <>
      <button
        ref={button}
        type="button"
        role="menuitem"
        className="sim-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={position !== undefined}
        disabled={disabled}
        // The screen keeps the focus until the menu takes it.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (position) return setPosition(undefined);
          menu.onOpen?.();
          setPosition(below(button.current));
        }}
      >
        {menu.label}
      </button>
      {position && (
        <Menu
          label={menu.label}
          entries={menu.entries}
          position={position}
          width={224}
          anchors={[button]}
          onClose={() => setPosition(undefined)}
        />
      )}
    </>
  );
}

/**
 * "Simulator menus": Edit, Device and View as small ghost buttons in a row
 * above the device picker, each opening its menu. A kind without a menu's items
 * has no button for it.
 */
export function MenuRow({
  menus,
  disabled,
}: {
  menus: readonly SimulatorMenu[];
  disabled: boolean;
}) {
  if (!menus.length) return null;
  return (
    <div className="sim-menus" role="menubar" aria-label="Simulator menus">
      {menus.map((menu) => (
        <MenuTrigger key={menu.key} menu={menu} disabled={disabled} />
      ))}
    </div>
  );
}
