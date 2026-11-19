import type {
  AuthStatus,
  PublicAccount,
  RemoteSignInPolicy,
  TwoFactorChallenge,
} from "../../shared/types";
import {
  webAuthRoutes,
  webClientName,
  webHeaders,
  webPaths,
} from "../../shared/web-protocol";
import {
  parseSignInOptions,
  signInOptionsRoute,
} from "../../shared/sign-in-api";
import {
  apiError,
  apiValue,
  bridgeError,
  messages,
  offlineError,
  readJson,
} from "../../shared/web-client/errors";
import {
  refreshLock,
  tabAccountKey,
  addingKey,
  lastAccountKey,
  refreshAheadMs,
  minimumLifeMs,
  signedOutMessages,
  record,
  text,
  accountFrom,
  signInPolicy,
  friendly,
  isSignedOutError,
} from "./auth-support";
import type { WebAuth } from "./auth";
import type { WebSession, SignedOutReason, TabMessage } from "./auth";

// -------------------------------------------------------------------------
// Requests

export function headers(
  this: WebAuth,
  bearer?: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    [webHeaders.web]: "1",
    [webHeaders.client]: webClientName,
    [webHeaders.tab]: this.tabId,
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
  };
}

/** POST to an auth endpoint; resolves to the answer's value. */
export async function post(
  this: WebAuth,
  route: string,
  body: unknown,
  bearer?: string,
): Promise<{ status: number; value: unknown }> {
  let response: Response;
  try {
    response = await this.env.fetch(`${webPaths.auth}${route}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: this.headers(bearer),
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw offlineError();
  }
  const json = await readJson(response);
  if (!response.ok)
    throw friendly(
      apiError(response.status, json),
      route !== webAuthRoutes.refresh && !bearer,
      route === webAuthRoutes.twoFactor,
    );
  return { status: response.status, value: apiValue(response.status, json) };
}

export async function get(
  this: WebAuth,
  path: string,
  bearer?: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await this.env.fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      headers: this.headers(bearer),
    });
  } catch {
    throw offlineError();
  }
  const json = await readJson(response);
  if (!response.ok) throw apiError(response.status, json);
  return apiValue(response.status, json);
}

/** Starts a session from an answer carrying an access token. */
export async function adopt(
  this: WebAuth,
  value: unknown,
  previous?: PublicAccount,
  continuation?: { epoch: object; session: WebSession },
) {
  const startingEpoch = this.sessionEpoch;
  const current = () => this.sessionEpoch === startingEpoch && (!continuation ||
    continuation.epoch === this.sessionEpoch && continuation.session === this.session);
  if (!current()) throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
  const json = record(value);
  const token = typeof json?.access_token === "string" ? json.access_token : "";
  if (!token) throw bridgeError("The service did not start a session.");
  const seconds =
    typeof json?.expires_in === "number" && json.expires_in > 0
      ? json.expires_in
      : 3600;
  // Any refresh token in the body is ignored: the cookie holds it. The
  // account always comes from the service: the cookie is shared by the
  // origin's tabs, so a refresh may answer for someone who signed in in
  // another tab, and the previous account must not label their token.
  const account =
    accountFrom(json) ?? accountFrom(await this.get("/api/v1/auth/me", token));
  if (!current()) throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
  if (!account) throw bridgeError("The service did not return the account.");
  if (previous && account.id !== previous.id) {
    // This tab shows someone else's data: back to sign-in, not a switch.
    // Only this tab: the other tab's new session is valid.
    this.end(
      "session-expired",
      "You signed in with another account in another tab. Sign in again.",
      false,
    );
    throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
  }
  const rawSessionId = json?.session_id;
  const sessionId = typeof rawSessionId === "number" && Number.isSafeInteger(rawSessionId) && rawSessionId > 0
    ? rawSessionId : undefined;
  if (continuation?.session.sessionId !== undefined && sessionId !== continuation.session.sessionId) {
    this.end("session-expired", messages.sessionExpired, false);
    throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
  }
  const session: WebSession = {
    ...(sessionId !== undefined ? { sessionId } : {}),
    accessToken: token,
    expiresAt: this.env.now() + seconds * 1000,
    account,
  };
  // This tab shows the account from now on (also after a reload), a new
  // tab opens it, and the chooser remembers it.
  this.setTabValue(tabAccountKey, account.id);
  this.setTabValue(addingKey, undefined);
  this.setLocal(lastAccountKey, account.id);
  this.remember(account);
  this.set(session, continuation);
  this.tell({ type: "session", session });
  return session;
}

export function set(this: WebAuth, session: WebSession | undefined, continuation?: { epoch: object; session: WebSession }) {
  // Only a token refresh for this session preserves its activation.
  const refresh = !!session && !!continuation && continuation.epoch === this.sessionEpoch &&
    continuation.session === this.session && session.account.id === this.session?.account.id &&
    (this.session?.sessionId === undefined || session.sessionId === this.session.sessionId);
  if (continuation && !refresh) throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
  if (!refresh) this.sessionEpoch = {};
  this.session = session;
  if (!session) this.authUnavailable = false;
  this.env.timers.clearTimeout(this.refreshTimer);
  this.refreshTimer = undefined;
  if (session) {
    const life = session.expiresAt - this.env.now();
    const ahead = Math.min(refreshAheadMs, life / 5);
    this.refreshTimer = this.env.timers.setTimeout(
      () => void this.refresh(session.accessToken).catch(() => {}),
      Math.max(5_000, life - ahead),
    );
  }
  this.changes.forEach((listener) => listener(session));
}

export function tell(this: WebAuth, message: TabMessage) {
  try {
    this.channel?.postMessage(message);
  } catch {
    /* A closed channel: the other tabs refresh on their own. */
  }
}

export function fromTab(this: WebAuth, data: unknown) {
  const message = record(data) as TabMessage | undefined;
  if (!message) return;
  if (message.type === "session") {
    const next = message.session;
    const mine = this.session;
    // Only a newer token of the account this tab shows; a sign-in in
    // another tab does not sign this one in behind the window's back.
    if (
      mine &&
      next?.account?.id === mine.account.id &&
      next.sessionId === mine.sessionId &&
      typeof next.accessToken === "string" &&
      next.accessToken.length > 0 &&
      typeof next.expiresAt === "number" && Number.isFinite(next.expiresAt) &&
      next.accessToken !== mine.accessToken &&
      next.expiresAt >= mine.expiresAt
    ) {
      const updated = { ...mine, accessToken: next.accessToken, expiresAt: next.expiresAt };
      this.set(updated, mine.sessionId !== undefined ? { epoch: this.sessionEpoch, session: mine } : undefined);
    }
  } else if (message.type === "signed-out" && this.session) {
    // Another tab's account ending leaves this tab's alone.
    if (
      (typeof message.account === "string" && message.account !== this.session.account.id) ||
      (typeof message.sessionId === "number" && this.session.sessionId !== undefined &&
        message.sessionId !== this.session.sessionId)
    )
      return;
    const pending = this.revokingAll;
    if (message.reason === "revoked" && pending?.epoch === this.sessionEpoch) {
      pending.notice ??= { message: message.message, fromTab: true };
      return;
    }
    this.end(message.reason, message.message, false);
  }
}

/** Ends the session here (and in the other tabs when `tell`). */
export function end(
  this: WebAuth,
  reason: SignedOutReason,
  message: string,
  tell: boolean,
) {
  const account = this.session?.account.id;
  const sessionId = this.session?.sessionId;
  this.set(undefined);
  if (tell) this.tell({ type: "signed-out", reason, message, account, sessionId });
  if (account) this.emit({ type: "signed-out", reason, message });
}

/** The service ended the session (revoked, expired): back to sign-in. */
export function expire(
  this: WebAuth,
  reason: SignedOutReason,
  message?: string,
) {
  const pending = this.revokingAll;
  if (reason === "revoked" && pending?.epoch === this.sessionEpoch) {
    pending.notice = { message };
    return;
  }
  // The account menu offers to sign in to it again (its session ended
  // without a log out).
  const account = this.session?.account.id;
  if (account) this.markSignInAgain(account, true);
  this.end(reason, message || signedOutMessages[reason], true);
}

// -------------------------------------------------------------------------
// Tokens

/**
 * A new access token from the cookie; null when the cookie is missing,
 * expired or revoked. `stale` is the token a call was refused with: when
 * another tab already replaced it, that token is used instead.
 */
export function refresh(
  this: WebAuth,
  stale?: string,
  account?: string,
): Promise<WebSession | null> {
  if (!this.refreshing || this.refreshingEpoch !== this.sessionEpoch) {
    const epoch = this.sessionEpoch;
    const run = this.env
      .withLock(refreshLock, () => this.sessionEpoch === epoch ? this.refreshNow(stale, account) : Promise.resolve(null))
      .finally(() => {
        if (this.refreshing === run) { this.refreshing = undefined; this.refreshingEpoch = undefined; }
      });
    this.refreshing = run;
    this.refreshingEpoch = epoch;
  }
  return this.refreshing;
}

/**
 * `account` names the cookie to use while signed out (the tab's or the
 * last account); signed in, it is always the session's own. Without
 * either, the service picks one of the browser's.
 */
export async function refreshNow(
  this: WebAuth,
  stale?: string,
  account?: string,
): Promise<WebSession | null> {
  const mine = this.session, epoch = this.sessionEpoch;
  const current = () => this.sessionEpoch === epoch && this.session === mine;
  // A call refused with a token of a session that has ended since (signed
  // out, another account's cookie): it must not start a new session.
  if (stale !== undefined && !mine) return null;
  if (
    mine &&
    mine.accessToken !== stale &&
    mine.expiresAt - this.env.now() > refreshAheadMs
  )
    return mine;
  const named = mine?.account.id ?? account;
  if (mine && this.authUnavailable)
    this.emit({ type: "auth-issue", issue: "retrying" });
  try {
    const { value } = await this.post(
      webAuthRoutes.refresh,
      named ? { account: named } : {},
    );
    if (!current()) return null;
    const next = await this.adopt(value, mine?.account, mine ? { epoch, session: mine } : undefined);
    if (this.session !== next || mine && this.sessionEpoch !== epoch) return null;
    // Only a recovery is news: a routine refresh says nothing.
    if (this.authUnavailable) {
      this.authUnavailable = false;
      this.emit({ type: "auth-issue", issue: null });
    }
    return next;
  } catch (error) {
    // A late old refresh must not expire or mark a later activation unavailable.
    if (!current()) return null;
    // No usable cookie: signed out. Other failures (offline, 5xx) keep
    // the session, so a short outage does not sign anyone out.
    if (isSignedOutError(error)) {
      if (this.session) this.expire("session-expired");
      return null;
    }
    // adopt() refused an answer for another account (already signed out).
    if (mine && !this.session) return null;
    if (mine) {
      this.authUnavailable = true;
      this.emit({ type: "auth-issue", issue: "auth_unavailable" });
    }
    throw error;
  }
}

/** A valid access token, refreshed when needed; throws when signed out. */
export async function accessToken(this: WebAuth): Promise<string> {
  const session = this.session;
  // Only authStatus() and sign-in start a session; a call made while
  // signed out (a window that has not caught up yet) is refused.
  if (!session) throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
  if (session.expiresAt - this.env.now() > minimumLifeMs)
    return session.accessToken;
  const next = await this.refresh(session.accessToken);
  if (!next) throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
  return next.accessToken;
}

// -------------------------------------------------------------------------
// The CoreDesktopAPI account calls

export async function signedOutStatus(this: WebAuth): Promise<AuthStatus> {
  let remote: RemoteSignInPolicy;
  // The chooser's accounts; a service without the list shows none.
  const accounts = this.browserAccounts().catch(() => undefined);
  try {
    const [settings, options] = await Promise.all([
      this.get("/api/v1/settings/public"),
      // A service without the Claudex sign-in options offers no email codes.
      this.get(`/api/v1${signInOptionsRoute}`).then(parseSignInOptions, () => ({
        emailCodeLogin: false,
      })),
    ]);
    remote = signInPolicy(settings, options, Boolean(this.env.passkey));
  } catch (error) {
    remote = {
      ...signInPolicy({}),
      unavailable: error instanceof Error ? error.message : messages.offline,
    };
  }
  const browserAccounts = await accounts;
  return {
    hasAccounts: true,
    remote,
    ...(this.pendingTwoFactor ? { twoFactorPending: true } : {}),
    ...(browserAccounts &&
    (browserAccounts.accounts.length > 0 || browserAccounts.adding)
      ? { browserAccounts }
      : {}),
  };
}

export async function status(this: WebAuth): Promise<AuthStatus> {
  if (this.session) return { account: this.session.account, hasAccounts: true };
  // Adding an account: the sign-in page, the current account left signed in.
  if (this.addingAccount()) return this.signedOutStatus();
  const start = this.startAccount();
  if (!start) return this.signedOutStatus();
  try {
    const session = await this.refresh(undefined, start.account);
    if (session) return { account: session.account, hasAccounts: true };
  } catch (error) {
    // The service cannot be reached: the form says so and offers a retry.
    const status = await this.signedOutStatus();
    return {
      ...status,
      remote: {
        ...status.remote!,
        unavailable: error instanceof Error ? error.message : messages.offline,
      },
    };
  }
  return this.signedOutStatus();
}

export async function signedIn(
  this: WebAuth,
  value: unknown,
): Promise<PublicAccount | TwoFactorChallenge> {
  const json = record(value);
  if (json?.requires_2fa === true || json?.twoFactorRequired === true) {
    const maskedEmail =
      text(json.user_email_masked, 254) ||
      text(json.masked_email, 254) ||
      text(json.maskedEmail, 254);
    this.pendingTwoFactor = {
      maskedEmail,
      ...(typeof json.temp_token === "string" && json.temp_token
        ? { tempToken: json.temp_token }
        : {}),
    };
    return { twoFactorRequired: true, maskedEmail };
  }
  this.pendingTwoFactor = undefined;
  return (await this.adopt(value)).account;
}
