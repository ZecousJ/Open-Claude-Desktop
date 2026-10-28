import { useEffect, useRef } from "react";
import type { Attachment } from "../../shared/types";
import { validSkillTokens, type SkillToken } from "./skill-tokens";

/**
 * Unsent drafts, one per composer.
 *
 * The text of a conversation's or a home's draft is kept in the browser's
 * storage for the account (at most `storedLimit` drafts, the oldest go first,
 * as the original keeps 50). Attached files stay for the window's lifetime
 * only: the service clears uploads that were never sent. An incognito chat's
 * draft and a split pane's new-session draft are never written to storage (the
 * original does not keep pane drafts either).
 */
export interface Draft {
  text: string;
  attachments: Attachment[];
  skillTokens?: SkillToken[];
}

/** Where a composer's draft lives. */
export interface DraftPlace {
  key: string;
  /** Kept in the browser's storage between launches. */
  persist: boolean;
}

export const storedLimit = 50;
const prefix = "claudex:composer-draft:v1:";

interface StoredDraft {
  text: string;
  storedAt: number;
  skillTokens?: SkillToken[];
}

/** The storage the drafts are written to (the browser's, or a test's). */
export interface DraftStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const browserStorage = (): DraftStorage | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

const memory = new Map<string, Draft>();
const memoryKey = (owner: string, key: string) => `${owner}\n${key}`;
const storageKey = (owner: string, key: string) => `${prefix}${owner}:${key}`;

/** The composer's place: the open conversation's, or the home's for its surface. */
export function draftPlace({
  conversationId,
  mode,
  incognito,
  pane,
}: {
  conversationId?: string;
  mode: string;
  incognito?: boolean;
  /** A split pane's key, for its new-session draft. */
  pane?: string;
}): DraftPlace {
  if (incognito)
    return { key: `incognito:${conversationId ?? "new"}`, persist: false };
  if (conversationId) return { key: conversationId, persist: true };
  if (pane) return { key: `pane:${pane}`, persist: false };
  // Chat and Cowork start from one home; Code has its own (the original's
  // separate Code draft).
  return { key: mode === "code" ? "new:code" : "new:chat", persist: true };
}

function readStored(storage: DraftStorage, name: string) {
  try {
    const raw = storage.getItem(name);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<StoredDraft>;
    return typeof value?.text === "string" && value.text
      ? {
          text: value.text,
          storedAt: Number(value.storedAt) || 0,
          skillTokens: validSkillTokens(value.text, value.skillTokens),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The draft kept for this place, if any. */
export function readDraft(
  owner: string,
  place: DraftPlace,
  storage = browserStorage(),
): Draft | undefined {
  const held = memory.get(memoryKey(owner, place.key));
  if (held) return held;
  if (!place.persist || !storage) return undefined;
  const stored = readStored(storage, storageKey(owner, place.key));
  return stored
    ? {
        text: stored.text,
        attachments: [],
        ...(stored.skillTokens.length
          ? { skillTokens: stored.skillTokens }
          : {}),
      }
    : undefined;
}

/** Keeps the draft for this place; an empty one is forgotten. */
export function writeDraft(
  owner: string,
  place: DraftPlace,
  draft: Draft,
  storage = browserStorage(),
  now = Date.now(),
) {
  const name = memoryKey(owner, place.key);
  const skillTokens = validSkillTokens(draft.text, draft.skillTokens);
  const empty = !draft.text && !draft.attachments.length;
  if (empty) memory.delete(name);
  else
    memory.set(name, {
      text: draft.text,
      attachments: draft.attachments,
      ...(skillTokens.length ? { skillTokens } : {}),
    });
  if (!place.persist || !storage) return;
  const key = storageKey(owner, place.key);
  try {
    if (!draft.text.trim()) {
      storage.removeItem(key);
      return;
    }
    const added = storage.getItem(key) === null;
    storage.setItem(
      key,
      JSON.stringify({
        text: draft.text,
        storedAt: now,
        ...(skillTokens.length ? { skillTokens } : {}),
      } satisfies StoredDraft),
    );
    if (added) trimStored(owner, storage);
  } catch {
    /* Storage is full or blocked: the draft lasts for this window only. */
  }
}

/** Forgets a place's draft (a split pane's draft was discarded). */
export function forgetDraft(
  owner: string,
  place: DraftPlace,
  storage = browserStorage(),
) {
  writeDraft(owner, place, { text: "", attachments: [] }, storage);
}

/** Drops the oldest stored drafts past the limit. */
function trimStored(owner: string, storage: DraftStorage) {
  const own = `${prefix}${owner}:`;
  const entries: { name: string; at: number }[] = [];
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index);
    if (!name?.startsWith(own)) continue;
    entries.push({ name, at: readStored(storage, name)?.storedAt ?? 0 });
  }
  if (entries.length <= storedLimit) return;
  entries
    .sort((a, b) => a.at - b.at)
    .slice(0, entries.length - storedLimit)
    .forEach(({ name }) => storage.removeItem(name));
}

/** Forgets every draft of the account (signing out, as the original clears its drafts then). */
export function forgetAccountDrafts(owner: string, storage = browserStorage()) {
  for (const name of [...memory.keys()])
    if (name.startsWith(`${owner}\n`)) memory.delete(name);
  if (!storage) return;
  const own = `${prefix}${owner}:`;
  try {
    const names: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const name = storage.key(index);
      if (name?.startsWith(own)) names.push(name);
    }
    names.forEach((name) => storage.removeItem(name));
  } catch {
    /* Blocked storage holds no drafts. */
  }
}

/** Clears the window's held drafts (tests). */
export function resetDraftMemory() {
  memory.clear();
}

/**
 * What the composer does when it shows a place: it brings back the place's
 * draft, unless the same change also put something new in the composer (a
 * prompt opened in a new session, a fork's message), which then belongs to
 * the new place.
 */
export function restoresOnSwitch(
  previous: { text: string; attachments: Attachment[] } | undefined,
  draft: Draft,
) {
  if (!previous) return true;
  if (!draft.text && !draft.attachments.length) return true;
  return (
    draft.text === previous.text && draft.attachments === previous.attachments
  );
}

/**
 * Keeps the composer's draft for its place and brings back the draft of a
 * place it shows again.
 */
export function usePlacedDraft({
  owner,
  place,
  text,
  attachments,
  setText,
  setAttachments,
  skillTokens,
  setSkillTokens,
}: {
  owner: string;
  place: DraftPlace;
  text: string;
  attachments: Attachment[];
  setText: (text: string) => void;
  setAttachments: (attachments: Attachment[]) => void;
  skillTokens?: SkillToken[];
  setSkillTokens?: (tokens: SkillToken[]) => void;
}) {
  const shown = useRef<
    { key: string; text: string; attachments: Attachment[] } | undefined
  >(undefined);
  useEffect(() => {
    const previous = shown.current;
    const key = memoryKey(owner, place.key);
    if (previous?.key !== key) {
      const current = { text, attachments };
      if (restoresOnSwitch(previous, current)) {
        const saved = readDraft(owner, place);
        const next = {
          text: saved?.text ?? "",
          attachments: saved?.attachments ?? [],
          skillTokens: saved?.skillTokens ?? [],
        };
        shown.current = { key, ...next };
        if (next.text !== text) setText(next.text);
        setSkillTokens?.(next.skillTokens);
        if (next.attachments.length || attachments.length)
          setAttachments(next.attachments);
        return;
      }
    }
    shown.current = { key, text, attachments };
    writeDraft(owner, place, { text, attachments, skillTokens });
  }, [owner, place.key, place.persist, text, attachments, skillTokens]);
}
