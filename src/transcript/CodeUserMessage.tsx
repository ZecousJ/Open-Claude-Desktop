import { Suspense, useContext, useEffect, useRef, useState } from "react";
import { sentPromptOf } from "./sent-prompt";
import { Code } from "../ui/glyphs";
import { lazyPiece } from "../ui/lazy-piece";
import { t } from "../i18n";
import type { Turn } from "../../shared/types";
import { displayPrompt } from "../../shared/pr-display";
import { MessageAttachments } from "../composer/Attachments";
import { CopyButton } from "../ui/Controls";
import { RelativeTime } from "../ui/RelativeTime";
import { ShowMessageActions } from "./ReplyToolbar";
import { ReplyCopyIcon, ReplyEditIcon, ReplyRetryIcon } from "../ui/ReplyIcons";
import { Menu, type MenuPosition } from "../ui/Menu";
import { codeMessageMenu, messageSelection } from "./code-message-menu";
import { terminalKey } from "../terminal/terminal-menu";
import { isMacPlatform } from "../host/keys";
import { ShortcutPlatform, WithTooltip } from "../ui/Tooltip";
import { PromptEdit } from "./PromptEdit";
import { coworkEditNote } from "./cowork-prompt-actions";
import type { MessageTextSize } from "./transcript-text-size";

const SentPromptDialog = lazyPiece(
  () => import("./SentPromptDialog"),
  "SentPromptDialog",
);

/**
 * A Code prompt longer than this many characters folds to 16rem behind a fade,
 * with Show more under it. Chat's bubble measures its height instead
 * (UserMessage.tsx).
 */
export const codePromptClampChars = 1200;

/** The selection when it lies inside the bubble, else none. */
function bubbleSelection(bubble: HTMLElement | null) {
  const selection = window.getSelection();
  if (!bubble || !selection || selection.isCollapsed) return undefined;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return undefined;
  if (!bubble.contains(anchorNode) || !bubble.contains(focusNode))
    return undefined;
  return messageSelection(selection.toString());
}

/**
 * A Code or Cowork prompt bubble. In Code its right-click menu is the
 * original's message menu: Copy message, Copy message as Markdown, Pin as
 * chapter (greyed), then Rewind to here ("Removes this message and what
 * follows") and Fork from here ("Starts a new session, keeps this one"). Attach
 * selection / message as context adds the text to the composer as an Excerpt
 * card (code-message-menu.ts).
 */
