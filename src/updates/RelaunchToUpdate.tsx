import { Suspense, useContext, useEffect, useState } from "react";
import { ArrowRight } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import { relaunchToUpdate } from "./useAppUpdate";
import { lazyPiece } from "../ui/lazy-piece";
import { formatText, t } from "../i18n";

/** Only shown when a task is running at relaunch: loaded then. */
const RelaunchBusyDialog = lazyPiece(
  () => import("./RelaunchBusyDialog"),
  "RelaunchBusyDialog",
);
import { AppContext } from "../app/AppContext";
import type { Conversation } from "../../shared/types";
import "./updates.css";

/** Conversations with a task in progress. */
export const runningConversations = (conversations: Conversation[]) =>
  conversations.filter((c) => c.turns.some((t) => t.status === "inProgress"));

/**
 * Relaunching to install a staged update, from wherever it is offered (the
 * sidebar button, the notice above the composer): with a task running it asks
 * first (Cancel, Wait for Claudex, Update anyway), and waiting ends in the
 * relaunch once nothing runs. `dialog` goes wherever the caller renders.
 */
export function useRelaunchFlow(onError: (error: unknown) => void) {
  // The window's conversations, when used inside App (tests render it alone).
  const app = useContext(AppContext);
  const conversations = app?.snapshot.conversations ?? [];
  const running = runningConversations(conversations);
  const [asking, setAsking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  // Waiting ends in the relaunch, once nothing runs any more.
  useEffect(() => {
    if (waiting && !running.length) relaunchToUpdate(onError);
  }, [waiting, running.length]);
  const close = () => {
    setAsking(false);
    setWaiting(false);
  };
  return {
    relaunch: () =>
      running.length ? setAsking(true) : relaunchToUpdate(onError),
    dialog: asking ? (
      <Suspense fallback={null}>
        <RelaunchBusyDialog
          count={running.length}
          firstTitle={running[0]?.title}
          waiting={waiting}
          onWait={() => setWaiting(true)}
          onUpdateAnyway={() => {
            close();
            relaunchToUpdate(onError, { interrupt: true });
          }}
          onClose={close}
          onOpenSession={
            app && running[0]
              ? () => app.openConversation(running[0])
              : undefined
          }
        />
      </Suspense>
    ) : null,
  };
}

/**
 * "Relaunch to update" at the foot of the sidebar, above the account row: a
 * full-width 28px rounded button, the label on the left and a grey arrow on the
 * right. Shown once an update is downloaded, verified and staged; clicking
 * quits, installs it and opens the new version. While a task runs it asks first
 * (useRelaunchFlow); after an install that did not complete it reads "Relaunch
 * to retry update".
 */
export function RelaunchToUpdate({
  version,
  retry = false,
  onError,
}: {
  version: string;
  /** The staged update was tried before and is still here. */
  retry?: boolean;
  onError: (error: unknown) => void;
}) {
  const { relaunch, dialog } = useRelaunchFlow(onError);
  return (
    <>
      <button
        type="button"
        className="relaunch-update"
        title={
          retry
            ? t("The last update didn't complete.")
            : formatText("Install Claudex {x} and relaunch", { x: version })
        }
        onClick={relaunch}
      >
        <span>
          {retry ? t("Relaunch to retry update") : t("Relaunch to update")}
        </span>
        <ArrowRight aria-hidden="true" size={11} strokeWidth={2} />
      </button>
      {dialog}
    </>
  );
}

/** While Check for Updates… is checking or downloading. */
export function UpdateStatusStrip({
  phase,
}: {
  phase: "checking" | "downloading";
}) {
  return (
    <div className="relaunch-update update-status-strip" role="status">
      <span className="update-status-lead" aria-hidden="true">
        <Spinner inheritColor size={14} className="spin" />
      </span>
      <span className="update-status-text">
        {phase === "checking"
          ? t("Checking for updates...")
          : t("Downloading update...")}
      </span>
    </div>
  );
}
