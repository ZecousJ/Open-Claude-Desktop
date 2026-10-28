import { useModelCatalog } from "../composer/model/code-model-choices";
import type { SettledTasks } from "./CodeTurnStatus";
import { sideChatAvailability } from "../side-chat/side-chat-model";
import { AppContext } from "../app/AppContext";
import type {
  ReactNode,
  RefObject,
  UIEventHandler,
  WheelEventHandler,
} from "react";
import { useContext, useEffect, useRef, useState } from "react";
import { editLastMessageEvent } from "../composer/double-escape";
import { AppIcon } from "../ui/app-icon";
import { useTranscriptSlots } from "./transcript-slots";
import type {
  Approval,
  BackgroundTerminalInfo,
  Conversation,
  Mode,
  Turn,
} from "../../shared/types";
import type { Artifact } from "../ui/ArtifactTypes";
import { type AgentTarget } from "./agents/AgentItems";
import { tasksFromTurn } from "../../shared/workflow-model";
import { failedRuns } from "./TurnOutcome";
import { coworkPromptActions } from "./cowork-prompt-actions";
import { lazyPiece } from "../ui/lazy-piece";
import { messageTextSize, transcriptTextSize } from "./transcript-text-size";
import { formatText } from "../i18n";
import { UsageReportsHere } from "../usage-report/UsageReportsHere";
import {
  reportsAfter,
  useUsageReports,
} from "../usage-report/usage-report-store";
import { conversationTranscriptView } from "./ConversationTranscriptView";

export const TitleOfferCard = lazyPiece(
  () => import("../title-offers/TitleOfferCard"),
  "TitleOfferCard",
);
export const SessionSetupSteps = lazyPiece(
  () => import("../code-tools/SessionSetupSteps"),
  "SessionSetupSteps",
);
export const ThinkingSummaries = lazyPiece(
  () => import("../transcript-view/ThinkingSummaries"),
);
export const CodeNewTaskCard = lazyPiece(
  () => import("../code-session/CodeNewTaskCard"),
);
export const BlankArtifactConversationIntro = lazyPiece(
  () => import("../artifacts/BlankArtifactConversationIntro"),
  "BlankArtifactConversationIntro",
);

/**
 * "N running task" counts background work only: background terminals and
 * background agents or workflows. A foreground command is not a task
 * (lifecycle-own-001 t=72/75s: "30s · 36 tokens · Thought for 27s").
 */
export function backgroundTaskCount(
  turn: Turn,
  conversation: Conversation,
  background: Set<string>,
) {
  return (
    turn.items.filter(
      (item) => item.type === "commandExecution" && background.has(item.id),
    ).length +
    tasksFromTurn(turn, conversation).filter(
      (task) => task.status === "running",
    ).length
  );
}

/** A turn younger than this when it first shows is new: it rises in. */
export const NEW_TURN_MS = 5000;

/**
 * The turns a conversation opened with. A turn that shows up later (a new
 * prompt, a retry) rises in; the ones already there when it opened, or that
 * come back with another version, do not.
 */
function useOpeningTurns(conversation: Conversation) {
  const opening = useRef<{ id: string; turns: Set<string> }>(null);
  if (opening.current?.id !== conversation.id)
    opening.current = {
      id: conversation.id,
      turns: new Set(conversation.turns.map((turn) => turn.id)),
    };
  return opening.current.turns;
}

/**
 * Back to the latest message: Chat uses the live 2026-10-16 36px round
 * arrow. Code keeps its compact pill. While the conversation waits
 * on the person (an approval or a question, which sits at the end of the
 * transcript) it reads "Needs your input" after an accent dot.
 */
export function ScrollToLatest({
  shown,
  needsInput,
  round,
  onClick,
}: {
  shown: boolean;
  needsInput: boolean;
  round: boolean;
  onClick: () => void;
}) {
  const Label = useTranscriptSlots().ScrollToLatestLabel;
  const circular = round && !needsInput && !Label;
  return (
    <div className="scroll-bottom-dock">
      <button
        type="button"
        className="scroll-bottom-button"
        data-visible={shown}
        data-needs-input={needsInput || undefined}
        data-round={circular || undefined}
        aria-label={
          needsInput
            ? "Needs your input. Scroll to the request"
            : "Scroll to bottom"
        }
        aria-hidden={!shown}
        tabIndex={shown ? 0 : -1}
        onClick={onClick}
      >
        {needsInput && (
          <>
            <span className="scroll-bottom-dot" aria-hidden="true" />
            <span className="scroll-bottom-label">Needs your input</span>
          </>
        )}
        <AppIcon name={circular ? "ArrowDown" : "CaretDownSmall"} />
        {Label && !needsInput && <Label />}
      </button>
    </div>
  );
}

