import { useSyncExternalStore } from "react";
import { draftPlace, forgetDraft, readDraft } from "../composer/draft-store";
import { requestComposerSubmit } from "../composer/submit-request";
import { closePane } from "./split-actions";
import { splitState } from "./split-state";

/**
 * Closing a split pane that holds an unsent new-session draft asks first. Keep
 * editing (or Escape) leaves the pane; Start session sends the draft from the
 * pane, which stays; Discard drops the draft and closes the pane. A pane with a
 * session, or with nothing typed or attached, closes at once.
 */
export type DraftCloseChoice = "cancel" | "start" | "discard";

export interface DiscardDraftQuestion {
  /** The draft's start, on one line; none when only files are attached. */
  preview?: string;
  answer: (choice: DraftCloseChoice) => void;
}

let question: DiscardDraftQuestion | undefined;
const listeners = new Set<() => void>();

function set(next: DiscardDraftQuestion | undefined) {
  question = next;
  listeners.forEach((listener) => listener());
}

/** The draft's first 60 characters on one line (the original's preview). */
export function draftPreview(text: string) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** Shows the question; resolves with the choice. */
export function askDiscardDraft(text: string): Promise<DraftCloseChoice> {
  question?.answer("cancel");
  return new Promise((resolve) => {
    const asked: DiscardDraftQuestion = {
      preview: text ? draftPreview(text) : undefined,
      answer: (choice) => {
        if (question === asked) set(undefined);
        resolve(choice);
      },
    };
    set(asked);
  });
}

export function useDiscardDraftQuestion() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => question,
    () => question,
  );
}

/**
 * Closes the pane with this key, asking first when it holds an unsent
 * new-session draft. Resolves true when the pane closed.
 */
export async function closePaneAsking(key: string, owner: string) {
  const entry = splitState().panes.find((pane) => pane.key === key);
  if (!entry) return false;
  const place = draftPlace({ mode: "code", pane: key });
  const draft =
    entry.ref.kind === "draft" ? readDraft(owner, place) : undefined;
  const text = draft?.text.trim() ?? "";
  if (!text && !draft?.attachments.length) {
    closePane(key);
    return true;
  }
  const choice = await askDiscardDraft(text);
  if (choice === "start") requestComposerSubmit(`${key}:code`);
  if (choice !== "discard") return false;
  forgetDraft(owner, place);
  closePane(key);
  return true;
}
