import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Pencil,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Trash2,
} from "../ui/glyphs";
import type {
  MemoryDocView,
  MemoryEditsChange,
  MemoryScopeRef,
} from "../../shared/memory-api";
import { formatText, useT } from "../i18n";
import { SettingsModal } from "../settings/controls";
import { Markdown } from "../ui/Markdown";
import { Skeleton } from "../ui/Skeleton";
import { showToast } from "../ui/toast-store";
import { memoryEditLine } from "./memory-edit-line";
import { memoryError } from "./useMemory";
import "./manage-memory.css";

/*
 * the memory in a 460px box, read-only, with a round pencil at its foot that
 * opens "Tell Claude what to remember or forget"; under the box "Manage edits"
 * with their count, which lists them to remove one by one or all at once. While
 * a change is saved the box shows "Updating memory..." and the dialog cannot
 * close.
 */

/** The box's height (FULL_SYNTHESIS_BOX_HEIGHT) and the edits view's. */
export const memoryBoxHeight = 460;
export const memoryEditsHeight = 512;

/** Placeholder line widths while memory loads (the bundle's skeleton). */
const skeletonLines = ["92%", "84%", "96%", "61%", "88%", "72%"];

/** The service's limits when an older main process sends none. */
const fallbackLimits = { edits: 50, editChars: 500 };

/** The hints the edit field cycles through, every 6 s. */
export const editPlaceholders = [
  "Tell Claudex what to remember or forget...",
  "“I like cats not dogs...”",
  "“Don’t bring up my former baseball career...”",
  "“Broccoli is my favorite veg...”",
];

/** The dialog's title for a scope and view. */
export function manageMemoryTitle(
  scope: MemoryScopeRef,
  view: "synthesis" | "edits",
) {
  if (view === "edits") return "Manage edits";
  return scope.kind === "project" ? "Manage project memory" : "Manage memory";
}

/**
 * The line under the title. The original says the summary is regenerated
 * "each night"; Claudex writes it about once a day while the app is open
 * (electron/memory/scheduler.ts), so it says "every day".
 */
export function manageMemoryDescription(scope: MemoryScopeRef) {
  return scope.kind === "project"
    ? "Claudex regenerates project memory every day from your past chats in this project. Only you can see this memory, and it is not shared with other project users."
    : "Here’s what Claudex remembers about you! This summary is regenerated every day and does not include projects, which have their own specific memory.";
}

/** The ids an edits list no longer holds: what Save changes removes. */
export const removedEdits = (
  before: MemoryDocView["edits"],
  kept: MemoryDocView["edits"],
) => {
  const keep = new Set(kept.map((edit) => edit.id));
  return before.filter((edit) => !keep.has(edit.id)).map((edit) => edit.id);
};

type Load =
  { state: "loading" } | { state: "ready"; doc: MemoryDocView | null };

/**
 * Sends a change of the edits and says how it went: the result line of the
 * change (memoryEditLine) or the original's "Something went wrong while
 * updating memory". Resolves to the scope's memory, or undefined when it
 * failed.
 */
export async function applyMemoryEdits(
  scope: MemoryScopeRef,
  change: MemoryEditsChange,
): Promise<MemoryDocView | null | undefined> {
  try {
    const answer = await window.desktop.updateMemoryEdits(scope, change);
    // A runner from before the outcome answers the memory itself, or null.
    if (!answer?.outcome) {
      showToast("Memory updated");
      return answer ?? null;
    }
    const { outcome, ...next } = answer;
    showToast(memoryEditLine(outcome));
    // A scope left without memory answers an empty document.
    return next.edits.length || next.content ? next : null;
  } catch (cause) {
    showToast(
      memoryError(cause) || "Something went wrong while updating memory",
    );
    return undefined;
  }
}

/**
 * Manage memory for the global scope (Settings → Memory's "View and manage
 * memory") or a project's (the project page's Edit memory). `initial` is
 * the memory the opener already has, shown at once (the original shares
 * its cached query); without it the box's skeleton shows while it is read.
 * `readOnly` (offline, memory unavailable) shows the memory and edits
 * without the field or the remove buttons.
 */
