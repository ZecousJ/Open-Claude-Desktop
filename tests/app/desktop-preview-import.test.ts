import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ChromeImport } from "../../electron/browser/chrome-import";
import {
  chromeProfiles,
  decryptChromeCookie,
  importedCookie,
  readChromeCookies,
  importSiteRoot,
  sensitiveSite,
  importHostMatches,
  type ImportCookie,
  type ImportProfile,
} from "../../electron/browser/chrome-cookies";
import {
  previewOrigin,
  previewOriginUnsafe,
} from "../../shared/preview-origin";
import { parseAllowedSite } from "../../shared/settings-extras";
import { browserSettingsEntries } from "../../src/browser/BrowserSettingsMenu";
import { allowedSiteMatches } from "../../electron/browser/site-permissions";

const profile: ImportProfile = {
  id: "chrome-default",
  browser: "chrome",
  browserName: "Google Chrome",
  name: "Personal",
  lastUsed: true,
  safeStorage: "Chrome Safe Storage",
  file: "/private/cookies",
};
const key = Buffer.alloc(16, 42);
const epoch = 11644473600;
function cookie(host = ".example.com"): ImportCookie {
  return {
    host_key: host,
    name: "login",
    value: "secret",
    encrypted_value: new Uint8Array(),
    path: "/",
    is_secure: 1,
    is_httponly: 1,
    samesite: 1,
    expires_utc: (epoch + Date.now() / 1000 + 90 * 86400) * 1e6,
    has_expires: 1,
    last_access_utc: 0,
  };
}

test("preview origins follow canonical www, mapped IPv6, and metadata safety rules", () => {
  assert.equal(
    previewOrigin("https://www.Example.com./a?q=1"),
    "https://example.com",
  );
  assert.equal(
    previewOrigin("http://www.printer.local:3000/"),
    "http://www.printer.local:3000",
  );
  assert.equal(
    previewOrigin("http://[::ffff:127.0.0.1]:3000/"),
    "http://127.0.0.1:3000",
  );
  assert.equal(previewOrigin("https://name:password@example.com"), undefined);
  assert.equal(
    allowedSiteMatches("http://www.example.com", "https://example.com"),
    true,
  );
  for (const host of [
    "0.0.0.0",
    "[::]",
    "metadata.google.internal",
    "169.254.169.254",
    "[::ffff:169.254.169.254]",
    "[fd00:ec2::254]",
  ]) {
    assert.equal(previewOriginUnsafe(`http://${host}`), true, host);
    assert.deepEqual(parseAllowedSite(`http://${host}`, []), {
      refusal: "full",
    });
  }
  assert.deepEqual(parseAllowedSite("www.Example.com./page", []), {
    site: "https://example.com",
  });
  assert.deepEqual(parseAllowedSite("http://127.0.0.2:3000", []), {
    refusal: "loopback",
  });
});

test("Chrome v24 cookies authenticate the host prefix and expire at most 30 days later", () => {
  const row = cookie();
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  const plain = Buffer.concat([
    createHash("sha256").update(row.host_key).digest(),
    Buffer.from("login-token"),
  ]);
  row.encrypted_value = Buffer.concat([
    Buffer.from("v10"),
    cipher.update(plain),
    cipher.final(),
  ]);
  assert.equal(decryptChromeCookie(row, key, 24), "login-token");
  assert.equal(
    decryptChromeCookie({ ...row, host_key: ".other.com" }, key, 24),
    undefined,
  );
  assert.equal(decryptChromeCookie(row, Buffer.alloc(16), 24), undefined);
  const now = Date.now() / 1000;
  const imported = importedCookie(row, "login-token", now)!;
  assert.equal(imported.expirationDate, now + 30 * 86400);
  assert.equal(imported.sameSite, "lax");
  assert.equal(imported.httpOnly, true);
  assert.equal(imported.domain, ".example.com");
  assert.equal(
    importedCookie({ ...row, expires_utc: 0 }, "token", now),
    undefined,
  );
  assert.equal(
    importedCookie({ ...row, has_expires: 0 }, "token", now)?.expirationDate,
    undefined,
  );
});

