/**
 * The window's Research state that App's controller does not hold (R4,
 * design R45 §4.1–4.4): whether the new-chat draft starts in Research mode,
 * which Research turn the side panel shows, and the latest progress the
 * main process pushed for each Research turn (between conversation
 * updates). Module-level stores read with useSyncExternalStore.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { ResearchState } from "../../shared/research";
import type { Conversation, Turn } from "../../shared/types";

type Listener = () => void;

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

// --- The new chat's Research switch -------------------------------------

const draft = store(false);

/** Whether the new-chat draft starts in Research mode. */
export const getDraftResearch = () => draft.get();
/** Turns Research on or off for the new-chat draft. */
export const setDraftResearch = (on: boolean) => draft.set(on);

/** The new-chat draft's Research switch. */
export function useResearchDraft() {
  return useSyncExternalStore(draft.subscribe, draft.get, draft.get);
}

// --- The Research side panel ---------------------------------------------

/** The Research turn the side panel shows. */
export interface ResearchTarget {
  conversationId: string;
  turnId: string;
  /** Which page of the panel shows. */
  view: "report" | "sources";
}

const panel = store<ResearchTarget | undefined>(undefined);

export const getResearchPanel = () => panel.get();
export const setResearchPanel = (target: ResearchTarget | undefined) =>
  panel.set(target);

/**
 * Opens the Research panel for a turn, closing the tool panel or file it
 * replaces (they share the right side).
 */
export function openResearchPanel(
  app: {
    setPanel: (panel: null) => void;
    setArtifact: (artifact: undefined) => void;
  },
  conversationId: string,
  turnId: string,
) {
  app.setPanel(null);
  app.setArtifact(undefined);
  panel.set({ conversationId, turnId, view: "report" });
}

/** The Research turn the side panel shows, if it is open. */
export function useResearchPanel() {
  return useSyncExternalStore(panel.subscribe, panel.get, panel.get);
}

// --- Live progress --------------------------------------------------------

const live = store<ReadonlyMap<string, ResearchState>>(new Map());
const liveKey = (conversationId: string, turnId: string) =>
  `${conversationId}\n${turnId}`;

/** Keeps the latest progress event for a Research turn. */
export function noteResearchEvent(
  conversationId: string,
  turnId: string,
  research: ResearchState,
) {
  const next = new Map(live.get());
  next.set(liveKey(conversationId, turnId), research);
  live.set(next);
}

/** Forgets every progress event (tests). */
export function resetResearchStores() {
  draft.set(false);
  panel.set(undefined);
  live.set(new Map());
}

let listening = false;

/** Listens for the main process's research events, once per window. */
function listen() {
  if (listening || typeof window === "undefined") return;
  const desktop = window.desktop as
    { onEvent?: (listener: (event: unknown) => void) => unknown } | undefined;
  if (!desktop?.onEvent) return;
  listening = true;
  desktop.onEvent((event) => {
    const value = event as {
      type?: string;
      conversationId?: string;
      turnId?: string;
      research?: ResearchState;
    };
    if (
      value?.type === "research" &&
      typeof value.conversationId === "string" &&
      typeof value.turnId === "string" &&
      value.research
    )
      noteResearchEvent(value.conversationId, value.turnId, value.research);
  });
}

/**
 * A Research turn's progress: the newer of the turn's stored state and the
 * last event pushed for it (events arrive between conversation updates).
 */
export function useTurnResearch(
  conversation: Pick<Conversation, "id"> | undefined,
  turn: Pick<Turn, "id" | "research"> | undefined,
): ResearchState | undefined {
  useEffect(listen, []);
  const events = useSyncExternalStore(live.subscribe, live.get, live.get);
  const stored = turn?.research;
  const pushed =
    conversation && turn
      ? events.get(liveKey(conversation.id, turn.id))
      : undefined;
  if (!pushed) return stored;
  if (!stored) return pushed;
  return newer(pushed, stored);
}

const phaseRank: Record<ResearchState["state"], number> = {
  starting: 0,
  planning: 1,
  gathering: 2,
  writing: 3,
  done: 4,
  failed: 4,
  interrupted: 4,
};

/** The state further along: a later phase, or more sources in the same one. */
function newer(a: ResearchState, b: ResearchState) {
  if (phaseRank[a.state] !== phaseRank[b.state])
    return phaseRank[a.state] > phaseRank[b.state] ? a : b;
  if (a.sourceCount !== b.sourceCount)
    return a.sourceCount > b.sourceCount ? a : b;
  return (a.searchCount ?? 0) > (b.searchCount ?? 0) ? a : b;
}
