import { draftReach, draftHeight, CommentDictation } from "./ArtifactChrome";
import { t, formatText } from "../i18n";
import { isComposingKey } from "../ui/ime";
import { Suspense } from "react";
import { ArrowUp, X, Check } from "../ui/glyphs";
import { FilterSlidersIcon } from "./artifact-icons";
import { ArtifactCommentCard } from "./ArtifactCommentCard";
import {
  toggleResolved,
  editComment,
  deleteThread,
  addReply,
  editReply,
  deleteReply,
} from "./comment-thread";
import type { DictationPhase } from "../composer/voice/DictationButton";
import type { ArtifactComment } from "../../shared/artifact-notes";

/** What ArtifactCommentsPane needs from ArtifactChromeView.tsx. */
export interface ArtifactCommentsPaneProps {
  authorInitial: string;
  authorName: string;
  commentMode: boolean;
  commentPhase: DictationPhase;
  comments: ArtifactComment[];
  commentsList: React.RefObject<HTMLElement | null>;
  draft: { x: number; y: number; left: boolean; lift: number } | undefined;
  draftInput: React.RefObject<HTMLTextAreaElement | null>;
  mention: React.RefObject<HTMLSpanElement | null>;
  mentionWidth: number;
  menu: "comments" | "filter" | "title" | undefined;
  noteKey: string;
  onError: (e: unknown) => void;
  pulse: { id: string; at: number } | undefined;
  save: (next: ArtifactComment[]) => Promise<void>;
  saved: {
    loaded: boolean;
    comments: ArtifactComment[] | undefined;
    canRead: boolean;
    canWrite: boolean;
    readOnly: boolean;
    isCurrent: () => boolean;
    writable: () => boolean;
    save: (comments: ArtifactComment[]) => Promise<void>;
  };
  sendToAgent: boolean;
  sending: boolean;
  setCommentPhase: React.Dispatch<React.SetStateAction<DictationPhase>>;
  setDraft: React.Dispatch<
    React.SetStateAction<
      { x: number; y: number; left: boolean; lift: number } | undefined
    >
  >;
  setMenu: React.Dispatch<
    React.SetStateAction<"comments" | "filter" | "title" | undefined>
  >;
  setPulse: React.Dispatch<
    React.SetStateAction<{ id: string; at: number } | undefined>
  >;
  setSendToAgent: React.Dispatch<React.SetStateAction<boolean>>;
  setShowComments: React.Dispatch<React.SetStateAction<boolean>>;
  setShowResolved: React.Dispatch<React.SetStateAction<boolean>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  showComments: boolean;
  showResolved: boolean;
  submit: (commentText?: string | undefined) => Promise<void>;
  text: string;
  toggleMenu: (
    value: "comments" | "filter" | "title" | undefined,
    button: HTMLButtonElement,
  ) => void;
  visibleComments: ArtifactComment[];
}

