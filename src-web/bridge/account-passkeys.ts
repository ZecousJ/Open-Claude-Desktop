/**
 * Settings → Account → Passkey on the web: the service's own passkey
 * routes (`/api/v1/user/passkeys`) with the session's token. The service
 * offers them when its public settings say `passkey_enabled`; making one
 * asks for the account's password first, then the browser's ceremony.
 */
import type { WebTransport } from "../../shared/web-client/transport";
import type { WebEnv } from "../../shared/web-client/env";

type Json = Record<string, unknown>;

/** The value of the service's `{code, data}` answer. */
function data(body: unknown): unknown {
  const wrapped = body as { data?: unknown } | undefined;
  return wrapped && typeof wrapped === "object" && "data" in wrapped
    ? wrapped.data
    : body;
}

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function createPasskeyMethods(
  transport: Pick<WebTransport, "json">,
  env: Pick<WebEnv, "passkeyCreate">,
) {
  return {
    accountPasskeys: async (): Promise<{ count: number } | null> => {
      if (!env.passkeyCreate) return null;
      const settings = data(await transport.json("/api/v1/settings/public")) as
        Json | undefined;
      if (settings?.passkey_enabled !== true) return null;
      const list = data(await transport.json("/api/v1/user/passkeys"));
      return { count: Array.isArray(list) ? list.length : 0 };
    },
    setUpPasskey: async (password: string): Promise<void> => {
      if (!env.passkeyCreate)
        throw new Error("This browser can't use passkeys.");
      const begin = data(
        await transport.json(
          "/api/v1/user/passkeys/register/begin",
          jsonPost({ password }),
        ),
      ) as Json | undefined;
      const sessionToken = begin?.session_token;
      if (typeof sessionToken !== "string" || !sessionToken)
        throw new Error("Couldn’t set up a passkey.");
      const credential = await env.passkeyCreate(begin?.options);
      await transport.json(
        "/api/v1/user/passkeys/register/finish",
        jsonPost({ session_token: sessionToken, credential }),
      );
    },
  };
}
