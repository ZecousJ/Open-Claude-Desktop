import fs from "node:fs";
import path from "node:path";
import type { PublicAccount, RemoteSignInPolicy } from "../../shared/types";
import type { StorageCipher } from "../engine/provider-credentials";
import { Sub2ApiClient, type PublicSettings, type RemoteUser } from "./client";
import { Sub2ApiError, type Fetch } from "./http";
import { deviceId } from "./provision";
import { ParkedSessions, RemoteSession, SessionFile } from "./session";
import {
  desktopMaxAccounts,
  noBrowserAccounts,
  signInAgainCode,
  type BrowserAccounts,
  type SignInOptions,
} from "../../shared/sign-in-api";
import { remoteAccountId } from "./identity-support";
import { signInError } from "./identity-support";
import { publicAccount } from "./identity-support";
import * as identitySignIn from "./identity-sign-in";
import { installMethods } from "./install-methods";

interface KnownAccount {
  id: string;
  baseUrl: string;
  userId: number;
  email: string;
  /** The account's name as the menu shows it (older registries: none). */
  name?: string;
  /** Its session ended without a log out: the menu offers "Sign in again". */
  ended?: boolean;
  /** When it was last opened here (ms), most recent first in the lists. */
  usedAt?: number;
}
/** How many signed-out accounts the chooser remembers (the web's 10). */
const rememberedAccounts = 10;
const settingsCacheMs = 60_000;

export type SignIn =
  | { kind: "signedIn"; session: RemoteSession; account: PublicAccount }
  | { kind: "twoFactor"; maskedEmail: string };