export function ArtifactCommentsPane({
  authorInitial,
  authorName,
  commentMode,
  commentPhase,
  comments,
  commentsList,
  draft,
  draftInput,
  mention,
  mentionWidth,
  menu,
  noteKey,
  onError,
  pulse,
  save,
  saved,
  sendToAgent,
  sending,
  setCommentPhase,
  setDraft,
  setMenu,
  setPulse,
  setSendToAgent,
  setShowComments,
  setShowResolved,
  setText,
  showComments,
  showResolved,
  submit,
  text,
  toggleMenu,
  visibleComments,
}: ArtifactCommentsPaneProps) {
  return (
    <div
      className="artifact-comment-layer"
      aria-label={commentMode ? "Comment mode on" : undefined}
    >
      {commentMode && saved.canWrite && (
        <div
          className="artifact-comment-capture"
          onClick={(e) => {
            if (sending) return;
            const b = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - b.left,
              y = e.clientY - b.top;
            setDraft({
              x: x / b.width,
              y: y / b.height,
              // The box opens to the right of its marker unless that
              // leaves the preview; then to the left.
              left: x + draftReach > b.width,
              lift: Math.max(0, y + draftHeight - b.height),
            });
            setText("");
          }}
        />
      )}
      {comments
        .filter((c) => !c.resolved)
        .map((c, i) => (
          <button
            key={c.id}
            className="artifact-comment-pin"
            style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}
            aria-label={`Comment ${i + 1}: ${c.text}`}
            onClick={() => {
              setShowComments(true);
              setPulse({ id: c.id, at: Date.now() });
            }}
          >
            {i + 1}
          </button>
        ))}
      {draft && saved.canWrite && (
        <div
          className="artifact-comment-draft-anchor"
          data-left={draft.left || undefined}
          style={{
            left: `${draft.x * 100}%`,
            top: `${draft.y * 100}%`,
          }}
        >
          <span className="artifact-comment-marker" aria-hidden="true">
            <span>{authorInitial}</span>
          </span>
          <div
            className="artifact-comment-draft"
            style={{ marginTop: -draft.lift }}
          >
            {sendToAgent && (
              <span className="artifact-comment-mention" ref={mention}>
                @Claudex
              </span>
            )}
            <textarea
              ref={draftInput}
              aria-label={sendToAgent ? "Comment for Claudex" : "Add a comment"}
              placeholder={
                commentPhase === "recording" || commentPhase === "requesting"
                  ? t("Listening…")
                  : commentPhase === "finishing"
                    ? t("Finishing dictation…")
                    : sendToAgent
                      ? undefined
                      : "Add a comment…"
              }
              style={{ textIndent: sendToAgent ? mentionWidth : 0 }}
              value={text}
              maxLength={10000}
              disabled={sending}
              readOnly={commentPhase !== "idle"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (commentPhase !== "idle" && e.key === "Enter") {
                  e.preventDefault();
                  return;
                }
                if (e.key === "Escape" && !sending) {
                  // Only the draft goes; comment mode stays (the next Esc leaves it).
                  e.stopPropagation();
                  setDraft(undefined);
                  setText("");
                }
                // Enter sends and Shift+Enter breaks the line, as the
                // original's desktop comment box does; ⌘/Ctrl+Enter sends too.
                if (
                  e.key === "Enter" &&
                  !isComposingKey(e) &&
                  (!e.shiftKey || e.metaKey || e.ctrlKey)
                ) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <div>
              <label>
                <input
                  type="checkbox"
                  checked={sendToAgent}
                  disabled={sending}
                  onChange={(e) => setSendToAgent(e.target.checked)}
                />
                Send to Claudex
              </label>
              <Suspense fallback={null}>
                <CommentDictation
                  text={text}
                  setText={setText}
                  field={draftInput}
                  contextKey={`${noteKey}:${draft.x}:${draft.y}`}
                  onPhase={setCommentPhase}
                  onError={onError}
                  onSubmit={(spoken) => void submit(spoken)}
                />
              </Suspense>
              <button
                aria-label={sendToAgent ? "Send to Claudex" : "Post comment"}
                disabled={!text.trim() || sending || commentPhase !== "idle"}
                onClick={() => void submit()}
              >
                <ArrowUp size={15} />
              </button>
            </div>
          </div>
        </div>
      )}
      {showComments && saved.canRead && (
        <section
          ref={commentsList}
          className="artifact-comments-list"
          aria-label="All comments"
          tabIndex={-1}
        >
          <header>
            <span>All comments</span>
            <button
              aria-label="Filter comments"
              aria-haspopup="menu"
              onClick={(e) => toggleMenu("filter", e.currentTarget)}
            >
              <FilterSlidersIcon size={15} />
            </button>
            <button
              aria-label="Close comments"
              onClick={() => setShowComments(false)}
            >
              <X size={14} />
            </button>
          </header>
          {menu === "filter" && (
            <div
              className="artifact-chrome-menu artifact-filter-menu"
              role="menu"
              aria-label="Filter comments"
            >
              {/* An artifact here is one page, so the page scope is fixed to all
                 pages, as the reference shows it. */}
              <button role="menuitemradio" aria-checked={false} disabled>
                This page
              </button>
              <button
                role="menuitemradio"
                aria-checked
                onClick={() => setMenu(undefined)}
              >
                All pages
                <Check size={14} />
              </button>
              <div role="separator" />
              <button
                role="menuitemcheckbox"
                aria-checked={showResolved}
                onClick={() => {
                  setShowResolved(!showResolved);
                  setMenu(undefined);
                }}
              >
                <span className="artifact-menu-checkbox" aria-hidden="true">
                  {showResolved && <Check size={11} strokeWidth={3} />}
                </span>
                Show resolved
              </button>
            </div>
          )}
          {!saved.loaded ? (
            <p role="status">{t("Loading comments…")}</p>
          ) : !visibleComments.length ? (
            <div className="artifact-comments-empty">
              {comments.length ? (
                // The original's line and, after it, a link that shows the
                // resolved ones.
                <p>
                  {t("No open comments.")}{" "}
                  <button
                    className="artifact-comments-show-resolved"
                    onClick={() => setShowResolved(true)}
                  >
                    {formatText("Show {count} resolved", {
                      count: comments.length,
                    })}
                  </button>
                </p>
              ) : (
                <>
                  <p>{t("No comments yet")}</p>
                  <span>
                    {t(
                      !saved.readOnly
                        ? "Press the comment button, then click anywhere on the artifact to add one."
                        : "Commenting isn’t available with view-only access.",
                    )}
                  </span>
                </>
              )}
            </div>
          ) : (
            visibleComments.map((c) => (
              <ArtifactCommentCard
                // A new jump restarts the ring.
                key={pulse?.id === c.id ? `${c.id}:${pulse.at}` : c.id}
                comment={c}
                readOnly={!saved.canWrite}
                isCurrent={saved.isCurrent}
                authorName={authorName}
                pulse={pulse?.id === c.id}
                onResolve={() => save(toggleResolved(comments, c.id))}
                onEdit={(value) =>
                  save(editComment(comments, c.id, value, Date.now()))
                }
                onDelete={() => save(deleteThread(comments, c.id))}
                onReply={(value) =>
                  save(
                    addReply(comments, c.id, value, {
                      id: crypto.randomUUID(),
                      now: Date.now(),
                    }),
                  )
                }
                onEditReply={(id, value) =>
                  save(editReply(comments, c.id, id, value, Date.now()))
                }
                onDeleteReply={(id) => save(deleteReply(comments, c.id, id))}
                onError={onError}
              />
            ))
          )}
        </section>
      )}
    </div>
  );
}
