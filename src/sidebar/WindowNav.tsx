import { useContext } from "react";
import { surface } from "../../shared/host";
import { ShortcutPlatform } from "../ui/Tooltip";
import { IconButton } from "../ui/Controls";
import { Anthropicon } from "../ui/anthropicons";
import {
  AppMenuIcon,
  BackIcon,
  ForwardIcon,
  SidebarToggleIcon,
} from "../ui/icons";

/**
 * Sidebar toggle with back and forward; shown in the sidebar and, when it is
 * hidden, over the workspace. Back and forward step through the window's
 * history and are disabled when it has nothing that way. The tooltips' text
 * and shortcuts follow the View menu and common ⌘[ / ⌘] (R-0146 to R-0150
 * were not captured). The web app leaves back and forward to the browser,
 * whose history follows the address (src/web/useWebRoute.ts), so there it
 * is the sidebar toggle alone. Windows and Linux windows have no menu bar,
 * so the controls start with ≡, which opens the app menu (File, Edit, View,
 * Go, Help) under it, as the Windows app does.
 */
export function WindowNav({
  toggleLabel,
  onToggleSidebar,
  onBack,
  onForward,
  dot = false,
  appMenu = false,
}: {
  toggleLabel: string;
  onToggleSidebar: () => void;
  onBack?: () => void;
  onForward?: () => void;
  /** Something in the hidden sidebar needs attention (R-0161). */
  dot?: boolean;
  /** Show ≡ first (windows without a menu bar). */
  appMenu?: boolean;
}) {
  // Alt+← and Alt+→ on Windows and Linux (desktop 2.37337.1).
  const mac = useContext(ShortcutPlatform) === "darwin";
  return (
    <>
      {appMenu && (
        <IconButton
          label="Menu"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            void window.desktop.showAppMenu(box.left, box.bottom + 4);
          }}
        >
          <AppMenuIcon />
        </IconButton>
      )}
      <IconButton
        label={toggleLabel}
        shortcut={["mod", "B"]}
        className={`window-nav-toggle${dot ? " has-dot" : ""}`}
        onClick={onToggleSidebar}
      >
        {surface === "web" ? (
          // The web's toggle is the Sidebar glyph (live claude.ai, 2026-10-21).
          <Anthropicon name="Sidebar" size={16} />
        ) : (
          <SidebarToggleIcon />
        )}
      </IconButton>
      {surface !== "web" && (
        <>
          <IconButton
            label="Back"
            shortcut={mac ? ["mod", "["] : ["alt", "←"]}
            disabled={!onBack}
            onClick={onBack}
          >
            <BackIcon />
          </IconButton>
          <IconButton
            label="Forward"
            shortcut={mac ? ["mod", "]"] : ["alt", "→"]}
            disabled={!onForward}
            onClick={onForward}
          >
            <ForwardIcon />
          </IconButton>
        </>
      )}
    </>
  );
}
