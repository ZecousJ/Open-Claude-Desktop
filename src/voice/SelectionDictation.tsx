import { Reply } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  DictationButton,
  type DictationPhase,
} from "../composer/voice/DictationButton";
import { useTooltip } from "../ui/Tooltip";
import { t } from "../i18n";
import { withSpoken } from "./useDictationDraft";
import type { SpeechEngine } from "./useSpeechEngine";
import "./selection-dictation.css";
import "./comment-dictation.css";

/** Reply editor. */
export function SelectionDictation({
  selection,
  engine,
  maxSeconds,
  shortcut,
  platform,
  boundary,
  onReply,
  onClose,
  onError,
}: {
  selection: { range: Range; text: string };
  engine: SpeechEngine;
  maxSeconds: number | null;
  shortcut: string;
  platform: string;
  boundary: RefObject<HTMLElement | null>;
  onReply: (text: string) => void;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [phase, setPhase] = useState<DictationPhase>("requesting");
  const base = useRef<string | null>(null);
  const final = useRef("");
  const active = phase !== "idle";
  const saveHint = useTooltip("Add to message");
  const save = (text = value) => {
    if (!text.trim()) return;
    onReply(text.trim());
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = editor.current;
    field.current?.focus();
    const highlights = globalThis.CSS?.highlights;
    if (highlights && typeof Highlight !== "undefined")
      highlights.set("epitaxy-reply-selection", new Highlight(selection.range));
    return () => {
      highlights?.delete("epitaxy-reply-selection");
      if (previous?.isConnected && element?.contains(document.activeElement))
        previous.focus({ preventScroll: true });
    };
  }, [selection.range]);
  useEffect(() => {
    const place = () => {
      const element = editor.current;
      if (!element || !selection.range.startContainer.isConnected) return;
      const box =
        selection.range.getClientRects()[0] ??
        selection.range.getBoundingClientRect();
      const bounds = boundary.current?.getBoundingClientRect();
      const left = Math.max(8, bounds?.left ?? 0);
      const right = Math.min(
        window.innerWidth - 8,
        bounds?.right ?? window.innerWidth,
      );
      const top = Math.max(8, bounds?.top ?? 0);
      const bottom = Math.min(
        window.innerHeight - 8,
        bounds?.bottom ?? window.innerHeight,
      );
      const height = element.offsetHeight;
      const above = box.top - 8 - height;
      const nextTop = above >= top ? above : box.bottom + 8;
      element.style.left = `${Math.max(8, Math.min(Math.max(box.left + box.width / 2 - 160, left), right - 320))}px`;
      element.style.top = `${Math.max(8, Math.min(nextTop, bottom - height))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    if (editor.current) observer.observe(editor.current);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [selection.range, boundary]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        (event.target as Element)?.closest?.(
          ".microphone-guidance, .microphone-menu, .toast",
        )
      )
        return;
      if (
        !active &&
        event.button === 0 &&
        !editor.current?.contains(event.target as Node)
      )
        onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [active, onClose]);
  return createPortal(
    <div
      ref={editor}
      className="selection-dictation-editor"
      role="dialog"
      tabIndex={-1}
      aria-label={t("Comment on selection")}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape" && !active) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.altKey &&
          !active
        ) {
          event.preventDefault();
          if (!event.repeat) save();
        }
      }}
    >
      <blockquote>{selection.text}</blockquote>
      <div className="selection-dictation-input">
        <textarea
          ref={field}
          aria-label={t("Reply")}
          rows={1}
          value={value}
          readOnly={active}
          placeholder={t(
            phase === "requesting" || phase === "recording"
              ? "Listening…"
              : phase === "finishing"
                ? "Finishing dictation…"
                : "Write a reply",
          )}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="selection-dictation-actions">
          <span hidden={!active}>
            <DictationButton
              autoStart
              comment
              engine={engine}
              maxSeconds={maxSeconds}
              contextKey="selection-reply"
              platform={platform}
              shortcut={shortcut}
              field={field}
              guidanceAnchor={editor}
              onPhase={setPhase}
              onError={onError}
              onLive={(spoken) => {
                base.current ??= value;
                setValue(withSpoken(base.current, spoken));
              }}
              onTranscript={(spoken) => {
                final.current = withSpoken(base.current ?? value, spoken);
                setValue(final.current);
                base.current = null;
              }}
              onCancel={() => {
                if (base.current !== null) setValue(base.current);
                base.current = null;
              }}
              onSubmit={() => save(final.current)}
            />
          </span>
          {!active && (
            <button
              {...saveHint.props}
              type="button"
              aria-label={t("Add to message")}
              disabled={!value.trim()}
              onClick={() => save()}
            >
              <Reply size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          {saveHint.tooltip}
        </div>
      </div>
    </div>,
    document.body,
  );
}
