/**
 * Back/forward history of what the window shows: a page, or on the chat page
 * a conversation or the new-chat draft, on one of the two sidebar surfaces.
 * Incognito chats are never recorded, since they disappear when left.
 */
export type Surface = "chat" | "code";
export type NavEntry = {
  page: string;
  surface: Surface;
  /** The open conversation on the chat page; absent for the new-chat draft. */
  conversationId?: string;
  artifactId?: string;
};
export type NavHistory = {
  back: NavEntry[];
  current: NavEntry;
  forward: NavEntry[];
};

/** Entries kept behind the current one. */
export const maxHistory = 50;

export const sameEntry = (a: NavEntry, b: NavEntry) =>
  a.page === b.page &&
  a.surface === b.surface &&
  (a.page !== "chat" || a.conversationId === b.conversationId) &&
  (!["chat", "artifact"].includes(a.page) || a.artifactId === b.artifactId);

export const startHistory = (current: NavEntry): NavHistory => ({
  back: [],
  current,
  forward: [],
});

/** Records a navigation; going somewhere new clears the forward entries. */
export function navigate(history: NavHistory, entry: NavEntry): NavHistory {
  if (sameEntry(history.current, entry)) return history;
  return {
    back: [...history.back, history.current].slice(-maxHistory),
    current: entry,
    forward: [],
  };
}

/** Swaps the current entry, e.g. when the draft becomes the chat it started. */
export const replaceCurrent = (
  history: NavHistory,
  entry: NavEntry,
): NavHistory => ({ ...history, current: entry });

/**
 * Steps back (or forward) to the nearest entry that can still be shown,
 * dropping ones whose conversation was deleted. Undefined when there is none.
 */
export function step(
  history: NavHistory,
  direction: "back" | "forward",
  valid: (entry: NavEntry) => boolean,
): NavHistory | undefined {
  const back = [...history.back];
  const forward = [...history.forward];
  if (direction === "back") {
    while (back.length) {
      const entry = back.pop()!;
      if (valid(entry))
        return { back, current: entry, forward: [history.current, ...forward] };
    }
  } else {
    while (forward.length) {
      const entry = forward.shift()!;
      if (valid(entry))
        return { back: [...back, history.current], current: entry, forward };
    }
  }
  return undefined;
}

/**
 * Steps from a location that was not recorded (an incognito chat): back
 * returns to the last recorded entry itself, which is still where the window
 * was before it; forward steps as usual.
 */
export function stepFromUnrecorded(
  history: NavHistory,
  direction: "back" | "forward",
  valid: (entry: NavEntry) => boolean,
): NavHistory | undefined {
  if (direction === "back" && valid(history.current)) return history;
  return step(history, direction, valid);
}

/** Whether a step in that direction would land somewhere. */
export const canStep = (
  history: NavHistory,
  direction: "back" | "forward",
  valid: (entry: NavEntry) => boolean,
) => (direction === "back" ? history.back : history.forward).some(valid);
