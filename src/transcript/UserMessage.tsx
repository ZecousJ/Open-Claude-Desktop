import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { sentPromptOf } from "./sent-prompt";
import {
  artifactComment,
  requestArtifactThread,
} from "../artifacts/artifact-comment-message";
import { Code, ChevronLeft, ChevronRight } from "../ui/glyphs";
import { MessageAttachments } from "../composer/Attachments";
import { ReplyCopyIcon, ReplyEditIcon, ReplyRetryIcon } from "../ui/ReplyIcons";
import { promptVersions } from "../../shared/branches";
import type { Conversation, Turn } from "../../shared/types";
import { displayPrompt } from "../../shared/pr-display";
import type { SteeredMessageItem } from "../../shared/agent-api";
import { CopyButton } from "../ui/Controls";
import { RelativeTime } from "../ui/RelativeTime";
import { ShowMessageActions } from "./ReplyToolbar";
import { WithTooltip } from "../ui/Tooltip";
import { PromptEdit } from "./PromptEdit";
import { useOverflowClamp } from "../ui/useOverflowClamp";
import { externalUrl, useOpenLink } from "../ui/ExternalLinks";
import { promptSegments } from "./prompt-segments";
import type { MessageTextSize } from "./transcript-text-size";
import { MessageActions, type MessageAction } from "./MessageActions";
import { copyMessageText } from "../ui/Controls";
import { useConversationServices } from "../conversation/ConversationServices";
import { lazyPiece } from "../ui/lazy-piece";
import { t, tf } from "../i18n";
import { waitingForResponse } from "./ReplyBanner";
import { messageSummary } from "./message-summary";

const SentPromptDialog = lazyPiece(
  () => import("./SentPromptDialog"),
  "SentPromptDialog",
);

/** A prompt taller than this is clamped behind a fade with Show more. */
export const userMessageClamp = 300;

/**
 * What saving an edited prompt does, as the original words it for a
 * conversation with versions: the edit becomes a new version of the prompt and
 * its reply.
 */
export const editNote =
  "Making changes creates a new branch in the conversation.";

