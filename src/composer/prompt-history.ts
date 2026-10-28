import type { ComposerField } from "./composer-field";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

/**
 * The prompt history: ↑ in an empty prompt brings back the session's last
 * prompt, then the ones before it; ↓ walks forward and, past the newest,
 * restores the draft. Ctrl+R searches the prompts, newest first: typing
 * narrows, ↑ or Ctrl+R finds an older match, ↓ a newer one, Esc puts the draft
 * back, Enter, Tab, ← → Home and End keep the match. Typing or deleting while a
 * recalled prompt shows keeps it and leaves the history.
 */
export type HistoryHint =
  | { kind: "nav"; index: number; total: number; hasDraft: boolean }
  | {
      kind: "search";
      query: string;
      failed: boolean;
      matchIndex: number;
      total: number;
      showHints: boolean;
    };

/** The search's key hints fade in after this long (the original's 6s). */
export const searchHintDelayMs = 6000;

export interface HistoryPress {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}

/** Ctrl+R alone (the R key on layouts that type another letter there). */
export const isHistorySearchKey = (press: HistoryPress) =>
  (press.key.toLowerCase() === "r" ||
    (press.code === "KeyR" &&
      (/^[^a-z]$/iu.test(press.key) ||
        ["Dead", "Unidentified"].includes(press.key)))) &&
  press.ctrlKey &&
  !press.metaKey &&
  !press.altKey &&
  !press.shiftKey &&
  !press.isComposing;

/** The prompts a search goes through: newest first, each once. */
export function searchOrder(prompts: readonly string[]) {
  const seen = new Set<string>();
  return [...prompts].reverse().filter((prompt) => {
    if (seen.has(prompt)) return false;
    seen.add(prompt);
    return true;
  });
}

/** The first prompt from `from`, stepping by `step`, that contains the query. */
export function findMatch(
  order: readonly string[],
  query: string,
  from: number,
  step: 1 | -1,
) {
  const needle = query.toLowerCase();
  for (let index = from; index >= 0 && index < order.length; index += step)
    if (order[index].toLowerCase().includes(needle)) return index;
  return -1;
}

