import assert from "node:assert/strict";
import test from "node:test";
import { createWebBridge } from "../../src-web/bridge";
import {
  accountFrom,
  affiliateKey,
  signInPolicy,
} from "../../src-web/bridge/auth-support";
import type { AppEvent } from "../../shared/types";
import { signInFailed } from "../../shared/sign-in-errors";
import {
  authService,
  FakeBrowser,
  FakeClock,
  fakeTab,
  flush,
  json,
  signedInBridge,
} from "./web-bridge-fakes.test.ts";

const path = (url: string) => new URL(url, "https://claudex.example").pathname;

test("a reloaded page restores its session from the refresh cookie only", async () => {
  const { tab, browser, bridge, status } = await signedInBridge();
  assert.deepEqual(status, {
    account: { id: "42", email: "ada@example.com", name: "Ada", remote: true },
    hasAccounts: true,
  });
  const refresh = tab.requests.find((r) =>
    path(r.url).endsWith("/web/auth/refresh"),
  )!;
  assert.equal(refresh.method, "POST");
  assert.equal(refresh.credentials, "same-origin");
  assert.equal(refresh.headers.get("x-claudex-web"), "1");
  assert.equal(refresh.headers.get("x-claudex-client"), "web");
  assert.equal(refresh.headers.get("authorization"), null);
  // The access token stays in memory; nothing keeps a refresh token.
  const session = bridge.auth.current!;
  assert.equal(session.accessToken, "at-1");
  assert.deepEqual(Object.keys(session).sort(), [
    "accessToken",
    "account",
    "expiresAt",
  ]);
  // Storage holds the tab's account and the remembered account, never a token.
  assert.deepEqual([...tab.session.entries()], [["claudex-web-account", "42"]]);
  for (const value of [...tab.session.values(), ...browser.local.values()])
    assert.doesNotMatch(value, /at-|rt-/);
  assert.equal(browser.local.get("claudex-web-last-account"), "42");
  assert.deepEqual(JSON.parse(browser.local.get("claudex-web-accounts")!), [
    { id: "42", email: "ada@example.com", name: "Ada" },
  ]);
});

test("without a session the sign-in screen gets the service's policy", async () => {
  const browser = new FakeBrowser();
  const tab = fakeTab(browser);
  authService(tab, browser, { signedIn: false });
  const bridge = createWebBridge(tab.env);
  const status = await bridge.api.authStatus();
  assert.equal(status.account, undefined);
  assert.equal(status.hasAccounts, true);
  assert.deepEqual(status.remote, {
    siteName: "Claudex",
    registrationEnabled: true,
    emailVerification: true,
    invitationCode: false,
    promoCode: false,
    captchaRequired: false,
    emailDomains: [],
    // Nothing more is offered unless the service says so.
    passwordReset: false,
    emailCodeLogin: false,
    passkey: false,
    backendMode: false,
  });
  assert.equal(tab.sockets.length, 0);
});

