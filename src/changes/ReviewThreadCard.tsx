import { useState } from "react";
import type { GitHubReviewThread } from "../../shared/github-api";
import {
  commentSegments,
  commentSummary,
  hasHiddenCharacters,
  reviewedText,
  type CommentSegment,
} from "../../shared/review-threads";
import { api } from "../desktop-api";
import { DiffLines } from "../diff/DiffLines";
import type { DiffLine } from "../diff/diff-model";
import { formatText, t } from "../i18n";
import { addReviewComment, useReviewComments } from "./review-comments";
import { ThreadIcon } from "./review-thread-glyphs";
import "./review-thread.css";

/**
 * A pull request's review thread under its line in the Changes panel: the
 * author, "Line N", the Resolved badge, Previous / Next comment, Open on GitHub
 * and (resolved) Collapse; the comment with its suggested changes (Apply), the
 * replies; then Reply, Resolve and Send to Claude, and the reply box ("Reply on
 * GitHub…", Send reply). A resolved thread starts folded to one row.
 */

type Busy = "reply" | "resolve" | "apply" | null;

const lineLabel = (thread: GitHubReviewThread) => {
  const end = thread.line ?? 0;
  const start = thread.startLine ?? end;
  return start === end
    ? formatText("Line {line}", { line: end })
    : formatText("Lines {start}–{end}", { start, end });
};

function Author({
  login,
  avatarUrl,
  url,
}: {
  login: string;
  avatarUrl?: string;
  url: string;
}) {
  if (!login) return null;
  return (
    <a
      className="review-thread-author"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {avatarUrl && <img src={avatarUrl} alt="" width={16} height={16} />}
      <span>{login}</span>
    </a>
  );
}

function Suggestion({
  code,
  original,
  applied,
  busy,
  onApply,
}: {
  code: string;
  original?: string;
  applied: boolean;
  busy: Busy;
  onApply?: () => void;
}) {
  const hidden = hasHiddenCharacters(code);
  const lines: DiffLine[] = [
    ...(original !== undefined
      ? original.split("\n").map((text) => ({ kind: "del" as const, text }))
      : []),
    ...code.split("\n").map((text) => ({ kind: "add" as const, text })),
  ];
  return (
    <div className="review-suggestion diff-lines">
      <div className="review-suggestion-head">
        <ThreadIcon name="GitDiff" />
        <span>{t("Suggested change")}</span>
        {applied ? (
          <span className="review-suggestion-end">{t("Applied")}</span>
        ) : onApply && hidden ? (
          <span className="review-suggestion-end">
            {t("Contains hidden or look-alike characters")}
          </span>
        ) : (
          onApply &&
          original !== undefined && (
            <button
              type="button"
              className="review-thread-ghost review-suggestion-end"
              aria-busy={busy === "apply" || undefined}
              disabled={busy !== null}
              onClick={onApply}
            >
              {busy === "apply" ? t("Applying…") : t("Apply")}
            </button>
          )
        )}
      </div>
      {!applied && <DiffLines lines={lines} words={false} />}
    </div>
  );
}

function Segments({
  segments,
  render,
}: {
  segments: CommentSegment[];
  render: (code: string, index: number) => React.ReactNode;
}) {
  return (
    <div className="review-thread-segments">
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <p key={index} className="review-thread-text">
            {segment.text}
          </p>
        ) : (
          <div key={index}>{render(segment.code, index)}</div>
        ),
      )}
    </div>
  );
}

