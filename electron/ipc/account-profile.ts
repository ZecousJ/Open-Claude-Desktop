import { z } from "zod";
import { actionVerificationPath } from "../../shared/action-verification";
import {
  accountProfileBody,
  accountProfileFrom,
  accountProfileMethods,
  accountProfilePath,
  termsPath,
  type SignUpProfile,
} from "../../shared/account-profile-api";
import type { AppContext, IpcHandle } from "../app/app-context";
import { requestJson, Sub2ApiError } from "../sub2api/http";
import { assertAccountOperationCurrent } from "../account/operation-lease";

const input = z.object({
  name: z.string().max(400),
  birthdate: z.string().max(10),
  termsVersion: z.string().max(32),
});

/**
 * The account step after sign-up (shared/account-profile-api.ts), read and
 * saved with the session's token in the main process. A local account, or a
 * service without the step (404), has none.
 */
export function registerAccountProfileHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  const service = () => (ctx.remote?.ready ? ctx.remote.backend : undefined);
  const actionVerification = async (suffix: string, body: { code?: string }) => {
    const remote = ctx.remote;
    if (!remote?.ready || ctx.accountRetiring) throw Error("Sign in to a Claudex service first.");
    const { backend } = remote;
    const activation = ctx.accountActivationIdentity;
    const current = () => !ctx.accountRetiring && ctx.remote === remote && ctx.accountActivationIdentity === activation;
    const answer = await backend.session.authorized((token) => {
      assertAccountOperationCurrent(current);
      return requestJson(
        fetch,
        `${backend.accounts.baseUrl}${actionVerificationPath}${suffix}`,
        { method: "POST", body, token },
      );
    }, current);
    assertAccountOperationCurrent(current);
    return answer;
  };
  handle("sendActionVerification", () => actionVerification("/send", {}));
  handle("confirmActionVerification", (raw: unknown) =>
    actionVerification("/confirm", {
      code: z
        .string()
        .regex(/^[0-9]{6}$/)
        .parse(raw),
    }),
  );
  handle("signUpProfile", async (): Promise<SignUpProfile | null> => {
    const backend = service();
    if (!backend) return null;
    const base = backend.accounts.baseUrl;
    try {
      const answer = await backend.session.authorized((token) =>
        requestJson(fetch, `${base}${accountProfilePath}`, { token }),
      );
      return accountProfileFrom(answer, `${base}${termsPath}`);
    } catch (error) {
      if (error instanceof Sub2ApiError && error.status === 404) return null;
      throw error;
    }
  });
  handle("saveSignUpProfile", async (raw: unknown) => {
    const backend = service();
    if (!backend) throw Error("Sign in to a Claudex service first.");
    const base = backend.accounts.baseUrl;
    const answer = await backend.session.authorized((token) =>
      requestJson(fetch, `${base}${accountProfilePath}`, {
        method: "PUT",
        body: accountProfileBody(input.parse(raw)),
        token,
      }),
    );
    return accountProfileFrom(answer, `${base}${termsPath}`);
  });
  // Keeps this list and the bridge's in step.
  void accountProfileMethods;
}
