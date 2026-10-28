import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PublicAccount } from "../../shared/types";
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
type User = {
  id: string;
  email: string;
  name: string;
  salt: string;
  passwordHash: string;
  createdAt: number;
};
type Session = { userId: string; tokenHash: string; expiresAt: number };
interface Database {
  version: 1;
  users: User[];
  sessions: Session[];
  /**
   * The account that received the data of the single-user version (see
   * importLegacyProfile); null once that account was deleted, so the data
   * never moves into anyone else's account.
   */
  legacyOwner?: string | null;
}
export interface LoginResult {
  account: PublicAccount;
  token: string;
  expiresAt: number;
}

function publicAccount(user: User): PublicAccount {
  return { id: user.id, email: user.email, name: user.name };
}
function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email))
    throw Error("Enter a valid email address.");
  return email;
}
function validatePassword(value: string) {
  if (value.length < 12 || value.length > 256)
    throw Error("Use a password between 12 and 256 characters.");
}
function validDatabase(value: unknown): value is Database {
  if (!value || typeof value !== "object") return false;
  const db = value as Record<string, unknown>;
  return (
    db.version === 1 &&
    Array.isArray(db.users) &&
    Array.isArray(db.sessions) &&
    db.users.length <= 10000 &&
    db.sessions.length <= 100000 &&
    db.users.every((user: unknown) => {
      if (!user || typeof user !== "object") return false;
      const u = user as Record<string, unknown>;
      return (
        typeof u.id === "string" &&
        /^[0-9a-f-]{36}$/.test(u.id) &&
        typeof u.email === "string" &&
        u.email.length <= 254 &&
        typeof u.name === "string" &&
        u.name.length <= 100 &&
        typeof u.salt === "string" &&
        /^[a-f0-9]{64}$/.test(u.salt) &&
        typeof u.passwordHash === "string" &&
        /^[a-f0-9]{128}$/.test(u.passwordHash) &&
        Number.isFinite(u.createdAt)
      );
    }) &&
    db.sessions.every((session: unknown) => {
      if (!session || typeof session !== "object") return false;
      const s = session as Record<string, unknown>;
      return (
        typeof s.userId === "string" &&
        typeof s.tokenHash === "string" &&
        /^[a-f0-9]{64}$/.test(s.tokenHash) &&
        Number.isFinite(s.expiresAt)
      );
    }) &&
    (db.legacyOwner === undefined ||
      db.legacyOwner === null ||
      (typeof db.legacyOwner === "string" &&
        /^[0-9a-f-]{36}$/.test(db.legacyOwner)))
  );
}
async function derive(password: string, salt: string) {
  return await new Promise<Buffer>((resolve, reject) =>
    scryptCallback(
      password,
      Buffer.from(salt, "hex"),
      64,
      { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 },
      (error, result) => (error ? reject(error) : resolve(result)),
    ),
  );
}
function digest(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Local account registry; credentials never enter renderer storage or the model process. */
export class Accounts {
  private readonly filename: string;
  private readonly root: string;
  private db: Database;
  private failures = new Map<string, number[]>();
  private dummySalt = randomBytes(32).toString("hex");
  constructor(
    root: string,
    private now: () => number = Date.now,
  ) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.filename = path.join(root, "accounts.json");
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(this.filename, "utf8"),
      );
      if (!validDatabase(parsed)) throw Error("Invalid account data.");
      this.db = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw Error(
          "Account data cannot be read; it has not been overwritten.",
        );
      this.db = { version: 1, users: [], sessions: [] };
    }
    // Registries from before the marker: the first account imported the data.
    if (this.db.legacyOwner === undefined && this.db.users.length)
      this.db.legacyOwner = this.db.users[0].id;
  }
  get hasAccounts() {
    return this.db.users.length > 0;
  }
  listPublicAccounts() {
    return this.db.users.map(publicAccount);
  }
  /** Whether this account takes the single-user version's data (the first account ever registered). */
  ownsLegacyData(accountId: string) {
    return this.db.legacyOwner === accountId;
  }
  private save() {
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.db, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.filename);
  }
  private issue(user: User): LoginResult {
    const token = randomBytes(32).toString("hex"),
      expiresAt = this.now() + sessionLifetimeMs;
    this.db.sessions = this.db.sessions.filter(
      (session) => session.expiresAt > this.now(),
    );
    this.db.sessions.push({
      userId: user.id,
      tokenHash: digest(token),
      expiresAt,
    });
    this.save();
    return { account: publicAccount(user), token, expiresAt };
  }
  async register(
    emailInput: string,
    password: string,
    nameInput: string,
  ): Promise<LoginResult> {
    const email = normalizeEmail(emailInput);
    validatePassword(password);
    const name = nameInput.trim();
    if (!name || name.length > 100)
      throw Error("Use a display name between 1 and 100 characters.");
    if (this.db.users.some((user) => user.email === email))
      throw Error("An account with this email already exists.");
    const salt = randomBytes(32).toString("hex");
    const user: User = {
      id: randomUUID(),
      email,
      name,
      salt,
      passwordHash: (await derive(password, salt)).toString("hex"),
      createdAt: this.now(),
    };
    if (this.db.users.some((value) => value.email === email))
      throw Error("An account with this email already exists.");
    this.db.users.push(user);
    const owner = this.db.legacyOwner;
    if (owner === undefined) this.db.legacyOwner = user.id;
    try {
      return this.issue(user);
    } catch (error) {
      this.db.users = this.db.users.filter((value) => value.id !== user.id);
      this.db.legacyOwner = owner;
      throw error;
    }
  }
  async login(emailInput: string, password: string): Promise<LoginResult> {
    const email = normalizeEmail(emailInput);
    if (password.length > 256) throw Error("Email or password is incorrect.");
    const since = this.now() - 15 * 60 * 1000;
    const attempts = (this.failures.get(email) ?? []).filter(
      (time) => time > since,
    );
    if (attempts.length >= 5)
      throw Error("Too many sign-in attempts. Try again later.");
    const user = this.db.users.find((value) => value.email === email);
    const actual = await derive(password, user?.salt ?? this.dummySalt);
    const expected = Buffer.from(user?.passwordHash ?? "00".repeat(64), "hex");
    if (!user || !timingSafeEqual(actual, expected)) {
      attempts.push(this.now());
      this.failures.set(email, attempts);
      throw Error("Email or password is incorrect.");
    }
    this.failures.delete(email);
    return this.issue(user);
  }
  session(token: string): PublicAccount | undefined {
    if (!/^[a-f0-9]{64}$/.test(token)) return;
    const hash = digest(token);
    const entry = this.db.sessions.find(
      (session) => session.tokenHash === hash && session.expiresAt > this.now(),
    );
    const user =
      entry && this.db.users.find((value) => value.id === entry.userId);
    return user && publicAccount(user);
  }
  logout(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) return;
    const hash = digest(token),
      size = this.db.sessions.length;
    this.db.sessions = this.db.sessions.filter(
      (session) => session.tokenHash !== hash,
    );
    if (this.db.sessions.length !== size) this.save();
  }
  rename(accountId: string, nameInput: string): PublicAccount {
    const name = nameInput.trim();
    if (!name || name.length > 100)
      throw Error("Use a name between 1 and 100 characters.");
    const user = this.db.users.find((value) => value.id === accountId);
    if (!user) throw Error("Unknown account.");
    user.name = name;
    this.save();
    return publicAccount(user);
  }
  /**
   * Removes an account, its sessions and its profile folder after checking
   * its password. The caller stops everything using the profile first.
   */
  async remove(accountId: string, password: string) {
    const user = this.db.users.find((value) => value.id === accountId);
    if (!user) throw Error("Unknown account.");
    const actual = await derive(password.slice(0, 256), user.salt);
    if (!timingSafeEqual(actual, Buffer.from(user.passwordHash, "hex")))
      throw Error("The password is incorrect.");
    this.removeSignedIn(accountId);
  }
  /** The active account session authorizes deletion. */
  removeSignedIn(accountId: string) {
    if (!this.db.users.some((user) => user.id === accountId))
      throw Error("Unknown account.");
    this.db.users = this.db.users.filter((value) => value.id !== accountId);
    this.db.sessions = this.db.sessions.filter(
      (session) => session.userId !== accountId,
    );
    const owner = this.db.legacyOwner === accountId;
    // The next account must not pick up the deleted account's old data.
    if (owner) this.db.legacyOwner = null;
    this.save();
    fs.rmSync(path.join(this.root, "profiles", accountId), {
      recursive: true,
      force: true,
    });
    if (owner) removeLegacyProfile(this.root);
  }
  /** Checks a password without signing in (before deleting an account). */
  async verify(accountId: string, password: string) {
    const user = this.db.users.find((value) => value.id === accountId);
    if (!user || password.length > 256) return false;
    const actual = await derive(password, user.salt);
    return timingSafeEqual(actual, Buffer.from(user.passwordHash, "hex"));
  }
  profileRoot(accountId: string) {
    if (!this.db.users.some((user) => user.id === accountId))
      throw Error("Unknown account.");
    const folder = path.join(this.root, "profiles", accountId);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    return folder;
  }
}

