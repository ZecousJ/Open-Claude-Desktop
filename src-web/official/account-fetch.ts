import {
  type officialAccountActivation,
  officialActivateAccountPath,
  officialAddAccountPath,
  type officialBrowserAccounts,
  officialBrowserAccountsPath,
} from "../../shared/official-account-menu";
import {
  officialActiveSessionsPage,
  officialActiveSessionsPath,
  officialEndActiveSessionBody,
  officialEndActiveSessionPath,
  sessionPage,
} from "../../shared/official-active-sessions";
import type { SettingsAccountAPI } from "../../shared/settings-api";
import { z } from "zod";
import { needsSignInAgain, type SignInAPI } from "../../shared/sign-in-api";

const activationBody = z.strictObject({ handle: z.string().optional() });
const emptyBody = z.strictObject({});

export type OfficialSignOut = "current" | "all";

export type OfficialFrameAccount = Pick<
  SettingsAccountAPI,
  "activeSessions" | "endActiveSession"
> &
  Pick<SignInAPI, "addAccount"> & {
    browserAccounts(): Promise<ReturnType<typeof officialBrowserAccounts>>;
    switchAccount(
      handle: string,
    ): Promise<ReturnType<typeof officialAccountActivation>>;
    signOut(scope: OfficialSignOut): Promise<void>;
  };

export function officialSignOutPath(
  pathname: string,
): OfficialSignOut | undefined {
  if (pathname === "/logout") return "current";
  if (pathname === "/logout/all-sessions") return "all";
}

function refusal(
  message: string,
  status: number,
  type = "invalid_request_error",
) {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

function empty() {
  return new Response(null, { status: 204 });
}

export function officialAccountRequest(
  request: Request,
  url: URL,
  account: OfficialFrameAccount | undefined,
  body: (request: Request) => Promise<Uint8Array | null>,
): Promise<Response> | undefined {
  const { method } = request;
  const { pathname, search, searchParams } = url;
  const activation = !search && officialActivateAccountPath.exec(pathname);
  const signOut =
    !search &&
    pathname.startsWith("/api/auth/") &&
    officialSignOutPath(pathname.slice("/api/auth".length));
  let operation: (() => Promise<Response>) | undefined;
  const readBody = async () => {
    const raw = await body(request);
    if (!raw) return { status: 413 } as const;
    try {
      const value: unknown = raw.length
        ? JSON.parse(new TextDecoder().decode(raw))
        : {};
      return { status: 200, value } as const;
    } catch {
      return { status: 400 } as const;
    }
  };

  if (method === "GET" && pathname === officialActiveSessionsPath && account) {
    operation = async () => {
      let page;
      try {
        page = sessionPage(searchParams);
      } catch {
        return refusal("Invalid active-session query.", 400);
      }
      const result = officialActiveSessionsPage(
        await account.activeSessions(),
        page,
      );
      request.signal.throwIfAborted();
      return result
        ? Response.json(result, { headers: { "Cache-Control": "no-store" } })
        : refusal("Active sessions are unavailable for this account.", 503);
    };
  } else if (
    method === "POST" &&
    pathname === officialEndActiveSessionPath &&
    !search &&
    account
  ) {
    operation = async () => {
      const input = await readBody();
      if (input.status !== 200)
        return refusal("Choose a valid active session.", input.status);
      const target = officialEndActiveSessionBody.safeParse(input.value);
      if (!target.success)
        return refusal("Choose a valid active session.", 400);
      request.signal.throwIfAborted();
      return (await account.endActiveSession(target.data.session_uuid)).ended
        ? empty()
        : refusal(
            "This session has already ended or changed.",
            404,
            "not_found_error",
          );
    };
  } else if (method === "POST" && signOut) {
    operation = async () => {
      if (!account) return refusal("Sign out is unavailable.", 501);
      await account.signOut(signOut);
      return empty();
    };
  } else if (
    method === "GET" &&
    pathname === officialBrowserAccountsPath &&
    !search &&
    account
  ) {
    operation = async () => {
      const result = await account.browserAccounts();
      request.signal.throwIfAborted();
      return Response.json(result, {
        headers: { "Cache-Control": "no-store" },
      });
    };
  } else if (method === "POST" && activation && account) {
    operation = async () => {
      let handle: string;
      try {
        handle = decodeURIComponent(activation[1]);
      } catch {
        return refusal("Choose an account.", 400);
      }
      const input = await readBody();
      if (input.status !== 200)
        return refusal("Choose an account.", input.status);
      const payload = activationBody.safeParse(input.value);
      if (
        !payload.success ||
        (payload.data.handle !== undefined && payload.data.handle !== handle)
      )
        return refusal("Choose an account.", 400);
      const listing = await account.browserAccounts();
      request.signal.throwIfAborted();
      const target = listing.accounts.find((row) => row.handle === handle);
      if (!target)
        return refusal(
          "This account is no longer in this browser.",
          404,
          "account_not_in_browser",
        );
      if (target.state === "sign_in_again")
        return refusal("Sign in again.", 401, "reauth_required");
      try {
        return Response.json(await account.switchAccount(handle));
      } catch (error) {
        if (needsSignInAgain(error))
          return refusal("Sign in again.", 401, "reauth_required");
        throw error;
      }
    };
  } else if (
    method === "POST" &&
    pathname === officialAddAccountPath &&
    !search &&
    account
  ) {
    operation = async () => {
      const input = await readBody();
      if (input.status !== 200 || !emptyBody.safeParse(input.value).success)
        return refusal(
          "Unsupported account request.",
          input.status === 200 ? 400 : input.status,
        );
      const result = await account.browserAccounts();
      request.signal.throwIfAborted();
      if (result.accounts.length >= result.max_accounts)
        return refusal(
          "The browser has reached its account limit.",
          409,
          "account_limit_reached",
        );
      await account.addAccount();
      return empty();
    };
  }

  return operation?.().catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return refusal("Something went wrong. Please try again.", 503);
  });
}
