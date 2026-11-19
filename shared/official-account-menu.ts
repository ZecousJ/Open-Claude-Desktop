import type { BrowserAccounts } from "./sign-in-api";
import type { PublicAccount } from "./types";

export const officialAccountMenuGate = "3060661201";

export function officialAccountMenuMessages(
  translate: (message: string) => string,
) {
  return {
    "secret:1ao18a0": translate("Switch account"),
    "secret:1a1o4ct": translate("Add account"),
    "secret:rzd05i": translate("Sign in again"),
    "secret:u5clsz": translate(
      "You can be signed in to up to {count} accounts.",
    ).replaceAll("{count}", "{max}"),
    "secret:13vlfhi": translate(
      "The account could not be switched. Try again.",
    ),
    "secret:zjtsw1": translate(
      "Your session for this account ended. Sign in again.",
    ),
    "secret:a8mq4c": translate("This account is no longer open."),
    "secret:14ef2rf": translate(
      "This organization does not allow multiple accounts.",
    ),
    "secret:zxli0e": translate("Switching to {email}"),
    "secret:1cgto6l": translate("Switching accounts"),
  };
}

export const officialBrowserAccountsPath = "/api/auth/accounts";
export const officialAddAccountPath = "/api/auth/accounts/add-intent";
export const officialActivateAccountPath =
  /^\/api\/auth\/accounts\/([^/]+)\/activate$/;

export function officialBrowserAccounts(
  source: BrowserAccounts,
  accountUuid: (handle: string) => string | null = (handle) => handle,
) {
  return {
    accounts: source.accounts
      .filter((account) => account.signedIn || account.signInAgain)
      .map((account) => ({
        handle: account.id,
        account_uuid: accountUuid(account.id),
        active: account.id === source.current,
        state: account.signedIn ? "signed_in" : "sign_in_again",
        email_address: account.email,
        full_name: account.name || null,
        avatar_url: null,
      })),
    max_accounts: source.maxAccounts,
  };
}

export function officialAccountActivation(account: Pick<PublicAccount, "id">) {
  return { account: { uuid: account.id } };
}
