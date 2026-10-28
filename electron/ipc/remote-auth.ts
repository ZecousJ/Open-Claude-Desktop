import { z } from "zod";
import { normalizeSub2ApiUrl } from "../../server/sub2api-config";
import {
  authorizeWithGoogle,
  cancelGoogleAuthorization,
} from "../account/google-sign-in";
import type { PublicAccount, RegisterExtras } from "../../shared/types";
import type { RemoteAccounts, SignIn } from "../sub2api/identity";
import type { RemoteSession } from "../sub2api/session";

type Handle = (name: string, fn: (...args: any[]) => any) => void;
interface Context {
  accounts: RemoteAccounts;
  readonly activeAccount?: PublicAccount;
  readonly session?: RemoteSession;
  /** Prepares the plan, key and models, then opens the account's profile. */
  activate: (
    session: RemoteSession,
    account: PublicAccount,
  ) => Promise<PublicAccount>;
  deactivate: () => Promise<void>;
  /**
   * Log out: tells the service this device is leaving (Claudex services),
   * before the session logs out and its access token is gone. Never throws.
   */
  leaveDevice?: () => Promise<void>;
  /**
   * Loads the window that asked again (Add account: it opens on the sign-in
   * page). The main process does it: the page reloading itself once left the
   * window on the old account's page, signed out underneath, every call failing
   * with "Sign in to continue.".
   */
  reloadCaller?: () => void;
  /** Keeps the service the person chose, and starts what needs one. */
  serviceChosen?: (baseUrl: string) => Promise<void>;
}

const email = z.string().trim().min(3).max(254);
const accountId = z.string().regex(/^[0-9a-f-]{36}$/);
const password = z.string().min(1).max(256);
const emailLinkRequest = z
  .object({
    request_id: z.string().regex(/^[a-f0-9]{64}$/),
    request_secret: z.string().regex(/^[a-f0-9]{64}$/),
    desktop: z.boolean().optional(),
  })
  .optional();
const code = (max: number) => z.string().trim().max(max).optional();
const extrasSchema = z
  .object({
    verifyCode: code(64),
    invitationCode: code(200),
    promoCode: code(200),
  })
  .optional();

/**
 * Sign-in IPC when the operator configured a Sub2API service. Tokens and
 * the pending 2FA challenge stay in the main process; the renderer only
 * gets the public account and what the service's policy allows.
 */