test("cookie import needs consent, selection and a single-use session-bound ticket; removal reaches the jar", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claudex-import-test-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = Date.now();
  let consent = false;
  let reads = 0;
  let keyReads = 0;
  const set: any[] = [];
  const removed: string[] = [];
  const reloads: string[] = [];
  const seeded: string[] = [];
  const cleared: string[] = [];
  const importer = new ChromeImport({
    profiles: async () => [profile],
    authorize: async () => consent,
    read: async () => {
      reads++;
      return { version: 24, rows: [cookie(), cookie("blocked.example")] };
    },
    key: async () => {
      keyReads++;
      return Buffer.from(key);
    },
    readStorage: async (_profile, allowed) => {
      assert.equal(allowed("login.example.com"), true);
      assert.equal(allowed("blocked.example"), false);
      return new Map([
        [
          "https://login.example.com",
          [{ key: "token", value: "storage-secret" }],
        ],
      ]);
    },
    seedStorage: async (_jar, storage) => {
      seeded.push(...storage.keys());
      return [...storage.keys()];
    },
    clearStorage: async (_jar, origins) => {
      cleared.push(...origins);
    },
    target: async () => ({
      partition: "persist:account-a",
      persistent: true,
      jar: {
        cookies: {
          set: async (cookie) => {
            set.push(cookie);
          },
          get: async () =>
            set.map((cookie) => ({
              ...cookie,
              domain: cookie.domain ?? new URL(cookie.url).hostname,
            })),
          remove: async (url, name) => {
            removed.push(`${url} ${name}`);
            set.splice(0);
          },
        },
      },
    }),
    blocked: (host) => host === "blocked.example",
    reload: (id) => {
      reloads.push(id);
    },
    indexFile: path.join(root, "index.json"),
    now: () => now,
  });
  assert.deepEqual(await importer.profiles(), [
    {
      id: profile.id,
      browser: "chrome",
      browserName: "Google Chrome",
      name: "Personal",
      lastUsed: true,
    },
  ]);
  assert.deepEqual(await importer.sites("conversation", profile.id), {
    ok: false,
    error: "keychain_denied",
  });
  assert.equal(reads, 0);
  consent = true;
  const listed = await importer.sites("conversation", profile.id);
  assert.ok(listed.ok);
  assert.deepEqual(
    listed.sites.map((entry) => entry.root),
    ["example.com"],
  );
  assert.equal(keyReads, 0);
  assert.deepEqual(
    await importer.import("other", listed.ticket, ["example.com"], true),
    { ok: false, error: "expired" },
  );
  const next = await importer.sites("conversation", profile.id);
  assert.ok(next.ok);
  const result = await importer.import(
    "conversation",
    next.ticket,
    ["example.com"],
    true,
  );
  assert.ok(result.ok);
  assert.deepEqual(result.results, [
    { root: "example.com", imported: 1, failed: 0 },
  ]);
  assert.equal(set[0].value, "secret");
  assert.deepEqual(seeded, ["https://login.example.com"]);
  assert.deepEqual(await importer.list("conversation"), [
    { root: "example.com", importedAt: now },
  ]);
  assert.doesNotMatch(
    await fs.readFile(path.join(root, "index.json"), "utf8"),
    /secret|login-token|private\/cookies/,
  );
  assert.deepEqual(
    await importer.import("conversation", next.ticket, ["example.com"], true),
    { ok: false, error: "expired" },
  );
  assert.equal(await importer.remove("conversation", "example.com"), true);
  assert.deepEqual(cleared, ["https://login.example.com"]);
  assert.deepEqual(removed, ["https://example.com/ login"]);
  assert.deepEqual(reloads, ["conversation", "conversation"]);
  const expired = await importer.sites("conversation", profile.id);
  assert.ok(expired.ok);
  now += 120_001;
  assert.deepEqual(
    await importer.import(
      "conversation",
      expired.ticket,
      ["example.com"],
      false,
    ),
    { ok: false, error: "expired" },
  );
  importer.dispose();
  assert.deepEqual(await importer.profiles(), []);
});

