import type { DeepLink } from "../../shared/deep-links";
import {
  useEffect,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  AppCommand,
  AppEvent,
  Conversation,
  Snapshot,
} from "../../shared/types";
import type { Artifact } from "../ui/components";
import type { SidePanel } from "../conversation/ToolSidePanel";
import type { ArtifactPresentation } from "../artifacts/artifact-presentation";
import { sameArtifact } from "../artifacts/artifact-context";
import { generatedArtifact } from "../artifacts/generatedArtifact";
import { finishedUnseen, isRunning } from "../conversation/unread";
import {
  notifyFinished,
  notifyCodeUpdate,
  notifyRoutineFinished,
  notifyCodePermission,
  withdrawCodePermission,
  clearCodePermissionNotifications,
} from "./web-notifications";
import type { Routine } from "../../shared/routines";
import { runningSchedule } from "../../shared/routine-notices";
import { surface } from "../../shared/host";
import { preference } from "../../shared/settings-extras";
import { newCodeNotifications } from "../../shared/code-notifications";
import { registerConnectionCheck, setStreamConnected } from "./connection";
import { windowRole } from "../conversation-window/window-role";
import { splitSessionIds } from "../split-view/split-state";
import { applySideChatText } from "../side-chat/side-chat-store";
import { openSettingsLink } from "../settings/navigation";
import {
  applyCloudSession,
  ConversationTurns,
  resyncSnapshot,
} from "../host/events";

/** Where a generated file opens when it presents itself during a reply. */
export interface ArtifactPlacement {
  surface: "artifact" | "file";
  /** The viewer's share of the workspace, in percent. */
  width: number;
  /** The open tool panel (Cowork's Progress card) stays open beside it. */
  keepPanel: boolean;
}

/** Chat's placement: the artifact view at 68%, replacing a tool panel. */
const defaultPlacement: ArtifactPlacement = {
  surface: "artifact",
  width: 68,
  keepPanel: false,
};

/**
 * The placement for a conversation's presented file. Package R11-E adds
 * `presentationFor(conversation, viewing)` to ArtifactPresentation (Cowork
 * outputs open as files, and never replace a file the person is viewing:
 * null keeps what is shown); until then Chat's placement applies.
 */
export function placementFor(
  presentation: ArtifactPresentation,
  conversation: Conversation,
  viewing: Artifact | undefined,
): ArtifactPlacement | null {
  const custom = (
    presentation as {
      presentationFor?: (
        conversation: Conversation,
        viewing: Artifact | undefined,
      ) => ArtifactPlacement | null;
    }
  ).presentationFor;
  return custom
    ? custom.call(presentation, conversation, viewing)
    : defaultPlacement;
}

/** What the window shows, read when an event arrives. */
export interface PresentationContext {
  activeId?: string;
  page: string;
  settingsOpen: boolean;
  artifact?: Artifact;
}

/**
 * Loads the first snapshot and applies the main process's events to it. Every
 * callback passed here must stay the same across renders (state setters,
 * refs, or callbacks without dependencies): the subscription is made once.
 */
