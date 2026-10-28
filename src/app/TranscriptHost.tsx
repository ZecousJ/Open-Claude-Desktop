import { openChangedFile } from "../changes/diff-file-request";
import { api } from "../desktop-api";
import { Suspense, useRef, useState } from "react";
import type { Conversation } from "../../shared/types";
import type { ReplyRating } from "../../shared/diagnostics-api";
import { feedbackDialogWanted } from "../reply-feedback/feedback-wanted";
import "../reply-feedback/reply-feedback.css";
import { useApp, type AppController } from "./AppContext";
import { openArtifact } from "./ArtifactHost";
import { openAgentTranscript } from "./agent-transcript";
import { continueResponse, sendSpoken } from "./composer-send";
import { forkConversation } from "./fork";
import { handOffConversation } from "./handOff";
import {
  attachTerminalSelection,
  messageExcerptLabel,
} from "../composer/terminal-excerpt";
import {
  confirmRewind,
  forkBeforeMessage,
  rewindConversation,
  swapRewind,
} from "./rewind";
import { askRewind, useRewindAsk } from "./rewind-ask";
import { CodeRunContext, requestTerminalTab } from "../code-run/run-store";
import { surface } from "../../shared/host";
import { workflowsIn } from "../../shared/workflow-model";
import { ResponseStatusAnnouncer } from "../conversation/ResponseStatusAnnouncer";
import { lazyPiece } from "../ui/lazy-piece";

const RewindDialog = lazyPiece(() => import("./RewindDialog"));
const ConversationTranscript = lazyPiece(
  () => import("../transcript/ConversationTranscript"),
  "ConversationTranscript",
);
import { TranscriptViewContext } from "../transcript-view/transcript-view-store";
import { useTranscriptViewActions } from "../transcript-view/useTranscriptViewActions";
import { useCodeSessionKeys } from "../code-keys/useCodeSessionKeys";
import { isMacPlatform } from "../host/keys";
import {
  trustDeclined,
  withWorkspaceTrust,
} from "../workspace-trust/trust-request";

// The feedback dialog loads when a rating first asks for it.
const ReplyFeedbackDialog = lazyPiece(
  () => import("../reply-feedback/ReplyFeedbackDialog"),
  "ReplyFeedbackDialog",
);

/** A rated reply whose feedback dialog is open. */
interface FeedbackPrompt {
  conversationId: string;
  turnId: string;
  rating: ReplyRating;
  allowConversationExcerpt: boolean;
}

