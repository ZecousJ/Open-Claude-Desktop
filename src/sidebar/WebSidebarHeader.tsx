import { X } from "../ui/glyphs";
import type { Conversation, Mode } from "../../shared/types";
import { IconButton } from "../ui/Controls";
import { SidebarToggleIcon } from "../ui/icons";
import { phoneQuery, useMediaQuery } from "../ui/useMediaQuery";
import { codeProductName, productName } from "../web/document-title";
import { SurfaceSwitch } from "./SurfaceSwitch";

/**
 * The web app's sidebar head (W-UI-design §3.1, ref-web-chat-home): the sidebar
 * toggle, the product name in the greeting's serif and the Chat | Code switch
 * at the right. There are no traffic lights and no back or forward buttons: the
 * browser has its own, and the address follows the window
 * (src/web/useWebRoute.ts), so switching surfaces is a navigation to `/new` or
 * `/code` with a browser history entry.
 *
 * The switch always shows, as on claude.ai, and Code always opens the Code page
 * (ref-web-code-home); until the service runs Code in the cloud, that page's
 * composer says it cannot send yet.
 *
 * On a phone the sidebar is a full-screen sheet and the toggle is its Close
 * button: an X with no tooltip.
 */
export function WebSidebarHeader({
  mode,
  conversations,
  approvalIds,
  onToggleSidebar,
  onSwitch,
}: {
  mode: Mode;
  conversations: Conversation[];
  approvalIds?: ReadonlySet<string>;
  onToggleSidebar: () => void;
  onSwitch: (mode: Mode) => void;
}) {
  const phone = useMediaQuery(phoneQuery);
  return (
    <div className="sidebar-chrome web-sidebar-head">
      {phone ? (
        <IconButton
          label="Close sidebar"
          tooltip={false}
          onClick={onToggleSidebar}
        >
          <X size={20} strokeWidth={1.5} />
        </IconButton>
      ) : (
        <IconButton
          label="Hide sidebar"
          shortcut={["mod", "B"]}
          onClick={onToggleSidebar}
        >
          <SidebarToggleIcon />
        </IconButton>
      )}
      <a
        className="web-sidebar-title"
        href={mode === "code" ? "/code" : "/new"}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          onSwitch(mode === "code" ? "code" : "chat");
        }}
      >
        {mode === "code" ? codeProductName : productName}
      </a>
      <SurfaceSwitch
        mode={mode}
        conversations={conversations}
        approvalIds={approvalIds}
        onSwitch={onSwitch}
      />
    </div>
  );
}
