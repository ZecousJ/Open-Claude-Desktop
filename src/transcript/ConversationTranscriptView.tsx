import { Suspense } from "react";
import {
  BlankArtifactConversationIntro,
  ConversationMessages,
  NEW_TURN_MS,
  TitleOfferCard,
  CodeNewTaskCard,
  ThinkingSummaries,
  ScrollToLatest,
} from "./ConversationTranscript";
import { SelectionReply } from "./SelectionReply";
import {
  sideChatStarted,
  openSideChatWithContext,
} from "../side-chat/side-chat-store";
import { ForkedFrom, RewindMarker, ForksHere } from "./ForkMarkers";
import { HandedOffFrom, HandedOffHere } from "./HandOffMarkers";
import { coworkPromptActions } from "./cowork-prompt-actions";
import { formatText } from "../i18n";
import { Star } from "../ui/Star";
import { ReplyMark } from "./TurnActivity";
import { turnActivity } from "../../shared/activity";
import type {
  Turn,
  Approval,
  Conversation,
  Mode,
  BackgroundTerminalInfo,
} from "../../shared/types";
import type { SettledTasks } from "./CodeTurnStatus";
import type { Artifact } from "../ui/ArtifactTypes";
import type { AgentTarget } from "./agents/AgentItems";
import type { AppController } from "../app/AppContext";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import type { MessageTextSize } from "./transcript-text-size";
import { AssistantContent } from "./AssistantContent";
import { TranscriptPrompt } from "./TranscriptPrompt";

/** What conversationTranscriptView needs from ConversationTranscript.tsx. */
export interface ConversationTranscriptViewKit {
  ReplyActions: React.ComponentType<{ turn: Turn }> | undefined;
  TurnChanges:
    React.ComponentType<{ turn: Turn; onOpen: () => void }> | undefined;
  app: AppController | undefined;
  approvals: Approval[];
  awaitingInput: boolean;
  away: boolean;
  background: Set<string>;
  backgroundOpen: boolean;
  catalog: ModelCatalog | null;
  chatPresentation: boolean;
  conversation: Conversation;
  editRequest: { turnId: string; count: number } | undefined;
  failed: Map<string, number> | undefined;
  feed: boolean;
  finishedTasks: number | SettledTasks;
  latestTurn: Turn | undefined;
  lookupConversation: ((id: string) => Conversation | undefined) | undefined;
  messageCount: number;
  mode: Mode;
  onArtifact: (artifact: Artifact) => void;
  onAttachMessage: ((text: string) => void) | undefined;
  onContinue: () => void;
  onDiscardTurn: ((turnId: string) => void) | undefined;
  onEditPrompt: (turnId: string, text: string) => Promise<boolean>;
  onError: (error: unknown) => void;
  onForkBefore: ((turnId: string) => void) | undefined;
  onForkFrom: ((turnId: string) => void) | undefined;
  onHandOff: (() => void) | undefined;
  onJumpToLatest: () => void;
  onOpenAgent: ((target: AgentTarget) => void) | undefined;
  onOpenChanges: ((path?: string) => void) | undefined;
  onOpenConversation: ((conversation: Conversation) => void) | undefined;
  onOpenPlan: (() => void) | undefined;
  onOpenWorkflow: () => void;
  onQuoteReply: ((quote: string) => void) | undefined;
  onReplyFeedback: (
    turnId: string,
    rating: "up" | "down" | null,
  ) => Promise<void>;
  onRetryResponse: (turnId: string) => void;
  onRewind: ((turnId: string) => void) | undefined;
  onScroll: React.UIEventHandler<HTMLDivElement>;
  onSelectVersion: (turnId: string, versionId: string, prompt: boolean) => void;
  onSwapRewind: (() => void) | undefined;
  onToggleBackground: (() => void) | undefined;
  onUndoChanges: ((prompt: string) => void) | undefined;
  onWheel: React.WheelEventHandler<HTMLDivElement>;
  openingTurns: Set<string>;
  ownTerminals: BackgroundTerminalInfo[];
  presentation: "chat" | undefined;
  replyFeedback: Record<string, "up" | "down">;
  reportsAt: (turnId: string | null) => React.JSX.Element | null;
  running: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  sending: boolean;
  setEditRequest: React.Dispatch<
    React.SetStateAction<{ turnId: string; count: number } | undefined>
  >;
  sideChatOffered: boolean;
  textSize: MessageTextSize | undefined;
}

