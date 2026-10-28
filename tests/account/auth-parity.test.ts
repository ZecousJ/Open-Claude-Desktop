import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  authIssueCopy,
  authIssueOf,
  turnAuthIssue,
  type AuthIssue,
} from "../../shared/auth-issue";
import { voiceAuthIssue } from "../../src/voice/auth-issue";
import { automaticUpdateNotice } from "../../shared/client-release";
import {
  codeAlreadyUsed,
  codeMismatch,
  signInErrorMessage,
  signInFailed,
} from "../../shared/sign-in-errors";
import { AuthIssueNotice } from "../../src/composer/AuthIssueBanner";
import { SignInFallback } from "../../src/auth/SignInFrame";
import { signInError } from "../../electron/sub2api/identity-support";
import { Sub2ApiError } from "../../electron/sub2api/http";
import {
  RemoteSession,
  type SessionFile,
} from "../../electron/sub2api/session";
import type { Sub2ApiClient } from "../../electron/sub2api/client";

test("login refusals use the live fallback, timeout and network-policy sentences", () => {
  assert.equal(
    signInErrorMessage("state_expired"),
    "That took too long. Please try again.",
  );
  assert.equal(
    signInErrorMessage("apple_login_expired"),
    "That took too long. Please try again.",
  );
  assert.equal(
    signInErrorMessage("tenant_restriction_violation"),
    "Access restricted by network policy. Contact IT Administrator.",
  );
  assert.equal(
    signInError(new Sub2ApiError(400, "UNKNOWN", "Internal details")).message,
    signInFailed,
  );
  const html = renderToStaticMarkup(createElement(SignInFallback));
  assert.match(html, /There was an error logging you in\./);
  assert.match(html, /contact support<\/a> for assistance\./);
  assert.ok(!html.includes("{emailSupport}"));
});

test("email rate limits and used codes have distinct sentences", () => {
  assert.equal(
    codeMismatch,
    "Incorrect code entered. Check that the code matches what you received in your other browser or device and try again.",
  );
  assert.equal(
    signInErrorMessage("TOTP_INVALID_CODE"),
    "That code didn’t match. Check it and try again.",
  );
  assert.equal(
    signInErrorMessage(undefined, 429, undefined, true),
    "Too many attempts. Wait a few minutes before trying again.",
  );
  assert.equal(
    signInErrorMessage(undefined, 429),
    "Too many login attempts. Try again later.",
  );
  assert.equal(
    signInErrorMessage("rate_limit_error"),
    "Too many login attempts. Try again later.",
  );
  assert.equal(
    signInErrorMessage("TOTP_TOO_MANY_ATTEMPTS", 429),
    "Too many attempts. Wait a few minutes before trying again.",
  );
  assert.equal(signInErrorMessage("CLAUDEX_EMAIL_CODE_INVALID"), codeMismatch);
  assert.equal(
    signInErrorMessage("CLAUDEX_EMAIL_CODE_ALREADY_USED"),
    codeAlreadyUsed,
  );
  assert.equal(
    signInErrorMessage(undefined, 400, "already_used"),
    codeAlreadyUsed,
  );
});

test("composer authentication warnings distinguish expiry from transient verification", () => {
  assert.equal(turnAuthIssue("401 Unauthorized"), "auth_error");
  assert.equal(turnAuthIssue("auth_unavailable"), "auth_unavailable");
  assert.equal(turnAuthIssue("403 permission denied"), undefined);
  assert.equal(turnAuthIssue("503 overloaded"), undefined);
  for (const issue of Object.keys(authIssueCopy) as AuthIssue[]) {
    const html = renderToStaticMarkup(
      createElement(AuthIssueNotice, {
        issue,
        onDismiss: issue === "retrying" ? undefined : () => {},
      }),
    );
    assert.ok(html.includes(authIssueCopy[issue]));
    assert.match(html, /data-variant="warning"/);
    assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
    assert.equal(html.includes('aria-label="Dismiss"'), issue !== "retrying");
  }
});

test("native update announcement has one acknowledgment, not a download or restart action", () => {
  assert.deepEqual(automaticUpdateNotice, {
    title: "Update Available",
    message:
      "A new version is available. It will be downloaded and installed automatically.",
    buttons: ["OK"],
  });
});

test("voice authentication failures latch until dismissed or a successful retry clears them", () => {
  assert.equal(authIssueOf({ code: "auth_unavailable" }), "auth_unavailable");
  assert.equal(authIssueOf({ errorCode: "auth_error" }), "auth_error");
  assert.equal(authIssueOf({ status: 401 }), "auth_error");
  assert.equal(
    authIssueOf(new Error("microphone permission denied")),
    undefined,
  );
  const states: Array<AuthIssue | null> = [];
  const off = voiceAuthIssue.subscribe(() =>
    states.push(voiceAuthIssue.read()),
  );
  voiceAuthIssue.set("retrying");
  voiceAuthIssue.set("auth_error");
  voiceAuthIssue.set(null);
  off();
  assert.deepEqual(states, ["retrying", "auth_error", null]);
});

test("desktop refresh outages warn, retry and clear without signing out", async () => {
  let failure: Error | undefined = new Sub2ApiError(
    503,
    "UNAVAILABLE",
    "unavailable",
  );
  const client = {
    refresh: async () => {
      if (failure) throw failure;
      return { accessToken: "new", refreshToken: "rotated", expiresIn: 3600 };
    },
  } as unknown as Sub2ApiClient;
  const session = new RemoteSession(
    client,
    { persistent: false } as SessionFile,
    {
      version: 1,
      baseUrl: "https://service.test",
      accountId: "account",
      userId: 1,
      email: "a@example.com",
      refreshToken: "old",
    },
  );
  const issues: Array<AuthIssue | null> = [];
  const signedOut: string[] = [];
  session.onAuthIssue = (issue) => issues.push(issue);
  session.onSignedOut = (reason) => signedOut.push(reason);
  await assert.rejects(session.refresh(), /unavailable/);
  assert.deepEqual(issues, ["auth_unavailable"]);
  failure = undefined;
  await session.refresh();
  assert.deepEqual(issues, ["auth_unavailable", "retrying", null]);
  assert.deepEqual(signedOut, []);
  failure = new Sub2ApiError(401, "UNAUTHORIZED", "expired");
  await assert.rejects(session.refresh(), /expired/);
  assert.deepEqual(signedOut, ["session-expired"]);
});
