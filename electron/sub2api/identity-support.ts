import type { PublicAccount } from "../../shared/types";
import { type RemoteUser } from "./client";
import { claudexErrorCodes } from "../../shared/claudex-contract";
import {
  signInErrorMessage,
  signInFailed,
  mfaSignInFailed,
} from "../../shared/sign-in-errors";
import { signInMessages } from "../../shared/sign-in-states";
import { metadataNumber, Sub2ApiError } from "./http";

import { createHash } from "node:crypto";

/**
 * A stable, UUID-shaped local id for one Sub2API user on one service, so
 * each gets its own profile root and the same person on another host does not.
 */
export function remoteAccountId(baseUrl: string, userId: number) {
  const hex = createHash("sha256")
    .update(`sub2api\n${baseUrl}\n${userId}`)
    .digest("hex");
  // Version 5 and RFC 4122 variant nibbles keep it a well-formed UUID.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export const pendingChallengeMs = 5 * 60_000;

/**
 * Messages for the sign-in failures people can act on, including the
 * device registration that finishes a Claudex sign-in; unknown refusals use
 * the live sign-in fallback instead of the service's raw error.
 */
export function signInError(error: unknown, twoFactor = false): Error {
  if (!(error instanceof Sub2ApiError)) return error as Error;
  if (error.code === claudexErrorCodes.deviceLimit) {
    // The fixed wording with the limit; the service's own sentence when it
    // did not say the limit.
    const limit = metadataNumber(error, "limit");
    return Error(
      limit !== undefined && Number.isSafeInteger(limit) && limit > 0
        ? deviceLimitMessage(limit)
        : error.message || deviceLimitMessage(5),
    );
  }
  const messages: Record<string, string> = {
    [claudexErrorCodes.noPlan]: noModelsMessage,
    [claudexErrorCodes.deviceKeysDisabled]: deviceKeysOffMessage,
    [claudexErrorCodes.deviceRegistrationThrottled]:
      "Too many sign-in attempts from this device. Try again in a minute.",
    [claudexErrorCodes.sessionRevoked]:
      "Your session ended. Sign in again to continue.",
    USER_NOT_ACTIVE: signInMessages.disabled,
    USER_INACTIVE: signInMessages.disabled,
    USER_DISABLED: signInMessages.disabled,
    BACKEND_MODE_ADMIN_ONLY: signInMessages.backendMode,
    [claudexErrorCodes.upgradeRequired]: signInMessages.upgradeRequired,
    UNREACHABLE: "The Claudex service is unreachable. Check your connection.",
  };
  if (messages[error.code]) return Error(messages[error.code]);
  const friendly = signInErrorMessage(
    error.code,
    error.status,
    error.message,
    twoFactor,
  );
  if (friendly) return Error(friendly);
  if (error.status === 426) return Error(signInMessages.upgradeRequired);
  if (error.status >= 500 || error.status === 0)
    return Error(signInMessages.unavailable);
  return Error(twoFactor ? mfaSignInFailed : signInFailed);
}

export function publicAccount(id: string, user: RemoteUser): PublicAccount {
  return {
    id,
    email: user.email,
    name: user.username || user.email.split("@")[0] || user.email,
    remote: true,
  };
}

/** The administrator turned device keys off (bootstrap `features.device_keys=false`). */
export const deviceKeysOffMessage =
  "Your administrator has turned off Claudex sign-in for this service.";

/**
 * An account with no group Claudex can use. It signs in (Claudex has no
 * subscriptions; usage runs on the balance) and meets this where a model is
 * needed; an older service that still refuses the sign-in says the same.
 */
export const noModelsMessage =
  "Your account does not include any models yet. Ask your administrator.";

/** The service's own wording for CLAUDEX_DEVICE_LIMIT (design 1.8). */
export const deviceLimitMessage = (limit: number) =>
  `You're signed in to Claudex on ${limit} devices, the most your account allows. Sign out on one of them, then sign in again.`;
