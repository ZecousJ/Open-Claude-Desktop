/**
 * Several accounts in one browser (src-web/bridge/auth.ts): one refresh
 * cookie per account, a tab that keeps its account, the account menu's
 * switch and "Add account", and the signed-out chooser.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { signInAgainCode } from "../../shared/sign-in-api";
import { createWebBridge } from "../../src-web/bridge";
import {
  FakeBrowser,
  fakeTab,
  flush,
  json,
  type FakeTab,
} from "./web-bridge-fakes.test.ts";

const users = [
  { id: 1, email: "ada@example.com", username: "Ada" },
  { id: 2, email: "bob@example.com", username: "" },
  { id: 3, email: "cy@example.com", username: "Cy" },
];

/**
 * The Go service's cookie handling (internal/claudex/web/accounts.go): one
 * cookie per account in `cookies`, a refresh names its account (or takes
 * the lowest id), a logout clears only the named one.
 */
class MultiService {
  cookies = new Map<number, string>();
  private tokens = 0;
  refreshBodies: unknown[] = [];
  logoutBodies: unknown[] = [];
  answer(user: (typeof users)[number]) {
    this.cookies.set(user.id, `rt-${user.id}-${++this.tokens}`);
    return json({
      code: 0,
      data: { access_token: `at-${this.tokens}`, expires_in: 3600, user },
    });
  }
  attach(tab: FakeTab) {
    tab.routes.push((request) => {
      const path = new URL(request.url, "https://claudex.example").pathname;
      const body = (request.body ?? {}) as { account?: string; email?: string };
      if (path.endsWith("/web/auth/refresh")) {
        this.refreshBodies.push(body);
        const id = body.account
          ? Number(body.account)
          : Math.min(...this.cookies.keys());
        const user = users.find((u) => u.id === id);
        if (!user || !this.cookies.has(id))
          return json(
            {
              code: 401,
              message: "Sign in to continue.",
              reason: "CLAUDEX_WEB_NO_SESSION",
            },
            401,
          );
        return this.answer(user);
      }
      if (path.endsWith("/web/auth/login")) {
        const user = users.find((u) => u.email === body.email)!;
        if (!this.cookies.has(user.id) && this.cookies.size >= 5)
          return json(
            {
              code: 409,
              message: "Too many",
              reason: "CLAUDEX_WEB_ACCOUNT_LIMIT",
            },
            409,
          );
        return this.answer(user);
      }
      if (path.endsWith("/web/auth/logout")) {
        this.logoutBodies.push(body);
        if (body.account) this.cookies.delete(Number(body.account));
        return json({ code: 0, data: { message: "ok" } });
      }
      if (path.endsWith("/web/auth/accounts"))
        return json({
          code: 0,
          data: {
            accounts: [...this.cookies.keys()].sort().map(String),
            legacy: false,
            max_accounts: 5,
          },
        });
      if (path === "/api/v1/settings/public")
        return json({ code: 0, data: { site_name: "Claudex" } });
      if (path.includes("/web/rpc/")) return json({ ok: true, value: null });
      return undefined;
    });
  }
}

function setup(browser = new FakeBrowser(), service = new MultiService()) {
  const tab = fakeTab(browser);
  service.attach(tab);
  const bridge = createWebBridge(tab.env);
  return { browser, service, tab, bridge };
}

