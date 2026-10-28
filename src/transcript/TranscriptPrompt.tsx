import { t } from "../i18n";
import { PromptArticle } from "./ConversationTranscript";
import { UserMessage } from "./UserMessage";
import { coworkEditNote } from "./cowork-prompt-actions";
import { CodeUserMessage } from "./CodeUserMessage";
import type { Conversation, Mode, Turn } from "../../shared/types";
import type { MessageTextSize } from "./transcript-text-size";

/** What TranscriptPrompt needs from ConversationTranscriptView.tsx. */
export interface ConversationTranscriptPart1Props {
  chatPresentation: boolean;
  conversation: Conversation;
  editRequest: { turnId: string; count: number } | undefined;
  feed: boolean;
  messageCount: number;
  mode: Mode;
  onAttachMessage: ((text: string) => void) | undefined;
  onDiscardTurn: ((turnId: string) => void) | undefined;
  onEditPrompt: (turnId: string, text: string) => Promise<boolean>;
  onForkBefore: ((turnId: string) => void) | undefined;
  onRetryResponse: (turnId: string) => void;
  onRewind: ((turnId: string) => void) | undefined;
  onSelectVersion: (turnId: string, versionId: string, prompt: boolean) => void;
  promptActions: { edit: boolean; restart: boolean };
  promptIndex: number | undefined;
  running: boolean;
  sending: boolean;
  textSize: MessageTextSize | undefined;
  turn: Turn;
  turnIndex: number;
}

export function TranscriptPrompt({
  chatPresentation,
  conversation,
  editRequest,
  feed,
  messageCount,
  mode,
  onAttachMessage,
  onDiscardTurn,
  onEditPrompt,
  onForkBefore,
  onRetryResponse,
  onRewind,
  onSelectVersion,
  promptActions,
  promptIndex,
  running,
  sending,
  textSize,
  turn,
  turnIndex,
}: ConversationTranscriptPart1Props) {
  return (
    <PromptArticle index={feed ? promptIndex : undefined} total={messageCount}>
      {chatPresentation || turn.sendFailed ? (
        <UserMessage
          conversation={conversation}
          turn={turn}
          busy={sending || running}
          onEdit={(text) => onEditPrompt(turn.id, text)}
          onRetry={() => void onRetryResponse(turn.id)}
          onDiscard={onDiscardTurn ? () => onDiscardTurn(turn.id) : undefined}
          onSelect={(id) => void onSelectVersion(turn.id, id, true)}
          textSize={textSize}
          editRequest={
            editRequest?.turnId === turn.id ? editRequest.count : undefined
          }
          actionPolicy={
            mode === "cowork"
              ? {
                  edit: promptActions.edit,
                  retry: promptActions.restart,
                  editNote: coworkEditNote,
                  retryLabel: "Restart session from here",
                  versions: false,
                }
              : undefined
          }
        />
      ) : (
        <CodeUserMessage
          turn={turn}
          foldLong={mode === "code"}
          textSize={textSize}
          onRewind={
            mode === "code" && onRewind && !conversation.incognito
              ? () => onRewind(turn.id)
              : undefined
          }
          onFork={
            mode === "code" &&
            onForkBefore &&
            turnIndex > 0 &&
            !conversation.incognito
              ? () => onForkBefore(turn.id)
              : undefined
          }
          onAttachAsContext={
            mode === "code" && onAttachMessage ? onAttachMessage : undefined
          }
          rewindReason={
            sending || running
              ? t("Rewind is unavailable while Claudex is working")
              : undefined
          }
          onEdit={
            promptActions.edit
              ? (text) => onEditPrompt(turn.id, text)
              : undefined
          }
          onRestart={
            promptActions.restart
              ? () => void onRetryResponse(turn.id)
              : undefined
          }
        />
      )}
    </PromptArticle>
  );
}
