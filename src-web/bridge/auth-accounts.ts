import type { PublicAccount } from "../../shared/types";
import { webAuthRoutes, webLimits } from "../../shared/web-protocol";
import {
  signInAgainCode,
  type BrowserAccounts,
} from "../../shared/sign-in-api";
import { bridgeError } from "../../shared/web-client/errors";
import {
  refreshLock,
  addingKey,
  record,
  isSignedOutError,
} from "./auth-support";
import type { WebAuth } from "./auth";

// -------------------------------------------------------------------------
// Several accounts per browser

/** The accounts used in this browser, marked with the cookies it holds. */
export async function browserAccounts(this: WebAuth): Promise<BrowserAccounts> {
  const value = record((await this.post(webAuthRoutes.accounts, {})).value);
  const listed = value?.accounts;
  const cookies = new Set(
    (Array.isArray(listed) ? (listed as unknown[]) : []).filter(
      (id): id is string => typeof id === "string",
    ),
  );
  const limit = value?.max_accounts;
  const max =
    typeof limit === "number" && limit >= 1
      ? Math.floor(limit)
      : webLimits.browserAccounts;
  const current = this.session?.account;
  const adding = this.addingAccount();
  let remembered = this.remembered();
  // The window's own account is always listed (storage may be blocked).
  if (current && !remembered.some((item) => item.id === current.id))
    remembered = [
      { id: current.id, email: current.email, name: current.name },
      ...remembered,
    ];
  // While adding, the account that stays signed in is the tab's own.
  const own = current?.id ?? (adding ? this.tabAccount() : undefined);
  return {
    ...(own ? { current: own } : {}),
    accounts: remembered.map((item) => {
      const signedIn = item.id === current?.id || cookies.has(item.id);
      return {
        id: item.id,
        email: item.email,
        name: item.name,
        signedIn,
        ...(!signedIn && item.signInAgain ? { signInAgain: true } : {}),
      };
    }),
    maxAccounts: max,
    ...(adding ? { adding } : {}),
  };
}

/**
 * This tab shows another account the browser is signed in to; the
 * current one stays signed in. An ended session is refused with
 * `signInAgainCode` (the menu then offers its sign-in page).
 */
export async function switchAccount(
  this: WebAuth,
  id: string,
): Promise<PublicAccount> {
  const target = String(id);
  if (!/^\d{1,19}$/.test(target)) throw bridgeError("Choose an account.");
  if (this.session?.account.id === target) return this.session.account;
  let value: unknown;
  try {
    ({ value } = await this.env.withLock(refreshLock, () =>
      this.post(webAuthRoutes.refresh, { account: target }),
    ));
  } catch (error) {
    if (!isSignedOutError(error)) throw error;
    this.markSignInAgain(target, true);
    throw bridgeError(
      "Your session for this account ended. Sign in again.",
      signInAgainCode,
    );
  }
  this.pendingTwoFactor = undefined;
  return (await this.adopt(value)).account;
}

/**
 * The sign-in page for another account, `email` filled in; the current
 * account stays signed in (only this tab leaves it until the new one
 * signs in, or the page goes back).
 */
export async function addAccount(this: WebAuth, email?: string) {
  const address = typeof email === "string" ? email.trim().slice(0, 254) : "";
  this.setTabValue(
    addingKey,
    JSON.stringify(address ? { email: address } : {}),
  );
  this.set(undefined);
}

/** Back to the tab's account (its cookie was kept). */
export async function cancelAddAccount(this: WebAuth) {
  this.setTabValue(addingKey, undefined);
}

/** "Remove {email} from this device": that account's session ends here. */
export async function forgetBrowserAccount(this: WebAuth, id: string) {
  const target = String(id);
  if (!/^\d{1,19}$/.test(target)) return;
  if (this.session?.account.id === target)
    throw bridgeError("Log out of this account instead.");
  await this.post(webAuthRoutes.logout, { account: target });
  this.leftAccount(target);
  this.saveRemembered(this.remembered().filter((item) => item.id !== target));
  this.tell({
    type: "signed-out",
    reason: "revoked",
    message: "You signed out in another tab.",
    account: target,
  });
}
