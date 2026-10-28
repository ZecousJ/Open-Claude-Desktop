import fs from "node:fs";
import path from "node:path";
import type { StorageCipher } from "../engine/provider-credentials";
import type { Sub2ApiClient, TokenPair } from "./client";
import { claudexErrorCodes } from "../../shared/claudex-contract";
import { Sub2ApiError } from "./http";

/** What survives a restart: the rotating refresh token, encrypted by the OS. */
export interface SessionRecord {
  version: 1;
  baseUrl: string;
  accountId: string;
  userId: number;
  email: string;
  refreshToken: string;
}

function validRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    data.version === 1 &&
    typeof data.baseUrl === "string" &&
    typeof data.accountId === "string" &&
    /^[0-9a-f-]{36}$/.test(data.accountId) &&
    Number.isSafeInteger(data.userId) &&
    typeof data.email === "string" &&
    typeof data.refreshToken === "string" &&
    data.refreshToken.length > 0 &&
    data.refreshToken.length <= 1000
  );
}

/**
 * `remote-session.enc` in the app data root. Without OS encryption nothing
 * is written, so the session lasts only while the app runs.
 */
export class SessionFile {
  readonly filename: string;
  constructor(
    root: string,
    private cipher: StorageCipher,
    /** Another file: a signed-in account the window is not showing (ParkedSessions). */
    filename = path.join(root, "remote-session.enc"),
  ) {
    this.filename = filename;
  }
  get persistent() {
    return this.cipher.isEncryptionAvailable();
  }
  load(): SessionRecord | undefined {
    if (!fs.existsSync(this.filename) || !this.persistent) return undefined;
    try {
      const parsed: unknown = JSON.parse(
        this.cipher.decryptString(fs.readFileSync(this.filename)),
      );
      return validRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  /** Atomic: the old token stays on disk until the new one is fully written. */
  save(record: SessionRecord) {
    if (!this.persistent) return false;
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(
      temporary,
      this.cipher.encryptString(JSON.stringify(record)),
      {
        mode: 0o600,
      },
    );
    fs.renameSync(temporary, this.filename);
    return true;
  }
  clear() {
    fs.rmSync(this.filename, { force: true });
  }
}

/**
 * The other accounts signed in on this computer (Add account / Switch
 * account, as the web keeps one session per account in its browser): each
 * one's session record, encrypted like the open account's, in
 * `remote-sessions/<account id>.enc`. The open account's session stays in
 * `remote-session.enc`; a switch moves records between the two. Without OS
 * encryption nothing is kept, so only the open account stays signed in.
 */
export class ParkedSessions {
  readonly folder: string;
  constructor(
    root: string,
    private cipher: StorageCipher,
  ) {
    this.folder = path.join(root, "remote-sessions");
  }
  /** The file of one account (ids are UUID-shaped, checked by validRecord). */
  file(accountId: string) {
    if (!/^[0-9a-f-]{36}$/.test(accountId)) throw Error("Unknown account.");
    return new SessionFile(
      this.folder,
      this.cipher,
      path.join(this.folder, `${accountId}.enc`),
    );
  }
  /** Keeps a session for later; false without OS encryption. */
  save(record: SessionRecord) {
    if (!this.cipher.isEncryptionAvailable()) return false;
    fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    return this.file(record.accountId).save(record);
  }
  load(accountId: string) {
    const record = this.file(accountId).load();
    return record?.accountId === accountId ? record : undefined;
  }
  remove(accountId: string) {
    this.file(accountId).clear();
  }
  /** The kept sessions, most recently parked first. */
  list(): SessionRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.folder);
    } catch {
      return [];
    }
    return names
      .map((name) => /^([0-9a-f-]{36})\.enc$/.exec(name)?.[1])
      .filter((id): id is string => Boolean(id))
      .map((id) => {
        const record = this.load(id);
        let at = 0;
        try {
          at = fs.statSync(path.join(this.folder, `${id}.enc`)).mtimeMs;
        } catch {
          // Gone meanwhile.
        }
        return { record, at };
      })
      .filter(
        (item): item is { record: SessionRecord; at: number } =>
          item.record !== undefined,
      )
      .sort((a, b) => b.at - a.at)
      .map((item) => item.record);
  }
}

/** Why the service ended the session, as the sign-in card explains it. */
export type SessionEndReason =
  "revoked" | "session-expired" | "password-changed";

/**
 * The reason for a refresh the service refused with 401. Sub2API answers
 * TOKEN_REVOKED when the token's version no longer matches the account's,
 * which happens when the password was changed (by the person or an
 * administrator) or, more rarely, the email address; other refusals mean
 * the session ended or expired.
 */
export function refreshRefusalReason(code: string): SessionEndReason {
  if (code === claudexErrorCodes.sessionRevoked) return "revoked";
  if (code === "TOKEN_REVOKED") return "password-changed";
  return "session-expired";
}

/** Access tokens are renewed this long before they expire. */
const refreshMarginMs = 60_000;
/** Codes Sub2API uses for an access token that is no longer accepted. */
const expiredCodes = new Set([
  "INVALID_TOKEN",
  "TOKEN_EXPIRED",
  "TOKEN_REVOKED",
  "UNAUTHORIZED",
]);

