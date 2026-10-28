/**
 * What the sign-in page says after the service ended this device's
 * session. Kept apart from signInView.ts: AuthGate needs it in the web
 * app's first load, the rest of the signed-out pages load on demand.
 */

export type SignedOutReason =
  "revoked" | "device-revoked" | "session-expired" | "password-changed";

/**
 * The line above the sign-in card after a session ended. The original says the
 * same whatever ended it.
 */
export const sessionEndedLine = "Your session ended. Log in again to continue.";

/** The notice on the sign-in page after the service ended this device's session. */
export interface SignedOutNotice {
  title: string;
  reason?: SignedOutReason;
}

/**
 * What the sign-in page says after a "signed-out" event: the original's
 * one line, until the person signs in again.
 */
export function signedOutNotice(event: {
  reason: SignedOutReason;
  message?: string;
}): SignedOutNotice {
  return { title: sessionEndedLine, reason: event.reason };
}
