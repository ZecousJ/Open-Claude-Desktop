import {
  useEffect,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { MentionFile } from "../../shared/composer-api";
import type { Conversation, Mode } from "../../shared/types";
import { currentCodeEnvironment } from "../ssh/codeEnvironment";
import type { ComposerField } from "./composer-field";
import {
  insertMention,
  mentionAt,
  mentionRanges,
  mentionToken,
} from "./mention";

/**
 * Code's @ file mentions in the composer: the query at the caret, the
 * files the folder offers for it, choosing one (its token then deletes and
 * selects as one and is marked in the accent), the Changes panel's "Attach
 * as context", and the list's keys.
 */
export function useComposerMentions({
  mode,
  text,
  setText,
  caret,
  setCaret,
  active,
  cwd,
  draftIdentity,
  suppressed,
  composer,
}: {
  mode: Mode;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  caret: number;
  setCaret: (caret: number) => void;
  active?: Conversation;
  cwd?: string;
  /** The draft: a new one starts without chosen files. */
  draftIdentity: string;
  /** A slash command or bash line is being written, or a menu is open. */
  suppressed: { slash: boolean; bash: boolean; addMenu: boolean };
  composer: RefObject<ComposerField | null>;
}) {
  const [files, setFiles] = useState<MentionFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  // Files chosen from the @ list. A new draft starts without.
  const [mentioned, setMentioned] = useState<string[]>([]);
  useEffect(() => setMentioned([]), [draftIdentity]);
  // @ file mentions: Code only, with a folder to look in.
  const folder = active ? active.cwd : cwd;
  const tokens =
    mode === "code" && mentioned.length ? mentionRanges(text, mentioned) : [];
  // A chosen file's token is not a query: the caret at its end opens no list.
  const typed =
    mode === "code" && !suppressed.slash && !suppressed.bash && folder
      ? mentionAt(text, caret)
      : null;
  const mention =
    typed && !tokens.some((range) => range.start === typed.start)
      ? typed
      : null;
  const open = Boolean(
    mention && dismissed !== mention.start && !suppressed.addMenu,
  );
  const selectedIndex = Math.min(selected, Math.max(0, files.length - 1));
  useEffect(() => {
    if (!open || !mention) return;
    let current = true;
    setLoading(true);
    const timer = setTimeout(() => {
      window.desktop
        .mentionFiles(
          active
            ? { conversationId: active.id }
            : { folder, environment: currentCodeEnvironment() },
          mention.query,
        )
        .then(
          (list) => current && setFiles(list),
          () => current && setFiles([]),
        )
        .finally(() => current && setLoading(false));
    }, 60);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, mention?.query, folder, active?.id]);
  const choose = (file: MentionFile) => {
    if (!mention) return;
    const next = insertMention(text, mention, caret, file.path);
    setText(next.text);
    setCaret(next.caret);
    setSelected(0);
    setMentioned((paths) =>
      paths.includes(file.path) ? paths : [...paths, file.path],
    );
    requestAnimationFrame(() => {
      composer.current?.focus();
      composer.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  // The Changes panel's Attach as context: the file joins the draft as a
  // mention at its end.
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (
        event as CustomEvent<{ conversationId?: string; path?: string }>
      ).detail;
      if (
        mode !== "code" ||
        !detail?.path ||
        detail.conversationId !== active?.id
      )
        return;
      const path = detail.path;
      setText((current) => {
        const token = mentionToken(path) + " ";
        return current && !/\s$/.test(current)
          ? `${current} ${token}`
          : `${current}${token}`;
      });
      setMentioned((paths) =>
        paths.includes(path) ? paths : [...paths, path],
      );
      requestAnimationFrame(() => {
        const field = composer.current;
        if (!field) return;
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      });
    };
    window.addEventListener("claudex:attach-path", listener);
    return () => window.removeEventListener("claudex:attach-path", listener);
  }, [mode, active?.id]);
  /** The list's keys; true when the key was the list's. */
  const keyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!open || !mention) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(
        (value) =>
          (value + (e.key === "ArrowDown" ? 1 : -1) + files.length) %
          Math.max(1, files.length),
      );
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(mention.start);
      return true;
    }
    if (
      (e.key === "Enter" || e.key === "Tab") &&
      !e.nativeEvent.isComposing &&
      files[selectedIndex]
    ) {
      e.preventDefault();
      choose(files[selectedIndex]);
      return true;
    }
    return false;
  };
  return {
    /** The files chosen from the list. */
    mentioned,
    /** The chosen files' token ranges in the text (MentionMirror). */
    tokens,
    /** The query being typed, when there is one. */
    mention,
    open,
    files,
    loading,
    selected: selectedIndex,
    setSelected,
    choose,
    keyDown,
    /** Closes the list for the query being typed (blur). */
    dismiss: () => mention && setDismissed(mention.start),
    /** The list may show again (focus). */
    reset: () => setDismissed(null),
  };
}
