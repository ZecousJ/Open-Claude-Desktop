import { coworkComputerWaiting } from "../../shared/remote-devices";
import { t, formatText } from "../i18n";
import { updateRequiredPlaceholder } from "../../shared/client-release";
import { shortcutText } from "../ui/Tooltip";
import { codeOutputPlaceholder } from "./code-output-model";
import { snapToMentions, mentionRanges, deleteMention } from "./mention";
import { editLastMessageEvent } from "./double-escape";
import { enterAction, plainEnterSends } from "./enter-key";
import type { Conversation, Attachment, Mode } from "../../shared/types";
import {
  autoResolveSlash,
  type CodeSlashCommand,
} from "./code/code-slash-commands";
import type { ComposerField } from "./composer-field";
import { watchComposerWidth } from "./composer-fit";
import type { HistoryHint } from "./prompt-history";
import type { HostInfo } from "../../shared/host";
import type { MentionRange, MentionMatch } from "./mention";
import type { MentionFile } from "../../shared/composer-api";
import type { PendingAttachment } from "./Attachments";
import type { ReviewComment } from "../changes/review-comments";
import type { SkillToken } from "./skill-tokens";

/** What messageFieldPropsOf needs from ComposerView.tsx. */
export interface MessageFieldPropsOfKit {
  active: Conversation | undefined;
  addMenu: boolean;
  artifactOutput: "docs" | "slides" | "design" | "dashboard" | undefined;
  attachments: Attachment[];
  bash: boolean;
  bashAvailable: boolean;
  caret: number;
  chooseSlash: (command: CodeSlashCommand) => void;
  compactPlaceholder: boolean;
  composer: React.RefObject<ComposerField | null>;
  dictation: {
    live: boolean;
    onLive(spoken: string): void;
    onTranscript(spoken: string): void;
    onCancel(): void;
  };
  firstRun: boolean;
  forkSendAvailable: boolean;
  fullPlaceholder: string;
  history: {
    hint: HistoryHint | null;
    onKeyDown: (event: React.KeyboardEvent<ComposerField>) => boolean;
    reset: () => void;
  };
  host: HostInfo;
  mentioned: string[];
  mentions: {
    mentioned: string[];
    tokens: MentionRange[];
    mention: MentionMatch | null;
    open: boolean;
    files: MentionFile[];
    loading: boolean;
    selected: number;
    setSelected: React.Dispatch<React.SetStateAction<number>>;
    choose: (file: MentionFile) => void;
    keyDown: (e: React.KeyboardEvent<HTMLElement>) => boolean;
    dismiss: () => void | null;
    reset: () => void;
  };
  mode: Mode;
  modelMenu: boolean;
  onFork: ((prompt: string) => void) | undefined;
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  pending: PendingAttachment[];
  pendingSlash: string | null;
  platform: NodeJS.Platform;
  previewShown: boolean;
  promptSuggestion: string | undefined;
  recall: (
    event: {
      key: string;
      repeat: boolean;
      isComposing: boolean;
      defaultPrevented: boolean;
      metaKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
    },
    enabled: boolean,
    now?: number | undefined,
  ) => boolean;
  reviewNotes: ReviewComment[];
  runPendingSlash: () => void;
  running: boolean;
  selectedSlash: number;
  sending: boolean;
  setBashMode: React.Dispatch<React.SetStateAction<boolean>>;
  setCaret: React.Dispatch<React.SetStateAction<number>>;
  setPendingSlash: React.Dispatch<React.SetStateAction<string | null>>;
  setSlashDismissed: React.Dispatch<React.SetStateAction<boolean>>;
  setSlashPlaceholderGone: React.Dispatch<React.SetStateAction<boolean>>;
  setSlashSelected: React.Dispatch<React.SetStateAction<number>>;
  setSlashTokenSelected: React.Dispatch<React.SetStateAction<boolean>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  skillRanges: SkillToken[];
  slashCommands: CodeSlashCommand[];
  slashOpen: boolean;
  slashPlaceholder: string;
  slashPlaceholderGone: boolean;
  slashTokenSelected: boolean;
  submit: (options?: { later?: boolean | undefined } | undefined) => void;
  text: string;
  updateRequired: boolean;
  voicePlaceholderText:
    | "Connecting..."
    | "Listening..."
    | "Reconnecting..."
    | "Processing..."
    | "Claudex is speaking..."
    | undefined;
}