export function conversationTranscriptView(kit: ConversationTranscriptViewKit) {
  const {
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
  } = kit;
  let messageIndex = 0;
  const conversationTranscriptViewView = (
    <>
      <div
        className="messages-scroll u-scroll-fade-y"
        data-presentation={chatPresentation ? "chat" : undefined}
        ref={scrollRef}
        tabIndex={0}
        role={feed ? undefined : "region"}
        aria-label={feed ? undefined : "Chat messages"}
        onScroll={onScroll}
        onWheel={onWheel}
      >
        {chatPresentation &&
          conversation.blankArtifact &&
          !conversation.turns.length && (
            <Suspense fallback={null}>
              <BlankArtifactConversationIntro
                artifact={conversation.blankArtifact}
              />
            </Suspense>
          )}
        {(chatPresentation || (mode === "code" && sideChatOffered)) && (
          <SelectionReply
            container={scrollRef}
            onReply={
              chatPresentation
                ? (quote) => {
                    if (onQuoteReply) return onQuoteReply(quote);
                    if (!app) return;
                    app.setText((text) => quote + text);
                    requestAnimationFrame(() => {
                      const field = app.composer.current;
                      field?.focus();
                      field?.setSelectionRange(quote.length, quote.length);
                    });
                  }
                : undefined
            }
            sideChat={
              sideChatOffered
                ? {
                    started: () => sideChatStarted(conversation.id),
                    onSelect: (text) =>
                      openSideChatWithContext(conversation.id, text),
                  }
                : undefined
            }
          />
        )}
        <ConversationMessages feed={feed}>
          {lookupConversation && onOpenConversation && (
            <ForkedFrom
              conversation={conversation}
              lookup={lookupConversation}
              onOpen={onOpenConversation}
            />
          )}
          {lookupConversation && onOpenConversation && (
            <HandedOffFrom
              conversation={conversation}
              lookup={lookupConversation}
              onOpen={onOpenConversation}
            />
          )}
          {conversation.rewind?.index === 0 && onSwapRewind && (
            <RewindMarker
              rewind={conversation.rewind}
              busy={sending || running}
              onSwap={onSwapRewind}
            />
          )}
          {reportsAt(null)}
          {conversation.turns.map((turn, turnIndex) => {
            const latest = turn.id === latestTurn?.id;
            const awaitingApproval = awaitingInput;
            // A /compact turn has no prompt of its own (E0).
            const compaction = Boolean(turn.compaction);
            const promptIndex = compaction ? undefined : ++messageIndex;
            const replyIndex = turn.sendFailed ? undefined : ++messageIndex;
            const promptActions = coworkPromptActions(
              conversation,
              turn,
              mode,
              sending || running,
            );
            const replyText = turn.items
              .filter((item) => item.type === "agentMessage")
              .map((item) => item.text ?? "")
              .join("\n\n");
            return (
              <div
                className={`turn${compaction ? " compaction-turn" : ""}`}
                data-latest={latest}
                data-entering={
                  (!openingTurns.has(turn.id) &&
                    Date.now() - turn.createdAt < NEW_TURN_MS) ||
                  undefined
                }
                key={turn.id}
              >
                {!compaction && (
                  <TranscriptPrompt
                    chatPresentation={chatPresentation}
                    conversation={conversation}
                    editRequest={editRequest}
                    feed={feed}
                    messageCount={messageCount}
                    mode={mode}
                    onAttachMessage={onAttachMessage}
                    onDiscardTurn={onDiscardTurn}
                    onEditPrompt={onEditPrompt}
                    onForkBefore={onForkBefore}
                    onRetryResponse={onRetryResponse}
                    onRewind={onRewind}
                    onSelectVersion={onSelectVersion}
                    promptActions={promptActions}
                    promptIndex={promptIndex}
                    running={running}
                    sending={sending}
                    textSize={textSize}
                    turn={turn}
                    turnIndex={turnIndex}
                  />
                )}
                <div
                  className="assistant-message"
                  data-text-size={textSize}
                  role={feed && replyIndex ? "article" : undefined}
                  aria-label={
                    feed && replyIndex
                      ? formatText("Message {index} of {total}", {
                          index: replyIndex,
                          total: messageCount,
                        })
                      : undefined
                  }
                  aria-posinset={feed ? replyIndex : undefined}
                  aria-setsize={feed && replyIndex ? messageCount : undefined}
                  tabIndex={feed && replyIndex ? -1 : undefined}
                >
                  {mode === "code" && (
                    <div className="assistant-mark" aria-hidden="true">
                      <Star size={24} />
                    </div>
                  )}
                  <AssistantContent
                    ReplyActions={ReplyActions}
                    TurnChanges={TurnChanges}
                    app={app}
                    approvals={approvals}
                    awaitingApproval={awaitingApproval}
                    background={background}
                    backgroundOpen={backgroundOpen}
                    catalog={catalog}
                    chatPresentation={chatPresentation}
                    compaction={compaction}
                    conversation={conversation}
                    failed={failed}
                    finishedTasks={finishedTasks}
                    latest={latest}
                    mode={mode}
                    onArtifact={onArtifact}
                    onContinue={onContinue}
                    onError={onError}
                    onForkFrom={onForkFrom}
                    onHandOff={onHandOff}
                    onOpenAgent={onOpenAgent}
                    onOpenChanges={onOpenChanges}
                    onOpenPlan={onOpenPlan}
                    onOpenWorkflow={onOpenWorkflow}
                    onReplyFeedback={onReplyFeedback}
                    onRetryResponse={onRetryResponse}
                    onRewind={onRewind}
                    onSelectVersion={onSelectVersion}
                    onToggleBackground={onToggleBackground}
                    onUndoChanges={onUndoChanges}
                    ownTerminals={ownTerminals}
                    replyFeedback={replyFeedback}
                    replyText={replyText}
                    running={running}
                    sending={sending}
                    setEditRequest={setEditRequest}
                    turn={turn}
                    // The title offer is a step of the reply it followed, above
                    // its status line and end mark, not under them at the foot
                    // of the transcript.
                    beforeStatus={
                      mode === "code" &&
                      conversation.titleOffer &&
                      (conversation.titleOffer.turnId
                        ? conversation.titleOffer.turnId === turn.id
                        : latest) ? (
                        <Suspense fallback={null}>
                          <TitleOfferCard
                            key={conversation.titleOffer.at}
                            conversation={conversation}
                            onError={onError}
                          />
                        </Suspense>
                      ) : undefined
                    }
                  />
                </div>
                {conversation.rewind &&
                  conversation.rewind.index === turnIndex + 1 &&
                  onSwapRewind && (
                    <RewindMarker
                      rewind={conversation.rewind}
                      busy={sending || running}
                      onSwap={onSwapRewind}
                    />
                  )}
                {lookupConversation && onOpenConversation && (
                  <ForksHere
                    conversation={conversation}
                    turnId={turn.id}
                    lookup={lookupConversation}
                    onOpen={onOpenConversation}
                  />
                )}
                {lookupConversation && onOpenConversation && (
                  <HandedOffHere
                    conversation={conversation}
                    turnId={turn.id}
                    lookup={lookupConversation}
                    onOpen={onOpenConversation}
                  />
                )}
                {reportsAt(turn.id)}
                {/* The desktop's and web's Chat has no mark under a reply,
                   streaming or done; the phone's keeps its own. */}
                {chatPresentation &&
                  presentation !== "chat" &&
                  latest &&
                  !compaction && (
                    <ReplyMark
                      streaming={
                        turnActivity(turn, awaitingApproval) === "streaming"
                      }
                      done={turn.status === "completed"}
                    />
                  )}
              </div>
            );
          })}
          {mode === "code" &&
            conversation.codeNewTask &&
            onOpenConversation && (
              <Suspense fallback={null}>
                <CodeNewTaskCard
                  conversation={conversation}
                  onStarted={onOpenConversation}
                  onError={onError}
                />
              </Suspense>
            )}
          {mode === "code" && (
            <Suspense fallback={null}>
              <ThinkingSummaries conversation={conversation} />
            </Suspense>
          )}
        </ConversationMessages>
      </div>
      <ScrollToLatest
        shown={away}
        needsInput={awaitingInput}
        round={feed}
        onClick={onJumpToLatest}
      />
    </>
  );
  return conversationTranscriptViewView;
}
