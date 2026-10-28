import { openArtifact, useArtifactThreadRequests } from "./ArtifactHost";
import { WarningIcon } from "../policy/GlobalLimitToast";
import "../policy/global-limit-toast.css";
import { CloseSmallIcon } from "../ui/icons";
import { Toaster } from "../ui/Toaster";
import {
  Component,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { useStreamConnection } from "./connection";
import { FocusNotices } from "../focus/FocusNotices";
import { X } from "../ui/glyphs";
import { IconButton } from "../ui/Controls";
import { ConfirmationDialog } from "../dialogs/ConfirmationDialog";
import { useApp } from "./AppContext";
import { useHost } from "../host/HostContext";
import { useErrorToastClearance } from "../ui/useErrorToastClearance";
import { useNoticeStack } from "../ui/notice-stack";
import { useProjectMoveRequest } from "../collections/projects/project-move-request";
import { lazyPiece } from "../ui/lazy-piece";
import { actionVerificationStore } from "../auth/action-verification-store";
import { useTaskRail } from "../cowork/useTaskRail";
import {
  ProjectEditorOverlay,
  RenameOverlay,
  SearchOverlay,
} from "./CollectionOverlays";
import { SettingsOverlay } from "./SettingsHost";
import {
  EditSidebarOverlay,
  ReleaseNotesOverlay,
  ShortcutsOverlay,
} from "./ShellChrome";

const ActionVerificationDialog = lazyPiece(
  () => import("../auth/ActionVerificationDialog"),
  "ActionVerificationDialog",
);

function ActionVerificationOverlay() {
  const active = useSyncExternalStore(
    actionVerificationStore.subscribe,
    actionVerificationStore.snapshot,
    actionVerificationStore.snapshot,
  );
  useEffect(() => () => actionVerificationStore.close(), []);
  return active ? (
    <Suspense fallback={null}>
      <ActionVerificationDialog key={active.key} />
    </Suspense>
  ) : null;
}

const CoworkTasksPanel = lazyPiece(
  () => import("../cowork/CoworkTasksPanelOverlay"),
  "CoworkTasksPanelOverlay",
);

export function TasksPanelOverlay() {
  const app = useApp();
  const host = useHost();
  const rail = useTaskRail(app, host);
  useEffect(() => {
    window.addEventListener("claudex:tasks-panel", rail.toggle);
    return () => window.removeEventListener("claudex:tasks-panel", rail.toggle);
  }, [rail.toggle]);
  const context = rail.context;
  return rail.open && context ? (
    <Suspense fallback={null}>
      <CoworkTasksPanel
        accountId={app.accountId}
        controllerScope={rail.lease}
        active={context.active}
        tasksAvailable={context.tasksAvailable}
        activityScope={rail.lease.key}
        view={rail.view}
        onViewChange={rail.changeView}
        onArtifact={(artifact) => {
          if (rail.isCurrent()) openArtifact(app, artifact);
        }}
        conversations={app.snapshot.conversations}
        approvals={app.snapshot.approvals ?? []}
        onOpen={(conversation) => {
          if (rail.isCurrent()) app.openConversation(conversation);
        }}
        onClose={rail.close}
        onError={(error) => {
          if (rail.isCurrent()) app.report(error);
        }}
        onRoutine={async (id) => {
          if (!rail.isCurrent()) return;
          try {
            const { requestScheduleConfirmation } =
              await import("../collections/routines/schedule-request");
            if (!rail.isCurrent()) return;
            // openRoutineId selects the canonical detail; routineId selects its editor.
            requestScheduleConfirmation({ description: "", openRoutineId: id });
            app.setPage("scheduled");
          } catch (error) {
            if (rail.isCurrent()) app.report(error);
          }
        }}
      />
    </Suspense>
  ) : null;
}

/**
 * Window-level overlays round-two packages add (R9's SSH prompt, R10's
 * computer-use indicator, …), above the built-in ones in registration order.
 * Each renders nothing while it has nothing to show.
 */
const overlays = new Map<string, ComponentType>();

const ResumeSessionDialog = lazyPiece(
  () => import("../code-home/ResumeSessionDialog"),
  "ResumeSessionDialog",
);

function ResumeSessionOverlay() {
  const app = useApp();
  const [query, setQuery] = useState<string>();
  useEffect(() => {
    const open = (event: Event) =>
      setQuery((event as CustomEvent<{ query: string }>).detail?.query ?? "");
    window.addEventListener("claudex:resume-session", open);
    return () => window.removeEventListener("claudex:resume-session", open);
  }, []);
  if (query === undefined) return null;
  return (
    <Suspense fallback={null}>
      <ResumeSessionDialog
        initialQuery={query}
        cwd={app.active?.cwd ?? app.cwd}
        branch={app.active?.branch}
        onClose={() => setQuery(undefined)}
        onResume={(conversation) => app.openConversation(conversation)}
      />
    </Suspense>
  );
}

/** Adds a window-level overlay, from the package's `*.slot.tsx` module. */
export function registerOverlay(id: string, overlay: ComponentType) {
  overlays.set(id, overlay);
}

/**
 * Everything drawn over the window, in stacking order: later entries sit
 * above earlier ones. Each overlay renders nothing while it is closed.
 */
export function AppOverlays() {
  useArtifactThreadRequests();
  return (
    <>
      <SettingsOverlay />
      <ActionVerificationOverlay />
      <ReleaseNotesOverlay />
      <ShortcutsOverlay />
      <ErrorBanner />
      <Toaster />
      <ConnectionToast />
      <FocusOverlay />
      <SearchOverlay />
      <ResumeSessionOverlay />
      <TasksPanelOverlay />
      <RenameOverlay />
      <ConfirmOverlay />
      <ProjectEditorOverlay />
      <LazyProjectMove />
      <EditSidebarOverlay />
      {[...overlays].map(([id, Overlay]) => (
        <OverlayBoundary key={id} id={id}>
          <Overlay />
        </OverlayBoundary>
      ))}
    </>
  );
}

/** A registered overlay that fails to render disappears instead of blanking the window. */
class OverlayBoundary extends Component<
  { id: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(
      `Overlay ${this.props.id} failed:`,
      error instanceof Error ? error.message : String(error),
    );
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * An error the window reports: the original's corner notice, not a banner of
 * its own.
 */
export function ErrorBanner() {
  const { error, setError } = useApp();
  const web = useHost().kind === "web";
  const ref = useErrorToastClearance(web && Boolean(error), error);
  // Off the web the clearance hook is idle: the notice rises above the others
  // and above a composer near the bottom with them.
  useNoticeStack(ref, !web && Boolean(error));
  if (!error) return null;
  return (
    <div ref={ref} className="global-limit-toast error-banner" role="alert">
      <WarningIcon size={20} />
      <p className="global-limit-toast-text">{error}</p>
      <button
        type="button"
        className="global-limit-toast-close"
        aria-label="Dismiss error"
        onClick={() => setError("")}
      >
        <CloseSmallIcon />
      </button>
    </div>
  );
}

/**
 * The corner notice while the event stream is down and a reply is running. It
 * goes when the stream is back; closing it keeps it away until the next loss.
 * Its words are the live bundle's, which the capture cut off.
 */
function ConnectionToast() {
  const { snapshot } = useApp();
  const { connected, lostAt } = useStreamConnection();
  const [closed, setClosed] = useState<number>();
  const ref = useRef<HTMLDivElement>(null);
  const running = snapshot.conversations.some(
    (c) => c.turns.at(-1)?.status === "inProgress",
  );
  const shown = !connected && running && closed !== lostAt;
  useNoticeStack(ref, shown);
  if (!shown) return null;
  return (
    <div ref={ref} className="global-limit-toast connection-toast" role="alert">
      <WarningIcon />
      <p className="global-limit-toast-text">
        Connection to Claudex’s response was lost. Claudex may still be working.
        If the response doesn’t appear, check back in a few minutes.
      </p>
      <button
        type="button"
        className="global-limit-toast-close"
        aria-label="Dismiss"
        onClick={() => setClosed(lostAt)}
      >
        <CloseSmallIcon />
      </button>
    </div>
  );
}

/** Settings → Time and focus: break reminders and quiet hours. */
function FocusOverlay() {
  const { snapshot } = useApp();
  return <FocusNotices settings={snapshot.settings} />;
}

function ConfirmOverlay() {
  const { confirm, setConfirm, report } = useApp();
  if (!confirm) return null;
  return (
    <ConfirmationDialog
      confirmation={confirm}
      onClose={() => setConfirm(undefined)}
      onError={report}
    />
  );
}

// Move to project loads with the first request for it.
const ProjectMoveOverlay = lazyPiece(
  () => import("../collections/projects/MoveToProjectModal"),
  "ProjectMoveOverlay",
);

function LazyProjectMove() {
  const request = useProjectMoveRequest();
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <ProjectMoveOverlay />
    </Suspense>
  );
}
