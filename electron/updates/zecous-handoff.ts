/**
 * First run after ZecousAI (docs/ota.md): a computer that had the ZecousAI
 * desktop app gets Claudex pointed at the Claudex service, and the sign-in
 * card may start with the person's email. Nothing secret moves: ZecousAI's
 * tokens are read only to decode the email claim of a token's payload (no
 * signature check, no network), and are never copied.
 *
 * Shared by the Claudex main process and the Windows bridge app
 * (tools/zecous-bridge), which writes the same files before it launches
 * Claudex. Node only; no Electron imports.
 */
import fs from "node:fs";
import path from "node:path";
import { saveSub2ApiConfig } from "../../server/sub2api-config";

type Env = Record<string, string | undefined>;

const pathFor = (platform: NodeJS.Platform) =>
  platform === "win32" ? path.win32 : path.posix;

/** The Electron `userData` folder of an app named `name`, by default. */
export function defaultUserData(
  name: string,
  platform: NodeJS.Platform,
  env: Env,
  home: string,
) {
  const p = pathFor(platform);
  if (platform === "darwin")
    return p.join(home, "Library", "Application Support", name);
  if (platform === "win32")
    return p.join(env.APPDATA || p.join(home, "AppData", "Roaming"), name);
  return p.join(env.XDG_CONFIG_HOME || p.join(home, ".config"), name);
}

/** ZecousAI's plain JSON store (desktop-store.json in its userData). */
export function zecousStoreFile(
  platform: NodeJS.Platform,
  env: Env,
  home: string,
) {
  return pathFor(platform).join(
    defaultUserData("ZecousAI", platform, env, home),
    "desktop-store.json",
  );
}

const emailPattern =
  /^[^\s@<>"',;:]{1,64}@[^\s@<>"',;:]{1,190}\.[^\s@<>"',;:.]{2,63}$/;

/** An address worth prefilling, trimmed and lower-cased; undefined otherwise. */
export function plausibleEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && emailPattern.test(email) ? email : undefined;
}

/** A JWT's payload, unverified: for hints only, never for trust. */
export function jwtPayload(
  token: unknown,
): Record<string, unknown> | undefined {
  if (typeof token !== "string" || token.length > 16_384) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]))
    return undefined;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The email in ZecousAI's store, when one of its tokens carries an address
 * claim (`email`, then `preferred_username`, `upn`, `sub`) or the store
 * names one. Undefined when nothing looks like an address.
 */
export function emailFromZecousStore(text: string): string | undefined {
  let store: unknown;
  try {
    store = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!store || typeof store !== "object") return undefined;
  const candidates: unknown[] = [];
  const auth = (store as { auth?: unknown }).auth;
  if (auth && typeof auth === "object") {
    const record = auth as Record<string, unknown>;
    for (const token of [record.accessToken, record.refreshToken]) {
      const claims = jwtPayload(token);
      if (claims)
        candidates.push(
          claims.email,
          claims.preferred_username,
          claims.upn,
          claims.sub,
        );
    }
    candidates.push(record.email, record.subject);
  }
  const user = (store as { user?: unknown }).user;
  if (user && typeof user === "object")
    candidates.push((user as Record<string, unknown>).email);
  for (const candidate of candidates) {
    const email = plausibleEmail(candidate);
    if (email) return email;
  }
  return undefined;
}

/** Where the sign-in card's suggested email waits (no secret; removed after sign-in). */
export const signInHintFile = (userData: string) =>
  path.join(userData, "backend", "sign-in-hint.json");

export function readSignInHint(userData: string): string | undefined {
  try {
    const value: unknown = JSON.parse(
      fs.readFileSync(signInHintFile(userData), "utf8"),
    );
    return value && typeof value === "object"
      ? plausibleEmail((value as { email?: unknown }).email)
      : undefined;
  } catch {
    return undefined;
  }
}

export function clearSignInHint(userData: string) {
  fs.rmSync(signInHintFile(userData), { force: true });
}

export interface HandoffResult {
  /** backend/sub2api.json was written now. */
  configured: boolean;
  /** The email the sign-in card starts with. */
  email?: string;
}

/**
 * Writes Claudex's service choice (and the email hint) when Claudex has
 * none yet and ZecousAI was installed. An existing `backend/sub2api.json`
 * is never replaced, so later runs do nothing.
 *
 * `fromZecousAI`: the caller knows this is a ZecousAI install moving to
 * Claudex (the Windows bridge, or Claudex started from ZecousAI.app), so the
 * service is written even when ZecousAI never saved its store (a user who
 * never signed in there); the email hint still needs the store.
 */
export function zecousHandoff(options: {
  /** Claudex's userData folder. */
  userData: string;
  /** ZecousAI's desktop-store.json. */
  zecousStore: string;
  serviceUrl: string;
  fromZecousAI?: boolean;
}): HandoffResult {
  const config = path.join(options.userData, "backend", "sub2api.json");
  const store = fs.existsSync(options.zecousStore);
  if (fs.existsSync(config) || (!store && !options.fromZecousAI))
    return { configured: false };
  let email: string | undefined;
  try {
    email = store
      ? emailFromZecousStore(fs.readFileSync(options.zecousStore, "utf8"))
      : undefined;
  } catch {
    email = undefined;
  }
  saveSub2ApiConfig(options.userData, options.serviceUrl);
  if (email)
    fs.writeFileSync(
      signInHintFile(options.userData),
      JSON.stringify({ version: 1, email, source: "zecousai" }, null, 2),
      { mode: 0o600 },
    );
  return { configured: true, ...(email ? { email } : {}) };
}