/** The single-user version's files that only its data owner's account uses. */
const legacyProfileFiles = [
  "settings.json",
  "conversations.json",
  "projects.json",
  "schedules.json",
  "artifact-shares.json",
];

/**
 * Deletes the single-user version's conversations, projects, settings and
 * agent home after the account that received them was deleted. secrets.enc
 * stays: the model keys it holds belong to this computer's configuration.
 */
function removeLegacyProfile(root: string) {
  for (const name of legacyProfileFiles)
    fs.rmSync(path.join(root, name), { force: true });
  fs.rmSync(path.join(root, "codex-home"), { recursive: true, force: true });
}

/** Copy legacy single-user data into the first account without deleting the original files. */
export function importLegacyProfile(root: string, profileRoot: string) {
  const marker = path.join(profileRoot, "legacy-import.json");
  if (fs.existsSync(marker)) return false;
  const files = [...legacyProfileFiles, "secrets.enc"];
  if (!files.some((name) => fs.existsSync(path.join(root, name)))) return false;
  fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  for (const name of files) {
    const source = path.join(root, name),
      target = path.join(profileRoot, name);
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
  }
  const oldHome = path.join(root, "codex-home"),
    newHome = path.join(profileRoot, "codex-home");
  if (fs.existsSync(oldHome) && !fs.existsSync(newHome))
    fs.cpSync(oldHome, newHome, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
    });
  fs.writeFileSync(
    marker,
    JSON.stringify({
      importedAt: Date.now(),
      source: "legacy-single-user-profile",
    }),
    { flag: "wx", mode: 0o600 },
  );
  return true;
}