export function usePromptHistory({
  prompts,
  text,
  setText,
  field,
  enabled,
  resetKey,
}: {
  /** The session's own prompts, oldest first. */
  prompts: readonly string[];
  text: string;
  setText: (text: string, caret: "start" | "end") => void;
  field: RefObject<ComposerField | null>;
  enabled: boolean;
  resetKey?: string;
}) {
  const [hint, setHint] = useState<HistoryHint | null>(null);
  // Navigation: the recalled prompt's place and the draft it replaced.
  const nav = useRef<{ index: number; draft: string; shown: string } | null>(
    null,
  );
  // Search: the order searched, the query, the match and the draft.
  const search = useRef<{
    order: string[];
    query: string;
    index: number;
    draft: string;
  } | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(hintTimer.current), []);
  // Another session, or the history changing under it, ends both.
  useEffect(() => {
    nav.current = null;
    search.current = null;
    setHint(null);
    clearTimeout(hintTimer.current);
  }, [resetKey, prompts.length, enabled]);

  const showSearch = (
    state: Omit<Extract<HistoryHint, { kind: "search" }>, "kind" | "showHints">,
  ) => {
    clearTimeout(hintTimer.current);
    setHint({ kind: "search", ...state, showHints: false });
    hintTimer.current = setTimeout(
      () =>
        setHint((current) =>
          current?.kind === "search"
            ? { ...current, showHints: true }
            : current,
        ),
      searchHintDelayMs,
    );
  };
  const endSearch = (restore: boolean) => {
    const state = search.current;
    search.current = null;
    clearTimeout(hintTimer.current);
    setHint(null);
    if (state && restore) setText(state.draft, "end");
  };
  const step = (query: string, from: number, direction: 1 | -1) => {
    const state = search.current!;
    state.query = query;
    if (!query) {
      state.index = -1;
      setText(state.draft, "end");
      showSearch({
        query,
        failed: false,
        matchIndex: 0,
        total: state.order.length,
      });
      return;
    }
    const found = findMatch(state.order, query, from, direction);
    if (found < 0) {
      showSearch({
        query,
        failed: true,
        matchIndex: 0,
        total: state.order.length,
      });
      return;
    }
    state.index = found;
    setText(state.order[found], "start");
    showSearch({
      query,
      failed: false,
      matchIndex: found + 1,
      total: state.order.length,
    });
  };

  /** Handles the key, returning true when the history took it. */
  const onKeyDown = (event: KeyboardEvent<ComposerField>) => {
    if (!enabled) return false;
    const press: HistoryPress = {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    };
    const searchKey = isHistorySearchKey(press);
    // Search.
    if (search.current) {
      if (
        press.isComposing ||
        ["Dead", "Process"].includes(press.key) ||
        ((press.ctrlKey || press.metaKey) &&
          !press.altKey &&
          ["v", "x"].includes(press.key.toLowerCase()))
      ) {
        endSearch(false);
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      const state = search.current;
      if (searchKey || press.key === "ArrowUp")
        step(state.query, state.index + 1, 1);
      else if (press.key === "ArrowDown")
        step(state.query, state.index - 1, -1);
      else if (press.key === "Escape") endSearch(true);
      else if (press.key === "Backspace")
        state.query === ""
          ? endSearch(true)
          : step(state.query.slice(0, -1), Math.max(state.index, 0), 1);
      else if (
        ["Enter", "Tab", "ArrowLeft", "ArrowRight", "Home", "End"].includes(
          press.key,
        )
      )
        endSearch(false);
      else if (
        press.key.length === 1 &&
        !press.metaKey &&
        !(press.ctrlKey && !press.altKey)
      )
        step(state.query + press.key, Math.max(state.index, 0), 1);
      return true;
    }
    if (searchKey) {
      event.preventDefault();
      event.stopPropagation();
      nav.current = null;
      search.current = {
        order: searchOrder(prompts),
        query: "",
        index: -1,
        draft: text,
      };
      showSearch({
        query: "",
        failed: false,
        matchIndex: 0,
        total: search.current.order.length,
      });
      return true;
    }
    // Navigation.
    if (press.key !== "ArrowUp" && press.key !== "ArrowDown") {
      if (
        nav.current &&
        !press.isComposing &&
        !press.metaKey &&
        !press.ctrlKey &&
        !press.altKey &&
        (press.key.length === 1 ||
          ["Backspace", "Delete", "Enter"].includes(press.key))
      ) {
        nav.current = null;
        setHint(null);
      }
      return false;
    }
    if (
      press.shiftKey ||
      press.metaKey ||
      press.ctrlKey ||
      press.altKey ||
      press.isComposing ||
      !prompts.length
    )
      return false;
    const area = field.current;
    if (!area) return false;
    const up = press.key === "ArrowUp";
    const atEdge = up
      ? area.selectionStart === 0 && area.selectionEnd === 0
      : area.selectionStart === area.value.length &&
        area.selectionEnd === area.value.length;
    if (!atEdge) return false;
    // A recalled prompt that was edited is the draft now.
    if (nav.current && text !== nav.current.shown) {
      nav.current = null;
      setHint(null);
    }
    let index: number;
    let draft: string;
    if (up) {
      if (!nav.current) {
        if (text) return false;
        draft = text;
        index = prompts.length - 1;
      } else {
        draft = nav.current.draft;
        index = Math.max(0, nav.current.index - 1);
      }
    } else {
      if (!nav.current) return false;
      draft = nav.current.draft;
      index = nav.current.index + 1;
    }
    event.preventDefault();
    if (nav.current && index === nav.current.index) return true;
    if (index >= prompts.length) {
      nav.current = null;
      setHint(null);
      setText(draft, "end");
      return true;
    }
    nav.current = { index, draft, shown: prompts[index] };
    setText(prompts[index], up ? "start" : "end");
    setHint({
      kind: "nav",
      index: index + 1,
      total: prompts.length,
      hasDraft: draft.trim() !== "",
    });
    return true;
  };
  return {
    hint,
    onKeyDown,
    /** Leaves the history (a send, a lost focus). */
    reset: () => {
      nav.current = null;
      if (search.current) endSearch(false);
      setHint(null);
    },
  };
}
