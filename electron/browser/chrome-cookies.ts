import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  timingSafeEqual,
} from "node:crypto";
import type { CookiesSetDetails } from "electron";
import type {
  ChromeImportProfile,
  ChromeImportSite,
} from "../../shared/chrome-import";

// .
export function importHostMatches(host: string, root: string) {
  return host === root || host.endsWith(`.${root}`);
}

export function importSiteRoot(host: string, domainCookies: string[]) {
  let root: string | undefined;
  for (const domain of domainCookies) {
    const candidate = domain.slice(1).toLowerCase();
    if (
      candidate.includes(".") &&
      importHostMatches(host, candidate) &&
      (root === undefined || candidate.length < root.length)
    )
      root = candidate;
  }
  return (
    root ??
    (host.startsWith("www.") && host.split(".").length >= 3
      ? host.slice(4)
      : host)
  );
}

export function importableHost(host: string) {
  return (
    /^[a-z0-9.-]+$/.test(host) &&
    host.includes(".") &&
    !/^\d+(\.\d+){3}$/.test(host) &&
    host !== "localhost" &&
    ![".localhost", ".local", ".internal"].some((suffix) =>
      host.endsWith(suffix),
    )
  );
}

export interface ImportProfile extends ChromeImportProfile {
  file: string;
  safeStorage: string;
}

export interface ImportCookie {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  is_secure: number;
  is_httponly: number;
  samesite: number;
  expires_utc: number;
  has_expires: number;
  last_access_utc: number;
}

export interface ImportJar {
  cookies: {
    set(cookie: CookiesSetDetails): Promise<void>;
    get(filter: { domain?: string }): Promise<
      {
        domain?: string;
        path?: string;
        name: string;
        value?: string;
        secure?: boolean;
        httpOnly?: boolean;
        sameSite?: CookiesSetDetails["sameSite"];
        expirationDate?: number;
      }[]
    >;
    remove(url: string, name: string): Promise<void>;
  };
}

const browsers = [
  {
    id: "chrome",
    name: "Google Chrome",
    folder: "Google/Chrome",
    safeStorage: "Chrome Safe Storage",
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    folder: "Microsoft Edge",
    safeStorage: "Microsoft Edge Safe Storage",
  },
  {
    id: "brave",
    name: "Brave",
    folder: "BraveSoftware/Brave-Browser",
    safeStorage: "Brave Safe Storage",
  },
  {
    id: "chromium",
    name: "Chromium",
    folder: "Chromium",
    safeStorage: "Chromium Safe Storage",
  },
];

// .
export async function chromeProfiles(
  home = os.homedir(),
  platform = process.platform,
): Promise<ImportProfile[]> {
  const profiles: ImportProfile[] = [];
  for (const browser of platform === "darwin" ? browsers : []) {
    const root = path.join(
      home,
      "Library",
      "Application Support",
      browser.folder,
    );
    let info: Record<string, { name?: string }> = {};
    let lastUsed = "Default";
    try {
      const state = JSON.parse(
        await fs.readFile(path.join(root, "Local State"), "utf8"),
      );
      info = state.profile?.info_cache ?? {};
      lastUsed = state.profile?.last_used ?? lastUsed;
    } catch {}
    for (const entry of await fs
      .readdir(root, { withFileTypes: true })
      .catch(() => [])) {
      if (!entry.isDirectory() || !/^(Default|Profile \d+)$/.test(entry.name))
        continue;
      for (const relative of ["Network/Cookies", "Cookies"]) {
        const file = path.join(root, entry.name, relative);
        const stat = await fs.stat(file).catch(() => undefined);
        if (!stat?.isFile() || stat.size > maxDatabase) continue;
        profiles.push({
          id: createHash("sha256").update(file).digest("hex"),
          name: info[entry.name]?.name || entry.name,
          lastUsed: entry.name === lastUsed,
          browser: browser.id,
          browserName: browser.name,
          file,
          safeStorage: browser.safeStorage,
        });
        break;
      }
    }
  }
  const firefox =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Firefox")
      : platform === "win32"
        ? path.join(
            process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
            "Mozilla",
            "Firefox",
          )
        : path.join(home, ".mozilla", "firefox");
  const ini = await fs
    .readFile(path.join(firefox, "profiles.ini"), "utf8")
    .catch(() => "");
  for (const section of ini.split(/(?=^\[)/m)) {
    if (!/^\[Profile\d+\]/.test(section)) continue;
    const relative = /^Path=(.+)$/m.exec(section)?.[1]?.trim();
    if (!relative) continue;
    const directory = /^IsRelative=0\s*$/m.test(section)
      ? relative
      : path.resolve(firefox, relative);
    const file = path.join(directory, "cookies.sqlite");
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile() || stat.size > maxDatabase) continue;
    profiles.push({
      id: createHash("sha256").update(file).digest("hex"),
      name:
        /^Name=(.+)$/m.exec(section)?.[1]?.trim() || path.basename(directory),
      browser: "firefox",
      browserName: "Firefox",
      safeStorage: "",
      lastUsed: /^Default=1\s*$/m.test(section),
      file,
    });
  }
  return profiles;
}