test("profile discovery and SQLite reading use snapshots without exposing cookie values in profiles", async (context) => {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "claudex-browser-profile-"),
  );
  context.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(
    home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
  );
  const directory = path.join(root, "Default", "Network");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(root, "Local State"),
    JSON.stringify({
      profile: {
        last_used: "Default",
        info_cache: { Default: { name: "Work" } },
      },
    }),
  );
  const file = path.join(directory, "Cookies");
  const database = new DatabaseSync(file);
  database.exec(`CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24');
    CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, is_secure INT,
      is_httponly INT, samesite INT, expires_utc INT, has_expires INT, last_access_utc INT,
      top_frame_site_key TEXT NOT NULL DEFAULT '');`);
  database
    .prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')")
    .run(
      ".example.com",
      "login",
      "secret",
      new Uint8Array(),
      "/",
      1,
      1,
      1,
      14000000000000000n,
      1,
      14000000000000000n,
    );
  database.exec(
    "INSERT INTO cookies (host_key, name, value, top_frame_site_key) VALUES ('.partitioned.example', 'login', 'must-not-import', 'https://other.example')",
  );
  database.close();
  const profiles = await chromeProfiles(home, "darwin");
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, "Work");
  const snapshot = await readChromeCookies(profiles[0]);
  assert.equal(snapshot.version, 24);
  assert.equal(snapshot.rows[0].value, "secret");
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].expires_utc, 14000000000000000);
  assert.equal(
    await fs.readFile(file).then((buffer) => buffer.length > 0),
    true,
  );
});

test("import groups hosts by domain-cookie boundaries without crossing sibling roots", () => {
  const domains = [".example.co.uk", ".accounts.example.co.uk", ".other.co.uk"];
  assert.equal(
    importSiteRoot("accounts.example.co.uk", domains),
    "example.co.uk",
  );
  assert.equal(importSiteRoot("www.host.example", []), "host.example");
  assert.equal(importSiteRoot("host.example", [".example"]), "host.example");
  assert.equal(importHostMatches("login.example.co.uk", "example.co.uk"), true);
  assert.equal(importHostMatches("notexample.co.uk", "example.co.uk"), false);
});

test("Firefox discovery and snapshot conversion exclude containers and normalize millisecond expiry", async (context) => {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "claudex-firefox-profile-"),
  );
  context.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".mozilla", "firefox");
  const directory = path.join(root, "default");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(root, "profiles.ini"),
    "[Profile0]\nName=Personal\nPath=default\nIsRelative=1\nDefault=1\n",
  );
  const database = new DatabaseSync(path.join(directory, "cookies.sqlite"));
  database.exec(`PRAGMA user_version = 14;
    CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, isSecure INT,
      isHttpOnly INT, sameSite INT, expiry INT, lastAccessed INT, originAttributes TEXT);
    INSERT INTO moz_cookies VALUES ('.example.com', 'login', 'secret', '/', 1, 1, 0, 2000000000000, 1900000000000000, '');
    INSERT INTO moz_cookies VALUES ('.example.com', 'container', 'private', '/', 1, 1, 0, 2000000000000, 1900000000000000, '^userContextId=1');`);
  database.close();
  const profiles = await chromeProfiles(home, "linux");
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].browser, "firefox");
  assert.equal(profiles[0].lastUsed, true);
  const snapshot = await readChromeCookies(profiles[0]);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].samesite, 0);
  assert.equal(
    importedCookie(snapshot.rows[0], "secret", 1900000000)?.sameSite,
    "no_restriction",
  );
  assert.equal(snapshot.rows[0].expires_utc / 1e6 - epoch, 2000000000);
});

test("Import cookies is a functioning menu action, not a disabled placeholder", () => {
  let opened = false;
  const entries = browserSettingsEntries({
    browserName: null,
    hasPage: true,
    canOpenElsewhere: true,
    toolsAvailable: true,
    settings: {},
    actions: {
      openElsewhere() {},
      copyUrl() {},
      setViewport() {},
      setColorScheme() {},
      saveScreenshot() {},
      openHtmlFile() {},
      setPreference() {},
      manageAllowedSites() {},
      chooseKeepCookies() {},
      clearBrowsingData() {},
      importCookies: () => {
        opened = true;
      },
    },
  });
  const entry = entries.find(
    (entry) => "label" in entry && entry.label === "Import cookies…",
  );
  assert.ok(entry && "onSelect" in entry);
  entry.onSelect?.();
  assert.equal(opened, true);
});

