/**
 * The web sign-in session (W-ARCH §4, web plan §2 #5). The refresh token
 * lives only in the HttpOnly `__Secure-claudex_web_rt` cookie, which the
 * browser sends to the auth endpoints alone; the 60-minute access token is
 * kept in this object's memory and never written to storage. A reloaded
 * page restores its session with `POST auth/refresh`.
 *
 * Several tabs share one cookie, and every refresh rotates it, so refreshes
 * run one at a time across tabs (Web Locks) and each tab tells the others
 * the new access token (BroadcastChannel), which saves them a refresh. A
 * sign-out in one tab signs the others out too.
 *
 * Several accounts per browser (the account menu's other accounts, "Add
 * account", the signed-out "Choose an account"; live claude.ai bundle,
 * 2026-10-12): each account has its own refresh cookie, and every refresh
 * and logout names its account. A tab keeps its account across reloads
 * (sessionStorage); a new tab opens the account used last (localStorage).
 * The accounts used here are remembered in localStorage (id, email, name:
 * no token) for the chooser, ten at most as the original keeps.
 */
import type { AppEvent, PublicAccount } from "../../shared/types";
import {
  parseTicketResponse,
  webAuthRoutes,
  type WebTicketResponse,
} from "../../shared/web-protocol";
import type { ChannelLike, WebEnv } from "../../shared/web-client/env";
import {
  bridgeError,
  messages,
  statusOf,
} from "../../shared/web-client/errors";
import {
  authChannel,
  tabAccountKey,
  addingKey,
  lastAccountKey,
  rememberedKey,
  loggedOut,
  rememberLimit,
  record,
  text,
} from "./auth-support";
import * as authSession from "./auth-session";
import { installMethods } from "./install-methods";
import * as authSignIn from "./auth-sign-in";
import * as authAccounts from "./auth-accounts";

export interface WebSession {
  accessToken: string;
  /** When the access token expires (ms since the epoch). */
  expiresAt: number;
  sessionId?: number;
  account: PublicAccount;
}

export type SignedOutReason = Extract<
  AppEvent,
  { type: "signed-out" }
>["reason"];

/** Messages between this origin's tabs on `authChannel`. */
export type TabMessage =
  | { type: "session"; session: WebSession }
  | {
      type: "signed-out";
      reason: SignedOutReason;
      message: string;
      /** The account that ended; older tabs sent none (then: any). */
      account?: string;
      sessionId?: number;
    };

interface Remembered {
  id: string;
  email: string;
  name: string;
  /** Its session ended without a log out. */
  signInAgain?: boolean;
}

export type Json = Record<string, unknown>;

export class WebAuth {
  authUnavailable = false;
  session?: WebSession;
  /** Memory-only activation epoch: never a token, cookie, storage value or wire field. */
  sessionEpoch: object = {};
  get activationIdentity(): object | undefined { return this.session ? this.sessionEpoch : undefined; }
  revokingAll?: { epoch: object; notice?: { message?: string; fromTab?: true } };
  pendingTwoFactor?: { tempToken?: string; maskedEmail: string };
  refreshing?: Promise<WebSession | null>;
  refreshingEpoch?: object;
  refreshTimer?: unknown;
  channel: ChannelLike | null;
  changes = new Set<(session: WebSession | undefined) => void>();

  constructor(
    public env: WebEnv,
    public tabId: string,
    /** Emits `signed-out` to the window. */
    public emit: (event: AppEvent) => void,
  ) {
    this.channel = env.channel(authChannel);
    if (this.channel)
      this.channel.onmessage = (event) => this.fromTab(event.data);
  }

  get current(): WebSession | undefined {
    return this.session;
  }

  /** Called when the session starts, changes token or ends. */
  onChange(listener: (session: WebSession | undefined) => void) {
    this.changes.add(listener);
    return () => this.changes.delete(listener);
  }

  // -------------------------------------------------------------------------
  // The accounts of this browser (storage holds ids, emails and names only)

  setTabValue(key: string, value: string | undefined) {
    this.env.setSessionValue?.(key, value);
  }

  private local(key: string) {
    return this.env.localValue?.(key);
  }

  setLocal(key: string, value: string | undefined) {
    this.env.setLocalValue?.(key, value);
  }

  /** The account this tab showed before a reload. */
  tabAccount() {
    return this.env.sessionValue(tabAccountKey) || undefined;
  }

  /** This tab is adding an account; the email to fill in, if any. */
  addingAccount(): { email?: string } | undefined {
    const raw = this.env.sessionValue(addingKey);
    if (raw === undefined) return undefined;
    try {
      const email = text(record(JSON.parse(raw))?.email, 254);
      return email ? { email } : {};
    } catch {
      return {};
    }
  }