export function ManageMemoryDialog({
  scope,
  readOnly = false,
  initial,
  onClose,
  onChanged,
}: {
  scope: MemoryScopeRef;
  readOnly?: boolean;
  initial?: MemoryDocView | null;
  onClose: () => void;
  /** An edit went through. */
  onChanged?: () => void;
}) {
  useT();
  const [load, setLoad] = useState<Load>(
    initial === undefined
      ? { state: "loading" }
      : { state: "ready", doc: initial },
  );
  const [view, setView] = useState<"synthesis" | "edits">("synthesis");
  const [updating, setUpdating] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const read = () =>
      void window.desktop
        .memoryDoc(scope)
        .then((doc) => {
          if (live.current) setLoad({ state: "ready", doc });
        })
        .catch((cause) => {
          if (!live.current) return;
          // The original's memory query reports the failure as a toast and
          // draws no dialog.
          showToast(memoryError(cause));
          onClose();
        });
    if (initial === undefined) read();
    const off = window.desktop.onEvent((event) => {
      if (event.type === "memory-changed") read();
    });
    return () => {
      live.current = false;
      off();
    };
  }, []);
  const doc = load.state === "ready" ? load.doc : undefined;
  // Without memory the original draws nothing; here the dialog goes.
  useEffect(() => {
    if (load.state === "ready" && !load.doc) onClose();
  }, [load]);
  const close = () => {
    if (!updating) onClose();
  };
  const update = (change: MemoryEditsChange) => {
    setUpdating(true);
    void applyMemoryEdits(scope, change).then((next) => {
      if (!live.current) return;
      setUpdating(false);
      if (next === undefined) return;
      setLoad({ state: "ready", doc: next });
      onChanged?.();
    });
  };
  if (load.state === "ready" && !doc) return null;
  return (
    <SettingsModal
      title={formatText(manageMemoryTitle(scope, view))}
      className="manage-memory-modal"
      onClose={close}
    >
      <ManageMemoryContent
        scope={scope}
        doc={doc ?? undefined}
        readOnly={readOnly}
        view={view}
        onView={setView}
        updating={updating}
        onUpdate={update}
      />
    </SettingsModal>
  );
}

/**
 * Manage memory's body: the line under the title, then the memory box with
 * its pencil and "Manage edits", or the edits list (the original's
 * MemoryPreviewContent). Import memory's result page shows it too. Without
 * `doc` the box's skeleton shows.
 */
export function ManageMemoryContent({
  scope,
  doc,
  readOnly = false,
  view,
  onView,
  updating,
  onUpdate,
}: {
  scope: MemoryScopeRef;
  doc: MemoryDocView | undefined;
  readOnly?: boolean;
  view: "synthesis" | "edits";
  onView: (view: "synthesis" | "edits") => void;
  updating: boolean;
  onUpdate: (change: MemoryEditsChange) => void;
}) {
  useT();
  // A save from the edits list goes back to the memory, which shows it.
  useEffect(() => {
    if (updating && view === "edits") onView("synthesis");
  }, [updating, view]);
  const edits = doc?.edits ?? [];
  const limits = doc?.limits ?? fallbackLimits;
  const update = onUpdate;
  const setView = onView;
  return (
    <div className="manage-memory" data-updating={updating || undefined}>
      <p className="manage-memory-intro">
        {formatText(manageMemoryDescription(scope))}
      </p>
      {!doc ? (
        <ManageMemorySkeleton />
      ) : view === "synthesis" ? (
        <>
          <MemoryBox
            text={doc.content}
            updating={updating}
            bottomBar={
              updating || readOnly ? null : (
                <EditField
                  full={edits.length >= limits.edits}
                  maxChars={limits.editChars}
                  onSubmit={(text) => update({ add: text })}
                />
              )
            }
          />
          {!updating && (
            <ManageEditsRow
              count={edits.length}
              onClick={() => setView("edits")}
            />
          )}
        </>
      ) : (
        <EditsList
          edits={edits}
          readOnly={readOnly}
          updating={updating}
          onBack={() => setView("synthesis")}
          onSave={(kept) => update({ remove: removedEdits(edits, kept) })}
        />
      )}
    </div>
  );
}

/** The loading box: six lines and the pencil's circle. */
export function ManageMemorySkeleton() {
  return (
    <div className="manage-memory-skeleton" role="status" aria-label="Loading">
      <div className="manage-memory-box" style={{ height: memoryBoxHeight }}>
        {skeletonLines.map((width, index) => (
          <span key={index} className="manage-memory-skeleton-line">
            <Skeleton width={width} height={12} />
          </span>
        ))}
        <span className="manage-memory-skeleton-pencil">
          <Skeleton width={56} height={56} round />
        </span>
      </div>
    </div>
  );
}

/**
 * The memory in its box: Markdown in the reply face, scrolling inside; or,
 * while a change is saved, the spinner and "Updating memory..." over a
 * clay glow that breathes.
 */
