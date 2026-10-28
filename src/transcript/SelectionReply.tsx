import { Suspense, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquareMore, Reply } from "../ui/glyphs";
import { useT } from "../i18n";
import { AppContext } from "../app/AppContext";
import { usePolicy } from "../policy/PolicyContext";
import { useVoiceAvailability } from "../voice/useVoiceAvailability";
import { useSpeechEngine } from "../voice/useSpeechEngine";
import { preference, preferenceDefaults } from "../../shared/settings-extras";
import { acceleratorLabel, pressMatches } from "../../shared/accelerator";
import { useTooltip } from "../ui/Tooltip";
import { AppIcon } from "../ui/app-icon";
import { lazyPiece } from "../ui/lazy-piece";

const SelectionDictation = lazyPiece(
  () => import("../voice/SelectionDictation"),
  "SelectionDictation",
);

/** Selection actions. */
export function SelectionReplyActions({
  onReply,
  onDictate,
  shortcut = "",
  platform = "",
}: {
  onReply: () => void;
  onDictate?: () => void;
  shortcut?: string;
  platform?: string;
}) {
  const t = useT();
  const hint = useTooltip("Dictate a reply", {
    detail: shortcut ? acceleratorLabel(shortcut, platform) : undefined,
    disabled: !onDictate,
  });
  return (
    <>
      <button type="button" onClick={onReply}>
        {t("Reply")}
        <Reply size={16} strokeWidth={1.8} />
      </button>
      {onDictate && (
        <>
          <span aria-hidden="true" />
          <button
            {...hint.props}
            type="button"
            className="selection-dictate"
            aria-label={t("Dictate a reply")}
            aria-keyshortcuts={
              shortcut
                ? shortcut
                    .replace(
                      /CommandOrControl/g,
                      platform === "darwin" ? "Meta" : "Control",
                    )
                    .replace(/Command|Super/g, "Meta")
                    .replace(/Option/g, "Alt")
                : undefined
            }
            onClick={onDictate}
          >
            <AppIcon name="Microphone" />
          </button>
          {hint.tooltip}
        </>
      )}
    </>
  );
}

/** The selection quoted into the composer: each line as Markdown quote. */
export function quoteSelection(text: string) {
  return (
    text
      .trim()
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n") + "\n\n"
  );
}

/**
 * "Reply ↰" over text selected in a reply: an 81×32 black pill centred over the
 * selection, 7px above its top line. It quotes the selection into the composer
 * and puts the caret after it. Where a side chat can be asked, "Start a side
 * chat" (once one has been used, "Send to side chat") comes first in the same
 * pill, split by a hairline, as the original's selection actions are; it opens
 * the side chat with the selection staged as the context of the next question.
 */
export function SelectionReply({
  container,
  onReply,
  sideChat,
}: {
  /** The transcript; only selections inside its replies count. */
  container: React.RefObject<HTMLElement | null>;
  /** Left out where replies cannot be quoted (Code). */
  onReply?: (quote: string) => void;
  /** Left out where no side chat can be started. */
  sideChat?: { started: () => boolean; onSelect: (text: string) => void };
}) {
  const t = useT();
  const app = useContext(AppContext);
  const policy = usePolicy();
  const voice = useVoiceAvailability(app?.providerId ?? "");
  const engine = useSpeechEngine(policy.voice, voice);
  const shortcut = app
    ? preference(app.snapshot.settings, "dictationShortcut")
    : preferenceDefaults.dictationShortcut;
  const platform =
    app?.snapshot.platform ??
    (/Mac/.test(globalThis.navigator?.platform ?? "") ? "darwin" : "linux");
  const [dictating, setDictating] = useState<{ range: Range; text: string }>();
  useEffect(() => setDictating(undefined), [engine]);
  const [place, setPlace] = useState<{
    left: number;
    top: number;
    text: string;
    range: Range;
  }>();
  useEffect(() => {
    const update = () => {
      const selection = document.getSelection();
      const text = selection?.toString() ?? "";
      if (!selection || selection.isCollapsed || !text.trim())
        return setPlace(undefined);
      const range = selection.getRangeAt(0);
      const reply = (node: Node | null) =>
        (node instanceof Element ? node : node?.parentElement)?.closest(
          ".assistant-content .markdown",
        );
      const start = reply(range.startContainer);
      if (
        !start ||
        !container.current?.contains(start) ||
        reply(range.endContainer) !== start
      )
        return setPlace(undefined);
      const box = range.getClientRects()[0] ?? range.getBoundingClientRect();
      const whole = range.getBoundingClientRect();
      setPlace({
        left: whole.left + whole.width / 2,
        top: box.top - 7,
        text,
        range: range.cloneRange(),
      });
    };
    const clear = () => setPlace(undefined);
    document.addEventListener("selectionchange", update);
    container.current?.addEventListener("scroll", clear, { passive: true });
    const scroller = container.current;
    return () => {
      document.removeEventListener("selectionchange", update);
      scroller?.removeEventListener("scroll", clear);
    };
  }, [container]);
  const dictate = () => {
    if (!place || !engine || !onReply) return;
    setDictating({ range: place.range, text: place.text });
    document.getSelection()?.removeAllRanges();
    setPlace(undefined);
  };
  useEffect(() => {
    if (!place || !engine || !onReply || !shortcut) return;
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        !pressMatches(event, shortcut, platform)
      )
        return;
      event.preventDefault();
      dictate();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [place, engine, onReply, shortcut, platform]);
  if (dictating && engine && onReply)
    return (
      <Suspense fallback={null}>
        <SelectionDictation
          selection={dictating}
          engine={engine}
          maxSeconds={voice?.maxSeconds ?? null}
          shortcut={shortcut}
          platform={platform}
          boundary={container}
          onError={(error) => app?.report(error)}
          onReply={(reply) => {
            onReply(quoteSelection(dictating.text) + reply + "\n\n");
            setDictating(undefined);
          }}
          onClose={() => setDictating(undefined)}
        />
      </Suspense>
    );
  if (!place || (!onReply && !sideChat)) return null;
  const finish = () => {
    document.getSelection()?.removeAllRanges();
    setPlace(undefined);
  };
  return createPortal(
    <div
      className="selection-reply"
      role="group"
      style={{ left: place.left, top: place.top }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {sideChat && (
        <button
          type="button"
          onClick={() => {
            sideChat.onSelect(place.text);
            finish();
          }}
        >
          {sideChat.started() ? t("Send to side chat") : t("Start a side chat")}
          <MessageSquareMore size={16} strokeWidth={1.8} />
        </button>
      )}
      {sideChat && onReply && <span aria-hidden="true" />}
      {onReply && (
        <SelectionReplyActions
          shortcut={shortcut}
          platform={platform}
          onDictate={engine ? dictate : undefined}
          onReply={() => {
            onReply(quoteSelection(place.text));
            finish();
          }}
        />
      )}
    </div>,
    document.body,
  );
}