export function registerRemoteAuthHandlers(handle: Handle, context: Context) {
  const { accounts } = context;
  /** The page's status while no service is chosen: it asks for the address. */
  const unconfigured = () => ({
    serviceConfigured: false,
    hasAccounts: false,
  });
  async function finish(result: SignIn) {
    if (result.kind === "twoFactor")
      return {
        twoFactorRequired: true as const,
        maskedEmail: result.maskedEmail,
      };
    if (!result.session.persist())
      console.error("Account session will not persist after restart.");
    let account: PublicAccount;
    try {
      account = await context.activate(result.session, result.account);
    } catch (error) {
      // A session whose plan or key cannot be prepared is not kept.
      await result.session.logout().catch(() => {});
      throw error;
    }
    // An account added (or signed in to again) is the window's account
    // now; an older session of it kept here gives way to the new one.
    accounts.finishAdding();
    await accounts.dropParked(account.id);
    return account;
  }
  const signedOut = () => {
    if (context.activeAccount) throw Error("Already signed in.");
  };
  handle("authStatus", async () => {
    if (!accounts.configured) return unconfigured();
    const account = context.activeAccount;
    // Signed out: the accounts of this computer ("Choose an account") and
    // whether one is being added.
    const browserAccounts = account ? undefined : accounts.browserAccounts();
    return {
      serviceOrigin: new URL(accounts.baseUrl).origin,
      account,
      hasAccounts: accounts.hasAccounts,
      remote: account ? undefined : await accounts.policy(),
      twoFactorPending: accounts.pendingTwoFactor,
      ...(browserAccounts &&
      (browserAccounts.accounts.length || browserAccounts.adding)
        ? { browserAccounts }
        : {}),
    };
  });
  handle("setServiceAddress", async (raw: unknown) => {
    signedOut();
    const address = normalizeSub2ApiUrl(
      z.string().trim().min(1).max(2000).parse(raw),
    );
    const previous = accounts.baseUrl;
    accounts.useService(address);
    try {
      await accounts.publicSettings();
    } catch {
      accounts.useService(previous);
      throw Error(
        "No Claudex service answered at this address. Check it and try again.",
      );
    }
    await context.serviceChosen?.(address);
    return {
      serviceOrigin: new URL(address).origin,
      hasAccounts: accounts.hasAccounts,
      remote: await accounts.policy(),
    };
  });
  handle("loginAccount", async (rawEmail: unknown, rawPassword: unknown) => {
    signedOut();
    return await finish(
      await accounts.login(email.parse(rawEmail), password.parse(rawPassword)),
    );
  });
  handle("completeTwoFactor", async (rawCode: unknown) => {
    signedOut();
    const result = await accounts.completeTwoFactor(
      z.string().trim().max(12).parse(rawCode),
    );
    const account = await finish(result);
    if ("twoFactorRequired" in account)
      throw Error("The service asked for another code.");
    return account;
  });
  handle("cancelTwoFactor", () => accounts.cancelTwoFactor());
  handle("sendVerificationCode", async (rawEmail: unknown) => {
    signedOut();
    return await accounts.sendVerificationCode(email.parse(rawEmail));
  });
  // The sign-in page's other ways in.
  handle("requestPasswordReset", async (rawEmail: unknown) => {
    signedOut();
    await accounts.requestPasswordReset(email.parse(rawEmail));
  });
  handle(
    "resetPassword",
    async (rawEmail: unknown, rawToken: unknown, rawPassword: unknown) => {
      signedOut();
      await accounts.resetPassword(
        email.parse(rawEmail),
        z.string().trim().min(1).max(512).parse(rawToken),
        z.string().min(6).max(256).parse(rawPassword),
      );
    },
  );
  handle("sendSignInCode", async (rawEmail: unknown, rawRequest: unknown) => {
    signedOut();
    return await accounts.sendSignInCode(
      email.parse(rawEmail),
      emailLinkRequest.parse(rawRequest),
    );
  });
  handle(
    "loginWithCode",
    async (rawEmail: unknown, rawCode: unknown, rawRequest: unknown) => {
      signedOut();
      return await finish(
        await accounts.loginWithCode(
          email.parse(rawEmail),
          z.string().trim().max(12).parse(rawCode),
          emailLinkRequest.parse(rawRequest),
        ),
      );
    },
  );
  // Continue with Google: Google in the browser, its code back here, the
  // service exchanges it (electron/google-sign-in.ts, LOGIN-GOOGLE).
  handle("loginWithGoogle", async () => {
    signedOut();
    return await finish(await accounts.loginWithGoogle(authorizeWithGoogle));
  });
  handle("cancelGoogleSignIn", () => cancelGoogleAuthorization());
  handle("loginWithPasskey", () => {
    throw Error("Passkeys work in Claudex on the web.");
  });
  handle("accountPasskeys", () => null);
  handle("setUpPasskey", () => {
    throw Error("Passkeys work in Claudex on the web.");
  });
  // Several accounts at once. The web keeps one cookie per account; here each
  // account's session is kept in the main process (RemoteAccounts.park/resume),
  // with its own refresh token, and the service registers this computer for
  // each account with its own key.
  handle("browserAccounts", () =>
    accounts.browserAccounts(context.activeAccount?.id),
  );
  /** The open account leaves the window but stays signed in. */
  async function leave(adding?: { email?: string }) {
    const session = context.session;
    if (!session) throw Error("Sign in to continue.");
    await accounts.park(session, adding);
    await context.deactivate();
  }
  /** Opens a signed-in account; one that cannot open stays signed in. */
  async function open(accountId: string) {
    const opened = await accounts.resume(accountId);
    try {
      return await context.activate(opened.session, opened.account);
    } catch (error) {
      await accounts.park(opened.session).catch(() => {});
      throw error;
    }
  }
  handle("switchAccount", async (raw: unknown) => {
    const id = accountId.parse(raw);
    const active = context.activeAccount;
    if (active?.id === id) return active;
    if (!accounts.canHoldAccounts)
      throw Error("Switching accounts needs this computer's secure storage.");
    const from = active ? active.id : undefined;
    if (active) await leave();
    accounts.finishAdding();
    try {
      return await open(id);
    } catch (error) {
      // Back to the account the window had.
      if (from) await open(from).catch(() => {});
      throw error;
    }
  });
  handle("addAccount", async (raw: unknown) => {
    const address = email.optional().parse(raw ?? undefined);
    const active = context.activeAccount;
    if (!active) throw Error("Sign in to continue.");
    if (!accounts.canHoldAccounts)
      throw Error("Switching accounts needs this computer's secure storage.");
    const limit = accounts.browserAccounts(active.id).maxAccounts;
    // An account to sign in to again does not take another place.
    const again = accounts
      .browserAccounts(active.id)
      .accounts.some(
        (account) =>
          !account.signedIn &&
          account.email.toLowerCase() === address?.toLowerCase(),
      );
    if (!again && accounts.signedInCount(active.id) >= limit)
      throw Error(`You can be signed in to up to ${limit} accounts.`);
    await leave(address ? { email: address } : {});
    context.reloadCaller?.();
  });
  handle("cancelAddAccount", async () => {
    const adding = accounts.adding;
    if (!adding || context.activeAccount) return;
    accounts.finishAdding();
    await open(adding.from);
  });
  handle("forgetBrowserAccount", async (raw: unknown) => {
    const id = accountId.parse(raw);
    if (context.activeAccount?.id === id)
      throw Error("Log out of this account to remove it.");
    await accounts.forget(id);
  });
  handle(
    "registerAccount",
    async (
      rawEmail: unknown,
      rawPassword: unknown,
      _rawName: unknown,
      rawExtras: unknown,
    ) => {
      signedOut();
      const result = await accounts.register(
        email.parse(rawEmail),
        password.parse(rawPassword),
        (extrasSchema.parse(rawExtras) ?? {}) as RegisterExtras,
      );
      const account = await finish(result);
      if ("twoFactorRequired" in account)
        throw Error("Sign in to finish creating your account.");
      return account;
    },
  );
  handle("logoutAccount", async () => {
    // Order matters: the device leaves with the access token the logout ends.
    if (context.session) await context.leaveDevice?.().catch(() => {});
    await context.session
      ?.logout()
      .catch((error) =>
        console.error(
          "The service did not confirm sign-out:",
          error instanceof Error ? error.message : String(error),
        ),
      );
    await context.deactivate();
    return {
      hasAccounts: accounts.hasAccounts,
      remote: await accounts.policy(),
    };
  });
  handle("revokeAllSessions", async () => {
    if (!context.session) throw Error("Sign in to continue.");
    await context.session.revokeAll();
    await context.deactivate();
    return {
      hasAccounts: accounts.hasAccounts,
      remote: await accounts.policy(),
    };
  });
}
