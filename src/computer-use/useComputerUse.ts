/**
 * The window's view of computer use (R10): settings, availability,
 * permissions, what Claudex is doing now and the access requests waiting
 * for an answer. One store per window, read from `computerUseState()` and
 * kept current by `computer-use` events.
 */
import { useSyncExternalStore } from "react";
import type {
  ComputerUseEvent,
  ComputerUseSettings,
  ComputerUseState,
} from "../../shared/computer-use-api";
import { hostFor, surface } from "../../shared/host";
import type { AppEvent } from "../../shared/types";

let state: ComputerUseState | undefined;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | undefined;
let generation = 0;

function set(next: ComputerUseState | undefined) {
  state = next;
  listeners.forEach((listener) => listener());
}

/** The bridge, where this host has computer use at all (not the web app). */
const desktop = () =>
  typeof window === "undefined" || !hostFor(surface).capabilities.computerUse
    ? undefined
    : window.desktop;

/**
 * The state after an event, or "reload" when the event only says that
 * something changed and the state has to be read again.
 */
export function applyComputerUseEvent(
  current: ComputerUseState,
  event: ComputerUseEvent,
): ComputerUseState | "reload" {
  if (event.changed) return "reload";
  let next = current;
  if (event.request) {
    const request = event.request;
    next = {
      ...next,
      requests: [
        ...(next.requests ?? []).filter((r) => r.id !== request.id),
        request,
      ],
    };
  }
  if (event.resolved)
    next = {
      ...next,
      requests: (next.requests ?? []).filter((r) => r.id !== event.resolved),
    };
  if ("activity" in event && event.activity !== undefined)
    next = { ...next, activity: event.activity };
  if (event.permissions) next = { ...next, permissions: event.permissions };
  return next;
}

/** Reads the state again; a newer read wins over an older one. */
export function reloadComputerUse(): Promise<void> {
  const api = desktop();
  if (!api?.computerUseState) return Promise.resolve();
  const mine = ++generation;
  return api
    .computerUseState()
    .then((next) => {
      if (mine === generation) set(next);
    })
    .catch((error: unknown) => {
      console.error(
        "Computer use state failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
}

function handle(event: AppEvent) {
  if (event.type !== "computer-use") return;
  if (!state) {
    void reloadComputerUse();
    return;
  }
  const next = applyComputerUseEvent(state, event);
  if (next === "reload") void reloadComputerUse();
  else set(next);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!unsubscribe) {
    const api = desktop();
    unsubscribe = api?.onEvent?.(handle) ?? (() => {});
    void reloadComputerUse();
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Computer use as the main process last reported it; undefined until loaded. */
export function useComputerUse(): ComputerUseState | undefined {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** Saves settings; the answer is the new state. */
export async function saveComputerUseSettings(
  patch: Partial<ComputerUseSettings>,
) {
  const api = desktop();
  if (!api) return;
  generation++;
  set(await api.saveComputerUseSettings(patch));
}

/** Lets tests start from a known state. */
export function resetComputerUseForTests(next?: ComputerUseState) {
  unsubscribe?.();
  unsubscribe = undefined;
  generation++;
  state = next;
}