/** The open conversation's transcript. */
export function TranscriptHost({ active }: { active: Conversation }) {
  const app = useApp();
  const { snapshot, transcriptScroll, setPanel, setArtifact } = app;
  const [feedback, setFeedback] = useState<FeedbackPrompt>();
  const lastTurn = active.turns.at(-1);
  // Code's transcript view (Normal, Thinking, Verbose) and its own keys:
  // Ctrl+O cycles the view, ⌥⌘↑ / ⌥⌘↓ jump between prompts.
  const code = app.mode === "code";
  const openId = useRef(app.activeId);
  openId.current = app.activeId;
  const transcriptView = useTranscriptViewActions(active);
  const rewindAsk = useRewindAsk();
  useCodeSessionKeys({
    enabled: code,
    mac: isMacPlatform(snapshot.platform),
    conversation: active,
    scrollRef: app.scroll,
    composer: app.composer,
    onCycleView: transcriptView.cycle,
  });
  // Run in terminal on shell code blocks: a Code session on this computer.
  const runHost =
    code &&
    surface !== "web" &&
    (!active.environment || active.environment.kind === "local")
      ? {
          conversationId: active.id,
          windows: snapshot.platform === "win32",
          openTerminal: (sessionId: string) => {
            requestTerminalTab(active.id, sessionId);
            app.setPanel("terminal");
          },
        }
      : null;
  return (
    <CodeRunContext.Provider value={runHost}>
      <TranscriptViewContext.Provider
        value={code ? transcriptView.view : "normal"}
      >
        <ResponseStatusAnnouncer
          conversationId={active.id}
          streaming={lastTurn?.status === "inProgress"}
          userStopped={lastTurn?.status === "interrupted"}
        />
        <Suspense
          fallback={<div className="messages-scroll" aria-hidden="true" />}
        >
          <ConversationTranscript
            conversation={active}
            mode={active.mode}
            presentation={app.mode === "code" ? undefined : "chat"}
            sending={app.sending}
            running={app.running}
            approvals={snapshot.approvals}
            replyFeedback={snapshot.replyFeedback}
            onReplyFeedback={async (turnId, rating) => {
              const prompt = await setReplyFeedback(
                app,
                active.id,
                turnId,
                rating,
              );
              if (prompt) setFeedback(prompt);
            }}
            onArtifact={(value) => openArtifact(app, value)}
            onOpenWorkflow={() => {
              setPanel("background");
              setArtifact(undefined);
            }}
            onOpenAgent={(target) => openAgentTranscript(app, target)}
            onEditPrompt={(turnId, text) => editPrompt(app, turnId, text)}
            onRetryResponse={(turnId) => retryResponse(app, turnId)}
            onDiscardTurn={(turnId) => void discardTurn(app, turnId)}
            onContinue={() => void continueResponse(app)}
            onSelectVersion={(turnId, versionId, prompt) =>
              void selectReplyVersion(app, turnId, versionId, prompt)
            }
            onError={app.report}
            backgroundTerminals={app.activeTerminals}
            finishedTasks={(() => {
              const settled = workflowsIn([active]).filter(
                (task) =>
                  task.status !== "running" &&
                  !snapshot.dismissedBackgroundTasks?.includes(task.id),
              );
              const count = (status: string) =>
                settled.filter((task) => task.status === status).length;
              return {
                completed: count("completed"),
                failed: count("failed"),
                stopped: count("stopped"),
              };
            })()}
            backgroundOpen={app.toolPanels.isOpen("background")}
            onToggleBackground={() => {
              if (app.toolPanels.isOpen("background"))
                app.toolPanels.close("background");
              else {
                setPanel("background");
                setArtifact(undefined);
              }
            }}
            onOpenChanges={(path) => {
              // One file opens where the original opens it (its diff in a
              // repository, else the file); the whole turn, the Changes.
              if (path)
                return openChangedFile(active, path, {
                  setPanel,
                  setArtifact,
                });
              setPanel("changes");
              setArtifact(undefined);
            }}
            // Undo on a turn's changes asks Claude in a new message, sent at
            // once like a spoken one.
            onUndoChanges={
              active.mode === "code"
                ? (prompt) => void sendSpoken(app, prompt)
                : undefined
            }
            onOpenPlan={() => {
              setPanel("plan");
              setArtifact(undefined);
            }}
            scrollRef={app.scroll}
            onScroll={transcriptScroll.onScroll}
            onWheel={transcriptScroll.onWheel}
            away={transcriptScroll.away}
            onJumpToLatest={transcriptScroll.jumpToLatest}
            onForkFrom={(turnId) => void forkConversation(app, { turnId })}
            onHandOff={
              active.mode === "code" && !active.incognito
                ? () => void handOffConversation(app)
                : undefined
            }
            lookupConversation={(id) =>
              snapshot.conversations.find((c) => c.id === id)
            }
            onOpenConversation={app.openConversation}
            onRewind={(turnId) => void rewindConversation(app, turnId)}
            onForkBefore={(turnId) => void forkBeforeMessage(app, turnId)}
            onSwapRewind={() => void swapRewind(app)}
            onAttachMessage={(text) =>
              void attachTerminalSelection(
                {
                  mode: active.mode,
                  attachments: app.attachments,
                  setAttachments: app.setAttachments,
                  notify: app.notify,
                  stillOpen: () => openId.current === active.id,
                  focus: () =>
                    requestAnimationFrame(() => app.composer.current?.focus()),
                },
                text,
                messageExcerptLabel(text),
              ).catch(app.report)
            }
          />
        </Suspense>
        {rewindAsk && rewindAsk.conversationId === active.id && (
          <Suspense fallback={null}>
            <RewindDialog
              conversation={active}
              turnId={rewindAsk.turnId}
              text={rewindAsk.text}
              onClose={() => askRewind(null)}
              onConfirm={(scope) =>
                confirmRewind(app, rewindAsk.turnId, scope).finally(() =>
                  askRewind(null),
                )
              }
            />
          </Suspense>
        )}
        {feedback && (
          <Suspense fallback={null}>
            <ReplyFeedbackDialog
              key={`${feedback.conversationId}:${feedback.turnId}:${feedback.rating}`}
              {...feedback}
              conversation={
                active.id === feedback.conversationId ? active : undefined
              }
              memoryAvailable={app.policy.memory?.enabled === true}
              webSearchAvailable={app.policy.webSearch}
              submit={(report) => api.submitReplyFeedback(report)}
              onDone={(message) => {
                setFeedback(undefined);
                app.notify(message);
              }}
              onClose={() => setFeedback(undefined)}
            />
          </Suspense>
        )}
      </TranscriptViewContext.Provider>
    </CodeRunContext.Provider>
  );
}

