/**
 * Which pages Claude may use its Browser tools on (R8-C): local development
 * addresses, Allowed sites, per-conversation approvals, blocked domains and
 * the administrator's external sites switch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SitePermissions,
  allowedSiteMatches,
  normalizeAllowedSite,
  siteKey,
  siteMessages,
} from "../../electron/browser/site-permissions";

function permissions(
  options: {
    sites?: string[];
    externalSites?: boolean;
    blockedDomains?: string[];
    allowAllBrowserActions?: boolean;
  } = {},
) {
  let sites = [...(options.sites ?? [])];
  const saved: string[][] = [];
  const policy = {
    externalSites: options.externalSites ?? true,
    blockedDomains: options.blockedDomains ?? [],
  };
  const perms = new SitePermissions({
    allowedSites: () => sites,
    setAllowedSites: (next) => {
      sites = next;
      saved.push(next);
    },
    allowAllBrowserActions: () => options.allowAllBrowserActions === true,
    policy: () => policy,
  });
  return { perms, saved, policy, sites: () => sites };
}

test("site keys: web origins, local hosts, files, blank and other schemes", () => {
  assert.deepEqual(siteKey(""), { kind: "blank" });
  assert.deepEqual(siteKey("about:blank"), { kind: "blank" });
  assert.deepEqual(siteKey("https://Example.com/a?b"), {
    kind: "web",
    origin: "https://example.com",
    host: "example.com",
    local: false,
  });
  assert.equal((siteKey("http://localhost:5173/") as any).local, true);
  assert.equal((siteKey("http://127.0.0.1:8080/") as any).local, true);
  assert.equal((siteKey("http://[::1]:3000/") as any).local, true);
  assert.equal((siteKey("http://app.localhost/") as any).local, true);
  // Private network addresses are not "this computer": they ask.
  assert.equal((siteKey("http://192.168.1.2/") as any).local, false);
  const file = siteKey("file:///Users/me/site/index.html");
  assert.equal(file.kind, "file");
  assert.equal((file as any).origin, "file:///Users/me/site");
  assert.deepEqual(siteKey("javascript:alert(1)"), {
    kind: "other",
    scheme: "javascript",
  });
});

test("Allowed sites entries: exact origins and any port", () => {
  assert.equal(
    normalizeAllowedSite("https://Example.com"),
    "https://example.com",
  );
  assert.equal(
    normalizeAllowedSite("https://example.com:443"),
    "https://example.com",
  );
  assert.equal(
    normalizeAllowedSite("http://localhost:*"),
    "http://localhost:*",
  );
  assert.equal(normalizeAllowedSite("https://example.com/path"), undefined);
  assert.equal(normalizeAllowedSite("ftp://example.com"), undefined);
  assert.equal(
    allowedSiteMatches("https://example.com", "https://example.com"),
    true,
  );
  assert.equal(
    allowedSiteMatches("https://example.com", "http://example.com"),
    false,
  );
  assert.equal(
    allowedSiteMatches("https://example.com", "https://www.example.com"),
    true,
  );
  assert.equal(
    allowedSiteMatches("http://dev.box:*", "http://dev.box:8080"),
    true,
  );
  assert.equal(
    allowedSiteMatches("http://dev.box:*", "https://dev.box:8080"),
    false,
  );
});

test("allow all browser actions skips external-site approval", () => {
  const { perms } = permissions({ allowAllBrowserActions: true });
  assert.deepEqual(perms.decide("conversation", "https://example.com"), {
    access: "allow",
    origin: "https://example.com",
    reason: "all-sites",
  });
});

test("allow all browser actions applies to new sessions, while managed restrictions remain live", () => {
  const options = { allowAllBrowserActions: false };
  const { perms, policy } = permissions(options);
  perms.begin("existing");
  options.allowAllBrowserActions = true;
  perms.begin("existing");
  assert.equal(perms.decide("existing", "https://example.com").access, "ask");
  assert.equal(perms.decide("new", "https://example.com").access, "allow");
  options.allowAllBrowserActions = false;
  assert.equal(perms.decide("new", "https://another.example").access, "allow");
  assert.equal(perms.decide("later", "https://example.com").access, "ask");
  policy.blockedDomains = ["example.com"];
  assert.equal(perms.decide("new", "https://example.com").access, "deny");
  policy.externalSites = false;
  assert.equal(perms.decide("new", "https://another.example").access, "deny");
  policy.externalSites = true;
  perms.forget("new");
  assert.equal(perms.decide("new", "https://another.example").access, "ask");
  options.allowAllBrowserActions = true;
  perms.forgetAll();
  assert.equal(
    perms.decide("existing", "https://another.example").access,
    "allow",
  );
});

test("local development addresses and blank pages need no approval", () => {
  const { perms } = permissions();
  assert.deepEqual(perms.decide("c1", "http://localhost:5173/x"), {
    access: "allow",
    origin: "http://localhost:5173",
    reason: "local",
  });
  assert.equal(perms.decide("c1", "about:blank").access, "allow");
  assert.equal(perms.decide("c1", "http://[::1]:3000/").access, "allow");
});

test("other sites ask once per conversation; Allow once stays in that conversation", () => {
  const { perms } = permissions();
  const first = perms.decide("c1", "https://example.com/page");
  assert.deepEqual(first, {
    access: "ask",
    origin: "https://example.com",
    canAlwaysAllow: true,
  });
  perms.grant("c1", "https://example.com");
  assert.equal(perms.decide("c1", "https://example.com/other").access, "allow");
  assert.equal(perms.decide("c2", "https://example.com/").access, "ask");
  // Another origin of the same site asks again.
  assert.equal(perms.decide("c1", "https://www.example.com/").access, "ask");
  perms.forget("c1");
  assert.equal(perms.decide("c1", "https://example.com/").access, "ask");
});

test("Always allow adds the origin to Allowed sites once", () => {
  const { perms, saved, sites } = permissions({ sites: ["https://docs.dev"] });
  assert.equal(perms.alwaysAllow("https://example.com"), true);
  assert.deepEqual(sites(), ["https://docs.dev", "https://example.com"]);
  assert.equal(perms.alwaysAllow("https://example.com"), true);
  assert.equal(saved.length, 1);
  assert.equal(perms.decide("c9", "https://example.com/a").access, "allow");
  assert.equal(
    (perms.decide("c9", "https://docs.dev/") as any).reason,
    "allowed-site",
  );
  // File folders are never written to Allowed sites.
  assert.equal(perms.alwaysAllow("file:///Users/me"), false);
});

test("Allowed sites stop growing at the limit", () => {
  const full = Array.from({ length: 200 }, (_, i) => `https://s${i}.example`);
  const { perms, saved } = permissions({ sites: full });
  assert.equal(perms.alwaysAllow("https://new.example"), false);
  assert.equal(saved.length, 0);
});

test("blocked domains win over local addresses, Allowed sites and approvals", () => {
  const { perms } = permissions({
    sites: ["https://mail.example.com"],
    blockedDomains: ["example.com", "blocked.localhost"],
  });
  perms.grant("c1", "https://example.com");
  for (const url of [
    "https://example.com/",
    "https://mail.example.com/",
    "http://blocked.localhost:3000/",
  ]) {
    const decision = perms.decide("c1", url);
    assert.equal(decision.access, "deny", url);
    assert.equal((decision as any).message, siteMessages.blocked);
  }
  assert.equal(perms.decide("c1", "http://localhost:3000").access, "allow");
});

test("externalSites off keeps Claudex on local development addresses", () => {
  const { perms } = permissions({
    externalSites: false,
    sites: ["https://example.com"],
  });
  perms.grant("c1", "https://other.dev");
  assert.equal(perms.decide("c1", "http://localhost:5173").access, "allow");
  for (const url of [
    "https://example.com/",
    "https://other.dev/",
    "http://192.168.0.5/",
    "file:///Users/me/page.html",
  ]) {
    const decision = perms.decide("c1", url);
    assert.equal(decision.access, "deny", url);
    assert.equal((decision as any).message, siteMessages.localOnly);
  }
});

test("file pages ask per session without Always allow; other schemes are refused", () => {
  const { perms } = permissions();
  const decision = perms.decide("c1", "file:///Users/me/site/index.html");
  assert.deepEqual(decision, {
    access: "ask",
    origin: "file:///Users/me/site",
    canAlwaysAllow: false,
  });
  perms.grant("c1", "file:///Users/me/site");
  assert.equal(
    perms.decide("c1", "file:///Users/me/site/other.html").access,
    "allow",
  );
  assert.equal(
    perms.decide("c1", "file:///Users/me/elsewhere/a.html").access,
    "ask",
  );
  assert.equal(perms.decide("c1", "chrome://settings").access, "deny");
  assert.equal(perms.decide("c1", "data:text/html,hi").access, "deny");
});

test("every site is allowed by default, until Allow all browser actions is turned off", async () => {
  const { preferenceDefaults } = await import("../../shared/settings-extras");
  assert.equal(preferenceDefaults.allowAllBrowserActions, true);
  const source = (await import("node:fs")).readFileSync(
    "electron/browser/browser-tools-registration.ts",
    "utf8",
  );
  assert.match(source, /allowAllBrowserActions !== false/);
});
