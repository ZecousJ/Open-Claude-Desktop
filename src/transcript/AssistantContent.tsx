import { Suspense } from "react";
import {
  SessionSetupSteps,
  backgroundTaskCount,
} from "./ConversationTranscript";
import { AgentItems } from "./agents/AgentItems";
import { AskingRows } from "../code-tools/AskingRows";
import { CodeTurnChanges } from "../code-tools/CodeFileChange";
import { ChatTurnContent } from "./ChatTurnContent";
import { TurnOutcome } from "./TurnOutcome";
import { catalogDefaultEffort } from "../composer/model/code-model-choices";
import { CodeTurnStatus } from "./CodeTurnStatus";
import {
  CodeReplyToolbar,
  ReplyToolbar,
  ShowMessageActions,
} from "./ReplyToolbar";
import { openSpinOff, spinOffCapacityMessage } from "../cowork/spin-off-store";
import { CopyButton } from "../ui/Controls";
import { ReplyCopyIcon } from "../ui/ReplyIcons";
import { ReplyVersions } from "./ReplyVersions";
import { RelativeTime } from "../ui/RelativeTime";
import type {
  Turn,
  Approval,
  Conversation,
  Mode,
  BackgroundTerminalInfo,
} from "../../shared/types";
import type { AppController } from "../app/AppContext";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import type { SettledTasks } from "./CodeTurnStatus";
import type { Artifact } from "../ui/ArtifactTypes";
import type { AgentTarget } from "./agents/AgentItems";

/** What AssistantContent needs from ConversationTranscriptView.tsx. */
export interface AssistantContentProps {
  ReplyActions: React.ComponentType<{ turn: Turn }> | undefined;
  TurnChanges:
    React.ComponentType<{ turn: Turn; onOpen: () => void }> | undefined;
  app: AppController | undefined;
  approvals: Approval[];
  awaitingApproval: boolean;
  background: Set<string>;
  backgroundOpen: boolean;
  catalog: ModelCatalog | null;
  chatPresentation: boolean;
  compaction: boolean;
  conversation: Conversation;
  failed: Map<string, number> | undefined;
  finishedTasks: number | SettledTasks;
  latest: boolean;
  mode: Mode;
  onArtifact: (artifact: Artifact) => void;
  onContinue: () => void;
  onError: (error: unknown) => void;
  onForkFrom: ((turnId: string) => void) | undefined;
  onHandOff: (() => void) | undefined;
  onOpenAgent: ((target: AgentTarget) => void) | undefined;
  onOpenChanges: ((path?: string) => void) | undefined;
  onOpenPlan: (() => void) | undefined;
  onOpenWorkflow: () => void;
  onReplyFeedback: (
    turnId: string,
    rating: "up" | "down" | null,
  ) => Promise<void>;
  onRetryResponse: (turnId: string) => void;
  onRewind: ((turnId: string) => void) | undefined;
  onSelectVersion: (turnId: string, versionId: string, prompt: boolean) => void;
  onToggleBackground: (() => void) | undefined;
  onUndoChanges: ((prompt: string) => void) | undefined;
  ownTerminals: BackgroundTerminalInfo[];
  replyFeedback: Record<string, "up" | "down">;
  replyText: string;
  running: boolean;
  sending: boolean;
  setEditRequest: React.Dispatch<
    React.SetStateAction<{ turnId: string; count: number } | undefined>
  >;
  turn: Turn;
  /**
   * A step row that belongs to this reply but follows its content (the
   * session's title offer): drawn before the status line and its end mark.
   */
  beforeStatus?: React.ReactNode;
}