export function ReviewThreadCard({
  thread,
  conversationId,
  canApply,
  onChanged,
  onPrevious,
  onNext,
  onReply,
  onResolve,
}: {
  thread: GitHubReviewThread;
  conversationId?: string;
  /** Suggestions can be written to the file here (a local session). */
  canApply: boolean;
  onChanged: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onReply?: (body: string) => Promise<unknown>;
  onResolve?: () => Promise<unknown>;
}) {
  const [expanded, setExpanded] = useState(!thread.resolved);
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string>();
  const [applied, setApplied] = useState<string[]>([]);
  const queued = useReviewComments(conversationId);
  const [first, ...replies] = thread.comments;
  const segments = commentSegments(first.body);
  const end = thread.line ?? 0;
  const start = thread.startLine ?? end;
  const original = reviewedText(first.diffHunk, end - start + 1);
  const sendText = `${first.author}: ${first.body}`;
  const isQueued = queued.some(
    (comment) => comment.file === thread.path && comment.text === sendText,
  );

  const run = async (
    kind: Busy,
    work: () => Promise<void>,
    failure: string,
  ) => {
    setBusy(kind);
    setError(undefined);
    try {
      await work();
    } catch {
      setError(t(failure));
    } finally {
      setBusy(null);
    }
  };
  const apply = (code: string) =>
    void run(
      "apply",
      async () => {
        if (!conversationId || original === undefined) return;
        const result = await api.applyReviewSuggestion(conversationId, {
          path: thread.path,
          startLine: start,
          endLine: end,
          original,
          suggestion: code,
        });
        if (result.ok) {
          setApplied((list) => [...list, code]);
          return;
        }
        setError(
          t(
            result.reason === "changed"
              ? "These lines changed after the review. Send the comment to Claudex instead."
              : result.reason === "denied"
                ? "This session cannot write to that file. Send the comment to Claudex instead."
                : result.reason === "hidden"
                  ? "This suggestion contains hidden or look-alike characters and was not applied."
                  : "A newer commit moved this comment. You can apply it at its new place or send the comment to Claudex instead.",
          ),
        );
      },
      "Could not apply the suggestion. Try again.",
    );
  const suggestion = (code: string) => (
    <Suggestion
      code={code}
      original={original}
      applied={applied.includes(code)}
      busy={busy}
      onApply={canApply && conversationId ? () => apply(code) : undefined}
    />
  );

  if (!expanded) {
    const summary = commentSummary(segments);
    return (
      <div className="review-thread-wrap">
        <button
          type="button"
          className="review-thread review-thread-folded"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          <ThreadIcon name="CaretRight" />
          <Author
            login={first.author}
            avatarUrl={first.avatarUrl}
            url={first.url}
          />
          <span className="review-thread-line">{lineLabel(thread)}</span>
          {summary && (
            <span className="review-thread-summary">
              {summary === "Suggested change" ? t(summary) : summary}
            </span>
          )}
          {thread.resolved && (
            <span className="review-thread-badge">{t("Resolved")}</span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="review-thread-wrap">
      <div className="review-thread">
        <div className="review-thread-head">
          <Author
            login={first.author}
            avatarUrl={first.avatarUrl}
            url={first.url}
          />
          <span className="review-thread-line">{lineLabel(thread)}</span>
          <div className="review-thread-tools">
            {thread.resolved && (
              <span className="review-thread-badge">{t("Resolved")}</span>
            )}
            {!thread.resolved && onPrevious && (
              <button
                type="button"
                className="review-thread-icon"
                aria-label={t("Previous comment")}
                onClick={onPrevious}
              >
                <ThreadIcon name="ArrowUp" />
              </button>
            )}
            {!thread.resolved && onNext && (
              <button
                type="button"
                className="review-thread-icon"
                aria-label={t("Next comment")}
                onClick={onNext}
              >
                <ThreadIcon name="ArrowDown" />
              </button>
            )}
            <button
              type="button"
              className="review-thread-icon"
              aria-label={t("Open on GitHub")}
              onClick={() => void api.openExternal(first.url)}
            >
              <ThreadIcon name="ArrowOutSquare" />
            </button>
            {thread.resolved && (
              <button
                type="button"
                className="review-thread-icon"
                aria-label={t("Collapse")}
                aria-expanded
                disabled={busy !== null}
                onClick={() => {
                  setExpanded(false);
                  setReplying(false);
                  setError(undefined);
                }}
              >
                <ThreadIcon name="CaretUp" />
              </button>
            )}
          </div>
        </div>
        <Segments segments={segments} render={suggestion} />
        {replies.map((reply) => (
          <div key={reply.id} className="review-thread-reply">
            <div className="review-thread-head">
              <Author
                login={reply.author}
                avatarUrl={reply.avatarUrl}
                url={reply.url}
              />
            </div>
            <Segments
              segments={commentSegments(reply.body)}
              render={suggestion}
            />
          </div>
        ))}
        <div className="review-thread-foot">
          <div className="review-thread-actions-row">
            {error && !replying && (
              <span className="review-thread-error">{error}</span>
            )}
            <div className="review-thread-actions">
              {thread.viewerCanReply && !replying && (
                <button
                  type="button"
                  className="review-thread-ghost"
                  disabled={busy !== null}
                  aria-expanded={false}
                  onClick={() => {
                    setReplying(true);
                    setError(undefined);
                  }}
                >
                  <ThreadIcon name="Chat" />
                  {t("Reply")}
                </button>
              )}
              {!thread.resolved && thread.viewerCanResolve && (
                <button
                  type="button"
                  className="review-thread-ghost"
                  aria-busy={busy === "resolve" || undefined}
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      "resolve",
                      async () => {
                        if (onResolve) await onResolve();
                        else
                          await api.githubResolveReviewThread({
                            threadId: thread.id,
                          });
                        onChanged();
                      },
                      "Couldn’t resolve this thread. Try again.",
                    )
                  }
                >
                  <ThreadIcon name="Check" />
                  {busy === "resolve" ? t("Resolving…") : t("Resolve")}
                </button>
              )}
              {conversationId && (
                <button
                  type="button"
                  className="secondary review-thread-send"
                  aria-pressed={isQueued}
                  disabled={isQueued}
                  onClick={() =>
                    addReviewComment(conversationId, {
                      file: thread.path,
                      startLine: start,
                      endLine: end,
                      code: original ?? "",
                      text: sendText,
                    })
                  }
                >
                  <ThreadIcon name={isQueued ? "Check" : "ArrowUp"} />
                  {isQueued ? t("Queued") : t("Send to Claudex")}
                </button>
              )}
            </div>
          </div>
          {replying && (
            <div className="review-thread-replybox">
              <textarea
                autoFocus
                rows={3}
                value={replyText}
                readOnly={busy !== null}
                placeholder={t("Reply on GitHub…")}
                aria-label={t("Reply on GitHub")}
                onChange={(event) => setReplyText(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Escape" &&
                    !event.nativeEvent.isComposing &&
                    busy === null
                  ) {
                    event.stopPropagation();
                    setReplying(false);
                  }
                }}
              />
              <div className="review-thread-actions-row">
                {error && <span className="review-thread-error">{error}</span>}
                <div className="review-thread-actions">
                  <button
                    type="button"
                    className="review-thread-ghost"
                    disabled={busy !== null}
                    onClick={() => setReplying(false)}
                  >
                    {t("Cancel")}
                  </button>
                  <button
                    type="button"
                    className="primary review-thread-primary"
                    aria-busy={busy === "reply" || undefined}
                    disabled={busy !== null || !replyText.trim()}
                    onClick={() =>
                      void run(
                        "reply",
                        async () => {
                          if (onReply) await onReply(replyText.trim());
                          else
                            await api.githubReplyReviewThread({
                              threadId: thread.id,
                              body: replyText.trim(),
                            });
                          setReplyText("");
                          setReplying(false);
                          onChanged();
                        },
                        "Couldn’t send the reply. Try again.",
                      )
                    }
                  >
                    {busy === "reply" ? t("Sending…") : t("Send reply")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