export async function retryResponse(app: AppController, turnId: string) {
  const { active } = app;
  if (!active || app.sending || app.running) return;
  app.setSending(true);
  app.setError("");
  app.follow.current = true;
  try {
    // A Code workspace no longer trusted asks first, then retries.
    const result = await withWorkspaceTrust(
      () => api.retryResponse(active.id, turnId, app.providerId, app.model),
      active,
      { api, notify: app.notify },
    );
    if (result !== trustDeclined) app.upsert(result);
  } catch (e) {
    app.report(e);
  } finally {
    app.setSending(false);
  }
}

async function discardTurn(app: AppController, turnId: string) {
  const { active } = app;
  if (!active || app.sending || app.running) return;
  try {
    app.upsert(await api.discardTurn(active.id, turnId));
  } catch (error) {
    app.report(error);
  }
}

async function editPrompt(app: AppController, turnId: string, text: string) {
  const { active } = app;
  if (!active || app.sending || app.running) return false;
  app.setSending(true);
  app.setError("");
  try {
    // A Code workspace no longer trusted asks first, then saves the edit.
    const result = await withWorkspaceTrust(
      () => api.editPrompt(active.id, turnId, text, app.providerId, app.model),
      active,
      { api, notify: app.notify },
    );
    if (result === trustDeclined) return false;
    app.upsert(result);
    return true;
  } catch (e) {
    app.report(e);
    return false;
  } finally {
    app.setSending(false);
  }
}

async function selectReplyVersion(
  app: AppController,
  turnId: string,
  versionTurnId: string,
  prompt = false,
) {
  const { active } = app;
  if (!active || app.sending || app.running) return;
  app.setSending(true);
  app.setError("");
  try {
    const selected = await (
      prompt ? api.selectPromptVersion : api.selectReplyVersion
    )(active.id, turnId, versionTurnId);
    app.upsert(selected);
    app.setProviderId(selected.providerId);
    app.setModel(selected.model);
  } catch (e) {
    app.report(e);
  } finally {
    app.setSending(false);
  }
}

/**
 * Stores the rating on this computer, then offers the feedback dialog when
 * the service collects feedback and the person agreed (C7); otherwise the
 * rating is all there is. Resolves with the dialog to open, if any.
 */
async function setReplyFeedback(
  app: AppController,
  conversationId: string,
  turnId: string,
  rating: ReplyRating | null,
): Promise<FeedbackPrompt | undefined> {
  const replyFeedback = await api.setReplyFeedback(
    conversationId,
    turnId,
    rating,
  );
  app.setSnapshot((current) =>
    current ? { ...current, replyFeedback } : current,
  );
  if (!rating || !api.reportingStatus) return undefined;
  const status = await Promise.resolve(api.reportingStatus()).catch(() => null);
  if (!status || !feedbackDialogWanted(status)) return undefined;
  return {
    conversationId,
    turnId,
    rating,
    allowConversationExcerpt: status.allowConversationExcerpt,
  };
}