export function publicProfile({
  file: _file,
  safeStorage: _storage,
  ...profile
}: ImportProfile): ChromeImportProfile {
  return profile;
}

export function decryptChromeCookie(
  row: ImportCookie,
  key: Uint8Array,
  version: number,
): string | undefined {
  if (!row.encrypted_value.length) return row.value;
  const encrypted = Buffer.from(row.encrypted_value);
  if (encrypted.subarray(0, 3).toString() !== "v10") return undefined;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    let plain = Buffer.concat([
      decipher.update(encrypted.subarray(3)),
      decipher.final(),
    ]);
    if (version >= 24) {
      const digest = createHash("sha256").update(row.host_key).digest();
      if (
        plain.length < digest.length ||
        !timingSafeEqual(plain.subarray(0, digest.length), digest)
      )
        return undefined;
      plain = plain.subarray(digest.length);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    return undefined;
  }
}

export function importedCookie(
  row: ImportCookie,
  value: string,
  now: number,
): CookiesSetDetails | undefined {
  const host = row.host_key.replace(/^\./, "");
  if (!host || /[\s/:@\\]/.test(host)) return undefined;
  const expires = Number(row.expires_utc) / 1e6 - chromeEpoch;
  if (row.has_expires && expires <= now) return undefined;
  const cookiePath = row.path.startsWith("/") ? row.path : "/";
  return {
    url: `${row.is_secure ? "https" : "http"}://${host}${cookiePath}`,
    name: row.name,
    value,
    ...(row.host_key.startsWith(".") ? { domain: row.host_key } : {}),
    path: cookiePath,
    secure: row.is_secure === 1,
    httpOnly: row.is_httponly === 1,
    sameSite:
      (
        {
          [-1]: "unspecified",
          0: "no_restriction",
          1: "lax",
          2: "strict",
        } as const
      )[row.samesite as -1 | 0 | 1 | 2] ?? "unspecified",
    ...(row.has_expires
      ? { expirationDate: Math.min(expires, now + 30 * 86400) }
      : {}),
  };
}

