import {
  Suspense,
  useRef,
  useState,
  useLayoutEffect,
  useMemo,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Ellipsis } from "../ui/glyphs";
import {
  artifactNoteLimits,
  type ArtifactComment,
  type ArtifactReply,
} from "../../shared/artifact-notes";
import { RelativeTime } from "../ui/RelativeTime";
import { ConfirmationDialog } from "../dialogs/ConfirmationDialog";
import { isComposingKey } from "../ui/ime";
import { Menu, type MenuPosition } from "../ui/Menu";
import { t } from "../i18n";
import { threadText } from "./comment-thread";
import { lazyPiece } from "../ui/lazy-piece";
import type { DictationPhase } from "../composer/voice/DictationButton";

const CommentDictation = lazyPiece(
  () => import("../voice/CommentDictation"),
  "CommentDictation",
);

/*
 * One comment of the All comments list as a thread, after the original's
 * comment cards: the first comment with Resolve/Reopen and a Comment options
 * menu (Edit, Delete thread), its replies each with a Reply actions menu (Edit,
 * Delete), an "edited" mark where the text was changed, and a reply field
 * underneath. Enter sends and Shift+Enter breaks the line; replying to a
 * resolved thread reopens it. Deleting asks first, in the original's words.
 */

/** Enter without Shift sends; a key that only confirms an IME composition does not. */
function sendsOnEnter(event: KeyboardEvent) {
  return event.key === "Enter" && !event.shiftKey && !isComposingKey(event);
}

/** Dialogs go to the page itself: the list around the card clips and animates its children. */
const portal = (node: ReactNode) =>
  typeof document === "undefined" ? node : createPortal(node, document.body);

type Target = { reply?: string };
type OpenMenu = Target & { position: MenuPosition };