/**
 * A signed-in Sub2API session in the main process. The access token stays in
 * memory; each refresh rotates the refresh token, and the new one is saved
 * before it is used so a crash cannot leave a spent token on disk.
 */
export class RemoteSession {
  onAuthIssue?: (
    issue: import("../../shared/auth-issue").AuthIssue | null,
  ) => void;
  private authUnavailable = false;
  private accessToken = "";
  private accessExpiresAt = 0;
  private refreshing?: Promise<void>;
  constructor(
    private client: Sub2ApiClient,
    private file: SessionFile,
    private record: SessionRecord,
    tokens?: TokenPair,
    private now: () => number = Date.now,
  ) {
    if (tokens) this.accept(tokens);
  }
  get accountId() {
    return this.record.accountId;
  }
  get userId() {
    return this.record.userId;
  }
  get email() {
    return this.record.email;
  }
  /** Saves the session; false when the OS offers no encrypted storage. */
  persist() {
    return this.file.save(this.record);
  }
  private accept(tokens: TokenPair) {
    this.accessToken = tokens.accessToken;
    this.accessExpiresAt = this.now() + tokens.expiresIn * 1000;
    this.record = { ...this.record, refreshToken: tokens.refreshToken };
  }
  /**
   * Called when the service ended this session: CLAUDEX_SESSION_REVOKED on
   * any call ("Log out of all devices" elsewhere, or this device removed),
   * or the refresh token refused (revoked, expired, or issued before the
   * password was changed). The remote host ends the account on this device;
   * unset while signing in.
   */
  onSignedOut?: (reason: SessionEndReason) => void;
  private signedOut(reason: SessionEndReason) {
    try {
      this.onSignedOut?.(reason);
    } catch (error) {
      console.error(
        "Sign-out handler failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  private detached = false;
  /**
   * Lets the session go without signing it out (a switch to another
   * account): waits for a refresh in flight, so the record holds the
   * newest refresh token, and refuses every later refresh, which would spend
   * that token behind the new holder's back (the service ends a family
   * whose spent token is used again). The access token is forgotten.
   */
  async detach(): Promise<SessionRecord> {
    this.detached = true;
    await this.refreshing?.catch(() => {});
    this.accessToken = "";
    this.accessExpiresAt = 0;
    return { ...this.record };
  }
  /** One refresh at a time; concurrent callers share it. */
  refresh() {
    if (this.detached)
      return Promise.reject(Error("This account is no longer open."));
    this.refreshing ??= (async () => {
      if (this.authUnavailable) this.onAuthIssue?.("retrying");
      try {
        const next = await this.client.refresh(this.record.refreshToken);
        const record = { ...this.record, refreshToken: next.refreshToken };
        if (this.file.persistent) this.file.save(record);
        this.accept(next);
        if (this.authUnavailable) {
          this.authUnavailable = false;
          this.onAuthIssue?.(null);
        }
      } catch (error) {
        if (error instanceof Sub2ApiError && error.status === 401)
          this.signedOut(refreshRefusalReason(error.code));
        else {
          this.authUnavailable = true;
          this.onAuthIssue?.("auth_unavailable");
        }
        throw error;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }
  private async token() {
    if (
      !this.accessToken ||
      this.now() >= this.accessExpiresAt - refreshMarginMs
    )
      await this.refresh();
    return this.accessToken;
  }
  /** The access token, renewed when it is about to expire (cloud client). */
  currentToken() {
    return this.token();
  }
  /**
   * A new access token after `stale` was refused (cloud client); refreshes
   * only when no other caller did already.
   */
  async renewed(stale: string) {
    if (!this.accessToken || this.accessToken === stale) await this.refresh();
    return this.accessToken;
  }
  /**
   * Runs a user-API call, refreshing once if the access token was refused.
   * A revoked session (CLAUDEX_SESSION_REVOKED) is not refreshed: the
   * service signed this device out, so `onSignedOut` hears of it.
   */
  async authorized<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    try {
      const first = await this.token();
      try {
        return await call(first);
      } catch (error) {
        if (
          !(error instanceof Sub2ApiError) ||
          error.status !== 401 ||
          !expiredCodes.has(error.code)
        )
          throw error;
        if (this.accessToken === first) await this.refresh();
        return await call(this.accessToken);
      }
    } catch (error) {
      if (
        error instanceof Sub2ApiError &&
        error.status === 401 &&
        error.code === claudexErrorCodes.sessionRevoked
      )
        this.signedOut("revoked");
      throw error;
    }
  }
  /** Revokes this device's refresh token; the local session ends even if the service is unreachable. */
  async logout() {
    try {
      await this.client.logout(this.record.refreshToken);
    } finally {
      this.end();
    }
  }
  async revokeAll() {
    await this.authorized((token) => this.client.revokeAllSessions(token));
    this.end();
  }
  end() {
    this.accessToken = "";
    this.accessExpiresAt = 0;
    this.file.clear();
  }
}