export function useDesktopEvents({
  latest,
  presentation,
  selectNext,
  artifactPresentation,
  runCommand,
  runDeepLink,
  setSnapshot,
  upsert,
  report,
  setActiveId,
  setArtifact,
  setArtifactWidth,
  setPanel,
  setProviderId,
  setModel,
  setError,
  onBootFailure = report,
}: {
  latest: RefObject<Snapshot | undefined>;
  presentation: RefObject<PresentationContext>;
  selectNext: RefObject<boolean>;
  artifactPresentation: RefObject<ArtifactPresentation>;
  runCommand: RefObject<
    (command: AppCommand, conversationId?: string, folder?: string) => void
  >;
  /** A claudex:// link opened from outside (shared/deep-links.ts). */
  runDeepLink?: RefObject<(link: DeepLink) => void>;
  setSnapshot: Dispatch<SetStateAction<Snapshot | undefined>>;
  upsert: (conversation: Conversation) => void;
  report: (error: unknown) => void;
  setActiveId: Dispatch<SetStateAction<string | undefined>>;
  setArtifact: Dispatch<SetStateAction<Artifact | undefined>>;
  setArtifactWidth: Dispatch<SetStateAction<number>>;
  setPanel: Dispatch<SetStateAction<SidePanel | null>>;
  setProviderId: Dispatch<SetStateAction<string>>;
  setModel: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string>>;
  /** The first snapshot did not load (the window shows its boot error page). */
  onBootFailure?: (error: unknown) => void;
}) {
  useEffect(() => {
    const api = window.desktop;
    if (!api) {
      setError(
        "Launch the desktop app with npm run dev to connect to the local Codex engine.",
      );
      return;
    }
    let alive = true;
    // Conversations the person can see in a separate window (R2): a reply
    // finishing there is not unread in this window's sidebar.
    let shownElsewhere = new Set<string>();
    const mainWindow = windowRole().kind === "main";
    let schedules: Routine[] = [];
    let receivedSchedules = false;
    if (surface === "web" && mainWindow)
      void api
        .listSchedules()
        .then((saved) => {
          if (alive && !receivedSchedules) schedules = saved;
        })
        .catch(report);
    // Turn events that arrive before the window renders the previous one.
    const turns = new ConversationTurns();
    // Only the latest reconnect's snapshot is applied, with the
    // conversations that changed while it was being read on top.
    let resyncs = 0;
    let arrivedDuringResync: Map<string, Conversation> | undefined;
    /** A conversation changed: show it, mark it unread, present its file. */
    const conversationChanged = (conversation: Conversation) => {
      const previous = latest.current?.conversations.find(
        (c) => c.id === conversation.id,
      );
      upsert(conversation);
      arrivedDuringResync?.set(conversation.id, conversation);
      const context = presentation.current;
      const visible =
        context.page === "chat" &&
        !context.settingsOpen &&
        (context.activeId === conversation.id || selectNext.current);
      // A reply that finished in another conversation marks its row unread;
      // the open one only goes out, even with the window in the background.
      // Only the main window marks: it has the sidebar, and a separate window
      // cannot see what the main window shows. A session in a split-view pane
      // is on screen too.
      if (
        mainWindow &&
        finishedUnseen(
          previous,
          conversation,
          visible ||
            shownElsewhere.has(conversation.id) ||
            (context.page === "chat" &&
              !context.settingsOpen &&
              splitSessionIds().has(conversation.id)),
        )
      )
        void api
          .updateConversation(conversation.id, { unread: true })
          .then(upsert)
          .catch(() => {});
      // The web's Response completions are the browser's notifications.
      const settings = latest.current?.settings;
      if (
        surface === "web" &&
        mainWindow &&
        settings &&
        preference(settings, "notifyResponses") &&
        !conversation.scheduledRun &&
        isRunning(previous) &&
        !isRunning(conversation)
      )
        notifyFinished(conversation, visible, (id) =>
          runCommand.current("open-conversation", id),
        );
      // Code notifications: what a Code session chose to tell the person.
      if (
        surface === "web" &&
        mainWindow &&
        settings &&
        preference(settings, "notifyCodeUpdates")
      )
        for (const message of newCodeNotifications(previous, conversation))
          notifyCodeUpdate(conversation, message, visible, (id) =>
            runCommand.current("open-conversation", id),
          );
      const file = artifactPresentation.current.observe(conversation, visible);
      const generated = file && generatedArtifact(file);
      // Existing source views refresh below without changing split, mode or expansion.
      const alreadyViewing =
        generated &&
        context.artifact?.conversationId === conversation.id &&
        sameArtifact(context.artifact, generated);
      const placement =
        generated &&
        !alreadyViewing &&
        placementFor(
          artifactPresentation.current,
          conversation,
          context.artifact,
        );
      if (generated && placement) {
        setArtifact({
          ...generated,
          conversationId: conversation.id,
          surface: placement.surface,
        });
        setArtifactWidth(placement.width);
        if (!placement.keepPanel) setPanel(null);
      }
      if (selectNext.current) {
        selectNext.current = false;
        setActiveId(conversation.id);
      }
    };
    /** Reads the whole state again (a reconnect past the replay, Check now). */
    const resync = () => {
      const request = ++resyncs;
      const readBridge = window.desktop;
      const arrived = new Map<string, Conversation>();
      arrivedDuringResync = arrived;
      return readBridge
        .snapshot()
        .then((fresh) => {
          if (!alive || request !== resyncs) return;
          arrivedDuringResync = undefined;
          if (window.desktop !== readBridge) return;
          turns.forget();
          const newer = [...arrived.values()];
          artifactPresentation.current.seed(
            resyncSnapshot(latest.current, fresh, newer).conversations,
          );
          setSnapshot((s) => resyncSnapshot(s, fresh, newer));
        })
        .catch((error) => {
          if (!alive || request !== resyncs) return;
          arrivedDuringResync = undefined;
          if (window.desktop !== readBridge) return;
          report(error);
        });
    };
    registerConnectionCheck(resync);
    const unsubscribe = api.onEvent((event: AppEvent) => {
      if (!alive) return;
      if (event.type === "schedules") {
        receivedSchedules = true;
        const settings = latest.current?.settings;
        if (
          surface === "web" &&
          mainWindow &&
          settings &&
          preference(settings, "notifySchedules")
        )
          notifyRoutineFinished(
            schedules,
            event.schedules,
            (id) => {
              const context = presentation.current;
              return (
                context?.page === "chat" &&
                !context.settingsOpen &&
                context.activeId === id
              );
            },
            (id) => runCommand.current("open-conversation", id),
          );
        schedules = event.schedules;
      } else if (event.type === "conversation") {
        turns.forget(event.conversation.id);
        conversationChanged(event.conversation);
      } else if (event.type === "conversation-turn") {
        const merged = turns.apply(
          latest.current?.conversations.find(
            (c) => c.id === event.conversationId,
          ),
          event,
        );
        if (merged) conversationChanged(merged);
      } else if (event.type === "cloud-session")
        setSnapshot((s) =>
          s
            ? {
                ...s,
                cloudSessions: applyCloudSession(
                  s.cloudSessions,
                  event.session,
                ),
              }
            : s,
        );
      // The web bridge's event stream reconnected past what it could replay.
      else if (event.type === "resync") void resync();
      else if (event.type === "stream-connection")
        setStreamConnected(event.connected);
      else if (event.type === "engine")
        setSnapshot((s) => (s ? { ...s, engine: event.engine } : s));
      // Changed by the main process: MCP configuration file, skills, policy.
      else if (event.type === "settings")
        setSnapshot((s) => (s ? { ...s, settings: event.settings } : s));
      else if (event.type === "artifact-shares")
        setSnapshot((s) => (s ? { ...s, artifactShares: event.shares } : s));
      else if (event.type === "approval") {
        const state = latest.current;
        const conversation = state?.conversations.find(
          (item) => item.id === event.approval.conversationId,
        );
        if (surface === "web" && mainWindow && state && conversation) {
          const context = presentation.current;
          const visible =
            shownElsewhere.has(conversation.id) ||
            (context.page === "chat" &&
              !context.settingsOpen &&
              (context.activeId === conversation.id ||
                splitSessionIds().has(conversation.id)));
          notifyCodePermission(
            event.approval,
            conversation,
            state.settings,
            visible,
            (id) => runCommand.current("open-conversation", id),
            runningSchedule(schedules, conversation.id),
          );
        }
        setSnapshot((s) =>
          s
            ? {
                ...s,
                approvals: [
                  ...s.approvals.filter((a) => a.id !== event.approval.id),
                  event.approval,
                ],
              }
            : s,
        );
      }
      // A side chat's answer as it is written.
      else if (event.type === "side-chat-text") applySideChatText(event);
      else if (event.type === "command")
        runCommand.current(event.command, event.conversationId, event.folder);
      else if (event.type === "deep-link") runDeepLink?.current(event.link);
      // Claude opened a page in this session's Browser: the panel opens beside
      // it, as on the live desktop.
      else if (event.type === "browser-reveal") {
        const shown = presentation.current;
        if (
          shown.activeId === event.conversationId &&
          shown.page === "chat" &&
          !shown.settingsOpen
        )
          setPanel("browser");
      } else if (event.type === "connector-link")
        openSettingsLink("connectors", event.connector);
      else if (event.type === "window-visibility")
        shownElsewhere = new Set(event.conversationIds);
      else if (event.type === "approval-resolved") {
        if (surface === "web") withdrawCodePermission(event.id);
        setSnapshot((s) =>
          s
            ? { ...s, approvals: s.approvals.filter((a) => a.id !== event.id) }
            : s,
        );
      }
    });
    api
      .snapshot()
      .then((s) => {
        if (!alive) return;
        artifactPresentation.current.seed(s.conversations);
        // An incognito chat left over from before a reload is ended now (by
        // the main window: a separate window opening must not end the
        // incognito chat the main window shows).
        if (mainWindow)
          for (const c of s.conversations)
            if (c.incognito) void api.discardIncognito(c.id).catch(() => {});
        setSnapshot({
          ...s,
          conversations: s.conversations.filter((c) => !c.incognito),
        });
        setProviderId(s.settings.activeProviderId);
        setModel(
          s.settings.providers.find((p) => p.id === s.settings.activeProviderId)
            ?.model ?? "",
        );
      })
      .catch((error) => {
        if (alive) onBootFailure(error);
      });
    return () => {
      if (surface === "web") clearCodePermissionNotifications();
      registerConnectionCheck(undefined);
      alive = false;
      unsubscribe();
    };
  }, []);
}