export function PromptArticle({
  index,
  total,
  children,
}: {
  index?: number;
  total: number;
  children: ReactNode;
}) {
  if (index === undefined) return children;
  return (
    <div
      className="user-message-article"
      role="article"
      aria-label={formatText("Message {index} of {total}", { index, total })}
      aria-posinset={index}
      aria-setsize={total}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

export function ConversationMessages({
  feed,
  children,
}: {
  feed: boolean;
  children: ReactNode;
}) {
  return (
    <div className="messages">
      {feed ? (
        <div className="message-feed" role="feed" aria-label="Chat messages">
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export function ConversationTranscript({
  conversation,
  mode,
  presentation,
  sending,
  running,
  approvals,
  replyFeedback,
  onReplyFeedback,
  onArtifact,
  onOpenWorkflow,
  onOpenAgent,
  onEditPrompt,
  onRetryResponse,
  onDiscardTurn,
  onContinue,
  onSelectVersion,
  onError,
  backgroundTerminals = [],
  finishedTasks = 0,
  backgroundOpen = false,
  onToggleBackground,
  onOpenChanges,
  onUndoChanges,
  onOpenPlan,
  scrollRef,
  onScroll,
  onWheel,
  away,
  onJumpToLatest,
  onQuoteReply,
  onForkFrom,
  onHandOff,
  lookupConversation,
  onOpenConversation,
  onRewind,
  onForkBefore,
  onSwapRewind,
  onAttachMessage,
}: {
  conversation: Conversation;
  /** Execution kind: actions and task capabilities keep the stored mode. */
  mode: Mode;
  /** The unified Claudex view can display a stored Cowork task as Chat. */
  presentation?: "chat";
  sending: boolean;
  running: boolean;
  approvals: Approval[];
  replyFeedback: Record<string, "up" | "down">;
  onReplyFeedback: (
    turnId: string,
    rating: "up" | "down" | null,
  ) => Promise<void>;
  onArtifact: (artifact: Artifact) => void;
  onOpenWorkflow: () => void;
  /** Opens a single Agent's own transcript beside the conversation. */
  onOpenAgent?: (target: AgentTarget) => void;
  onEditPrompt: (turnId: string, text: string) => Promise<boolean>;
  onRetryResponse: (turnId: string) => void;
  onDiscardTurn?: (turnId: string) => void;
  /** Sends "Continue" after a reply stopped at the output limit. */
  onContinue: () => void;
  onSelectVersion: (turnId: string, versionId: string, prompt: boolean) => void;
  onError: (error: unknown) => void;
  /** Code: background terminals Codex lists for this conversation. */
  backgroundTerminals?: BackgroundTerminalInfo[];
  /** Code: background tasks that ended and are still listed under Finished. */
  finishedTasks?: number | SettledTasks;
  /** Code: whether the Background tasks panel is open. */
  backgroundOpen?: boolean;
  /** Code: opens the Background tasks panel, or closes it when it is open. */
  onToggleBackground?: () => void;
  onOpenChanges?: (path?: string) => void;
  /** Code: sends the latest turn's Undo message (CodeTurnChanges). */
  onUndoChanges?: (prompt: string) => void;
  onOpenPlan?: () => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onWheel: WheelEventHandler<HTMLDivElement>;
  away: boolean;
  onJumpToLatest: () => void;
  /** Native composer adapter; the desktop AppContext default is unchanged. */
  onQuoteReply?: (quote: string) => void;
  /** Code: Fork from here on a reply, a new session continuing after it. */
  onForkFrom?: (turnId: string) => void;
  /** Code: Hand off to a new session, offered when a reply ran out of room. */
  onHandOff?: () => void;
  /** Finds a stored conversation for the fork markers. */
  lookupConversation?: (id: string) => Conversation | undefined;
  /** Opens a conversation a fork marker names. */
  onOpenConversation?: (conversation: Conversation) => void;
  /** Code: Rewind to here on a message. */
  onRewind?: (turnId: string) => void;
  /** Code: Fork from here on a message (a new session before it). */
  onForkBefore?: (turnId: string) => void;
  /** Undo rewind / Redo rewind. */
  onSwapRewind?: () => void;
  /** Code: Attach selection / message as context on a prompt. */
  onAttachMessage?: (text: string) => void;
}) {
  const chatPresentation =
    mode === "chat" || (mode === "cowork" && presentation === "chat");
  const ownTerminals = backgroundTerminals.filter(
    (terminal) => terminal.conversationId === conversation.id,
  );
  const background = new Set(ownTerminals.map((terminal) => terminal.itemId));
  const latestTurn = conversation.turns.at(-1);
  const app = useContext(AppContext);
  const catalog = useModelCatalog();
  const openingTurns = useOpeningTurns(conversation);
  // A stopped reply's Edit prompt asks that prompt's editor to open.
  const [editRequest, setEditRequest] = useState<{
    turnId: string;
    count: number;
  }>();
  useEffect(() => {
    const editLast = (event: Event) => {
      if (
        (event as CustomEvent).detail !== conversation.id ||
        sending ||
        running ||
        !chatPresentation
      )
        return;
      const turn = conversation.turns.at(-1);
      if (
        turn &&
        mode === "cowork" &&
        !coworkPromptActions(conversation, turn, mode, false).edit
      )
        return;
      if (turn)
        setEditRequest((request) => ({
          turnId: turn.id,
          count: (request?.count ?? 0) + 1,
        }));
    };
    window.addEventListener(editLastMessageEvent, editLast);
    return () => window.removeEventListener(editLastMessageEvent, editLast);
  }, [conversation, sending, running, mode, chatPresentation]);
  // Selected text can go to the side chat where the desktop app has one for
  // this conversation (the phone layouts have none).
  const sideChatOffered =
    Boolean(app) && sideChatAvailability(conversation, mode).available;
  const awaitingInput = approvals.some(
    (approval) => approval.conversationId === conversation.id,
  );
  // Chat and Cowork fold failed replies in a row into one notice.
  const failed = mode === "code" ? undefined : failedRuns(conversation.turns);
  // Prompts and replies follow Settings → Transcript text size in every mode.
  const textSize = messageTextSize(transcriptTextSize(app?.snapshot.settings));
  // The phones draw the official turn-edits card and reply actions (slots).
  const slots = useTranscriptSlots();
  const TurnChanges = slots.CodeTurnChanges;
  const ReplyActions = slots.CodeReplyActions;
  // Code's posted usage reports (src/usage-report), under their turns.
  const usageReports = useUsageReports(conversation.id);
  const reportsAt = (turnId: string | null) =>
    mode === "code" && usageReports.length ? (
      <UsageReportsHere
        conversation={conversation}
        reports={reportsAfter(usageReports, turnId, conversation.turns)}
      />
    ) : null;
  // A prompt and its reply are distinct feed messages. A compaction has
  // no user prompt; a failed send has no assistant response to number.
  const feed = mode !== "code";
  const messageCount = conversation.turns.reduce(
    (count, turn) =>
      count + (turn.compaction ? 0 : 1) + (turn.sendFailed ? 0 : 1),
    0,
  );
  const conversationTranscriptViewView = conversationTranscriptView({
    ReplyActions,
    TurnChanges,
    app,
    approvals,
    awaitingInput,
    away,
    background,
    backgroundOpen,
    catalog,
    chatPresentation,
    conversation,
    editRequest,
    failed,
    feed,
    finishedTasks,
    latestTurn,
    lookupConversation,
    messageCount,
    mode,
    onArtifact,
    onAttachMessage,
    onContinue,
    onDiscardTurn,
    onEditPrompt,
    onError,
    onForkBefore,
    onForkFrom,
    onHandOff,
    onJumpToLatest,
    onOpenAgent,
    onOpenChanges,
    onOpenConversation,
    onOpenPlan,
    onOpenWorkflow,
    onQuoteReply,
    onReplyFeedback,
    onRetryResponse,
    onRewind,
    onScroll,
    onSelectVersion,
    onSwapRewind,
    onToggleBackground,
    onUndoChanges,
    onWheel,
    openingTurns,
    ownTerminals,
    presentation,
    replyFeedback,
    reportsAt,
    running,
    scrollRef,
    sending,
    setEditRequest,
    sideChatOffered,
    textSize,
  });
  return conversationTranscriptViewView;
}
