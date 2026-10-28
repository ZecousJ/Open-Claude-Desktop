import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { createPortal } from "react-dom";
import { MessageSquarePlus, MessageSquare, Trash2, X } from "../ui/glyphs";
import type { PlanComment } from "../../shared/plan-comments";
import { overlapsPlanComment } from "../../shared/plan-comments";
import { t, tf } from "../i18n";
import { Markdown } from "../ui/Markdown";
import { AppContext } from "../app/AppContext";
import { useConversationServices } from "../conversation/ConversationServices";
import {
  planAnnotationPlugin,
  selectedPlanText,
} from "./plan-comment-annotations";
import {
  planCommentKey,
  planComments,
  usePlanComments,
  usePlanCommentsEnabled,
} from "./plan-comments-store";
import "./plan-comments.css";

interface CommentSelection {
  range: Range;
  selectedText: string;
  startOffset: number;
  endOffset: number;
  entry?: PlanComment;
}

/** Selection opens the editor directly. */
export function PlanCommentText({
  planId: itemId,
  ...props
}: ComponentProps<typeof Markdown> & { planId: string }) {
  const app = useContext(AppContext);
  const services = useConversationServices();
  const planId = planCommentKey(
    services.conversationId ?? app?.activeId ?? "",
    itemId,
  );
  const comments = usePlanComments(planId);
  const enabled = usePlanCommentsEnabled(planId);
  const root = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<CommentSelection>();
  const draft = useRef("");
  const plugins = useMemo(() => [planAnnotationPlugin(comments)], [comments]);
  const components = useMemo<
    NonNullable<ComponentProps<typeof Markdown>["extraComponents"]>
  >(
    () => ({
      mark({ children, node }) {
        const id = String(node?.properties["data-plan-comment-id"] ?? "");
        const open = (element: HTMLElement) => {
          if (!enabled) return;
          const entry = comments.find((entry) => entry.id === id);
          if (!entry) return;
          const range = element.ownerDocument.createRange();
          range.selectNodeContents(element);
          draft.current = entry.comment;
          setSelection({ ...entry, range, entry });
        };
        return (
          <mark data-plan-comment-id={id} className="plan-comment-mark">
            <span
              role="button"
              tabIndex={enabled ? 0 : -1}
              onClick={(event) => {
                event.stopPropagation();
                open(event.currentTarget);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  open(event.currentTarget);
                }
              }}
            >
              {children}
            </span>
          </mark>
        );
      },
    }),
    [comments, enabled],
  );
  const dismiss = () => {
    setSelection(undefined);
    root.current?.ownerDocument.getSelection()?.removeAllRanges();
  };
  useEffect(() => {
    if (!enabled) setSelection(undefined);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    const element = root.current!;
    const document = element.ownerDocument;
    let dragging = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      if (selection && draft.current !== (selection.entry?.comment ?? ""))
        return;
      const current = document.getSelection();
      if (
        !current ||
        current.isCollapsed ||
        !current.rangeCount ||
        !element.contains(current.anchorNode)
      )
        return;
      const range = current.getRangeAt(0).cloneRange();
      if (!element.contains(range.startContainer)) range.setStart(element, 0);
      if (!element.contains(range.endContainer))
        range.setEnd(element, element.childNodes.length);
      const picked = selectedPlanText(element, range);
      if (
        !picked.selectedText.trim() ||
        overlapsPlanComment(comments, picked.startOffset, picked.endOffset)
      )
        return;
      draft.current = "";
      setSelection({ ...picked, range });
    };
    const down = () => {
      dragging = true;
      clearTimeout(timer);
    };
    const change = () => {
      if (!dragging) read();
    };
    const up = (event: MouseEvent) => {
      dragging = false;
      if (event.detail >= 2) timer = setTimeout(read, 250);
      else read();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("selectionchange", change);
    document.addEventListener("mouseup", up);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("selectionchange", change);
      document.removeEventListener("mouseup", up);
    };
  }, [enabled, comments, selection]);
  return (
    <div ref={root} data-plan-id={planId}>
      {enabled && (
        <div className="plan-comment-hint" data-plan-comment-skip>
          <MessageSquare size={12} />
          {t("Select any text to leave a comment for Claudex")}
        </div>
      )}
      <Markdown
        {...props}
        extraRehypePlugins={plugins}
        extraComponents={components}
      />
      {selection && enabled && (
        <PlanCommentEditor
          key={
            selection.entry?.id ??
            `${selection.startOffset}:${selection.endOffset}`
          }
          selection={selection}
          onChange={(value) => {
            draft.current = value;
          }}
          onDismiss={dismiss}
          onSave={(comment) => {
            if (selection.entry)
              planComments.update(planId, selection.entry.id, comment);
            else
              planComments.add(planId, {
                selectedText: selection.selectedText,
                startOffset: selection.startOffset,
                endOffset: selection.endOffset,
                comment,
              });
            dismiss();
          }}
          onDelete={
            selection.entry
              ? () => {
                  planComments.remove(planId, selection.entry!.id);
                  dismiss();
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function PlanCommentEditor({
  selection,
  onChange,
  onDismiss,
  onSave,
  onDelete,
}: {
  selection: CommentSelection;
  onChange: (value: string) => void;
  onDismiss: () => void;
  onSave: (value: string) => void;
  onDelete?: () => void;
}) {
  const initial = selection.entry?.comment ?? "";
  const [value, setValue] = useState(initial);
  const editor = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = editor.current;
    field.current?.focus();
    field.current?.setSelectionRange(initial.length, initial.length);
    return () => {
      if (previous?.isConnected && element?.contains(document.activeElement))
        previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (
      typeof CSS === "undefined" ||
      !CSS.highlights ||
      typeof Highlight === "undefined"
    )
      return;
    CSS.highlights.set(
      "claudex-plan-selection",
      new Highlight(selection.range),
    );
    return () => {
      CSS.highlights.delete("claudex-plan-selection");
    };
  }, [selection.range]);
  useEffect(() => {
    const place = () => {
      const box = selection.range.getBoundingClientRect();
      const height = editor.current?.offsetHeight ?? 0;
      setPosition({
        left: Math.max(8, Math.min(box.left, window.innerWidth - 320 - 8)),
        top:
          box.bottom + height + 8 <= window.innerHeight
            ? box.bottom + 8
            : Math.max(8, box.top - height - 8),
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    const observer = new ResizeObserver(place);
    if (editor.current) observer.observe(editor.current);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      observer.disconnect();
    };
  }, [selection.range]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        event.button === 0 &&
        !editor.current?.contains(event.target as Node) &&
        (!value.trim() || value === initial)
      )
        onDismiss();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [value, initial, onDismiss]);
  const save = () => {
    if (value.trim()) onSave(value.trim());
  };
  return createPortal(
    <div
      ref={editor}
      role="dialog"
      aria-label={t("Comment on selection")}
      className="plan-comment-editor"
      style={position}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onDismiss();
        }
        if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          if (!event.repeat) save();
        }
        if (event.key === "Tab") {
          const controls = Array.from(
            editor.current!.querySelectorAll<HTMLElement>(
              "textarea, button:not([disabled])",
            ),
          );
          const index = controls.indexOf(document.activeElement as HTMLElement);
          event.preventDefault();
          controls[
            (index + (event.shiftKey ? controls.length - 1 : 1)) %
              controls.length
          ]?.focus();
        }
      }}
    >
      <textarea
        ref={field}
        aria-label={t("Plan comment")}
        placeholder={t("Add a comment")}
        rows={1}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          onChange(event.target.value);
        }}
      />
      <div className="plan-comment-editor-actions">
        {onDelete && (
          <button
            type="button"
            aria-label={t("Delete comment")}
            onClick={onDelete}
          >
            <Trash2 size={14} />
          </button>
        )}
        <button
          type="button"
          aria-label={t("Save comment")}
          disabled={!value.trim()}
          onClick={save}
        >
          <MessageSquarePlus size={16} />
        </button>
      </div>
    </div>,
    document.body,
  );
}

export function PlanCommentList({
  planId,
  disabled,
}: {
  planId: string;
  disabled: boolean;
}) {
  const comments = usePlanComments(planId);
  return (
    <ul className="plan-comment-list">
      {comments.map((entry) => (
        <li key={entry.id}>
          <button
            type="button"
            disabled={disabled}
            className="plan-comment-preview"
            onClick={() => {
              const plan = Array.from(
                document.querySelectorAll<HTMLElement>("[data-plan-id]"),
              ).find((element) => element.dataset.planId === planId);
              plan?.scrollIntoView({ block: "start" });
            }}
          >
            <span>
              <MessageSquare size={12} />
              <span>{entry.selectedText}</span>
            </span>
            <span>{entry.comment}</span>
          </button>
          <button
            type="button"
            className="plan-comment-delete"
            disabled={disabled}
            aria-label={t("Delete comment")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => planComments.remove(planId, entry.id)}
          >
            <X size={16} />
          </button>
        </li>
      ))}
      <li className="sr-only" role="status">
        {comments.length === 1
          ? t("1 inline comment will be sent")
          : tf("{count} inline comments will be sent", {
              count: comments.length,
            })}
      </li>
    </ul>
  );
}