export function messageFieldPropsOf(kit: MessageFieldPropsOfKit) {
  const {
    active,
    addMenu,
    artifactOutput,
    attachments,
    bash,
    bashAvailable,
    caret,
    chooseSlash,
    compactPlaceholder,
    composer,
    dictation,
    firstRun,
    forkSendAvailable,
    fullPlaceholder,
    history,
    host,
    mentioned,
    mentions,
    mode,
    modelMenu,
    onFork,
    onPaste,
    pending,
    pendingSlash,
    platform,
    previewShown,
    promptSuggestion,
    recall,
    reviewNotes,
    runPendingSlash,
    running,
    selectedSlash,
    sending,
    setBashMode,
    setCaret,
    setPendingSlash,
    setSlashDismissed,
    setSlashPlaceholderGone,
    setSlashSelected,
    setSlashTokenSelected,
    setText,
    skillRanges,
    slashCommands,
    slashOpen,
    slashPlaceholder,
    slashPlaceholderGone,
    slashTokenSelected,
    submit,
    text,
    updateRequired,
    voicePlaceholderText,
  } = kit;
  const messageFieldProps: React.ComponentPropsWithRef<"textarea"> &
    Record<`data-${string}`, unknown> = {
    ref: (field) => {
      composer.current = field;
      watchComposerWidth(field);
    },
    "data-previewing": previewShown || undefined,
    "aria-label": mode === "code" ? "Prompt" : "Write your prompt to Claudex",
    "data-bash-mode": bash || undefined,
    disabled: updateRequired || coworkComputerWaiting(active),
    readOnly: dictation.live,
    placeholder: coworkComputerWaiting(active)
      ? t("Waiting for your computer")
      : updateRequired
        ? updateRequiredPlaceholder
        : ((voicePlaceholderText && t(voicePlaceholderText)) ??
          (bash
            ? "Enter a shell command"
            : mode === "code"
              ? pendingSlash
                ? slashPlaceholderGone
                  ? ""
                  : slashPlaceholder
                : active
                  ? reviewNotes.length && !running
                    ? "Address these review comments"
                    : running
                      ? // While a turn runs (the reference design,
                        // How to send and how to queue.
                        formatText(
                          "{sendKey} to send, {queueKey} to queue for later",
                          {
                            sendKey: shortcutText(platform, ["↵"]),
                            queueKey: shortcutText(platform, ["mod", "↵"]),
                          },
                        )
                      : (promptSuggestion ?? "Type / for commands")
                  : artifactOutput
                    ? codeOutputPlaceholder(artifactOutput)
                    : firstRun
                      ? "Describe something to build, change, or fix"
                      : "Describe a task or ask a question"
              : compactPlaceholder
                ? t("Ask Claudex…")
                : fullPlaceholder)),
    value: text,
    onChange: (e) => {
      // "!" in an empty draft enters Bash mode and is not typed.
      if (bashAvailable && !bash && !text && e.target.value === "!") {
        setBashMode(true);
        return;
      }
      // "/name " that names exactly one listed command turns into its chip and
      // what follows is the argument.
      const resolved =
        mode === "code" && !pendingSlash && !bash
          ? autoResolveSlash(text, e.target.value, slashCommands)
          : undefined;
      if (resolved) {
        setPendingSlash(resolved.command.name);
        setSlashDismissed(true);
        setText(resolved.rest);
        setCaret(0);
        return;
      }
      setText(e.target.value);
      setCaret(e.target.selectionStart ?? e.target.value.length);
      setSlashSelected(0);
      setSlashDismissed(false);
      mentions.setSelected(0);
    },
    onSelect: (e) => {
      const area = e.currentTarget;
      // A caret or selection never splits a chosen file's token.
      if ((mode === "code" && mentioned.length) || skillRanges.length) {
        const snapped = snapToMentions(
          area.selectionStart,
          area.selectionEnd,
          mode === "code" ? mentionRanges(area.value, mentioned) : skillRanges,
          caret,
        );
        if (
          snapped.start !== area.selectionStart ||
          snapped.end !== area.selectionEnd
        )
          area.setSelectionRange(
            snapped.start,
            snapped.end,
            area.selectionDirection,
          );
      }
      setCaret(area.selectionStart ?? text.length);
    },
    onPaste: onPaste,
    onBlur: () => {
      setSlashDismissed(true);
      mentions.dismiss();
    },
    onFocus: mentions.reset,
    onKeyDown: (e) => {
      if (
        promptSuggestion &&
        (e.key === "Tab" || e.key === "ArrowRight") &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.nativeEvent.isComposing &&
        !dictation.live
      ) {
        e.preventDefault();
        setText(promptSuggestion);
        return;
      }
      if (
        recall(
          {
            key: e.key,
            repeat: e.repeat,
            isComposing: e.nativeEvent.isComposing || e.keyCode === 229,
            defaultPrevented: e.defaultPrevented,
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
            altKey: e.altKey,
            shiftKey: e.shiftKey,
          },
          mode === "chat" &&
            Boolean(active?.turns.length) &&
            !running &&
            !sending &&
            !text &&
            !attachments.length &&
            !pending.length &&
            !dictation.live &&
            !modelMenu &&
            !addMenu &&
            !document.querySelector('[role="dialog"], [role="menu"]'),
        )
      ) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(
          new CustomEvent(editLastMessageEvent, { detail: active?.id }),
        );
        return;
      }
      // While dictation writes the draft, Enter does not send the half-heard text.
      if (dictation.live && e.key === "Enter") {
        e.preventDefault();
        return;
      }
      if (history.onKeyDown(e)) return;
      if (bash && !e.nativeEvent.isComposing) {
        if (e.key === "Backspace" && !text) {
          e.preventDefault();
          setBashMode(false);
          return;
        }
        // While a reply runs, Escape stops it (the document's listener).
        if (e.key === "Escape" && !running) {
          e.preventDefault();
          setBashMode(false);
          return;
        }
      }
      if (pendingSlash) {
        if (e.key === "Backspace" && !text) {
          e.preventDefault();
          if (slashPlaceholder && !slashPlaceholderGone)
            setSlashPlaceholderGone(true);
          else if (!slashTokenSelected) setSlashTokenSelected(true);
          else setPendingSlash(null);
          return;
        }
        if (slashTokenSelected && e.key !== "Enter")
          setSlashTokenSelected(false);
        if (e.key === "Escape" && !running) {
          e.preventDefault();
          composer.current?.blur();
          return;
        }
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          runPendingSlash();
          return;
        }
      }
      // Backspace or Delete next to a chosen file's token takes the
      // whole token.
      if (
        (e.key === "Backspace" || e.key === "Delete") &&
        skillRanges.length &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.nativeEvent.isComposing &&
        e.currentTarget.selectionStart === e.currentTarget.selectionEnd
      ) {
        const at = e.currentTarget.selectionStart;
        const token = skillRanges.find((range) =>
          e.key === "Backspace"
            ? at > range.start && at <= range.end
            : at >= range.start && at < range.end,
        );
        if (token) {
          e.preventDefault();
          // Source shared9 Cq.Backspace selects the atomic node first;
          // the next deletion removes the selected reference normally.
          e.currentTarget.setSelectionRange(token.start, token.end);
          return;
        }
      }
      if (
        (e.key === "Backspace" || e.key === "Delete") &&
        mode === "code" &&
        mentioned.length &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.nativeEvent.isComposing &&
        e.currentTarget.selectionStart === e.currentTarget.selectionEnd
      ) {
        const area = e.currentTarget;
        const next = deleteMention(
          area.value,
          area.selectionStart,
          mentionRanges(area.value, mentioned),
          e.key,
        );
        if (next) {
          e.preventDefault();
          setText(next.text);
          setCaret(next.caret);
          requestAnimationFrame(() =>
            composer.current?.setSelectionRange(next.caret, next.caret),
          );
          return;
        }
      }
      if (mentions.keyDown(e)) return;
      if (slashOpen) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setSlashSelected(
            (value) =>
              (value +
                (e.key === "ArrowDown" ? 1 : -1) +
                slashCommands.length) %
              Math.max(1, slashCommands.length),
          );
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setSlashDismissed(true);
          return;
        }
        // Tab chooses the lit row as Enter does.
        if (
          (e.key === "Enter" ||
            (e.key === "Tab" &&
              !e.shiftKey &&
              !e.ctrlKey &&
              !e.altKey &&
              !e.metaKey)) &&
          !e.nativeEvent.isComposing
        ) {
          e.preventDefault();
          if (slashCommands[selectedSlash])
            chooseSlash(slashCommands[selectedSlash]);
          return;
        }
      }
      // ⌥⌘↵ (Ctrl+Alt+Enter elsewhere) sends the draft in a forked session, as
      // `/fork <prompt>`. A fork carries no attachments, so with files attached
      // the key keeps its new line.
      if (
        forkSendAvailable &&
        e.key === "Enter" &&
        e.altKey &&
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.nativeEvent.isComposing &&
        !bash &&
        text.trim() &&
        !attachments.length &&
        !pending.length
      ) {
        e.preventDefault();
        if (e.repeat) return;
        const prompt = text.trim();
        setText("");
        onFork?.(prompt);
        return;
      }
      // On a touch screen a plain Enter starts a new line (enter-key.ts).
      if (
        enterAction(
          {
            key: e.key,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
            isComposing: e.nativeEvent.isComposing,
          },
          plainEnterSends(host.kind === "desktop"),
        ) === "send"
      ) {
        e.preventDefault();
        // ⌘↵ while a reply runs queues the message for after it. Files
        // still being added make the send wait for them (Composer submit).
        submit({ later: e.metaKey || e.ctrlKey });
      }
    },
    rows: 1,
  };
  return messageFieldProps;
}
