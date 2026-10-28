import { Suspense, useEffect, useState } from "react";
import { Laptop, Share } from "../ui/glyphs";
import type { Conversation, Mode } from "../../shared/types";
import { useApp } from "../app/AppContext";
import { ConversationTitle } from "../conversation/ConversationTitle";
import { IconButton } from "../ui/Controls";
import { draftHandoff } from "./handoff";
import { useConversationShare } from "./share";
import { useWindowVisibility } from "./useWindowVisibility";
import { useTranscriptViewActions } from "../transcript-view/useTranscriptViewActions";
import { lazyPiece } from "../ui/lazy-piece";
import { WindowPinIcon as PinIcon } from "./WindowPinIcon";

const NewOutputStyleDialog = lazyPiece(
  () => import("../output-style/NewOutputStyleDialog"),
);

const badges: Record<Mode, string | undefined> = {
  chat: undefined,
  cowork: "Cowork",
  code: "Developer",
};

/** The page reports its visibility through the bridge (stable across renders). */
const reportVisibility = (visible: boolean) =>
  window.desktop.reportWindowVisibility(visible);

/** Return to the main window: a window with an arrow to its lower left. */
function ReturnIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <path d="M15 9l-5.5 5.5M9.5 10v4.5H14" />
    </svg>
  );
}

/**
 * A separate conversation window's title bar: the environment icon, the title
 * with its menu and, for Code and Cowork, the badge on the left; Share, Return
 * to the main window and Keep on top on the right. No panel toggles,
 * conversation menu or sidebar controls.
 */
export function ConversationWindowHeader({ active }: { active: Conversation }) {
  const app = useApp();
  const { patchConversation, confirmDelete, report } = app;
  const api = window.desktop;
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .getWindowPinned()
      .then((value) => {
        if (active) setPinned(value);
      })
      .catch(report);
    return () => {
      active = false;
    };
  }, [api]);
  const [sharing, setSharing] = useState(false);
  const [newStyle, setNewStyle] = useState(false);
  const share = useConversationShare(active);
  const transcriptView = useTranscriptViewActions(active);
  useWindowVisibility(reportVisibility);
  const badge = badges[active.mode];
  const Dialog = share.Dialog;

  const returnToMain = () => {
    try {
      const handoff = draftHandoff({
        text: app.text,
        attachments: app.attachments,
        providerId: app.providerId,
        model: app.model,
      });
      void api.returnToMainWindow(handoff).catch(report);
    } catch (error) {
      report(error);
    }
  };

  return (
    <>
      <header className="chat-header conversation-window-header">
        <div>
          {active.mode !== "chat" && <Laptop size={16} />}
          <ConversationTitle
            conversation={active}
            projects={app.snapshot.projects}
            running={app.running}
            actions={{
              onPin: () =>
                void patchConversation(active, { pinned: !active.pinned }),
              onRename: (title) => void patchConversation(active, { title }),
              onMoveToProject: (id) => void app.moveToProject(id).catch(report),
              onCreateProject: (name) => app.startProject(active.id, name),
              // Projects open in the main window; the breadcrumb is hidden here.
              onOpenProjects: () => {},
              onArchive: () =>
                void patchConversation(active, { archived: !active.archived }),
              onDelete: () => confirmDelete(active),
              transcriptView:
                active.mode === "code" ? transcriptView.menu : undefined,
              outputStyle:
                active.mode === "code"
                  ? [
                      "default",
                      "Concise",
                      "Explanatory",
                      "Learning",
                      "Proactive",
                      ...Object.keys(active.customOutputStyles ?? {}),
                    ].map((name) => ({
                      name,
                      onSelect: () =>
                        void patchConversation(active, { outputStyle: name }),
                    }))
                  : undefined,
              onNewOutputStyle:
                active.mode === "code" ? () => setNewStyle(true) : undefined,
            }}
          />
          {badge && <span className="mode-badge">{badge}</span>}
        </div>
        <div className="header-actions conversation-window-actions">
          {share.status && Dialog && (
            <IconButton
              label="Share"
              expanded={sharing}
              onClick={() => setSharing(true)}
            >
              <Share size={16} strokeWidth={1.8} />
            </IconButton>
          )}
          <IconButton label="Return to the main window" onClick={returnToMain}>
            <ReturnIcon />
          </IconButton>
          <IconButton
            label={pinned ? "Stop keeping on top" : "Keep on top"}
            active={pinned}
            className="conversation-window-pin"
            onClick={() =>
              void api.setWindowPinned(!pinned).then(setPinned).catch(report)
            }
          >
            <PinIcon />
          </IconButton>
        </div>
      </header>
      {sharing && share.status && Dialog && (
        <Dialog
          conversation={active}
          status={share.status}
          onClose={() => setSharing(false)}
        />
      )}
      {newStyle && (
        <Suspense fallback={null}>
          <NewOutputStyleDialog
            onClose={() => setNewStyle(false)}
            onSave={(name, prompt) => {
              setNewStyle(false);
              void patchConversation(active, {
                outputStyle: name,
                customOutputStyles: {
                  ...(active.customOutputStyles ?? {}),
                  [name]: { name, prompt },
                },
              });
            }}
          />
        </Suspense>
      )}
    </>
  );
}