test("shared-cookie offers copy only imported roots into another session and remove its storage independently", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "claudex-shared-import-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sharedCookies: any[] = [];
  const sessionCookies: any[] = [];
  const jar = (cookies: any[]) => ({
    cookies: {
      set: async (value: any) => {
        cookies.push({
          ...value,
          domain: value.domain ?? new URL(value.url).hostname,
        });
      },
      get: async () => cookies,
      remove: async () => {
        cookies.splice(0);
      },
    },
  });
  const sharedJar = jar(sharedCookies);
  const sessionJar = jar(sessionCookies);
  const cleared: string[][] = [];
  const importer = new ChromeImport({
    profiles: async () => [profile],
    read: async () => ({ rows: [cookie()], version: 24 }),
    key: async () => Buffer.from(key),
    authorize: async () => true,
    target: async (id, keep) =>
      id === "original" || keep
        ? { partition: "persist:shared", jar: sharedJar, persistent: true }
        : { partition: "session", jar: sessionJar, persistent: false },
    shared: () => ({ partition: "persist:shared", jar: sharedJar }),
    blocked: (host) => host === "blocked.example.com",
    reload() {},
    indexFile: path.join(directory, "index.json"),
    readStorage: async () =>
      new Map([
        ["https://example.com", [{ key: "login", value: "storage-secret" }]],
      ]),
    seedStorage: async (_jar, storage) => [...storage.keys()],
    readJarStorage: async (jar, origins, allowed) => {
      assert.equal(jar, sharedJar);
      assert.deepEqual(origins, ["https://example.com"]);
      assert.equal(allowed("login.example.com"), true);
      assert.equal(allowed("blocked.example.com"), false);
      return new Map([
        ["https://example.com", [{ key: "login", value: "updated-secret" }]],
      ]);
    },
    clearStorage: async (_jar, origins) => {
      cleared.push(origins);
    },
  });
  const listed = await importer.sites("original", profile.id);
  assert.ok(listed.ok);
  assert.ok(
    (await importer.import("original", listed.ticket, ["example.com"], true))
      .ok,
  );
  sharedCookies.push({
    domain: ".unselected.com",
    name: "private",
    value: "not-consented",
  });
  sharedCookies.push({
    domain: "blocked.example.com",
    name: "private",
    value: "blocked",
  });
  assert.deepEqual(await importer.sharedOffer("original"), {
    offer: false,
    roots: [],
  });
  assert.deepEqual(await importer.sharedOffer("new"), {
    offer: true,
    roots: ["example.com"],
  });
  assert.equal(await importer.acceptShared("new", false), true);
  assert.equal(sessionCookies.length, 1);
  assert.equal(sessionCookies[0].value, "secret");
  assert.deepEqual(await importer.sharedOffer("new"), {
    offer: false,
    roots: [],
  });
  assert.equal(await importer.remove("new", "example.com"), true);
  assert.deepEqual(cleared, [["https://example.com"]]);
  assert.equal(sharedCookies.length, 3);
  assert.equal(await importer.acceptShared("another", true), true);
  assert.equal(sessionCookies.length, 0);
  await importer.clearPartition("persist:shared");
  assert.deepEqual(await importer.sharedOffer("new"), {
    offer: false,
    roots: [],
  });
  assert.doesNotMatch(
    await fs.readFile(path.join(directory, "index.json"), "utf8"),
    /storage-secret|updated-secret|not-consented/,
  );
});

test("the site picker tags sign-in providers, email and banks", () => {
  assert.equal(sensitiveSite("okta.com"), "identity");
  assert.equal(sensitiveSite("login.microsoftonline.com"), "identity");
  assert.equal(sensitiveSite("google.com"), "email");
  assert.equal(sensitiveSite("chase.com"), "financial");
  assert.equal(sensitiveSite("mybank.example"), "financial");
  assert.equal(
    sensitiveSite("example.com", ["pay.paypal.example.com"]),
    "financial",
  );
  assert.equal(sensitiveSite("github.com"), undefined);
});
