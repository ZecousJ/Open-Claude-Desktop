/**
 * The first-run onboarding calls (shared/onboarding-api.ts) on the web:
 * plain requests to the service's onboarding endpoint with the session's
 * token.
 */
import {
  noOnboarding,
  onboardingBody,
  onboardingFrom,
  type OnboardingAnswers,
  type OnboardingAPI,
} from "../../shared/onboarding-api";
import type { WebTransport } from "../../shared/web-client/transport";

type Method = (...args: any[]) => Promise<unknown>;

/** The value of the service's `{code, data}` answer. */
function data(body: unknown): unknown {
  const wrapped = body as { data?: unknown } | undefined;
  return wrapped && typeof wrapped === "object" && "data" in wrapped
    ? wrapped.data
    : body;
}

const path = "/api/v1/claudex/onboarding";

export function createOnboardingMethods(
  transport: Pick<WebTransport, "json">,
): { [K in keyof OnboardingAPI]: Method } {
  return {
    onboardingState: async () => {
      try {
        return onboardingFrom(data(await transport.json(path)));
      } catch {
        // A service that can't answer shows nothing; the next load asks again.
        return noOnboarding;
      }
    },
    saveOnboarding: async (answers: OnboardingAnswers, finished?: boolean) =>
      onboardingFrom(
        data(
          await transport.json(path, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(onboardingBody(answers, finished === true)),
          }),
        ),
      ),
  };
}