test("a sign-in adds an account; the first one stays signed in", async () => {
  const { service, bridge, browser, tab } = setup();
  assert.equal((await bridge.api.authStatus()).account, undefined);
  await bridge.api.loginAccount("ada@example.com", "pw");
  assert.equal(tab.session.get("claudex-web-account"), "1");

  // Add account: this tab leaves Ada (her cookie stays) for the sign-in page.
  const refreshes = service.refreshBodies.length;
  await bridge.api.addAccount();
  assert.equal(bridge.auth.current, undefined);
  const adding = await bridge.api.authStatus();
  assert.equal(adding.account, undefined);
  assert.deepEqual(adding.browserAccounts?.adding, {});
  assert.deepEqual(
    adding.browserAccounts?.accounts.map((a) => [a.id, a.signedIn]),
    [["1", true]],
  );
  // No refresh while adding: the page must not slip back into Ada.
  assert.equal(service.refreshBodies.length, refreshes);

  const bob = await bridge.api.loginAccount("bob@example.com", "pw");
  assert.deepEqual(bob, {
    id: "2",
    email: "bob@example.com",
    name: "bob",
    remote: true,
  });
  assert.deepEqual([...service.cookies.keys()], [1, 2]);
  assert.equal(tab.session.get("claudex-web-adding"), undefined);
  assert.equal(browser.local.get("claudex-web-last-account"), "2");

  const list = await bridge.api.browserAccounts();
  assert.equal(list.current, "2");
  assert.equal(list.maxAccounts, 5);
  assert.deepEqual(
    list.accounts.map((a) => [a.id, a.name, a.signedIn]),
    [
      ["2", "bob", true],
      ["1", "Ada", true],
    ],
  );
});

test("a switch shows the other account; a reload keeps the tab's account", async () => {
  const { browser, service, bridge, tab } = setup();
  await bridge.api.loginAccount("ada@example.com", "pw");
  await bridge.api.addAccount("bob@example.com");
  assert.deepEqual((await bridge.api.authStatus()).browserAccounts?.adding, {
    email: "bob@example.com",
  });
  await bridge.api.loginAccount("bob@example.com", "pw");

  const ada = await bridge.api.switchAccount("1");
  assert.equal(ada.email, "ada@example.com");
  assert.equal(bridge.auth.current?.account.id, "1");
  assert.deepEqual(service.refreshBodies.at(-1), { account: "1" });
  assert.deepEqual([...service.cookies.keys()].sort(), [1, 2], "Bob stays");

  // The reloaded tab asks for its own account.
  const reloaded = createWebBridge(tab.env);
  assert.equal((await reloaded.api.authStatus()).account?.id, "1");
  assert.deepEqual(service.refreshBodies.at(-1), { account: "1" });

  // A new tab opens the account used last.
  const other = fakeTab(browser);
  service.attach(other);
  const second = createWebBridge(other.env);
  assert.equal((await second.api.authStatus()).account?.id, "1");
});

test("an ended session asks to sign in again; the menu marks it", async () => {
  const { service, bridge } = setup();
  await bridge.api.loginAccount("ada@example.com", "pw");
  await bridge.api.addAccount();
  await bridge.api.loginAccount("bob@example.com", "pw");
  service.cookies.delete(1); // Ada's session ended elsewhere.
  await assert.rejects(bridge.api.switchAccount("1"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, signInAgainCode);
    return true;
  });
  assert.equal(bridge.auth.current?.account.id, "2", "still Bob");
  const list = await bridge.api.browserAccounts();
  assert.deepEqual(
    list.accounts.map((a) => [a.id, a.signedIn, a.signInAgain ?? false]),
    [
      ["2", true, false],
      ["1", false, true],
    ],
  );
});

test("a log out ends only this account; the chooser lists the others", async () => {
  const { browser, service, bridge } = setup();
  await bridge.api.loginAccount("ada@example.com", "pw");
  await bridge.api.addAccount();
  await bridge.api.loginAccount("bob@example.com", "pw");
  const after = await bridge.api.logoutAccount();
  assert.deepEqual(service.logoutBodies.at(-1), { account: "2" });
  assert.deepEqual([...service.cookies.keys()], [1]);
  assert.equal(browser.local.get("claudex-web-last-account"), "-");
  assert.deepEqual(
    after.browserAccounts?.accounts.map((a) => [
      a.id,
      a.signedIn,
      a.signInAgain ?? false,
    ]),
    [
      ["2", false, false],
      ["1", true, false],
    ],
  );
  // A new tab after a log out opens the sign-in page, not Ada.
  const other = fakeTab(browser);
  service.attach(other);
  const before = service.refreshBodies.length;
  const fresh = await createWebBridge(other.env).api.authStatus();
  assert.equal(fresh.account, undefined);
  assert.equal(service.refreshBodies.length, before);

  // Choosing Ada in the chooser switches without a password.
  const ada = await createWebBridge(other.env).api.switchAccount("1");
  assert.equal(ada.id, "1");
});