export function ArtifactCommentCard({
  comment,
  authorName,
  pulse,
  readOnly = false,
  isCurrent,
  onResolve,
  onEdit,
  onDelete,
  onReply,
  onEditReply,
  onDeleteReply,
  onError,
}: {
  comment: ArtifactComment;
  authorName: string;
  /** A pin jumped here: the card rings once (the list's own motion). */
  pulse: boolean;
  readOnly?: boolean;
  isCurrent?: () => boolean;
  onResolve: () => Promise<void>;
  onEdit: (text: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onReply: (text: string) => Promise<void>;
  onEditReply: (id: string, text: string) => Promise<void>;
  onDeleteReply: (id: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const mounted = useRef(false);
  const lease = useMemo(() => ({ readOnly, isCurrent }), [readOnly, isCurrent]);
  const authority = useRef(lease);
  authority.current = lease;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () =>
    mounted.current &&
    authority.current === lease &&
    !lease.readOnly &&
    (lease.isCurrent?.() ?? true);
  const [menu, setMenu] = useState<OpenMenu>();
  const [editing, setEditing] = useState<Target & { text: string }>();
  const [confirming, setConfirming] = useState<Target>();
  const [reply, setReply] = useState("");
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const field = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const replies = comment.replies ?? [];

  async function run(work: () => Promise<void>) {
    if (busy || !current()) return false;
    const started = authority.current;
    const active = () => authority.current === started && current();
    setBusy(true);
    try {
      await work();
      return active();
    } catch (error) {
      if (active()) onError(error);
      return false;
    } finally {
      if (active()) setBusy(false);
    }
  }
  async function saveEdit() {
    if (!editing || !threadText(editing.text)) return;
    const done = await run(() =>
      editing.reply === undefined
        ? onEdit(editing.text)
        : onEditReply(editing.reply, editing.text),
    );
    if (done) setEditing(undefined);
  }
  async function sendReply(text = reply) {
    if (!threadText(text)) return;
    if (await run(() => onReply(text))) setReply("");
  }
  function openMenu(button: HTMLButtonElement, target: Target) {
    if (!current()) return;
    anchor.current = button;
    if (menu && menu.reply === target.reply) return setMenu(undefined);
    const rect = button.getBoundingClientRect();
    setMenu({
      ...target,
      position: { right: innerWidth - rect.right, top: rect.bottom + 4 },
    });
  }
  const editEntry = (target: Target, label: string) => ({
    label,
    onSelect: () => {
      if (!current()) return;
      setEditing({
        ...target,
        text:
          target.reply === undefined
            ? comment.text
            : (replies.find((value) => value.id === target.reply)?.text ?? ""),
      });
    },
  });

  /** The text, or its edit field with Cancel and Save. */
  useLayoutEffect(() => {
    setBusy(false);
    setMenu(undefined);
    setEditing(undefined);
    setConfirming(undefined);
    setReply("");
  }, [lease]);
  const body = (target: Target, text: string) =>
    editing && editing.reply === target.reply ? (
      <div className="artifact-thread-edit">
        <textarea
          autoFocus
          rows={2}
          maxLength={10000}
          aria-label={t("Edit comment")}
          value={editing.text}
          disabled={busy}
          onChange={(event) =>
            setEditing({ ...editing, text: event.target.value })
          }
          onFocus={(event) => {
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // Cancels the edit, not the list or comment mode behind it.
              event.stopPropagation();
              setEditing(undefined);
            } else if (
              sendsOnEnter(event) ||
              (event.key === "Enter" && (event.metaKey || event.ctrlKey))
            ) {
              event.preventDefault();
              void saveEdit();
            }
          }}
        />
        <div>
          <button disabled={busy} onClick={() => setEditing(undefined)}>
            {t("Cancel")}
          </button>
          <button
            disabled={busy || !threadText(editing.text)}
            onClick={() => void saveEdit()}
          >
            {t("Save")}
          </button>
        </div>
      </div>
    ) : (
      <p>{text}</p>
    );

  const more = (target: Target, label: string) => (
    <button
      className="artifact-thread-more"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={menu !== undefined && menu.reply === target.reply}
      disabled={busy}
      onClick={(event) => openMenu(event.currentTarget, target)}
    >
      <Ellipsis size={15} />
    </button>
  );
  const byline = (value: ArtifactComment | ArtifactReply) => (
    <>
      <RelativeTime createdAt={value.createdAt} />
      {value.editedAt !== undefined && (
        <span className="artifact-thread-edited">{t("edited")}</span>
      )}
    </>
  );

  return (
    <article
      data-comment-id={comment.id}
      data-pulse={pulse || undefined}
      data-resolved={comment.resolved || undefined}
    >
      <header>
        <strong>{authorName}</strong>
        {byline(comment)}
        <span className="artifact-thread-actions">
          {!readOnly && (
            <button
              className="artifact-thread-resolve"
              disabled={busy}
              onClick={() => void run(onResolve)}
            >
              {comment.resolved ? t("Reopen") : t("Resolve")}
            </button>
          )}
          {!readOnly && more({}, t("Comment options"))}
        </span>
      </header>
      {body({}, comment.text)}
      {replies.map((value) => (
        <div className="artifact-thread-reply" key={value.id}>
          <header>
            <strong>{authorName}</strong>
            {byline(value)}
            <span className="artifact-thread-actions">
              {!readOnly && more({ reply: value.id }, t("Reply actions"))}
            </span>
          </header>
          {body({ reply: value.id }, value.text)}
        </div>
      ))}
      {!readOnly && (
        <div className="artifact-thread-compose">
          <textarea
            ref={field}
            rows={1}
            maxLength={10000}
            aria-label={t("Reply")}
            placeholder={
              phase === "recording" || phase === "requesting"
                ? t("Listening…")
                : phase === "finishing"
                  ? t("Finishing dictation…")
                  : comment.resolved
                    ? t("Reply to reopen…")
                    : t("Add your comment")
            }
            value={reply}
            disabled={busy || replies.length >= artifactNoteLimits.replies}
            readOnly={phase !== "idle"}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (phase !== "idle") return;
              if (event.key === "Escape" && reply) {
                event.stopPropagation();
                setReply("");
              } else if (sendsOnEnter(event)) {
                event.preventDefault();
                void sendReply();
              }
            }}
          />
          {!busy && replies.length < artifactNoteLimits.replies && (
            <Suspense fallback={null}>
              <CommentDictation
                text={reply}
                setText={(text) => {
                  if (current()) setReply(text);
                }}
                field={field}
                contextKey={comment.id}
                onPhase={(phase) => {
                  if (current()) setPhase(phase);
                }}
                onError={(error) => {
                  if (current()) onError(error);
                }}
                onSubmit={(spoken) => void sendReply(spoken)}
              />
            </Suspense>
          )}
          {threadText(reply) && (
            <button
              aria-label={t("Add comment")}
              disabled={busy || phase !== "idle"}
              onClick={() => void sendReply()}
            >
              <ArrowUp size={14} />
            </button>
          )}
        </div>
      )}
      {!readOnly && menu && (
        <Menu
          label={t(
            menu.reply === undefined ? "Comment options" : "Reply actions",
          )}
          entries={[
            editEntry(menu, t("Edit")),
            {
              label:
                menu.reply === undefined ? t("Delete thread") : t("Delete"),
              danger: true,
              onSelect: () => {
                if (current()) setConfirming({ reply: menu.reply });
              },
            },
          ]}
          position={menu.position}
          width={150}
          anchors={[anchor]}
          onClose={() => {
            if (current()) setMenu(undefined);
          }}
        />
      )}
      {!readOnly &&
        confirming &&
        portal(
          <ConfirmationDialog
            confirmation={
              confirming.reply === undefined
                ? {
                    title: t("Delete this comment thread?"),
                    body: t(
                      "The thread and all its replies will be permanently deleted.",
                    ),
                    confirm: t("Delete"),
                    action: async () => {
                      if (current()) await onDelete();
                    },
                  }
                : {
                    title: t("Delete this comment?"),
                    body: t("The comment will be permanently deleted."),
                    confirm: t("Delete"),
                    action: async () => {
                      if (current()) await onDeleteReply(confirming.reply!);
                    },
                  }
            }
            onClose={() => {
              if (current()) setConfirming(undefined);
            }}
            onError={(error) => {
              if (current()) onError(error);
            }}
          />,
        )}
    </article>
  );
}
