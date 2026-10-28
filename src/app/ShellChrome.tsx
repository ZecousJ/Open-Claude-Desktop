import { surface } from "../../shared/host";
import { IncognitoIcon } from "../ui/IncognitoIcon";
import { ReleaseNotesDialog } from "../dialogs/ReleaseNotesDialog";
import { defaultHiddenNavItemsFor } from "../sidebar/navItems";
import { useAnnouncements } from "../policy/Announcements";
import { WithTooltip } from "../ui/Tooltip";
import { useApp } from "./AppContext";
import { Suspense } from "react";
import { lazyPiece } from "../ui/lazy-piece";

/** Opened from More: loaded, with its styles, when first shown. */
const EditSidebarDialog = lazyPiece(
  () => import("../sidebar/EditSidebarDialog"),
  "EditSidebarDialog",
);

/** Opened from the Help menu or ⌘/: loaded when first shown. */
const KeyboardShortcutsDialog = lazyPiece(
  () => import("../dialogs/KeyboardShortcutsDialog"),
  "KeyboardShortcutsDialog",
);

/**
 * The web Code draft has its title and no version-update nudge. The native Code
 * host retains its release-note entry; Chat keeps the incognito action.
 */
export function HomeCornerActions() {
  const app = useApp();
  const announcements = useAnnouncements();
  const { mode, incognitoShown } = app;
  const actions = (
    <>
      {surface !== "web" &&
        mode === "code" &&
        (!app.notesSeen || announcements.unread.length > 0) && (
          <button className="whats-new" onClick={app.openReleaseNotes}>
            What's new
          </button>
        )}
      {mode !== "code" && !incognitoShown && app.policy.incognito && (
        <WithTooltip
          label="Use incognito"
          shortcut={["shift", "mod", "I"]}
          placement="below-before"
        >
          {(props) => (
            <button
              {...props}
              className="incognito-button"
              aria-label="Use incognito"
              onClick={() => app.newChat("chat", undefined, true)}
            >
              <IncognitoIcon />
            </button>
          )}
        </WithTooltip>
      )}
    </>
  );
  return surface === "web" || mode === "code" ? (
    <div
      className={`web-home-corner${mode === "code" ? " code-draft-corner" : ""}${surface !== "web" ? " native-code-draft-corner" : ""}`}
    >
      {mode === "code" && <h1 className="code-draft-title">New session</h1>}
      {actions}
    </div>
  ) : (
    actions
  );
}

export function ReleaseNotesOverlay() {
  const { releaseNotes, setReleaseNotes } = useApp();
  return releaseNotes ? (
    <ReleaseNotesDialog onClose={() => setReleaseNotes(false)} />
  ) : null;
}

export function ShortcutsOverlay() {
  const { shortcutsOpen, setShortcutsOpen, snapshot, mode, active } = useApp();
  return shortcutsOpen ? (
    <Suspense fallback={null}>
      <KeyboardShortcutsDialog
        platform={snapshot.platform}
        surface={surface}
        context={(active?.mode ?? mode) === "code" ? "code" : "chat"}
        onClose={() => setShortcutsOpen(false)}
      />
    </Suspense>
  ) : null;
}

export function EditSidebarOverlay() {
  const app = useApp();
  return app.editSidebar ? (
    <Suspense fallback={null}>
      <EditSidebarDialog
        mode={app.mode}
        hidden={
          app.snapshot.settings.hiddenNavItems ??
          defaultHiddenNavItemsFor(app.mode)
        }
        onChange={(hiddenNavItems) =>
          void app.updatePreference({ hiddenNavItems })
        }
        onClose={() => app.setEditSidebar(false)}
      />
    </Suspense>
  ) : null;
}