test("removing an account from this device signs it out here and forgets it", async () => {
  const { browser, service, bridge } = setup();
  await bridge.api.loginAccount("ada@example.com", "pw");
  await bridge.api.logoutAccount();
  await bridge.api.loginAccount("bob@example.com", "pw");
  await assert.rejects(
    bridge.api.forgetBrowserAccount("2"),
    /Log out of this account/,
  );
  await bridge.api.forgetBrowserAccount("1");
  assert.deepEqual(service.logoutBodies.at(-1), { account: "1" });
  assert.deepEqual(
    JSON.parse(browser.local.get("claudex-web-accounts")!).map(
      (a: { id: string }) => a.id,
    ),
    ["2"],
  );
});

test("a sign-out in one tab ends only the tabs showing that account", async () => {
  const browser = new FakeBrowser();
  const service = new MultiService();
  const one = setup(browser, service);
  await one.bridge.api.loginAccount("ada@example.com", "pw");
  const two = setup(browser, service);
  await two.bridge.api.addAccount();
  await two.bridge.api.loginAccount("bob@example.com", "pw");
  const three = setup(browser, service);
  three.tab.session.set("claudex-web-account", "2");
  assert.equal((await three.bridge.api.authStatus()).account?.id, "2");

  const ended: string[] = [];
  one.bridge.api.onEvent((e) => e.type === "signed-out" && ended.push("one"));
  three.bridge.api.onEvent(
    (e) => e.type === "signed-out" && ended.push("three"),
  );
  await two.bridge.api.logoutAccount();
  await flush();
  assert.deepEqual(ended, ["three"]);
  assert.equal(one.bridge.auth.current?.account.id, "1");
});

test("the remembered list holds ten accounts, no tokens, and survives bad data", async () => {
  const { browser, bridge } = setup();
  browser.local.set(
    "claudex-web-accounts",
    JSON.stringify([
      { id: "x", email: "bad@example.com" },
      { id: "7", email: "" },
      ...Array.from({ length: 12 }, (_, i) => ({
        id: String(100 + i),
        email: `u${i}@example.com`,
        name: `U${i}`,
        token: "secret",
      })),
    ]),
  );
  const list = await bridge.api.browserAccounts();
  assert.equal(list.accounts.length, 10);
  assert.equal(list.accounts[0].id, "100");
  assert.ok(list.accounts.every((a) => !a.signedIn));
  await bridge.api.loginAccount("ada@example.com", "pw");
  const stored = browser.local.get("claudex-web-accounts")!;
  assert.doesNotMatch(stored, /secret|rt-|at-/);
  assert.equal(JSON.parse(stored).length, 10);
  assert.equal(JSON.parse(stored)[0].id, "1");

  browser.local.set("claudex-web-accounts", "{not json");
  assert.deepEqual((await bridge.api.browserAccounts()).accounts.length, 1);
});

test("going back from adding an account returns to the tab's account", async () => {
  const { bridge, tab } = setup();
  await bridge.api.loginAccount("ada@example.com", "pw");
  await bridge.api.addAccount();
  await bridge.api.cancelAddAccount();
  assert.equal(tab.session.get("claudex-web-adding"), undefined);
  const reloaded = createWebBridge(tab.env);
  assert.equal((await reloaded.api.authStatus()).account?.id, "1");
});
