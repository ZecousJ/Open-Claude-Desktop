import { ActivationCleanupUnconfirmed } from "../account/activation-failure";
import { z } from "zod";
import { assertAccountOperationCurrent, type AccountOperationCurrent } from "../account/operation-lease";
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
  readonly accountActivationIdentity?: unknown;
  readonly accountRetiring?: boolean;
  readonly accountStore?: object;
  /** Prepares the plan, key and models, then opens the account's profile. */
  activate: (
    session: RemoteSession,
    account: PublicAccount,
    current?: AccountOperationCurrent,
    onPhase?: () => void,
  ) => Promise<PublicAccount>;
  deactivate: () => Promise<void>;
  /**
   * Log out: tells the service this device is leaving (Claudex services),
   * before the session logs out and its access token is gone. Never throws.
   */
  leaveDevice?: () => Promise<void>;
  /**
   * Loads the window that asked again (Add account: it opens on the sign-in
   * page). The main process does it: the page reloading itself once left
   * the window on the old account's page, signed out underneath, every call
   * failing with "Sign in to continue." (owner, 2026-10-14).
   */
  reloadCaller?: () => void;
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
  // Only session-replacing intents supersede one another. Read-only status,
  // verification-code requests and other independent reads do not cancel them.
  let operationSerial = 0;
  let activeTransition = false;
  const replaceActiveAccount = <Args extends unknown[], Result>(
    run: (...args: Args) => Promise<Result>,
  ) => async (...args: Args): Promise<Result> => {
    if (activeTransition) throw Error("An account change is already in progress.");
    activeTransition = true;
    try {
      return await run(...args);
    } finally {
      activeTransition = false;
    }
  };
  function beginOperation() {
    const serial = ++operationSerial;
    let owner = context.activeAccount?.id, session = context.session;
    let generation = context.accountActivationIdentity, store = context.accountStore;
    const intentCurrent = () => serial === operationSerial;
    const current = () => intentCurrent() && context.activeAccount?.id === owner &&
      context.session === session && context.accountActivationIdentity === generation &&
      context.accountStore === store && (context.accountRetiring !== true ||
        (!context.activeAccount && !context.accountStore));
    const capture = () => {
      owner = context.activeAccount?.id; session = context.session;
      generation = context.accountActivationIdentity; store = context.accountStore;
    };
    assertAccountOperationCurrent(current);
    return { current, intentCurrent, capture };
  }
  type Operation = ReturnType<typeof beginOperation>;
  async function activate(session: RemoteSession, account: PublicAccount, op: Operation) {
    assertAccountOperationCurrent(op.current);
    let generation = context.accountActivationIdentity, store = context.accountStore;
    const onPhase = () => {
      assertAccountOperationCurrent(op.intentCurrent);
      generation = context.accountActivationIdentity; store = context.accountStore;
    };
    const pending = context.activate(session, account, op.intentCurrent, onPhase);
    void pending.catch(() => {}); // Observe even if a synchronous reentrant handoff invalidates onPhase.
    // Only a synchronous lifecycle handoff or host's explicit phase callback
    // can establish a new generation; never accept an arbitrary late result.
    onPhase();
    let result: PublicAccount;
    try { result = await pending; }
    catch (error) {
      if (error instanceof ActivationCleanupUnconfirmed && error.isCurrent()) throw error;
      assertAccountOperationCurrent(() => op.intentCurrent() &&
        context.accountActivationIdentity === generation && context.accountStore === store &&
        !context.activeAccount && !context.accountStore);
      op.capture();
      throw error;
    }
    assertAccountOperationCurrent(() => op.intentCurrent() &&
      context.accountActivationIdentity === generation && context.accountStore === store &&
      context.activeAccount?.id === account.id && context.session === session &&
      context.accountRetiring !== true);
    op.capture();
    return result;
  }
  async function finish(result: SignIn, op: Operation) {
    assertAccountOperationCurrent(op.current);
    if (result.kind === "twoFactor")
      return { twoFactorRequired: true as const, maskedEmail: result.maskedEmail };
    if (!result.session.persist())
      console.error("Account session will not persist after restart.");
    let account: PublicAccount;
    try { account = await activate(result.session, result.account, op); }
    catch (error) {
      if (error instanceof ActivationCleanupUnconfirmed && error.isCurrent()) throw error;
      assertAccountOperationCurrent(op.current);
      await result.session.logout(op.current).catch(() => {});
      assertAccountOperationCurrent(op.current);
      throw error;
    }
    assertAccountOperationCurrent(op.current);
    accounts.finishAdding();
    await accounts.dropParked(account.id, op.current);
    assertAccountOperationCurrent(op.current);
    return account;
  }
  const signedOut = () => {
    if (activeTransition) throw Error("An account change is already in progress.");
    if (context.activeAccount) throw Error("Already signed in.");
  };
  let restore: Promise<void> | undefined;
  const retrySavedSession = replaceActiveAccount(async () => {
    const op = beginOperation();
    const restored = await accounts.restore(op.current);
    if (restored) await activate(restored.session, restored.account, op);
  });
  handle("authStatus", async () => {
    let unavailable: string | undefined;
    if (!context.activeAccount && (restore || accounts.restorePending && !activeTransition)) {
      restore ??= retrySavedSession().finally(() => { restore = undefined; });
      try { await restore; }
      catch (error) {
        if (accounts.restorePending && error instanceof Error)
          unavailable = error.message;
      }
    }
    const account = context.activeAccount;
    // Signed out: the accounts of this computer ("Choose an account") and
    // whether one is being added.
    const browserAccounts = account ? undefined : accounts.browserAccounts();
    const remote = account ? undefined : await accounts.policy();
    return {
      serviceOrigin: new URL(accounts.baseUrl).origin,
      account,
      hasAccounts: accounts.hasAccounts,
      signedOutReason: account ? undefined : accounts.signedOutReason,
      remote: remote && unavailable ? { ...remote, unavailable } : remote,
      twoFactorPending: accounts.pendingTwoFactor,
      ...(browserAccounts &&
      (browserAccounts.accounts.length || browserAccounts.adding)
        ? { browserAccounts }
        : {}),
    };
  });
  handle("loginAccount", async (rawEmail: unknown, rawPassword: unknown) => {
    signedOut();
    const op = beginOperation();
    return await finish(
      await accounts.login(email.parse(rawEmail), password.parse(rawPassword), op.current), op,
    );
  });
  handle("completeTwoFactor", async (rawCode: unknown) => {
    signedOut();
    const op = beginOperation();
    const result = await accounts.completeTwoFactor(
      z.string().trim().max(12).parse(rawCode), op.current,
    );
    const account = await finish(result, op);
    if ("twoFactorRequired" in account)
      throw Error("The service asked for another code.");
    return account;
  });
  handle("cancelTwoFactor", () => {
    if (activeTransition) return;
    operationSerial++;
    accounts.cancelTwoFactor();
  });
  handle("sendVerificationCode", async (rawEmail: unknown) => {
    signedOut();
    return await accounts.sendVerificationCode(email.parse(rawEmail));
  });
  // The sign-in page's other ways in (shared/sign-in-api.ts, package LOGIN).
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
      const op = beginOperation();
      return await finish(
        await accounts.loginWithCode(
          email.parse(rawEmail),
          z.string().trim().max(12).parse(rawCode),
          emailLinkRequest.parse(rawRequest), op.current,
        ), op,
      );
    },
  );
  // Continue with Google: Google in the browser, its code back here, the
  // service exchanges it (electron/google-sign-in.ts, LOGIN-GOOGLE).
  handle("loginWithGoogle", async () => {
    signedOut();
    const op = beginOperation();
    return await finish(await accounts.loginWithGoogle(authorizeWithGoogle, op.current), op);
  });
  handle("cancelGoogleSignIn", () => {
    if (activeTransition) return;
    operationSerial++;
    cancelGoogleAuthorization();
  });
  handle("loginWithPasskey", () => {
    throw Error("Passkeys work in Claudex on the web.");
  });
  handle("accountPasskeys", () => null);
  handle("setUpPasskey", () => {
    throw Error("Passkeys work in Claudex on the web.");
  });
  // Several accounts at once (live claude.ai bundle, 2026-10-12: the user
  // menu's session accounts, Add account, the signed-out chooser; the
  // desktop app shows the same page). The web keeps one cookie per
  // account; here each account's session is kept in the main process
  // (RemoteAccounts.park/resume), with its own refresh token, and the
  // service registers this computer for each account with its own key.
  handle("browserAccounts", () =>
    accounts.browserAccounts(context.activeAccount?.id),
  );
  /** The open account leaves the window but stays signed in. */
  async function leave(op: Operation, adding?: { email?: string }) {
    const session = context.session;
    if (!session) throw Error("Sign in to continue.");
    await accounts.park(session, adding, op.current);
    assertAccountOperationCurrent(op.current);
    const pending = context.deactivate();
    const generation = context.accountActivationIdentity;
    await pending;
    assertAccountOperationCurrent(() => op.intentCurrent() &&
      context.accountActivationIdentity === generation && !context.activeAccount && !context.accountStore);
    op.capture();
  }
  /** Failure recovery may only touch the same still-current operation. */
  async function open(accountId: string, op: Operation) {
    assertAccountOperationCurrent(op.current);
    const opened = await accounts.resume(accountId, op.current);
    assertAccountOperationCurrent(op.current);
    try { return await activate(opened.session, opened.account, op); }
    catch (error) {
      if (error instanceof ActivationCleanupUnconfirmed && error.isCurrent()) throw error;
      assertAccountOperationCurrent(op.current);
      await accounts.park(opened.session, undefined, op.current).catch(() => {});
      assertAccountOperationCurrent(op.current);
      throw error;
    }
  }
  handle("switchAccount", replaceActiveAccount(async (raw: unknown) => {
    const id = accountId.parse(raw);
    const active = context.activeAccount;
    if (active?.id === id) return active;
    if (!accounts.canHoldAccounts)
      throw Error("Switching accounts needs this computer's secure storage.");
    const op = beginOperation();
    const from = active ? active.id : undefined;
    if (active) await leave(op);
    assertAccountOperationCurrent(op.current);
    accounts.finishAdding();
    try {
      return await open(id, op);
    } catch (error) {
      if (error instanceof ActivationCleanupUnconfirmed && error.isCurrent()) throw error;
      // Back to the account the window had.
      assertAccountOperationCurrent(op.current);
      if (from) await open(from, op).catch(() => {});
      assertAccountOperationCurrent(op.current);
      throw error;
    }
  }));
  handle("addAccount", replaceActiveAccount(async (raw: unknown) => {
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
    const op = beginOperation();
    await leave(op, address ? { email: address } : {});
    assertAccountOperationCurrent(op.current);
    context.reloadCaller?.();
  }));
  handle("cancelAddAccount", replaceActiveAccount(async () => {
    const adding = accounts.adding;
    if (!adding || context.activeAccount) return;
    const op = beginOperation();
    accounts.finishAdding();
    await open(adding.from, op);
  }));
  handle("forgetBrowserAccount", async (raw: unknown) => {
    const id = accountId.parse(raw);
    if (context.activeAccount?.id === id)
      throw Error("Log out of this account to remove it.");
    const owner = context.activeAccount?.id, generation = context.accountActivationIdentity;
    const store = context.accountStore, serial = operationSerial;
    const current = () => serial === operationSerial && context.activeAccount?.id === owner &&
      context.accountActivationIdentity === generation && context.accountStore === store &&
      (context.accountRetiring !== true || (!context.activeAccount && !context.accountStore));
    await accounts.forget(id, current);
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
      const op = beginOperation();
      const result = await accounts.register(
        email.parse(rawEmail),
        password.parse(rawPassword),
        (extrasSchema.parse(rawExtras) ?? {}) as RegisterExtras, op.current,
      );
      const account = await finish(result, op);
      if ("twoFactorRequired" in account)
        throw Error("Sign in to finish creating your account.");
      return account;
    },
  );
  handle("logoutAccount", replaceActiveAccount(async () => {
    const serial = ++operationSerial;
    const session = context.session, owner = context.activeAccount?.id;
    const generation = context.accountActivationIdentity, store = context.accountStore;
    const current = () => serial === operationSerial && context.session === session && context.activeAccount?.id === owner &&
      context.accountActivationIdentity === generation && context.accountStore === store && context.accountRetiring !== true &&
      (!("accountActivationIdentity" in context) || generation != null && generation !== "");
    assertAccountOperationCurrent(current);
    // Order matters: the device leaves with the access token the logout ends.
    if (session) await context.leaveDevice?.().catch(() => {});
    assertAccountOperationCurrent(current);
    await session
      ?.logout(current)
      .catch((error) =>
        console.error(
          "The service did not confirm sign-out:",
          error instanceof Error ? error.message : String(error),
        ),
      );
    assertAccountOperationCurrent(current);
    await context.deactivate();
    return {
      hasAccounts: accounts.hasAccounts,
      remote: await accounts.policy(),
    };
  }));
  handle("revokeAllSessions", replaceActiveAccount(async () => {
    const serial = ++operationSerial;
    const session = context.session, owner = context.activeAccount?.id;
    const generation = context.accountActivationIdentity, store = context.accountStore;
    if (!session) throw Error("Sign in to continue.");
    const current = () => serial === operationSerial && context.session === session && context.activeAccount?.id === owner &&
      context.accountActivationIdentity === generation && context.accountStore === store && context.accountRetiring !== true &&
      (!("accountActivationIdentity" in context) || generation != null && generation !== "");
    assertAccountOperationCurrent(current);
    await session.revokeAll(current);
    assertAccountOperationCurrent(current);
    await context.deactivate();
    return {
      hasAccounts: accounts.hasAccounts,
      remote: await accounts.policy(),
    };
  }));
}
