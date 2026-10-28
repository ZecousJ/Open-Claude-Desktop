/**
 * Sign-in requests wait for the connection, as the original's do. Used on the
 * desktop and the web alike: both windows know `navigator.onLine` and its
 * events.
 */
import type { AuthStep } from "./signInView";

/** What the waiting needs of the window (tests pass their own). */
export interface Connection {
  /** True only when the browser knows it has no network. */
  offline(): boolean;
  /** Resolves at the next `online` event. */
  online(): Promise<void>;
}

export const browserConnection: Connection = {
  offline: () => typeof navigator !== "undefined" && navigator.onLine === false,
  online: () =>
    new Promise<void>((resolve) =>
      window.addEventListener("online", () => resolve(), { once: true }),
    ),
};

/**
 * Runs `task` once the connection is there. Offline, `onPaused(true)`
 * shows the warning and the task waits; a task that failed because the
 * connection dropped while it ran waits and runs again. Any other failure
 * is the task's own.
 */
export async function runWhenOnline<T>(
  task: () => Promise<T>,
  onPaused: (paused: boolean) => void,
  connection: Connection = browserConnection,
): Promise<T> {
  for (;;) {
    if (connection.offline()) {
      onPaused(true);
      try {
        while (connection.offline()) await connection.online();
      } finally {
        onPaused(false);
      }
    }
    try {
      return await task();
    } catch (error) {
      if (!connection.offline()) throw error;
    }
  }
}

/** The three waits the original names (its sign-in, code and resend steps). */
export type OfflineWait = "sign-in" | "verify" | "send";

/**
 * Which wait a step's request is: signing in (the email step when it sends
 * a code, the password), checking a code, or none (steps the original has
 * no wait for, and the email step that only moves on to the password).
 */
export function offlineWaitOf(
  step: AuthStep,
  emailCodeLogin: boolean,
): OfflineWait | undefined {
  switch (step) {
    case "email":
      return emailCodeLogin ? "sign-in" : undefined;
    case "password":
    case "login":
      return "sign-in";
    case "code":
    case "twoFactor":
    case "createVerify":
      return "verify";
    default:
      return undefined;
  }
}

export const offlineNotes: Record<OfflineWait, string> = {
  "sign-in":
    "You appear to be offline. Your sign-in will continue when your connection returns.",
  verify:
    "You appear to be offline. Your code will be verified when your connection returns.",
  send: "You appear to be offline. Your code will be sent when your connection returns.",
};