export function AssistantContent({
  beforeStatus,
  ReplyActions,
  TurnChanges,
  app,
  approvals,
  awaitingApproval,
  background,
  backgroundOpen,
  catalog,
  chatPresentation,
  compaction,
  conversation,
  failed,
  finishedTasks,
  latest,
  mode,
  onArtifact,
  onContinue,
  onError,
  onForkFrom,
  onHandOff,
  onOpenAgent,
  onOpenChanges,
  onOpenPlan,
  onOpenWorkflow,
  onReplyFeedback,
  onRetryResponse,
  onRewind,
  onSelectVersion,
  onToggleBackground,
  onUndoChanges,
  ownTerminals,
  replyFeedback,
  replyText,
  running,
  sending,
  setEditRequest,
  turn,
}: AssistantContentProps) {
  return (
    <div className="assistant-content">
      {mode === "code" ? (
        <>
          {turn.setup && (
            <Suspense fallback={null}>
              <SessionSetupSteps turn={turn} />
            </Suspense>
          )}
          <AgentItems
            conversation={conversation}
            turn={turn}
            mode={mode}
            onArtifact={onArtifact}
            onOpenWorkflow={onOpenWorkflow}
            onOpenAgent={onOpenAgent}
            background={background}
            onOpenPlan={onOpenPlan}
          />
          {latest && (
            <AskingRows
              conversationId={conversation.id}
              approvals={approvals}
            />
          )}
          {onOpenChanges && TurnChanges && (
            <TurnChanges turn={turn} onOpen={onOpenChanges} />
          )}
          {onOpenChanges && !TurnChanges && (
            <CodeTurnChanges
              turn={turn}
              onOpen={onOpenChanges}
              onUndo={
                latest && !sending && !running ? onUndoChanges : undefined
              }
            />
          )}
        </>
      ) : (
        <ChatTurnContent
          conversation={conversation}
          turn={turn}
          onOpenWorkflow={onOpenWorkflow}
          onOpenAgent={onOpenAgent}
          awaitingApproval={awaitingApproval}
          onArtifact={onArtifact}
          variant={mode === "cowork" ? "cowork" : "chat"}
          presentation={chatPresentation ? "chat" : undefined}
        />
      )}
      <TurnOutcome
        turn={turn}
        effort={
          conversation.effort ??
          (mode === "code"
            ? app?.snapshot.settings.codeEffort
            : app?.snapshot.settings.effort)
        }
        effortRecommended={
          catalogDefaultEffort(catalog, conversation.model) === "max"
        }
        canRewind={Boolean(onRewind && !conversation.incognito)}
        mode={mode}
        latest={latest}
        busy={sending || running}
        onRetry={() => void onRetryResponse(turn.id)}
        onContinue={onContinue}
        onHandOff={onHandOff}
        onNewChat={
          mode === "chat" && app ? () => app.newChat("chat") : undefined
        }
        failedRun={failed?.get(turn.id)}
        onEditPrompt={() =>
          setEditRequest((request) => ({
            turnId: turn.id,
            count: (request?.count ?? 0) + 1,
          }))
        }
      />
      {beforeStatus}
      {mode === "code" && (
        <CodeTurnStatus
          turn={turn}
          latest={latest}
          awaitingApproval={awaitingApproval}
          runningTasks={
            turn.status === "inProgress"
              ? backgroundTaskCount(turn, conversation, background)
              : 0
          }
          backgroundTasks={latest ? ownTerminals.length : 0}
          finishedTasks={latest ? finishedTasks : 0}
          backgroundOpen={backgroundOpen}
          onOpenBackground={onToggleBackground ?? onOpenWorkflow}
        />
      )}
      {/* Code ends with its still star, not a toolbar; earlier replies keep
         their toolbar. */}
      {mode === "code" &&
        !latest &&
        !compaction &&
        turn.status === "completed" &&
        (ReplyActions ? (
          <ReplyActions turn={turn} />
        ) : (
          <CodeReplyToolbar
            turn={turn}
            onFork={
              onForkFrom && !conversation.incognito
                ? () => onForkFrom(turn.id)
                : undefined
            }
          />
        ))}
      {mode !== "code" &&
        !compaction &&
        (turn.status === "completed" ||
          (mode === "chat" && turn.status !== "inProgress")) &&
        (turn.status === "completed" ? (
          <ReplyToolbar
            conversation={conversation}
            turn={turn}
            busy={sending || running}
            // Cowork is merged into Chat: a unified Chat reply has Chat's
            // Retry.
            versions={
              mode === "chat" || (mode === "cowork" && chatPresentation)
            }
            contextualActions={chatPresentation}
            rating={replyFeedback[JSON.stringify([conversation.id, turn.id])]}
            onRating={(rating) => onReplyFeedback(turn.id, rating)}
            onRetry={() => void onRetryResponse(turn.id)}
            onSelect={(version) =>
              void onSelectVersion(turn.id, version, false)
            }
            onError={onError}
            onSpinOff={
              mode === "cowork" && !chatPresentation && !conversation.incognito
                ? () => {
                    if (openSpinOff(conversation.id, turn.id) === null)
                      onError(new Error(spinOffCapacityMessage));
                  }
                : undefined
            }
          />
        ) : (
          <div
            className="message-actions"
            role="toolbar"
            aria-label="Message actions"
          >
            <ShowMessageActions />
            {/* Copy only when a reply was written before the stop or error. */}
            {replyText && (
              <CopyButton
                iconOnly
                text={replyText}
                glyph={<ReplyCopyIcon />}
                message="reply"
              />
            )}
            <ReplyVersions
              conversation={conversation}
              turn={turn}
              busy={sending || running}
              onRetry={() => void onRetryResponse(turn.id)}
              onSelect={(version) =>
                void onSelectVersion(turn.id, version, false)
              }
            />
            <RelativeTime createdAt={turn.createdAt} />
          </div>
        ))}
    </div>
  );
}
