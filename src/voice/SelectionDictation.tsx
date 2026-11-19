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

const replyPath =
  "m8.79 3.21q-.16-.17-.16-.41q0-.24.16-.41q.17-.16.41-.16q.24 0 .41.16l3.2 3.2q.17.18.16.41q-.01.23-.16.4q-.15.17-.41.17h-4q-.71 0-1.33.27q-.62.27-1.09.74q-.47.47-.74 1.09q-.27.62-.27 1.33v2.4q0 .24-.16.41q-.17.16-.41.16q-.24 0-.41-.16q-.16-.17-.16-.41v-2.4q0-.95.35-1.77q.36-.83.99-1.46q.63-.63 1.46-.99q.82-.35 1.77-.35h2.62zm.82 6.4q-.17.16-.41.16q-.24 0-.41-.16q-.16-.17-.16-.41q0-.24.16-.41l3.2-3.2l.82.82z";

/** Reply editor (live claude.ai bundle, 2026-10-14, cc970fefe-DKWvZ4j5, cb1afaa4b-BvLfaAzp, cdf69fdd3-DpoW_Yf7). */
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
              <svg
                width={16}
                height={16}
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
                style={{ transform: "scaleX(-1)" }}
              >
                <path d={replyPath} />
              </svg>
            </button>
          )}
          {saveHint.tooltip}
        </div>
      </div>
    </div>,
    document.body,
  );
}
