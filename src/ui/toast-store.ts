import { useSyncExternalStore } from "react";
import { prefersReducedMotion } from "./usePresence";

/*
 * The window's notices (the corner toasts), after the original's toaster: each
 * stays 6 seconds (a shorter time is raised to that), at most three show,
 * newest in front, and the same message again counts up on the toast already
 * shown ("(×2)") instead of stacking a copy. A fourth is kept, hidden, until
 * one in front goes. Hovering the stack holds every timer. A dismissed toast
 * stays 200ms for its exit. A danger toast given no time stays 6.5 seconds, and
 * a counted toast the person closes keeps the same message away for 30 seconds.
 */

export const TOAST_TIMEOUT_MS = 6000;
export const TOAST_LIMIT = 3;
export const TOAST_EXIT_MS = 200;
export const TOAST_DANGER_TIMEOUT_MS = 6500;
export const TOAST_SUPPRESS_MS = 30_000;

export type ToastVariant = "warning" | "danger";

/** A button on a toast ("Undo"): the toast dismisses itself after it runs. */
export type ToastAction = { label: string; onSelect: () => void };
export type ToastInlineAction = ToastAction & {
  title: string;
  ariaLabel?: string;
};

export type Toast = {
  id: number;
  message: string;
  description?: string;
  variant?: ToastVariant;
  action?: ToastAction;
  inlineAction?: ToastInlineAction;
  /** How many times this message was shown while it was up. */
  count: number;
  /** Dismissed, playing its exit. */
  closing: boolean;
  /** Past the limit of three: kept out of sight and inert until a place frees. */
  limited: boolean;
  /** Runs once when the toast goes (timed out, closed, or its action ran). */
  onDismiss?: () => void;
};

type Timer = {
  handle?: ReturnType<typeof setTimeout>;
  /** When the running countdown ends. */
  endsAt: number;
  remaining: number;
};

let toasts: readonly Toast[] = [];
let nextId = 1;
let paused = false;
const timers = new Map<number, Timer>();
/** Messages the person closed after they repeated: until when they stay away. */
const suppressed = new Map<string, number>();
const listeners = new Set<() => void>();

function publish(next: readonly Toast[]) {
  let shown = 0;
  toasts = next.map((toast) => {
    const limited = !toast.closing && ++shown > TOAST_LIMIT;
    return limited === toast.limited ? toast : { ...toast, limited };
  });
  syncLimited();
  for (const listener of listeners) listener();
}

/** A limited toast's countdown waits; it runs on once the toast shows. */
function syncLimited() {
  for (const toast of toasts) {
    const timer = timers.get(toast.id);
    if (!timer) continue;
    if (toast.limited && timer.handle !== undefined) {
      clearTimeout(timer.handle);
      timer.handle = undefined;
      timer.remaining = Math.max(0, timer.endsAt - Date.now());
    } else if (!toast.limited && timer.handle === undefined && !paused)
      startTimer(toast.id, timer.remaining);
  }
}

function startTimer(id: number, ms: number) {
  const timer: Timer = timers.get(id) ?? { endsAt: 0, remaining: ms };
  clearTimeout(timer.handle);
  if (!Number.isFinite(ms)) {
    timers.delete(id);
    return;
  }
  timer.remaining = ms;
  timer.endsAt = Date.now() + ms;
  timer.handle = paused ? undefined : setTimeout(() => dismissToast(id), ms);
  timers.set(id, timer);
}

/** Shows a notice; returns its id. */
export function showToast(
  message: string,
  {
    timeout,
    action,
    inlineAction,
    onDismiss,
    description,
    variant,
  }: {
    timeout?: number;
    description?: string;
    variant?: ToastVariant;
    action?: ToastAction;
    inlineAction?: ToastInlineAction;
    /**
     * Runs once when the toast goes. A toast with one is never merged with
     * another of the same message, so each keeps its own.
     */
    onDismiss?: () => void;
  } = {},
): number {
  if (!onDismiss && (suppressed.get(message) ?? 0) > Date.now()) return -1;
  const duration = Math.max(
    timeout ??
      (variant === "danger" ? TOAST_DANGER_TIMEOUT_MS : TOAST_TIMEOUT_MS),
    TOAST_TIMEOUT_MS,
  );
  const same = onDismiss
    ? undefined
    : toasts.find((t) => !t.closing && !t.onDismiss && t.message === message);
  if (same) {
    // The newest action is the one that still has something to undo.
    publish(
      toasts.map((t) =>
        t === same
          ? {
              ...t,
              count: t.count + 1,
              action,
              inlineAction,
              description,
              variant,
            }
          : t,
      ),
    );
    startTimer(same.id, duration);
    return same.id;
  }
  const toast: Toast = {
    id: nextId++,
    message,
    description,
    variant,
    action,
    inlineAction,
    count: 1,
    closing: false,
    limited: false,
    ...(onDismiss ? { onDismiss } : {}),
  };
  publish([toast, ...toasts]);
  startTimer(toast.id, duration);
  // Past the limit the oldest wait out of sight.
  syncLimited();
  return toast.id;
}

/**
 * Closes one notice, after its exit. `byPerson`: closed with its cross or
 * Escape, so a message that kept repeating stays away for a while.
 */
export function dismissToast(id: number, byPerson = false) {
  clearTimeout(timers.get(id)?.handle);
  timers.delete(id);
  const toast = toasts.find((t) => t.id === id);
  if (!toast || toast.closing) return;
  if (byPerson && toast.count > 1)
    suppressed.set(toast.message, Date.now() + TOAST_SUPPRESS_MS);
  try {
    toast.onDismiss?.();
  } catch {
    // The toast still goes.
  }
  if (prefersReducedMotion()) {
    publish(toasts.filter((t) => t.id !== id));
    return;
  }
  publish(toasts.map((t) => (t.id === id ? { ...t, closing: true } : t)));
  setTimeout(() => publish(toasts.filter((t) => t.id !== id)), TOAST_EXIT_MS);
}

export function dismissAllToasts() {
  for (const toast of toasts) dismissToast(toast.id);
}

/** Holds every countdown (the pointer is on the stack), or lets them run on. */
export function pauseToasts(hold: boolean) {
  if (paused === hold) return;
  paused = hold;
  for (const [id, timer] of timers) {
    if (hold) {
      clearTimeout(timer.handle);
      timer.handle = undefined;
      timer.remaining = Math.max(0, timer.endsAt - Date.now());
    } else if (!toasts.find((t) => t.id === id)?.limited)
      startTimer(id, timer.remaining);
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The notices on screen, newest first. */
export function useToasts() {
  return useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts,
  );
}

/** For tests: forget closed-message suppression. */
export const resetToastSuppression = () => suppressed.clear();

/** For tests: the notices now, newest first. */
export const currentToasts = () => toasts;
