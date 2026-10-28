import { Sub2ApiError } from "./http";
import {
  claudexErrorCodes,
  type ClaudexBootstrap,
} from "../../shared/claudex-contract";
import { type ClaudexDeviceRegistration } from "../../shared/claudex-contract";
import type { KeyGroup } from "./backend";
import type { Provider } from "../../shared/types";
export const sub2apiProviderId = "sub2api";

/** Openai groups speak Responses; other platforms go through Chat Completions. */
export function protocolFor(platform: string): Provider["protocol"] {
  return platform === "openai" ? "responses" : "chat";
}

/** The groups of a registration other than the plan group. */
export function otherGroups(
  registration: ClaudexDeviceRegistration,
): KeyGroup[] {
  return registration.apiKeys
    .filter((key) => !key.primary)
    .map(({ groupId, groupName, platform, protocol }) => ({
      groupId,
      groupName,
      platform,
      protocol,
    }));
}

/** Registrations one device may make in a minute; the service allows the same (design 2.5). */
export const registrationsPerMinute = 2;

export const reconnectMessage =
  "Couldn't reconnect to your plan. Try again in a minute.";

/**
 * The bootstrap says the account has no group Claudex can use
 * (CLAUDEX_NO_PLAN). Such an account still signs in and runs on its balance
 * alone; its device holds no key.
 */
export function withoutPlan(boot: ClaudexBootstrap | undefined) {
  return (
    boot?.errors.some(
      (error) =>
        error.section === "plan" && error.code === claudexErrorCodes.noPlan,
    ) ?? false
  );
}

/** Why the bootstrap could not be read, when that means "offline" rather than "stop". */
export function offline(error: unknown) {
  // A refused session or a turned-off account is not an outage.
  return !(
    error instanceof Sub2ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 404 &&
    error.status !== 408 &&
    error.status !== 429
  );
}