export function MemoryBox({
  text,
  updating,
  bottomBar,
}: {
  text: string;
  updating: boolean;
  bottomBar?: ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  // The original's dialog focuses itself, so the pencil stays a pencil:
  // the memory takes focus first (the dialog then leaves it there instead
  // of opening the field, its first input).
  useEffect(() => {
    const box = scroll.current;
    if (box && !box.closest(".modal")?.contains(document.activeElement))
      box.focus({ preventScroll: true });
  }, []);
  return (
    <div className="manage-memory-box" style={{ height: memoryBoxHeight }}>
      <div className="manage-memory-glow" aria-hidden="true" />
      <div className="manage-memory-frame">
        <div className="manage-memory-scroll" ref={scroll} tabIndex={-1}>
          {updating ? (
            <div
              className="manage-memory-updating"
              role="status"
              key="updating"
            >
              <span className="manage-memory-spinner" aria-hidden="true" />
              Updating memory...
            </div>
          ) : (
            <div className="manage-memory-text" key="text" data-no-translate>
              <Markdown text={text} />
              <div className="manage-memory-text-fade" aria-hidden="true" />
            </div>
          )}
        </div>
      </div>
      {bottomBar && <div className="manage-memory-bar">{bottomBar}</div>}
    </div>
  );
}

/**
 * The round pencil at the box's foot. Focused it widens to the box and
 * takes "remember or forget" text (one line, the service's length), with
 * hints that change every 6 s and the submit arrow; empty and blurred it
 * shrinks back.
 */
export function EditField({
  full,
  maxChars,
  onSubmit,
  open: initialOpen = false,
}: {
  /** The scope holds as many edits as the service keeps. */
  full: boolean;
  maxChars: number;
  onSubmit: (text: string) => void;
  /** Starts open (previews and tests). */
  open?: boolean;
}) {
  useT();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(initialOpen);
  const hints = full ? ["Maximum edits reached"] : editPlaceholders;
  const [hint, setHint] = useState(0);
  const showHint = !text && open;
  useEffect(() => {
    if (!showHint) return;
    const timer = setInterval(
      () => setHint((index) => (index + 1) % hints.length),
      6000,
    );
    return () => clearInterval(timer);
  }, [showHint, hints.length]);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.replace("\n", " ").trim();
    if (!value || full) return;
    onSubmit(value);
    setText("");
  };
  return (
    <div className="memory-edit-field" data-open={open || undefined}>
      <div className="memory-edit-pill">
        <form onSubmit={submit}>
          <input
            value={text}
            maxLength={maxChars}
            aria-label={formatText("Tell Claudex what to remember or forget")}
            onChange={(event) => setText(event.target.value)}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              if (!text) setOpen(false);
            }}
          />
          <div
            className="memory-edit-hint"
            aria-hidden={!showHint}
            data-shown={showHint || undefined}
          >
            <p key={`${full}-${hint}`}>
              {formatText(hints[hint % hints.length])}
            </p>
          </div>
          <span className="memory-edit-pencil" aria-hidden="true">
            <Pencil size={24} strokeWidth={1.5} />
          </span>
        </form>
        {open && (
          <button
            type="button"
            className="primary memory-edit-submit"
            aria-label={formatText("Submit")}
            disabled={!text.trim() || full}
            // Keeps the field focused (and open) while the arrow is pressed.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => submit()}
          >
            <ArrowRight size={16} strokeWidth={1.75} />
          </button>
        )}
      </div>
    </div>
  );
}

/** "Manage edits" with the count and a caret; only while there are edits. */
export function ManageEditsRow({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  if (!count) return null;
  return (
    <button type="button" className="manage-memory-edits-row" onClick={onClick}>
      <span>Manage edits</span>
      <span className="manage-memory-edits-count">
        <span>{count}</span>
        <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
      </span>
    </button>
  );
}

/**
 * The edits: "Back to memory", then Clear edits (or Save changes once
 * something is removed) and the list, each with its trash button; emptied,
 * "All edits cleared".
 */
export function EditsList({
  edits,
  readOnly,
  updating,
  onBack,
  onSave,
}: {
  edits: MemoryDocView["edits"];
  readOnly: boolean;
  updating: boolean;
  onBack: () => void;
  onSave: (kept: MemoryDocView["edits"]) => void;
}) {
  useT();
  const [kept, setKept] = useState(edits);
  const [dirty, setDirty] = useState(false);
  const remove = (id: string) => {
    setKept((list) => list.filter((edit) => edit.id !== id));
    setDirty(true);
  };
  return (
    <div className="manage-memory-edits" style={{ height: memoryEditsHeight }}>
      <div className="manage-memory-edits-head">
        <button
          type="button"
          className="manage-memory-ghost flush"
          onClick={onBack}
        >
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          Back to memory
        </button>
        {readOnly ? null : dirty ? (
          <button
            type="button"
            className="primary manage-memory-save"
            disabled={updating}
            onClick={() => {
              onSave(kept);
              setDirty(false);
            }}
          >
            Save changes
          </button>
        ) : (
          <button
            type="button"
            className="manage-memory-ghost"
            disabled={updating}
            onClick={() => {
              setKept([]);
              setDirty(true);
            }}
          >
            <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
            Clear edits
          </button>
        )}
      </div>
      <div className="manage-memory-edits-body">
        {kept.length ? (
          <div className="manage-memory-edits-scroll u-scroll-fade-y">
            <ul>
              {kept.map((edit) => (
                <li key={edit.id}>
                  <p data-no-translate>{edit.text}</p>
                  {!readOnly && (
                    <button
                      type="button"
                      className="manage-memory-trash"
                      aria-label={formatText("Remove edit")}
                      disabled={updating}
                      onClick={() => remove(edit.id)}
                    >
                      <Trash2 size={16} strokeWidth={1.5} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="manage-memory-edits-empty">All edits cleared</div>
        )}
      </div>
    </div>
  );
}