export async function readChromeCookies(profile: ImportProfile) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "claudex-cookie-import-"),
  );
  try {
    await fs.chmod(directory, 0o700);
    for (const suffix of ["", "-wal"]) {
      const stat = await fs
        .stat(`${profile.file}${suffix}`)
        .catch(() => undefined);
      if (!stat) {
        if (!suffix) throw new Error("Cookie database is missing");
        continue;
      }
      if (!stat.isFile() || stat.size > maxDatabase)
        throw new Error("Cookie database exceeds the size limit");
      await fs.copyFile(
        `${profile.file}${suffix}`,
        path.join(directory, `Cookies${suffix}`),
      );
    }
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(directory, "Cookies"), {
      readOnly: true,
    });
    try {
      const firefox = profile.browser === "firefox";
      const modernFirefox =
        firefox &&
        (Number(
          database.prepare("PRAGMA user_version").get()?.user_version ?? 0,
        ) >= 14 ||
          database
            .prepare("SELECT 1 FROM moz_cookies WHERE sameSite = 256 LIMIT 1")
            .get() !== undefined);
      const version = firefox
        ? 0
        : Number(
            database
              .prepare("SELECT value FROM meta WHERE key = 'version'")
              .get()?.value ?? 0,
          );
      const query = firefox
        ? `SELECT host AS host_key, name, value, x'' AS encrypted_value, path, isSecure AS is_secure,
           isHttpOnly AS is_httponly, CASE WHEN sameSite = 0 AND NOT (${modernFirefox ? 1 : 0} AND isSecure = 1) THEN -1 ELSE sameSite END AS samesite,
           CAST((CASE WHEN expiry > 1000000000000 THEN expiry / 1000 ELSE expiry END) + ${chromeEpoch} AS REAL) * 1000000 AS expires_utc, 1 AS has_expires,
           CAST(lastAccessed AS REAL) + ${chromeEpoch * 1e6} AS last_access_utc FROM moz_cookies WHERE originAttributes = ''`
        : `SELECT host_key, name, value, encrypted_value, path, is_secure, is_httponly,
           samesite, CAST(expires_utc AS REAL) AS expires_utc, has_expires, CAST(last_access_utc AS REAL) AS last_access_utc FROM cookies${version >= 18 ? " WHERE top_frame_site_key = ''" : ""}`;
      const rows = database
        .prepare(`${query} LIMIT ${maxCookies + 1}`)
        .all() as unknown as ImportCookie[];
      if (rows.length > maxCookies)
        throw new Error("Cookie database exceeds the row limit");
      return { rows, version };
    } finally {
      database.close();
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function chromeKey(profile: ImportProfile) {
  if (profile.browser === "firefox") return Buffer.alloc(0);
  const result = await execute(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", profile.safeStorage],
    {
      timeout: 120_000,
      maxBuffer: 4096,
    },
  );
  return pbkdf2Sync(
    result.stdout.replace(/\r?\n$/, ""),
    "saltysalt",
    1003,
    16,
    "sha1",
  );
}

// Sites the picker warns about: sign-in providers, email, banks and payments.
const identityRoots = new Set([
  "okta.com",
  "oktapreview.com",
  "okta-emea.com",
  "onelogin.com",
  "auth0.com",
  "duosecurity.com",
  "pingidentity.com",
  "pingone.com",
  "microsoftonline.com",
  "live.com",
  "microsoft.com",
  "office.com",
  "apple.com",
  "icloud.com",
  "1password.com",
  "1password.eu",
  "1password.ca",
  "lastpass.com",
  "bitwarden.com",
  "dashlane.com",
  "keepersecurity.com",
]);

const emailRoots = new Set([
  "google.com",
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "ymail.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
  "hey.com",
  "zoho.com",
  "icloud.com",
]);

const financialPattern =
  /bank|banque|banco|(^|[.-])(chase|wellsfargo|citi|hsbc|barclays|schwab|fidelity|vanguard|etrade|robinhood|coinbase|kraken|binance|paypal|venmo|wise|revolut|monzo|stripe|brex|ramp|mercury|amex|americanexpress|capitalone|discover|sofi|ally)([.-]|$)/;

const inSet = (root: string, set: Set<string>) =>
  [...set].some((entry) => importHostMatches(root, entry));

export function sensitiveSite(
  root: string,
  hosts: Iterable<string> = [],
): ChromeImportSite["sensitive"] {
  if (inSet(root, identityRoots)) return "identity";
  if (inSet(root, emailRoots)) return "email";
  if (financialPattern.test(root)) return "financial";
  for (const host of hosts) if (financialPattern.test(host)) return "financial";
  return undefined;
}

export const execute = promisify(execFile);

export const chromeEpoch = 11644473600;

export const maxDatabase = 64 * 1024 * 1024;

export const maxCookies = 100_000;