export function CodeUserMessage({
  turn,
  foldLong = false,
  onRewind,
  onFork,
  rewindReason,
  onEdit,
  onRestart,
  onAttachAsContext,
  textSize,
}: {
  turn: Turn;
  /** Code: the Transcript text size's message size (transcript-text-size.ts). */
  textSize?: MessageTextSize;
  /** Code: a prompt over codePromptClampChars folds behind Show more. */
  foldLong?: boolean;
  /** Rewind to here; absent where rewinding has no meaning (Cowork). */
  onRewind?: () => void;
  /** Fork from here; absent for the first message. */
  onFork?: () => void;
  /** Why rewinding is unavailable right now (Claude is working). */
  rewindReason?: string;
  /** Cowork's last prompt: saves an edited text as the new latest message. */
  onEdit?: (text: string) => Promise<boolean>;
  /** Cowork's last prompt: sends it again from here. */
  onRestart?: () => void;
  /** Code: Attach selection / message as context, into the composer. */
  onAttachAsContext?: (text: string) => void;
}) {
  const [menu, setMenu] = useState<MenuPosition>();
  const [editing, setEditing] = useState(false);
  const [showSentPrompt, setShowSentPrompt] = useState(false);
  const [draft, setDraft] = useState(turn.prompt);
  // The prompt stops being the last one, or a reply starts: the editor goes.
  const editable = Boolean(onEdit);
  useEffect(() => {
    if (!editable) setEditing(false);
  }, [editable]);
  const editor = editing && onEdit;
  const [expanded, setExpanded] = useState(false);
  // Create PR's long instruction reads as "/create-pr", as in the original.
  const shown = displayPrompt(turn.prompt);
  const text = turn.shell ? `! ${turn.prompt}` : shown;
  const long = foldLong && text.length > codePromptClampChars;
  const folded = long && !expanded;
  // Attach reads the bubble's own selection when it has two characters or
  // more, else the whole message (the original's jC).
  const bubble = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string>();
  const attach = onAttachAsContext
    ? () => {
        if (selected) window.getSelection()?.removeAllRanges();
        onAttachAsContext(selected ?? text);
      }
    : undefined;
  const mac = isMacPlatform(useContext(ShortcutPlatform));
  useEffect(() => {
    if (!menu || !attach || !selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (terminalKey(event, mac) !== "attach") return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(undefined);
      attach();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  const entries = codeMessageMenu({
    copy: () => void navigator.clipboard?.writeText(shown),
    onAttach: attach,
    selection: selected,
    onRewind,
    rewindReason,
    onFork,
    mac,
  });
  return (
    <>
      <MessageAttachments attachments={turn.attachments ?? []} />
      <div
        className={`user-message${editor ? " is-editing" : ""}${Date.now() - turn.createdAt < 1500 ? " entering" : ""}`}
        data-text-size={textSize}
        ref={bubble}
        onContextMenu={
          !editor && (onRewind || onFork || onAttachAsContext)
            ? (event) => {
                event.preventDefault();
                setSelected(bubbleSelection(bubble.current));
                setMenu({ left: event.clientX, top: event.clientY });
              }
            : undefined
        }
      >
        {editor ? (
          <PromptEdit
            original={turn.prompt}
            draft={draft}
            onDraft={setDraft}
            busy={false}
            note={coworkEditNote}
            onSave={() =>
              void editor(draft).then((saved) => saved && setEditing(false))
            }
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            {/* A Bash mode line reads as typed: "! command". A long prompt is
               folded and out of reach while folded; screen readers get the
               whole text instead. */}
            <div
              className={`user-message-text${folded ? " is-clamped" : ""}`}
              inert={folded || undefined}
            >
              {text}
            </div>
            {folded && <p className="sr-only">{text}</p>}
            {long && (
              <button
                type="button"
                className="user-message-more"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
            {/* A sent prompt's actions show once the pointer rests on it: the
               time, then icon buttons. Cowork's last prompt adds Restart and
               Edit before Copy, as the original orders them. */}
            <div
              className="user-message-actions"
              role="toolbar"
              aria-label={t("User message actions")}
            >
              <ShowMessageActions />
              <RelativeTime createdAt={turn.createdAt} />
              {onRestart && (
                <WithTooltip label={t("Restart session from here")}>
                  {(tooltip) => (
                    <button
                      {...tooltip}
                      className="small-action icon-only"
                      aria-label={t("Restart session from here")}
                      onClick={onRestart}
                    >
                      <ReplyRetryIcon />
                    </button>
                  )}
                </WithTooltip>
              )}
              {onEdit && (
                <WithTooltip label={t("Edit")}>
                  {(tooltip) => (
                    <button
                      {...tooltip}
                      className="small-action icon-only"
                      aria-label={t("Edit")}
                      onClick={() => {
                        setDraft(turn.prompt);
                        setEditing(true);
                      }}
                    >
                      <ReplyEditIcon />
                    </button>
                  )}
                </WithTooltip>
              )}
              <CopyButton
                iconOnly
                text={shown}
                glyph={<ReplyCopyIcon />}
                message="prompt"
              />
              {sentPromptOf(turn) ? (
                <WithTooltip label={t("View sent prompt")}>
                  {(tooltip) => (
                    <button
                      {...tooltip}
                      type="button"
                      className="small-action icon-only"
                      aria-label={t("View sent prompt")}
                      onClick={() => setShowSentPrompt(true)}
                    >
                      <Code size={14} aria-hidden="true" />
                    </button>
                  )}
                </WithTooltip>
              ) : null}
            </div>
          </>
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
      {menu && (
        <Menu
          label={t("Message actions")}
          position={menu}
          width={260}
          entries={entries}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  );
}