  remembered(): Remembered[] {
    let list: unknown;
    try {
      list = JSON.parse(this.local(rememberedKey) ?? "[]");
    } catch {
      return [];
    }
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const out: Remembered[] = [];
    for (const item of list) {
      const json = record(item);
      const id = text(json?.id, 40);
      const email = text(json?.email, 254);
      if (!/^\d{1,19}$/.test(id) || !email || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        email,
        name: text(json?.name, 200) || email,
        ...(json?.signInAgain === true ? { signInAgain: true } : {}),
      });
    }
    return out.slice(0, rememberLimit);
  }

  saveRemembered(list: Remembered[]) {
    this.setLocal(
      rememberedKey,
      list.length ? JSON.stringify(list.slice(0, rememberLimit)) : undefined,
    );
  }

  /** The account signed in here: first in the list, its session alive. */
  remember(account: PublicAccount) {
    this.saveRemembered([
      { id: account.id, email: account.email, name: account.name },
      ...this.remembered().filter((item) => item.id !== account.id),
    ]);
  }

  markSignInAgain(id: string, signInAgain: boolean) {
    this.saveRemembered(
      this.remembered().map((item) =>
        item.id !== id
          ? item
          : signInAgain
            ? { ...item, signInAgain: true }
            : { id: item.id, email: item.email, name: item.name },
      ),
    );
  }

  /** The tab's account left by choice: a reload or new tab signs nothing in. */
  leftAccount(id: string) {
    if (this.tabAccount() === id) this.setTabValue(tabAccountKey, undefined);
    const last = this.local(lastAccountKey);
    if (last === id || last === undefined)
      this.setLocal(lastAccountKey, loggedOut);
    this.markSignInAgain(id, false);
  }

  /**
   * The account a signed-out tab opens: its own (a reload), else the one
   * used last; none after a log out; without either the service picks one
   * of the browser's cookies (a browser signed in before several accounts).
   */
  startAccount(): { account?: string } | null {
    const tab = this.tabAccount();
    if (tab) return { account: tab };
    const last = this.local(lastAccountKey);
    if (last === loggedOut) return null;
    return last ? { account: last } : {};
  }

  signedOutOnly() {
    if (this.session) throw bridgeError("Already signed in.");
  }

  /**
   * A one-time ticket for a WebSocket of this tab: the event stream, or the
   * dictation socket (`voiceTicket`, bound to this web session).
   */
  async ticket(
    route:
      | typeof webAuthRoutes.eventsTicket
      | typeof webAuthRoutes.voiceTicket = webAuthRoutes.eventsTicket,
  ): Promise<WebTicketResponse> {
    const opening = this.activationIdentity;
    const current = () => {
      if (this.activationIdentity !== opening)
        throw new DOMException("The active account changed.", "AbortError");
    };
    const send = async (token: string) => {
      current();
      const answer = await this.post(route, { tabId: this.tabId }, token);
      current();
      return parseTicketResponse(answer.value);
    };
    const token = await this.accessToken();
    try {
      return await send(token);
    } catch (error) {
      current();
      if (statusOf(error) !== 401) throw error;
      const next = await this.refresh(token);
      if (!next) throw bridgeError(messages.sessionExpired, "UNAUTHORIZED");
      return send(next.accessToken);
    }
  }

  dispose() {
    this.env.timers.clearTimeout(this.refreshTimer);
    this.channel?.close();
  }
}

export interface WebAuth {
  browserAccounts: OmitThisParameter<typeof authAccounts.browserAccounts>;
  switchAccount: OmitThisParameter<typeof authAccounts.switchAccount>;
  addAccount: OmitThisParameter<typeof authAccounts.addAccount>;
  cancelAddAccount: OmitThisParameter<typeof authAccounts.cancelAddAccount>;
  forgetBrowserAccount: OmitThisParameter<
    typeof authAccounts.forgetBrowserAccount
  >;
}
installMethods(WebAuth.prototype, authAccounts);

export interface WebAuth {
  login: OmitThisParameter<typeof authSignIn.login>;
  completeTwoFactor: OmitThisParameter<typeof authSignIn.completeTwoFactor>;
  cancelTwoFactor: OmitThisParameter<typeof authSignIn.cancelTwoFactor>;
  sendCode: OmitThisParameter<typeof authSignIn.sendCode>;
  requestPasswordReset: OmitThisParameter<
    typeof authSignIn.requestPasswordReset
  >;
  resetPassword: OmitThisParameter<typeof authSignIn.resetPassword>;
  sendSignInCode: OmitThisParameter<typeof authSignIn.sendSignInCode>;
  loginWithCode: OmitThisParameter<typeof authSignIn.loginWithCode>;
  loginWithGoogle: OmitThisParameter<typeof authSignIn.loginWithGoogle>;
  loginWithPasskey: OmitThisParameter<typeof authSignIn.loginWithPasskey>;
  register: OmitThisParameter<typeof authSignIn.register>;
  logout: OmitThisParameter<typeof authSignIn.logout>;
  revokeAll: OmitThisParameter<typeof authSignIn.revokeAll>;
}
installMethods(WebAuth.prototype, authSignIn);

export interface WebAuth {
  headers: OmitThisParameter<typeof authSession.headers>;
  post: OmitThisParameter<typeof authSession.post>;
  get: OmitThisParameter<typeof authSession.get>;
  adopt: OmitThisParameter<typeof authSession.adopt>;
  set: OmitThisParameter<typeof authSession.set>;
  tell: OmitThisParameter<typeof authSession.tell>;
  fromTab: OmitThisParameter<typeof authSession.fromTab>;
  end: OmitThisParameter<typeof authSession.end>;
  expire: OmitThisParameter<typeof authSession.expire>;
  refresh: OmitThisParameter<typeof authSession.refresh>;
  refreshNow: OmitThisParameter<typeof authSession.refreshNow>;
  accessToken: OmitThisParameter<typeof authSession.accessToken>;
  signedOutStatus: OmitThisParameter<typeof authSession.signedOutStatus>;
  status: OmitThisParameter<typeof authSession.status>;
  signedIn: OmitThisParameter<typeof authSession.signedIn>;
}
installMethods(WebAuth.prototype, authSession);