test("an unreachable service is reported on the form with a retry", async () => {
  const tab = fakeTab();
  tab.env.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const bridge = createWebBridge(tab.env);
  const status = await bridge.api.authStatus();
  assert.equal(status.account, undefined);
  assert.match(status.remote!.unavailable!, /Can't reach Claudex/);
});

test("backend mode turns registration off; captchas are reported", () => {
  const policy = signInPolicy({
    registration_enabled: true,
    backend_mode_enabled: true,
    turnstile_enabled: true,
    registration_email_suffix_whitelist: ["example.com", 7],
  });
  assert.equal(policy.registrationEnabled, false);
  assert.equal(policy.captchaRequired, true);
  assert.deepEqual(policy.emailDomains, ["example.com"]);
});

test("accounts come from the web session or a Sub2API user", () => {
  assert.deepEqual(
    accountFrom({
      account: { id: "u-1", email: "a@b.c", name: "A", plan: "Pro" },
    }),
    { id: "u-1", email: "a@b.c", name: "A", plan: "Pro", remote: true },
  );
  assert.deepEqual(
    accountFrom({ user: { id: 7, email: "bob@b.c", username: "" } }),
    { id: "7", email: "bob@b.c", name: "bob", remote: true },
  );
  assert.equal(accountFrom({ user: { id: -1, email: "x" } }), undefined);
});

test("sign-in with an authenticator code keeps the challenge in memory", async () => {
  const browser = new FakeBrowser();
  const tab = fakeTab(browser);
  const service = authService(tab, browser, { signedIn: false });
  tab.routes.unshift((request) => {
    if (path(request.url).endsWith("/web/auth/login"))
      return json({
        code: 0,
        data: {
          requires_2fa: true,
          temp_token: "tmp-1",
          user_email_masked: "a***@example.com",
        },
      });
    if (path(request.url).endsWith("/web/auth/2fa"))
      return json({
        code: 0,
        data: {
          access_token: service.issue(),
          refresh_token: "must-be-ignored",
          expires_in: 3600,
          user: { id: 42, email: "ada@example.com", username: "Ada" },
        },
      });
    return undefined;
  });
  const bridge = createWebBridge(tab.env);
  const challenge = await bridge.api.loginAccount("ada@example.com", "pw");
  assert.deepEqual(challenge, {
    twoFactorRequired: true,
    maskedEmail: "a***@example.com",
  });
  assert.equal((await bridge.api.authStatus()).twoFactorPending, true);
  const account = await bridge.api.completeTwoFactor(" 123456 ");
  assert.equal(account.id, "42");
  const twoFactor = tab.requests.find((r) =>
    path(r.url).endsWith("/web/auth/2fa"),
  )!;
  assert.deepEqual(twoFactor.body, {
    temp_token: "tmp-1",
    totp_code: "123456",
  });
  assert.ok(!JSON.stringify(bridge.auth.current).includes("must-be-ignored"));
  await flush();
  assert.equal(tab.sockets.length, 1, "the event stream opens");
});

test("a 2FA step the service forgot says to start again and is dropped", async () => {
  const browser = new FakeBrowser();
  const tab = fakeTab(browser);
  authService(tab, browser, { signedIn: false });
  tab.routes.unshift((request) => {
    if (path(request.url).endsWith("/web/auth/login"))
      return json({
        code: 0,
        data: { requires_2fa: true, temp_token: "tmp-1" },
      });
    if (path(request.url).endsWith("/web/auth/2fa"))
      return json(
        {
          code: 400,
          message: "Invalid or expired 2FA session",
          reason: "CLAUDEX_2FA_SESSION_EXPIRED",
        },
        400,
      );
    return undefined;
  });
  const bridge = createWebBridge(tab.env);
  await bridge.api.loginAccount("ada@example.com", "pw");
  const expired = "This sign-in expired. Start again to get a new code.";
  await assert.rejects(bridge.api.completeTwoFactor("123456"), {
    message: expired,
  });
  assert.equal((await bridge.api.authStatus()).twoFactorPending, undefined);
  await assert.rejects(bridge.api.completeTwoFactor("123456"), {
    message: expired,
  });
});

test("sign-in failures read as the sign-in page's sentences, codes kept", async () => {
  const tab = fakeTab();
  tab.routes.push(() =>
    json(
      {
        code: 401,
        message: "Invalid email or password",
        reason: "INVALID_CREDENTIALS",
      },
      401,
    ),
  );
  const bridge = createWebBridge(tab.env);
  await assert.rejects(bridge.api.loginAccount("a@b.c", "x"), (error: any) => {
    assert.equal(error.message, "Email or password is incorrect.");
    assert.equal(error.code, "INVALID_CREDENTIALS");
    return true;
  });
  tab.routes.unshift(() =>
    json({ code: 400, message: "Something specific", reason: "ODD_CASE" }, 400),
  );
  await assert.rejects(bridge.api.loginAccount("a@b.c", "x"), (error: any) => {
    assert.equal(error.message, signInFailed);
    assert.equal(error.code, "ODD_CASE");
    return true;
  });
});

test("registration sends the extras and a remembered aff code", async () => {
  const browser = new FakeBrowser();
  const tab = fakeTab(browser);
  const service = authService(tab, browser, { signedIn: false });
  tab.session.set(affiliateKey, "AFF42");
  tab.routes.unshift((request) =>
    path(request.url).endsWith("/web/auth/register")
      ? json({
          code: 0,
          data: {
            access_token: service.issue(),
            expires_in: 3600,
            user: { id: 42, email: "ada@example.com", username: "Ada" },
          },
        })
      : undefined,
  );
  const bridge = createWebBridge(tab.env);
  await bridge.api.registerAccount("ada@example.com", "secret1", "Ada", {
    verifyCode: "999111",
    promoCode: "",
  });
  const register = tab.requests.find((r) =>
    path(r.url).endsWith("/web/auth/register"),
  )!;
  assert.deepEqual(register.body, {
    email: "ada@example.com",
    password: "secret1",
    verify_code: "999111",
    aff_code: "AFF42",
  });
});

test("tabs refresh one at a time, so rotating the cookie never replays it", async () => {
  const browser = new FakeBrowser();
  const clock = new FakeClock();
  const a = fakeTab(browser, clock);
  const b = fakeTab(browser, clock);
  const serviceA = authService(a, browser);
  // Both tabs talk to the same service (one cookie jar).
  b.routes.push(...a.routes);
  const tabA = createWebBridge(a.env);
  const tabB = createWebBridge(b.env);
  const [first, second] = await Promise.all([
    tabA.api.authStatus(),
    tabB.api.authStatus(),
  ]);
  assert.ok(first.account && second.account);
  assert.equal(serviceA.refreshes, 2);
  assert.notEqual(tabA.auth.current!.accessToken, "");
});

test("a new token from another tab saves this tab a refresh", async () => {
  const browser = new FakeBrowser();
  const clock = new FakeClock();
  const a = fakeTab(browser, clock);
  const b = fakeTab(browser, clock);
  const service = authService(a, browser);
  b.routes.push(...a.routes);
  const tabA = createWebBridge(a.env);
  const tabB = createWebBridge(b.env);
  await tabA.api.authStatus();
  await tabB.api.authStatus();
  await flush();
  const stale = tabB.auth.current!.accessToken;
  // Tab A refreshes (its token was refused); tab B hears of the new token.
  await tabA.auth.refresh(tabA.auth.current!.accessToken);
  await flush();
  assert.equal(tabB.auth.current!.accessToken, tabA.auth.current!.accessToken);
  const before = service.refreshes;
  const next = await tabB.auth.refresh(stale);
  assert.equal(next!.accessToken, tabA.auth.current!.accessToken);
  assert.equal(service.refreshes, before);
});

test("the token is refreshed before it expires", async () => {
  const clock = new FakeClock();
  const { service, bridge } = await signedInBridge(() => null, { clock });
  const first = bridge.auth.current!.accessToken;
  await clock.advance(55 * 60_000 + 1000);
  assert.notEqual(bridge.auth.current!.accessToken, first);
  assert.equal(service.refreshes, 2);
});

test("a refused refresh signs the window out; a failing one does not", async () => {
  const { tab, bridge, service, events } = await signedInBridge();
  tab.routes.unshift((request) =>
    path(request.url).endsWith("/web/auth/refresh") && service.refreshes > 5
      ? json({ code: 502, message: "Bad gateway" }, 502)
      : undefined,
  );
  service.refreshes = 10;
  await assert.rejects(bridge.auth.refresh("at-1"), /Bad gateway/);
  assert.ok(bridge.auth.current, "an outage keeps the session");
  assert.deepEqual(
    events.filter((event) => event.type === "auth-issue").at(-1),
    {
      type: "auth-issue",
      issue: "auth_unavailable",
    },
  );
  service.refreshes = 0;
  await bridge.auth.refresh("at-1");
  assert.deepEqual(
    events.filter((event) => event.type === "auth-issue").slice(-2),
    [
      { type: "auth-issue", issue: "retrying" },
      { type: "auth-issue", issue: null },
    ],
  );
  service.signOut();
  assert.equal(
    await bridge.auth.refresh(bridge.auth.current!.accessToken),
    null,
  );
  assert.equal(bridge.auth.current, undefined);
  const signedOut = events.filter((e) => e.type === "signed-out");
  assert.equal(signedOut.length, 1);
  assert.equal((signedOut[0] as any).reason, "session-expired");
});

test("signing out in one tab signs the other tabs out", async () => {
  const browser = new FakeBrowser();
  const a = await signedInBridge(() => null, { browser });
  const b = await signedInBridge(() => null, { browser });
  a.tab.routes.unshift((request) =>
    path(request.url).endsWith("/web/auth/logout")
      ? json({ code: 0, data: {} })
      : undefined,
  );
  const status = await a.bridge.api.logoutAccount();
  assert.equal(status.account, undefined);
  assert.ok(status.remote);
  const logout = a.tab.requests.find((r) =>
    path(r.url).endsWith("/web/auth/logout"),
  )!;
  assert.equal(logout.headers.get("x-claudex-web"), "1");
  await flush();
  assert.equal(b.bridge.auth.current, undefined);
  const event = b.events.find((e) => e.type === "signed-out") as Extract<
    AppEvent,
    { type: "signed-out" }
  >;
  assert.ok(event);
  assert.equal(event.message, "You signed out in another tab.");
  // The tab that signed out does not show "you were signed out".
  assert.equal(a.events.filter((e) => e.type === "signed-out").length, 0);
});

test("sign out everywhere uses the access token and ends the session", async () => {
  const { tab, bridge } = await signedInBridge();
  tab.routes.unshift((request) =>
    path(request.url).endsWith("/web/auth/revoke-all")
      ? json({ code: 0, data: {} })
      : undefined,
  );
  const status = await bridge.api.revokeAllSessions();
  assert.equal(status.account, undefined);
  const revoke = tab.requests.find((r) =>
    path(r.url).endsWith("/web/auth/revoke-all"),
  )!;
  assert.equal(revoke.headers.get("authorization"), "Bearer at-1");
  assert.equal(tab.sockets.at(-1)!.closedWith?.code, 1000);
});

test("send-code reports the countdown", async () => {
  const tab = fakeTab();
  tab.routes.push(() =>
    json({ code: 0, data: { message: "ok", countdown: 45 } }),
  );
  const bridge = createWebBridge(tab.env);
  assert.deepEqual(await bridge.api.sendVerificationCode("a@b.c"), {
    countdown: 45,
  });
});

test("the sign-in page's other ways in go to the web auth routes (LOGIN)", async () => {
  const tab = fakeTab();
  const user = { id: 7, email: "ada@example.com", username: "Ada" };
  tab.routes.push((request) => {
    const route = path(request.url).replace("/api/v1/claudex/web/auth/", "");
    if (route === "forgot-password") return json({ code: 0, data: {} });
    if (route === "email-code/send")
      return json({ code: 0, data: { countdown: 30 } });
    if (route === "email-code/login") {
      const body = request.body as { email: string; code: string };
      if (body.code !== "123456")
        return json(
          {
            code: 400,
            message: "That code didn\u2019t match. Check it and try again.",
            reason: "CLAUDEX_EMAIL_CODE_INVALID",
          },
          400,
        );
      return json({
        code: 0,
        data: { access_token: "at-code", expires_in: 3600, user },
      });
    }
    return undefined;
  });
  const bridge = createWebBridge(tab.env);
  await bridge.api.requestPasswordReset(" ada@example.com ");
  const reset = tab.requests.find((r) =>
    path(r.url).endsWith("/web/auth/forgot-password"),
  )!;
  assert.deepEqual(reset.body, { email: "ada@example.com" });
  assert.deepEqual(await bridge.api.sendSignInCode("ada@example.com"), {
    countdown: 30,
  });
  await assert.rejects(
    bridge.api.loginWithCode("ada@example.com", "000000"),
    (error: Error & { code?: string }) =>
      error.code === "CLAUDEX_EMAIL_CODE_INVALID",
  );
  // Without passkeys in this browser the call refuses at once.
  await assert.rejects(bridge.api.loginWithPasskey(), /passkeys/);
  assert.deepEqual(
    await bridge.api.loginWithCode("ada@example.com", "123456"),
    {
      id: "7",
      email: "ada@example.com",
      name: "Ada",
      remote: true,
    },
  );
  // Signed in now: the sign-in calls refuse.
  await assert.rejects(bridge.api.loginWithPasskey(), /Already signed in/);
});

test("the sign-in policy adds the Claudex options (LOGIN)", () => {
  const policy = signInPolicy(
    {
      site_name: "Acme",
      password_reset_enabled: true,
      passkey_enabled: true,
      login_agreement_documents: [{ id: "privacy" }],
    },
    { emailCodeLogin: true },
    true,
  );
  assert.equal(policy.passwordReset, true);
  assert.equal(policy.emailCodeLogin, true);
  assert.equal(policy.passkey, true);
  assert.equal(policy.privacyPolicyUrl, "/legal/privacy");
  // Backend mode turns the self-service ways off.
  const backend = signInPolicy(
    { password_reset_enabled: true, backend_mode_enabled: true },
    { emailCodeLogin: true },
  );
  assert.deepEqual(
    [backend.passwordReset, backend.emailCodeLogin, backend.backendMode],
    [false, false, true],
  );
});

test("a refresh that answers for another account signs this tab out", async () => {
  const { tab, bridge, events } = await signedInBridge();
  // Someone signed in as another account in another tab: the shared cookie
  // now refreshes to their session.
  tab.routes.unshift((request) =>
    path(request.url).endsWith("/web/auth/refresh")
      ? json({
          code: 0,
          data: {
            access_token: "other-token",
            expires_in: 3600,
            user: { id: 43, email: "eve@example.com", username: "Eve" },
          },
        })
      : undefined,
  );
  assert.equal(await bridge.auth.refresh("at-1"), null);
  assert.equal(bridge.auth.current, undefined);
  const signedOut = events.filter((e) => e.type === "signed-out");
  assert.equal(signedOut.length, 1);
  assert.match((signedOut[0] as any).message, /another account/);
});

test("a refresh without the account reads it from the service", async () => {
  const { tab, bridge } = await signedInBridge();
  let me = 0;
  tab.routes.unshift((request) => {
    if (path(request.url).endsWith("/web/auth/refresh"))
      return json({ code: 0, data: { access_token: "t2", expires_in: 3600 } });
    if (path(request.url) === "/api/v1/auth/me") {
      me++;
      return json({
        code: 0,
        data: { id: 42, email: "ada@example.com", username: "Ada" },
      });
    }
    return undefined;
  });
  const next = await bridge.auth.refresh("at-1");
  assert.equal(next!.accessToken, "t2");
  assert.equal(next!.account.id, "42");
  assert.equal(me, 1);
});

test("a call made while signed out does not start a session", async () => {
  const browser = new FakeBrowser();
  const tab = fakeTab(browser);
  const service = authService(tab, browser);
  const bridge = createWebBridge(tab.env);
  await assert.rejects(bridge.auth.accessToken(), /session has expired/);
  assert.equal(await bridge.auth.refresh("at-old"), null);
  assert.equal(service.refreshes, 0);
  assert.equal(bridge.auth.current, undefined);
});
