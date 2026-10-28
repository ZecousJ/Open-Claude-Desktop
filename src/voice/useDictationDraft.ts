import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/** The draft with spoken text after it, separated by a space. */
export function withSpoken(draft: string, spoken: string) {
  if (!spoken) return draft;
  return `${draft}${draft && !/\s$/.test(draft) ? " " : ""}${spoken}`;
}

/**
 * Puts dictation into the composer's draft (package C6): while recording,
 * the draft shows what was typed before plus the transcript so far; the
 * final transcript replaces it, and Escape brings back what was typed.
 * `live` is true while the recording writes into the draft.
 */
export function useDictationDraft(
  text: string,
  setText: Dispatch<SetStateAction<string>>,
  contextKey: string,
  focus: () => void,
) {
  const typed = useRef<string | null>(null),
    current = useRef(text);
  current.current = text;
  const [live, setLive] = useState(false);
  useEffect(() => {
    typed.current = null;
    setLive(false);
  }, [contextKey]);
  return {
    live,
    onLive(spoken: string) {
      typed.current ??= current.current;
      setText(withSpoken(typed.current, spoken));
      setLive(true);
    },
    onTranscript(spoken: string) {
      const before = typed.current ?? current.current;
      typed.current = null;
      setText(withSpoken(before, spoken));
      setLive(false);
      focus();
    },
    onCancel() {
      if (typed.current !== null) setText(typed.current);
      typed.current = null;
      setLive(false);
    },
  };
}
