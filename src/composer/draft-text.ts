import { useSyncExternalStore, type SetStateAction } from "react";
import {
  editSkillTokens,
  validSkillTokens,
  type SkillToken,
} from "./skill-tokens";

export interface DraftText {
  text: string;
  skillTokens: SkillToken[];
}

/**
 * The composer's unsent text and its skill tokens, outside the app's React
 * state: a keystroke re-renders only what subscribes (the composer, the
 * draft's saving and sizing, the menu sync), not the whole window with its
 * transcript and sidebar. Event handlers read `text` when they run.
 * Programmatic edits, dictation and typing share the same text/token state.
 */
export class DraftTextStore {
  private draft: DraftText;
  private listeners = new Set<() => void>();

  constructor(initialText = "") {
    this.draft = { text: initialText, skillTokens: [] };
  }

  get text() {
    return this.draft.text;
  }
  get skillTokens() {
    return this.draft.skillTokens;
  }
  /** The current snapshot; a new object only when something changed. */
  readonly snapshot = () => this.draft;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly setText = (value: SetStateAction<string>) => {
    const current = this.draft;
    const text = typeof value === "function" ? value(current.text) : value;
    if (text === current.text) return;
    this.publish({
      text,
      skillTokens: editSkillTokens(current.text, text, current.skillTokens),
    });
  };

  readonly setSkillTokens = (value: SetStateAction<SkillToken[]>) => {
    const current = this.draft;
    this.publish({
      ...current,
      skillTokens: validSkillTokens(
        current.text,
        typeof value === "function" ? value(current.skillTokens) : value,
      ),
    });
  };

  private publish(next: DraftText) {
    this.draft = next;
    for (const listener of [...this.listeners]) listener();
  }
}

const noSubscription = () => () => {};

/** Subscribes a component to the draft (re-renders on every edit). */
export function useDraftText(store: DraftTextStore): DraftText {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

/**
 * The app's draft for a component: live from its store, or, for a
 * controller built without one (a stand-in in tests), its plain fields.
 */
export function useAppDraft(app: {
  draft?: DraftTextStore;
  text?: string;
  skillTokens?: SkillToken[];
}): DraftText {
  const store = app.draft;
  const live = useSyncExternalStore(
    store ? store.subscribe : noSubscription,
    store ? store.snapshot : () => undefined,
    store ? store.snapshot : () => undefined,
  );
  return live ?? { text: app.text ?? "", skillTokens: app.skillTokens ?? [] };
}
