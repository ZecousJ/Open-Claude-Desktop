import type { ReactNode } from "react";
import type { Mode } from "../../shared/types";
import { Modal } from "../ui/Controls";
import { AppIcon } from "../ui/app-icon";
import {
  isFixedNavItem,
  sidebarNav,
  toggleNavItem,
  type NavItemId,
} from "./navItems";
import { useHost } from "../host/HostContext";
import { coworkAvailable } from "../home/home-mode";
import "./edit-sidebar.css";

/** The rows' glyphs, the same as the sidebar draws them (MainNav.tsx). */
const glyphs: Record<NavItemId, ReactNode> = {
  projects: <AppIcon name="Projects" />,
  artifacts: <AppIcon name="Artifacts" />,
  scheduled: <AppIcon name="Clock" />,
  customize: <AppIcon name="Tool" />,
  api: <AppIcon name="Key" />,
  status: <AppIcon name="Activity" />,
  dispatch: <AppIcon name="Dispatch" />,
};

/**
 * Edit sidebar… from More: choose which collection rows stay in the sidebar;
 * hidden ones are reached from More. Saved with the settings, so the choice
 * follows the account. The dialog is the original's: the line "Choose which
 * items appear in your sidebar.", a checkbox row per item with its glyph, and a
 * primary Done at the right.
 */
export function EditSidebarDialog({
  mode,
  hidden,
  onChange,
  onClose,
}: {
  mode: Mode;
  hidden: string[];
  onChange: (hidden: string[]) => void;
  onClose: () => void;
}) {
  const hub = coworkAvailable(useHost());
  const { offered } = sidebarNav(mode, hidden, hub);
  return (
    <Modal title="Edit sidebar" onClose={onClose} className="edit-sidebar">
      <p className="edit-sidebar-note">
        Choose which items appear in your sidebar.
      </p>
      <div className="edit-sidebar-list">
        {offered.map((item) => {
          const fixed = isFixedNavItem(mode, item.id, hub);
          const shown = fixed || !hidden.includes(item.id);
          return (
            <label className="edit-sidebar-row" key={item.id}>
              <input
                type="checkbox"
                className="cx-check-input"
                checked={shown}
                disabled={fixed}
                onChange={(event) =>
                  onChange(
                    toggleNavItem(hidden, item.id, event.target.checked, fixed),
                  )
                }
              />
              <span className="edit-sidebar-glyph">{glyphs[item.id]}</span>
              {item.label}
            </label>
          );
        })}
      </div>
      <div className="button-row">
        <button className="primary" autoFocus onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
