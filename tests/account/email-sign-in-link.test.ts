import assert from "node:assert/strict";
import test from "node:test";
import {
  emailLinkRequest,
  parseEmailLink,
  parsePendingEmailLink,
} from "../../shared/email-link";
import { EmailSignInWindows } from "../../electron/account/email-sign-in-links";
import { Sub2ApiClient } from "../../electron/sub2api/client";
import { createWebBridge } from "../../src-web/bridge";
import { fakeTab, json } from "../app/web-bridge-fakes.test.ts";

test("email links parse only the callback and fixed desktop protocol", () => {
  const request = emailLinkRequest(true);
  assert.match(request.request_id, /^[a-f0-9]{64}$/);
  assert.match(request.request_secret, /^[a-f0-9]{64}$/);
  assert.notEqual(request.request_id, request.request_secret);
  const link = {
    email: "ada@example.com",
    request_id: request.request_id,
    code: "123456",
  };
  const fragment = new URLSearchParams(link);
  for (const base of [
    "claudex://sign-in",
    "https://claudex.example/sign-in/callback",
  ])
    assert.deepEqual(parseEmailLink(`${base}#${fragment}`), link);
  for (const base of [
    "claudex://chat",
    "claudex://sign-in/elsewhere",
    "javascript:sign-in",
    "https://claudex.example/login",
    "claudex://user@sign-in",
    "claudex://sign-in:1234",
  ])
    assert.equal(parseEmailLink(`${base}#${fragment}`), undefined);
  assert.equal(
    parseEmailLink(
      `claudex://sign-in#${new URLSearchParams({ ...link, code: "12345" })}`,
    ),
    undefined,
  );
  assert.equal(parseEmailLink("not a URL"), undefined);
});

test("only a current, well-formed requesting-tab proof can be restored", () => {
  const pending = {
    ...emailLinkRequest(false),
    email: "ada@example.com",
    expiresAt: 601_000,
  };
  assert.deepEqual(
    parsePendingEmailLink(JSON.stringify(pending), 1000),
    pending,
  );
  for (const value of [
    null,
    "{}",
    "not JSON",
    JSON.stringify({ ...pending, request_secret: "" }),
    JSON.stringify({ ...pending, expiresAt: 1000 }),
    JSON.stringify({ ...pending, expiresAt: 601_001 }),
    JSON.stringify({ ...pending, email: 42 }),
  ])
    assert.equal(parsePendingEmailLink(value, 1000), undefined);
});

test("desktop sends the request proof and keeps link and manual-code verification distinct", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const client = new Sub2ApiClient(
    "https://claudex.example",
    async (url, init) => {
      requests.push({
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(init?.body)),
      });
      return json({
        code: 0,
        data: String(url).endsWith("/send")
          ? { countdown: 60 }
          : {
              requires_2fa: true,
              temp_token: "pending",
              user_email_masked: "a***@example.com",
            },
      });
    },
  );
  const request = emailLinkRequest(true);
  assert.deepEqual(await client.sendSignInCode("ada@example.com", request), {
    countdown: 60,
  });
  assert.deepEqual(requests[0], {
    path: "/api/v1/claudex/auth/email-code/send",
    body: { email: "ada@example.com", ...request },
  });
  assert.deepEqual(
    await client.loginWithCode("ada@example.com", "123456", request),
    {
      kind: "twoFactor",
      tempToken: "pending",
      maskedEmail: "a***@example.com",
    },
  );
  assert.deepEqual(requests[1].body, {
    email: "ada@example.com",
    code: "123456",
    ...request,
    link: true,
  });
  await client.loginWithCode("ada@example.com", "123456");
  assert.deepEqual(requests[2].body, {
    email: "ada@example.com",
    code: "123456",
  });
});

test("web link verification uses the cookie-session route and retains the authenticator challenge", async () => {
  const tab = fakeTab();
  tab.routes.push((request) => {
    if (request.url.endsWith("/email-code/send"))
      return json({ code: 0, data: { countdown: 60 } });
    if (request.url.endsWith("/email-code/login"))
      return json({
        code: 0,
        data: {
          requires_2fa: true,
          temp_token: "pending",
          user_email_masked: "a***@example.com",
        },
      });
    return undefined;
  });
  const bridge = createWebBridge(tab.env);
  const request = emailLinkRequest(false);
  await bridge.api.sendSignInCode(" ada@example.com ", request);
  assert.deepEqual(tab.requests[0].body, {
    email: "ada@example.com",
    ...request,
  });
  const result = await bridge.api.loginWithCode(
    "ada@example.com",
    "123456",
    request,
  );
  assert.deepEqual(result, {
    twoFactorRequired: true,
    maskedEmail: "a***@example.com",
  });
  assert.deepEqual(tab.requests[1].body, {
    email: "ada@example.com",
    code: "123456",
    ...request,
    link: true,
  });
  assert.match(tab.requests[1].url, /\/web\/auth\/email-code\/login$/);
  assert.equal(tab.requests[1].credentials, "same-origin");
  assert.equal(bridge.auth.current, undefined);
});

test("desktop callbacks return only to the requesting window, until expiry", () => {
  let now = 1000;
  const requests = new EmailSignInWindows(() => now);
  const first = { isDestroyed: () => false };
  let destroyed = false;
  const second = { isDestroyed: () => destroyed };
  requests.remember("first", first);
  requests.remember("second", second);
  assert.equal(requests.owner("first"), first);
  assert.equal(requests.owner("second"), second);
  assert.equal(requests.owner("foreign-device"), undefined);
  requests.remember("resent", first);
  assert.equal(requests.owner("first"), undefined);
  assert.equal(requests.owner("resent"), first);
  destroyed = true;
  assert.equal(requests.owner("second"), undefined);
  now += 600_000;
  assert.equal(requests.owner("resent"), undefined);
});