export function UserMessage({
  conversation,
  turn,
  busy,
  onEdit,
  onRetry,
  onDiscard,
  onSelect,
  editRequest,
  textSize,
  actionPolicy,
}: {
  conversation: Conversation;
  turn: Turn;
  busy: boolean;
  onEdit: (text: string) => Promise<boolean>;
  onRetry: () => void;
  onDiscard?: () => void;
  onSelect: (id: string) => void;
  /** Changes when something else (a stopped reply's Edit prompt) asks to edit this prompt. */
  editRequest?: number;
  /** Settings → Transcript text size's message size (transcript-text-size.ts). */
  textSize?: MessageTextSize;
  /** A different execution kind can borrow the bubble without gaining Chat actions. */
  actionPolicy?: {
    edit: boolean;
    retry: boolean;
    editNote?: string;
    retryLabel?: string;
    versions?: boolean;
  };
}) {
  const canEdit = actionPolicy?.edit ?? true;
  const shownPrompt =
    conversation.mode === "cowork"
      ? `${turn.shell ? "! " : ""}${displayPrompt(turn.prompt)}`
      : turn.prompt;
  const retryLabel = actionPolicy?.retryLabel ?? "Retry";
  const filterPromptActions = (actions: MessageAction[]) =>
    actions.filter((action) =>
      action.id === "edit"
        ? canEdit
        : action.id === "retry"
          ? // A message that failed to send has Retry and Discard once, in its
            // bubble's failed row.
            !failedSend && (actionPolicy?.retry ?? true)
          : action.id === "versions"
            ? (actionPolicy?.versions ?? true)
            : true,
    );
  const [editing, setEditing] = useState(false);
  const [showSentPrompt, setShowSentPrompt] = useState(false);
  const services = useConversationServices();
  const [copyStatus, setCopyStatus] = useState("");
  const copyOperation = useRef(0);
  const copyReset = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      copyOperation.current++;
      clearTimeout(copyReset.current);
    },
    [],
  );
  async function copyPrompt() {
    const operation = ++copyOperation.current;
    clearTimeout(copyReset.current);
    try {
      await copyMessageText(services.copyText, shownPrompt, !comment);
      if (operation !== copyOperation.current) return;
      setCopyStatus(t("Copied"));
    } catch {
      if (operation !== copyOperation.current) return;
      setCopyStatus(t("Copy failed"));
    }
    copyReset.current = setTimeout(() => setCopyStatus(""), 2000);
  }
  const comment = artifactComment(turn.prompt);
  const [draft, setDraft] = useState(turn.prompt);
  const [expanded, setExpanded] = useState(false);
  const { ref: text, clipped } = useOverflowClamp<HTMLDivElement>(
    userMessageClamp,
    [turn.prompt, editing],
  );
  const versions = promptVersions(conversation, turn);
  const current = versions.findIndex((v) => v.turnId === turn.id);
  const requested = useRef(editRequest);
  useEffect(() => {
    if (editRequest === requested.current) return;
    requested.current = editRequest;
    if (!canEdit) return;
    setDraft(turn.prompt);
    setEditing(true);
  }, [editRequest, canEdit, turn.prompt]);
  useEffect(() => {
    if (!canEdit) setEditing(false);
  }, [canEdit]);
  // A collapsed prompt is out of the tab order, and keyboard focus that gets
  // in anyway opens it (the original does the same).
  useLayoutEffect(() => {
    const element = text.current;
    if (!element || !clipped || expanded || editing) return;
    const held = new Map<Element, string | null>();
    for (const item of element.querySelectorAll(
      "a[href], button, [tabindex]",
    )) {
      if (item.getAttribute("tabindex") === "-1") continue;
      held.set(item, item.getAttribute("tabindex"));
      item.setAttribute("tabindex", "-1");
    }
    return () => {
      for (const [item, value] of held)
        if (value === null) item.removeAttribute("tabindex");
        else item.setAttribute("tabindex", value);
    };
  }, [clipped, expanded, editing, turn.prompt]);
  function cancel() {
    setEditing(false);
    setDraft(turn.prompt);
  }
  async function save() {
    if (!canEdit || busy) return;
    if (await onEdit(draft)) setEditing(false);
  }
  const copy = (
    <CopyButton
      text={shownPrompt}
      iconOnly
      glyph={<ReplyCopyIcon />}
      message="prompt"
      rich={!comment}
    />
  );
  const failedSend = turn.status === "failed" && turn.sendFailed;
  const summary = messageSummary(shownPrompt);
  const authors = conversation.sessionAuthors;
  const ownMessage =
    !authors || authors.viewerAccountUuid === authors.ownerAccountUuid;
  // A prompt sent just now pops in; older ones do not.
  const [entering] = useState(() => Date.now() - turn.createdAt < 1500);
  return (
    <>
      {summary && (
        <h2 className="sr-only message-summary" data-find-omitted="">
          {ownMessage ? tf("You said: {prompt}", { prompt: summary }) : summary}
        </h2>
      )}
      <MessageAttachments attachments={turn.attachments ?? []} />
      <div
        className={`user-message${conversation.sessionAuthors?.viewerAccountUuid === conversation.sessionAuthors?.ownerAccountUuid && conversation.sessionAuthors && !editing ? " personal-message" : ""}${editing ? " is-editing" : ""}${comment ? " comment-message" : ""}${entering ? " entering" : ""}`}
        data-text-size={textSize}
        data-cds="UserMessage"
      >
        {editing ? (
          <PromptEdit
            original={turn.prompt}
            draft={draft}
            onDraft={setDraft}
            busy={busy}
            note={actionPolicy?.editNote ?? editNote}
            onSave={() => void save()}
            onCancel={cancel}
          />
        ) : (
          <>
            <div
              ref={text}
              className={`user-message-text${clipped && !expanded ? " is-clamped" : ""}`}
              onFocusCapture={(event) => {
                if (
                  clipped &&
                  !expanded &&
                  (event.target as HTMLElement).matches(":focus-visible")
                )
                  setExpanded(true);
              }}
            >
              {comment ? (
                comment.text
              ) : conversation.mode !== "code" ? (
                <PromptText text={shownPrompt} />
              ) : (
                shownPrompt
              )}
            </div>
            {comment && (
              // A comment sent from an artifact ends with View thread.
              <button
                type="button"
                className="comment-message-thread"
                onClick={() =>
                  requestArtifactThread(conversation.id, comment.name)
                }
              >
                {t("View thread")}
                <ChevronRight size={16} strokeWidth={1.6} />
              </button>
            )}
            {clipped && !expanded && (
              <span className="sr-only">{t("Message collapsed")}</span>
            )}
            {clipped && (
              <button
                className="user-message-more"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? t("Show less") : t("Show more")}
              </button>
            )}
            {failedSend && (
              <div
                className="failed-send-row"
                role="alert"
                title={t("Response couldn’t be sent. You can try again.")}
              >
                <span>{t("Failed to send")}</span>
                <button
                  type="button"
                  data-testid="failed-send-retry"
                  onClick={onRetry}
                  disabled={busy}
                  title={busy ? t(waitingForResponse) : undefined}
                >
                  {t("Retry")}
                </button>
                {onDiscard && (
                  <button
                    type="button"
                    data-testid="failed-send-discard"
                    onClick={onDiscard}
                    disabled={busy}
                    title={busy ? t(waitingForResponse) : undefined}
                  >
                    {t("Discard")}
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {!editing && (
          <div
            className="user-message-actions"
            role="toolbar"
            aria-label={t("User message actions")}
          >
            <ShowMessageActions />
            <MessageActions
              floating
              actions={filterPromptActions([
                {
                  id: "time",
                  content: <RelativeTime createdAt={turn.createdAt} />,
                },
                {
                  id: "retry",
                  kind: "retry",
                  label: retryLabel,
                  disabled: busy,
                  onSelect: onRetry,
                  content: (
                    <WithTooltip
                      label={t(busy ? waitingForResponse : retryLabel)}
                    >
                      {(tooltip) => (
                        <button
                          {...tooltip}
                          className="small-action icon-only"
                          aria-label={t(retryLabel)}
                          disabled={busy}
                          onClick={onRetry}
                        >
                          <ReplyRetryIcon />
                        </button>
                      )}
                    </WithTooltip>
                  ),
                },
                {
                  id: "edit",
                  kind: "edit",
                  disabled: busy,
                  onSelect: () => {
                    setDraft(turn.prompt);
                    setEditing(true);
                  },
                  content: (
                    <WithTooltip label={t("Edit")}>
                      {(tooltip) => (
                        <button
                          {...tooltip}
                          className="small-action icon-only"
                          aria-label={t("Edit")}
                          disabled={busy}
                          onClick={() => {
                            setDraft(turn.prompt);
                            setEditing(true);
                          }}
                        >
                          <ReplyEditIcon />
                        </button>
                      )}
                    </WithTooltip>
                  ),
                },
                {
                  id: "copy",
                  kind: "copy",
                  onSelect: () => void copyPrompt(),
                  content: copy,
                },
                ...(sentPromptOf(turn)
                  ? [
                      {
                        id: "sent-prompt",
                        content: (
                          <button
                            type="button"
                            className="small-action icon-only"
                            aria-label={t("View sent prompt")}
                            title={t("View sent prompt")}
                            onClick={() => setShowSentPrompt(true)}
                          >
                            <Code size={14} aria-hidden="true" />
                          </button>
                        ),
                      },
                    ]
                  : []),
                ...(versions.length > 1
                  ? [
                      {
                        id: "versions",
                        content: (
                          <div
                            className="reply-versions"
                            aria-label={t("Message versions")}
                          >
                            <button
                              className="small-action icon-only"
                              aria-label={t("Previous version")}
                              disabled={busy || current <= 0}
                              onClick={() =>
                                onSelect(versions[current - 1].turnId)
                              }
                            >
                              <ChevronLeft size={12} />
                            </button>
                            <span aria-live="polite">
                              {current + 1} / {versions.length}
                            </span>
                            <button
                              className="small-action icon-only"
                              aria-label={t("Next version")}
                              disabled={busy || current >= versions.length - 1}
                              onClick={() =>
                                onSelect(versions[current + 1].turnId)
                              }
                            >
                              <ChevronRight size={12} />
                            </button>
                          </div>
                        ),
                      },
                    ]
                  : []),
              ])}
            />
            <span className="sr-only" role="status">
              {copyStatus}
            </span>
          </div>
        )}
      </div>
      {showSentPrompt && sentPromptOf(turn) && (
        <Suspense fallback={null}>
          <SentPromptDialog
            prompts={sentPromptOf(turn)!}
            onClose={() => setShowSentPrompt(false)}
          />
        </Suspense>
      )}
    </>
  );
}

/**
 * A prompt as typed: Markdown stays literal, but `code` spans and web addresses
 * are styled, and an address opens like a link in a reply. Chat only: the Code
 * and Cowork captures show no styled prompts.
 */
function PromptText({ text }: { text: string }) {
  const openLink = useOpenLink();
  // An empty line is a paragraph break of 8px, not a whole blank line (bubble
  // line pitch 20px, across the break 28px); single line breaks stay as typed.
  return (
    <>
      {text.split(/\n[ \t]*\n/).map((block, at) => (
        <div className="prompt-paragraph" key={at}>
          {promptSegments(block).map((segment, index) =>
            segment.kind === "code" ? (
              <code key={index}>{segment.text}</code>
            ) : segment.kind === "link" ? (
              <a
                key={index}
                href={segment.text}
                onClick={(event) => {
                  event.preventDefault();
                  const url = externalUrl(segment.text);
                  if (url) openLink(url);
                }}
              >
                {segment.text}
              </a>
            ) : (
              segment.text
            ),
          )}
        </div>
      ))}
    </>
  );
}

/**
 * A message the user sent while the turn was running (`steerTurn`, E0). It
 * sits where the model read it, between the reply's earlier and later parts,
 * and cannot be edited or retried on its own.
 */
export function SteeredMessage({ item }: { item: SteeredMessageItem }) {
  return (
    <>
      <MessageAttachments attachments={item.attachments ?? []} />
      <div className="user-message steered-message">
        <div className="user-message-text">{item.text}</div>
      </div>
    </>
  );
}