/** Sign-in against the operator's Sub2API service; replaces the local account registry. */
export class RemoteAccounts {
  client: Sub2ApiClient;
  private readonly registry: string;
  readonly file: SessionFile;
  /** The other signed-in accounts (Add account / Switch account). */
  readonly parked: ParkedSessions;
  private readonly addingFile: string;
  private known: KnownAccount[] = [];
  private settings?: { value: PublicSettings; at: number };
  challenge?: { tempToken: string; email: string; expiresAt: number };
  constructor(
    private root: string,
    /** The service's address; empty until one is chosen. */
    public baseUrl: string,
    cipher: StorageCipher,
    private fetchImpl: Fetch = fetch,
    public now: () => number = Date.now,
  ) {
    this.client = new Sub2ApiClient(baseUrl, fetchImpl);
    this.file = new SessionFile(root, cipher);
    this.parked = new ParkedSessions(root, cipher);
    this.addingFile = path.join(root, "remote-adding.json");
    this.registry = path.join(root, "remote-accounts.json");
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(this.registry, "utf8"),
      );
      const accounts = (parsed as { accounts?: unknown })?.accounts;
      if (Array.isArray(accounts))
        this.known = accounts
          .filter(
            (item): item is KnownAccount =>
              !!item &&
              typeof item.id === "string" &&
              /^[0-9a-f-]{36}$/.test(item.id) &&
              typeof item.baseUrl === "string" &&
              Number.isSafeInteger(item.userId) &&
              typeof item.email === "string",
          )
          .map((item) => ({
            id: item.id,
            baseUrl: item.baseUrl,
            userId: item.userId,
            email: item.email,
            ...(typeof item.name === "string" && item.name.length <= 200
              ? { name: item.name }
              : {}),
            ...(item.ended === true ? { ended: true } : {}),
            ...(Number.isFinite(item.usedAt) ? { usedAt: item.usedAt } : {}),
          }));
    } catch {
      this.known = [];
    }
  }
  /** A service has been chosen (a build without a default asks for one). */
  get configured() {
    return this.baseUrl !== "";
  }
  /** Signs in to another service from now on: the one the person entered. */
  useService(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.client = new Sub2ApiClient(baseUrl, this.fetchImpl);
    this.settings = undefined;
    this.kind = undefined;
    this.challenge = undefined;
  }
  /** Someone has signed in to this service on this computer before. */
  get hasAccounts() {
    return this.known.some((item) => item.baseUrl === this.baseUrl);
  }
  ownsLegacyData() {
    // Legacy single-user data belongs to local accounts only.
    return false;
  }
  private kind?: "claudex" | "legacy";
  /**
   * Whether the service has the Claudex module. Only a 404 from the public
   * `GET /claudex/release` makes it an older Sub2API (legacy key flow); an
   * outage or a 5xx is not a reason to fall back, so it counts as a Claudex
   * service and is asked again next time. Known answers are kept for this run.
   */
  async serviceKind(): Promise<"claudex" | "legacy"> {
    if (this.kind) return this.kind;
    try {
      await this.client.claudexRelease();
      this.kind = "claudex";
    } catch (error) {
      if (error instanceof Sub2ApiError && error.status === 404) {
        this.kind = "legacy";
        return this.kind;
      }
      // An answer outside the contract still comes from a Claudex service.
      if (!(error instanceof Sub2ApiError)) this.kind = "claudex";
      return "claudex";
    }
    return this.kind;
  }
  profileRoot(accountId: string) {
    if (!this.known.some((item) => item.id === accountId))
      throw Error("Unknown account.");
    const folder = path.join(this.root, "profiles", accountId);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    return folder;
  }
  async publicSettings(fresh = false) {
    if (
      !fresh &&
      this.settings &&
      this.now() - this.settings.at < settingsCacheMs
    )
      return this.settings.value;
    const value = await this.client.publicSettings();
    this.settings = { value, at: this.now() };
    return value;
  }
  /** What the sign-in screen may offer, straight from the service's public settings. */
  async policy(): Promise<RemoteSignInPolicy> {
    try {
      const [settings, options] = await Promise.all([
        this.publicSettings(true),
        // An older service or a failed read offers no email codes.
        this.client
          .signInOptions()
          .catch(() => ({ emailCodeLogin: false }) as SignInOptions),
      ]);
      const privacy = options.privacyPolicyUrl ?? settings.agreementUrl;
      return {
        siteName: settings.siteName,
        registrationEnabled:
          settings.registrationEnabled && !settings.backendModeEnabled,
        emailVerification: settings.emailVerifyEnabled,
        invitationCode: settings.invitationCodeEnabled,
        promoCode: settings.promoCodeEnabled,
        captchaRequired: settings.captchaEnabled,
        emailDomains: settings.emailSuffixWhitelist,
        passwordReset:
          settings.passwordResetEnabled && !settings.backendModeEnabled,
        emailCodeLogin: options.emailCodeLogin && !settings.backendModeEnabled,
        ...(options.googleDesktopClientId && !settings.backendModeEnabled
          ? { googleClientId: options.googleDesktopClientId }
          : {}),
        backendMode: settings.backendModeEnabled,
        // The window opens links in the browser: a path becomes an address
        // on this service.
        ...(privacy
          ? { privacyPolicyUrl: new URL(privacy, this.baseUrl).href }
          : {}),
      };
    } catch (error) {
      return {
        siteName: "",
        registrationEnabled: false,
        emailVerification: false,
        invitationCode: false,
        promoCode: false,
        captchaRequired: false,
        emailDomains: [],
        unavailable: signInError(error).message,
      };
    }
  }
  private writeRegistry() {
    const temporary = `${this.registry}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({ version: 1, accounts: this.known }, null, 2),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, this.registry);
  }
  remember(user: RemoteUser) {
    const id = remoteAccountId(this.baseUrl, user.id);
    this.known = [
      ...this.known.filter((item) => item.id !== id),
      {
        id,
        baseUrl: this.baseUrl,
        userId: user.id,
        email: user.email,
        name: publicAccount(id, user).name,
        usedAt: this.now(),
      },
    ];
    this.writeRegistry();
    return id;
  }

  // Several accounts at once (Add account / Switch account). The live claude.ai
  // bundle keeps one session per account in the browser and its desktop app
  // shows that same web page; Claudex keeps each account's session here instead
  // (ParkedSessions).

  /** Whether this computer can keep accounts signed in beside the open one. */
  get canHoldAccounts() {
    return this.file.persistent;
  }
  /** The account being added: the window's account parked meanwhile. */
  get adding(): { from: string; email?: string } | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(this.addingFile, "utf8")) as {
        from?: unknown;
        email?: unknown;
      };
      if (typeof value.from !== "string" || !/^[0-9a-f-]{36}$/.test(value.from))
        return undefined;
      return {
        from: value.from,
        ...(typeof value.email === "string" && value.email.length <= 254
          ? { email: value.email }
          : {}),
      };
    } catch {
      return undefined;
    }
  }
  setAdding(value: { from: string; email?: string } | undefined) {
    if (!value) {
      fs.rmSync(this.addingFile, { force: true });
      return;
    }
    fs.writeFileSync(this.addingFile, JSON.stringify(value), { mode: 0o600 });
  }
  /** Ends "adding an account" (it signed in, or the person went back). */
  finishAdding() {
    this.setAdding(undefined);
  }
  /** The session of the service ended without a log out: "Sign in again". */
  markEnded(accountId: string) {
    const item = this.known.find((value) => value.id === accountId);
    if (!item || item.ended) return;
    item.ended = true;
    this.writeRegistry();
  }
  /** The signed-in accounts kept beside the open one. */
  private parkedIds() {
    return new Set(
      this.parked
        .list()
        .filter((record) => record.baseUrl === this.baseUrl)
        .map((record) => record.accountId),
    );
  }
  /**
   * The accounts of this service on this computer: the open one, the
   * others still signed in, and the remembered ones (10 at most), most
   * recently used first.
   */
  browserAccounts(current?: string): BrowserAccounts {
    if (!this.canHoldAccounts) return noBrowserAccounts;
    const parked = this.parkedIds();
    const adding = this.adding;
    const accounts = this.known
      .filter((item) => item.baseUrl === this.baseUrl)
      .sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0))
      .map((item) => {
        const signedIn = item.id === current || parked.has(item.id);
        return {
          id: item.id,
          email: item.email,
          name: item.name || item.email.split("@")[0] || item.email,
          signedIn,
          ...(item.ended && !signedIn ? { signInAgain: true } : {}),
        };
      })
      .filter(
        (item, index, list) =>
          item.signedIn ||
          list.slice(0, index).filter((other) => !other.signedIn).length <
            rememberedAccounts,
      );
    return {
      ...(current ? { current } : adding ? { current: adding.from } : {}),
      accounts,
      maxAccounts: desktopMaxAccounts,
      ...(adding && !current
        ? { adding: adding.email ? { email: adding.email } : {} }
        : {}),
    };
  }
  /** How many accounts are signed in here, the open one included. */
  signedInCount(current?: string) {
    const parked = this.parkedIds();
    if (current) parked.add(current);
    return parked.size;
  }
  /**
   * Keeps the open account signed in while the window leaves it (a switch,
   * or Add account with `adding`): its session moves to ParkedSessions.
   */
  async park(session: RemoteSession, adding?: { email?: string }) {
    const record = await session.detach();
    if (!this.parked.save(record))
      throw Error("Switching accounts needs this computer's secure storage.");
    this.file.clear();
    if (adding) this.setAdding({ from: record.accountId, ...adding });
  }
  /**
   * Opens a parked account: its session moves back to the open session's
   * file and is renewed once. A session the service ended is refused with
   * `signInAgainCode` (and the account offers "Sign in again"); an outage
   * keeps it parked.
   */
  async resume(
    accountId: string,
  ): Promise<{ session: RemoteSession; account: PublicAccount }> {
    const record = this.parked.load(accountId);
    if (!record || record.baseUrl !== this.baseUrl) {
      this.markEnded(accountId);
      throw Error(signInAgainCode);
    }
    // The open file first, so a renewed token is never only in memory.
    if (this.file.persistent) this.file.save(record);
    this.parked.remove(accountId);
    const session = new RemoteSession(
      this.client,
      this.file,
      record,
      undefined,
      this.now,
    );
    try {
      await session.refresh();
      const user = await session.authorized((token) => this.client.me(token));
      if (remoteAccountId(this.baseUrl, user.id) !== accountId)
        throw new Sub2ApiError(401, "ACCOUNT_CHANGED", "");
      this.remember(user);
      return { session, account: publicAccount(accountId, user) };
    } catch (error) {
      if (error instanceof Sub2ApiError && error.status === 401) {
        session.end();
        this.markEnded(accountId);
        throw Error(signInAgainCode);
      }
      // Not reachable now: the account stays signed in for later.
      this.parked.save(await session.detach());
      this.file.clear();
      throw signInError(error);
    }
  }
  /**
   * An account signed in anew while an older session of it was parked:
   * the older one's refresh token is revoked (best effort) and forgotten.
   */
  async dropParked(accountId: string) {
    const record = this.parked.load(accountId);
    if (!record) return;
    this.parked.remove(accountId);
    await this.client.logout(record.refreshToken).catch(() => {});
  }
  /**
   * "Remove {email} from this device": a parked account signs out (the
   * service lets this device go, the refresh token is revoked) and is
   * forgotten here. Never throws for an unreachable service.
   */
  async forget(accountId: string) {
    const record = this.parked.load(accountId);
    if (record) {
      const session = new RemoteSession(
        this.client,
        this.parked.file(accountId),
        record,
        undefined,
        this.now,
      );
      if ((await this.serviceKind()) === "claudex")
        await session
          .authorized((token) =>
            this.client.revokeCurrentDevice(token, deviceId(this.root), 3_000),
          )
          .catch(() => {});
      await session.logout().catch(() => {});
      this.parked.remove(accountId);
    }
    if (this.adding?.from === accountId) this.setAdding(undefined);
    this.known = this.known.filter((item) => item.id !== accountId);
    this.writeRegistry();
  }
  async removeDeleted(accountId: string) {
    if (!/^[0-9a-f-]{36}$/.test(accountId)) throw Error("Unknown account.");
    await this.forget(accountId);
    fs.rmSync(path.join(this.root, "profiles", accountId), {
      recursive: true,
      force: true,
    });
  }
  get pendingTwoFactor() {
    return !!this.challenge && this.challenge.expiresAt > this.now();
  }
  cancelTwoFactor() {
    this.challenge = undefined;
  }
}

export interface RemoteAccounts {
  finish(
    ...args: Parameters<typeof identitySignIn.finish>
  ): ReturnType<typeof identitySignIn.finish>;
  login(
    ...args: Parameters<typeof identitySignIn.login>
  ): ReturnType<typeof identitySignIn.login>;
  completeTwoFactor(
    ...args: Parameters<typeof identitySignIn.completeTwoFactor>
  ): ReturnType<typeof identitySignIn.completeTwoFactor>;
  requestPasswordReset(
    ...args: Parameters<typeof identitySignIn.requestPasswordReset>
  ): ReturnType<typeof identitySignIn.requestPasswordReset>;
  resetPassword(
    ...args: Parameters<typeof identitySignIn.resetPassword>
  ): ReturnType<typeof identitySignIn.resetPassword>;
  sendSignInCode(
    ...args: Parameters<typeof identitySignIn.sendSignInCode>
  ): ReturnType<typeof identitySignIn.sendSignInCode>;
  loginWithCode(
    ...args: Parameters<typeof identitySignIn.loginWithCode>
  ): ReturnType<typeof identitySignIn.loginWithCode>;
  loginWithGoogle(
    ...args: Parameters<typeof identitySignIn.loginWithGoogle>
  ): ReturnType<typeof identitySignIn.loginWithGoogle>;
  sendVerificationCode(
    ...args: Parameters<typeof identitySignIn.sendVerificationCode>
  ): ReturnType<typeof identitySignIn.sendVerificationCode>;
  register(
    ...args: Parameters<typeof identitySignIn.register>
  ): ReturnType<typeof identitySignIn.register>;
  restore(
    ...args: Parameters<typeof identitySignIn.restore>
  ): ReturnType<typeof identitySignIn.restore>;
}
installMethods(RemoteAccounts.prototype, identitySignIn);
