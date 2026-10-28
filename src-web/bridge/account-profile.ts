/**
 * The account step after sign-up on the web: plain requests to the service's
 * profile endpoint with the session's token. The terms are the site's own
 * /legal/terms, as an absolute address so openExternal (http(s) only) opens it.
 */
import {
  accountProfileBody,
  accountProfileFrom,
  accountProfilePath,
  termsPath,
  type AccountProfileAPI,
  type SignUpProfileInput,
} from "../../shared/account-profile-api";
import type { WebTransport } from "../../shared/web-client/transport";
import { actionVerificationPath } from "../../shared/action-verification";

type Method = (...args: any[]) => Promise<unknown>;

/** The value of the service's `{code, data}` answer. */
function data(body: unknown): unknown {
  const wrapped = body as { data?: unknown } | undefined;
  return wrapped && typeof wrapped === "object" && "data" in wrapped
    ? wrapped.data
    : body;
}

export function createAccountProfileMethods(
  transport: Pick<WebTransport, "json">,
  origin: string,
): { [K in keyof AccountProfileAPI]: Method } {
  const termsUrl = new URL(termsPath, origin).href;
  return {
    sendActionVerification: async () =>
      data(
        await transport.json(`${actionVerificationPath}/send`, {
          method: "POST",
        }),
      ),
    confirmActionVerification: async (code: string) =>
      data(
        await transport.json(`${actionVerificationPath}/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        }),
      ),
    signUpProfile: async () => {
      try {
        return accountProfileFrom(
          data(await transport.json(accountProfilePath)),
          termsUrl,
        );
      } catch (error) {
        // A service without the step.
        if ((error as { status?: number })?.status === 404) return null;
        throw error;
      }
    },
    saveSignUpProfile: async (input: SignUpProfileInput) =>
      accountProfileFrom(
        data(
          await transport.json(accountProfilePath, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(accountProfileBody(input)),
          }),
        ),
        termsUrl,
      ),
  };
}
