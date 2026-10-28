import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeStreamRefusal,
  describeSub2ApiRefusal,
} from "../../server/sub2api-errors";
import {
  loadSub2ApiConfig,
  normalizeSub2ApiUrl,
  saveSub2ApiConfig,
} from "../../server/sub2api-config";
import { parseProgress } from "../../electron/sub2api/client";
import { defaultClaudexServiceUrl } from "../../shared/claudex-service";
import {
  blockedStatus,
  blockFor,
  weeklyFromKeyUsage,
  weeklyFromProgress,
} from "../../electron/sub2api/quota";
import {
  blockedPage,
  createFields,
  emailProblem,
  frameHeading,
  hero,
  initialStep,
  opensOnWelcome,
  passwordMin,
  privacyNote,
  statePage,
  welcomePlatform,
} from "../../src/auth/signInView";
import {
  codeMismatch,
  totpCodeMismatch,
  signInErrorMessage,
  signInExpired,
} from "../../shared/sign-in-errors";
import { parseSignInOptions, privacyPolicyUrl } from "../../shared/sign-in-api";
import { accountStateOf } from "../../shared/sign-in-states";
import { signInError } from "../../electron/sub2api/identity-support";
import { Sub2ApiError } from "../../electron/sub2api/http";
import { bannerText } from "../../src/composer/usageBanner";
import type { RemoteSignInPolicy, WeeklyUsageStatus } from "../../shared/types";

const body = (value: unknown) => JSON.stringify(value);

test("gateway refusals map to plain English, with the limit and re-provisioning flags", () => {
  const cases: Array<[number, unknown, string | undefined, boolean, boolean]> =
    [
      // status, body, reason, exceeded, invalidKey
      [
        429,
        { code: "DAILY_LIMIT_EXCEEDED", message: "x" },
        "daily",
        true,
        false,
      ],
      [
        429,
        { code: "WEEKLY_LIMIT_EXCEEDED", message: "x" },
        "weekly",
        true,
        false,
      ],
      [
        429,
        { code: "MONTHLY_LIMIT_EXCEEDED", message: "x" },
        "monthly",
        true,
        false,
      ],
      // Current Sub2API reuses one code and names the window in the message.
      [
        429,
        {
          code: "USAGE_LIMIT_EXCEEDED",
          message: "weekly usage limit exceeded",
        },
        "weekly",
        true,
        false,
      ],
      [
        429,
        {
          error: {
            type: "rate_limit_exceeded",
            message: "daily usage limit exceeded",
          },
        },
        "daily",
        true,
        false,
      ],
      [
        429,
        { code: "API_KEY_QUOTA_EXHAUSTED", message: "api key 额度已用完" },
        "key-quota",
        true,
        false,
      ],
      [
        429,
        {
          error: {
            code: "insufficient_quota",
            type: "insufficient_quota",
            message: "api key 额度已用完",
          },
        },
        "key-quota",
        true,
        false,
      ],
      [
        429,
        {
          error: {
            type: "rate_limit_exceeded",
            message: "api key 7天限额已用完",
          },
        },
        "key-quota",
        true,
        false,
      ],
      [
        403,
        {
          code: "INSUFFICIENT_BALANCE",
          message: "Insufficient account balance",
        },
        "balance",
        true,
        false,
      ],
      [
        403,
        { code: "SUBSCRIPTION_EXPIRED", message: "x" },
        "subscription",
        true,
        false,
      ],
      [
        403,
        { code: "SUBSCRIPTION_SUSPENDED", message: "x" },
        "subscription",
        true,
        false,
      ],
      [
        403,
        {
          code: "SUBSCRIPTION_INVALID",
          message: "SUBSCRIPTION_EXPIRED: subscription has expired",
        },
        "subscription",
        true,
        false,
      ],
      [
        401,
        { code: "INVALID_API_KEY", message: "Invalid API key" },
        undefined,
        false,
        true,
      ],
      [
        429,
        { code: "USER_RPM_EXCEEDED", message: "x" },
        undefined,
        false,
        false,
      ],
      // The key's group is gone: the key is issued again in the current plan.
      [403, { code: "GROUP_DELETED", message: "x" }, undefined, false, true],
      [
        403,
        { code: "GROUP_NOT_ALLOWED", message: "API Key 所属专属分组不再允许" },
        undefined,
        false,
        true,
      ],
      [
        401,
        { code: "API_KEY_DISABLED", message: "API key is disabled" },
        undefined,
        false,
        false,
      ],
      [401, { code: "USER_NOT_FOUND", message: "x" }, undefined, false, false],
    ];
  for (const [status, value, reason, exceeded, invalidKey] of cases) {
    const refusal = describeSub2ApiRefusal(status, body(value));
    assert.ok(refusal, body(value));
    assert.deepEqual(
      [refusal.reason, refusal.exceeded, refusal.invalidKey],
      [reason, exceeded, invalidKey],
      body(value),
    );
    assert.match(refusal.message, /^[\x20-\x7e’]+$/, "English only");
  }
  assert.equal(
    describeSub2ApiRefusal(403, body({ code: "INSUFFICIENT_BALANCE" }))
      ?.message,
    "Your Claudex balance is used up. Add funds to keep going.",
  );
  assert.match(
    describeSub2ApiRefusal(
      429,
      body({ error: { message: "api key 5小时限额已用完" } }),
    )!.message,
    /5-hour/,
  );
  assert.equal(describeSub2ApiRefusal(500, "upstream exploded"), undefined);
});

test("a stream that fails mid-reply counts only Sub2API's named refusals", () => {
  // Upstream and server failures keep the agent's own error.
  assert.equal(
    describeStreamRefusal({ code: "server_error", message: "upstream failed" }),
    undefined,
  );
  assert.equal(
    describeStreamRefusal({
      code: "rate_limit_exceeded",
      message: "slow down",
    }),
    undefined,
  );
  assert.equal(describeStreamRefusal(undefined), undefined);
  assert.equal(
    describeStreamRefusal({
      code: "rate_limit_exceeded",
      message: "daily usage limit exceeded",
    })?.reason,
    "daily",
  );
});

test("the backend URL is operator configuration: https, or http on this computer", () => {
  assert.equal(
    normalizeSub2ApiUrl("https://api.example.com/"),
    "https://api.example.com",
  );
  assert.equal(
    normalizeSub2ApiUrl("http://127.0.0.1:18080"),
    "http://127.0.0.1:18080",
  );
  for (const bad of [
    "http://api.example.com",
    "https://user:pw@api.example.com",
    "https://api.example.com/?x=1",
    "ftp://api.example.com",
  ])
    assert.throws(() => normalizeSub2ApiUrl(bad));
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-sub2api-config-"),
  );
  try {
    // No local accounts: nothing configured means the default Claudex service.
    assert.equal(loadSub2ApiConfig(root, {}).baseUrl, defaultClaudexServiceUrl);
    assert.equal(
      loadSub2ApiConfig(root, { CLAUDEX_SUB2API_URL: "https://env.example" })
        .baseUrl,
      "https://env.example",
    );
    saveSub2ApiConfig(root, "https://file.example/");
    assert.equal(
      loadSub2ApiConfig(root, { CLAUDEX_SUB2API_URL: "https://env.example" })
        .baseUrl,
      "https://file.example",
    );
    fs.writeFileSync(path.join(root, "backend", "sub2api.json"), "{");
    assert.throws(() => loadSub2ApiConfig(root, {}), /cannot be read/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("subscription progress parses both response shapes", () => {
  const window = {
    limit_usd: 5,
    used_usd: 1,
    remaining_usd: 4,
    percentage: 20,
    window_start: "2026-09-21T00:00:00Z",
    resets_at: "2026-09-28T00:00:00Z",
    resets_in_seconds: 3600,
  };
  const wrapped = parseProgress([
    {
      subscription: { id: 2, group_id: 9, group: { id: 9, name: "Pro" } },
      progress: {
        id: 2,
        group_name: "Pro",
        expires_at: "2026-10-01T00:00:00Z",
        weekly: window,
      },
    },
  ]);
  const flat = parseProgress([
    {
      id: 2,
      group_name: "Pro",
      expires_at: "2026-10-01T00:00:00Z",
      weekly: window,
    },
  ]);
  assert.equal(wrapped[0].groupId, 9);
  assert.equal(flat[0].groupId, null);
  for (const entry of [wrapped[0], flat[0]]) {
    assert.equal(entry.groupName, "Pro");
    assert.deepEqual(entry.weekly, {
      limitUsd: 5,
      usedUsd: 1,
      percentage: 20,
      resetsAt: Date.parse("2026-09-28T00:00:00Z"),
    });
    assert.equal(entry.daily, undefined);
  }
  assert.deepEqual(parseProgress({}), []);
});

test("weekly status in USD, from the plan window or the key's 7d cap", () => {
  const policy = { warnPercent: 80, moreUsageUrl: "https://example.com/more" };
  const at = Date.parse("2026-09-28T00:00:00Z");
  const weekly = weeklyFromProgress(
    { limitUsd: 5, usedUsd: 5.2, percentage: 100, resetsAt: at },
    policy,
  )!;
  assert.deepEqual(
    [weekly.state, weekly.percent, weekly.unit, weekly.resetsAt],
    ["exceeded", 100, "usd", at],
  );
  assert.equal(
    weeklyFromProgress(
      { limitUsd: 5, usedUsd: 1, percentage: 20, resetsAt: at },
      policy,
    )!.state,
    "ok",
  );
  assert.equal(
    weeklyFromProgress(
      { limitUsd: 5, usedUsd: 4, percentage: 80, resetsAt: at },
      policy,
      { resetsAt: at, exceeded: false },
    )!.dismissed,
    true,
  );
  const now = Date.parse("2026-09-25T00:00:00Z");
  const key = weeklyFromKeyUsage(
    {
      rate_limits: [
        { window: "7d", limit: 5, used: 0, remaining: 5, window_start: null },
      ],
    },
    policy,
    now,
  )!;
  assert.deepEqual([key.state, key.resetsAt], ["ok", now + 7 * 86400_000]);
  assert.equal(weeklyFromKeyUsage({ rate_limits: [] }, policy, now), null);

  const block = blockFor(
    {
      status: 403,
      code: "INSUFFICIENT_BALANCE",
      reason: "balance",
      exceeded: true,
      invalidKey: false,
      message: "",
    },
    undefined,
    now,
  );
  const blocked = blockedStatus(null, block, policy, undefined);
  assert.deepEqual([blocked.state, blocked.reason], ["exceeded", "balance"]);
  assert.deepEqual(bannerText(blocked, "code"), {
    title: "Your balance is used up",
  });
});

test("banner wording names the refused limit", () => {
  const base: WeeklyUsageStatus = {
    used: 1,
    limit: 1,
    percent: 100,
    warnPercent: 80,
    resetsAt: Date.parse("2026-09-28T17:00:00"),
    moreUsageUrl: null,
    state: "exceeded",
    dismissed: false,
    unit: "usd",
  };
  assert.equal(
    bannerText({ ...base, reason: "daily" }, "code").title,
    "Daily usage limit reached",
  );
  assert.equal(
    bannerText({ ...base, reason: "monthly" }, "chat").title,
    "You’ve reached your monthly limit",
  );
  assert.equal(bannerText(base, "code").title, "Weekly usage limit reached");
  assert.equal(
    bannerText({ ...base, reason: "subscription" }, "chat").detail,
    undefined,
  );
});

test("the sign-in card follows the remote policy", () => {
  const policy: RemoteSignInPolicy = {
    siteName: "Acme AI",
    registrationEnabled: false,
    emailVerification: false,
    invitationCode: false,
    promoCode: true,
    captchaRequired: false,
    emailDomains: [],
  };
  // A service signs in with the email first, then the password.
  const closed = { hasAccounts: false, remote: policy };
  assert.equal(initialStep(closed), "email");
  assert.equal(initialStep(closed, "create"), "email");
  assert.equal(passwordMin(closed), 6);
  assert.equal(privacyNote(policy), undefined);
  assert.deepEqual(
    privacyNote({ ...policy, privacyPolicyUrl: "https://x.test/p" }),
    { service: "Acme AI", url: "https://x.test/p" },
  );

  const open = {
    ...policy,
    registrationEnabled: true,
    emailVerification: true,
    invitationCode: true,
  };
  // The registration code has its own step (createVerify).
  assert.deepEqual(createFields({ hasAccounts: false, remote: open }), [
    "email",
    "password",
    "invitationCode",
    "promoCode",
  ]);
  assert.equal(
    initialStep({ hasAccounts: false, remote: open }, "create"),
    "create",
  );
  assert.equal(
    initialStep({ hasAccounts: true, remote: policy, twoFactorPending: true }),
    "twoFactor",
  );
  assert.equal(
    blockedPage({
      hasAccounts: false,
      remote: { ...policy, captchaRequired: true },
    })?.kind,
    "captcha",
  );
  assert.deepEqual(
    blockedPage({
      hasAccounts: false,
      remote: { ...policy, unavailable: "Down." },
    }),
    statePage("unavailable", "Down."),
  );
  assert.equal(blockedPage(closed), undefined);
  // Registration domains and malformed addresses stop at the form.
  assert.equal(
    emailProblem("a@b.org", { ...open, emailDomains: ["acme.test"] }, true),
    "Use an address at acme.test.",
  );
  assert.equal(
    emailProblem("a@acme.test", { ...open, emailDomains: ["acme.test"] }, true),
    undefined,
  );
  assert.equal(
    emailProblem("nope"),
    "Invalid email address. Double-check the email entered and try again.",
  );
  // Local accounts keep one email-and-password card.
  assert.equal(initialStep({ hasAccounts: true }), "login");
  assert.equal(initialStep({ hasAccounts: false }), "create");
  assert.deepEqual(createFields({ hasAccounts: true }), [
    "name",
    "email",
    "password",
  ]);
  assert.equal(passwordMin({ hasAccounts: true }), 12);
});

test("the desktop opens on its welcome screen, then a short heading", () => {
  const policy: RemoteSignInPolicy = {
    siteName: "Acme AI",
    registrationEnabled: false,
    emailVerification: false,
    invitationCode: false,
    promoCode: false,
    captchaRequired: false,
    emailDomains: [],
  };
  const status = { hasAccounts: true, remote: policy };
  // Each desktop sign-in opens on it.
  assert.equal(opensOnWelcome(status, "desktop"), true);
  assert.equal(opensOnWelcome({ hasAccounts: false }, "desktop"), true);
  assert.equal(opensOnWelcome(status, "web"), false);
  // A pending 2FA step or a refusing service skips it.
  assert.equal(
    opensOnWelcome({ ...status, twoFactorPending: true }, "desktop"),
    false,
  );
  assert.equal(
    opensOnWelcome(
      { hasAccounts: true, remote: { ...policy, captchaRequired: true } },
      "desktop",
    ),
    false,
  );
  assert.equal(welcomePlatform("darwin"), "Mac");
  assert.equal(welcomePlatform("linux"), "Linux");
  assert.equal(welcomePlatform("win32"), "Windows");
  assert.equal(welcomePlatform(undefined), "Windows");
  // The web keeps the hero; the desktop says "Sign In", a state page its own.
  assert.deepEqual(frameHeading(undefined, "web"), { ...hero });
  assert.deepEqual(frameHeading(undefined, "desktop"), {
    title: "Sign In",
    subtitle: "",
  });
  const page = statePage("disabled", "", "desktop");
  assert.deepEqual(frameHeading(page, "desktop"), {
    title: page.title,
    subtitle: page.subtitle,
  });
});

test("code refusals use the original's sentences", () => {
  assert.equal(signInErrorMessage("TOTP_INVALID_CODE"), totpCodeMismatch);
  assert.equal(signInErrorMessage("INVALID_VERIFY_CODE"), codeMismatch);
  assert.equal(
    signInErrorMessage("CLAUDEX_2FA_SESSION_EXPIRED"),
    signInExpired,
  );
});

test("refusals with a page of their own are recognised by code or wording", () => {
  const coded = (code: string, message = "x") =>
    Object.assign(new Error(message), { code });
  assert.equal(accountStateOf(coded("CLAUDEX_DEVICE_LIMIT")), "device-limit");
  assert.equal(accountStateOf(coded("USER_NOT_ACTIVE")), "disabled");
  assert.equal(
    accountStateOf(coded("BACKEND_MODE_ADMIN_ONLY")),
    "backend-mode",
  );
  assert.equal(
    accountStateOf(Object.assign(new Error("x"), { status: 426 })),
    "upgrade-required",
  );
  // Over Electron's IPC only the main process's wording arrives.
  const deviceLimitError = new Sub2ApiError(409, "CLAUDEX_DEVICE_LIMIT", "", {
    metadata: { limit: "5" },
  });
  assert.equal(accountStateOf(signInError(deviceLimitError)), "device-limit");
  for (const [code, state] of [
    ["USER_NOT_ACTIVE", "disabled"],
    ["BACKEND_MODE_ADMIN_ONLY", "backend-mode"],
    ["CLAUDEX_UPGRADE_REQUIRED", "upgrade-required"],
  ] as const)
    assert.equal(
      accountStateOf(signInError(new Sub2ApiError(403, code, "upstream"))),
      state,
    );
  assert.equal(
    accountStateOf(signInError(new Sub2ApiError(503, "", "down"))),
    "unavailable",
  );
  // A wrong password stays next to the form.
  assert.equal(
    accountStateOf(
      signInError(new Sub2ApiError(401, "INVALID_CREDENTIALS", "")),
    ),
    undefined,
  );
  assert.equal(
    statePage("device-limit", "On 5 devices.").detail,
    "On 5 devices.",
  );
  assert.equal(
    statePage("upgrade-required", "", "desktop").action.does,
    "update",
  );
  assert.equal(statePage("upgrade-required", "", "web").action.does, "retry");
});

test("sign-in options come from the Claudex extension or the agreement documents", () => {
  assert.deepEqual(parseSignInOptions({ email_code_login: true }), {
    emailCodeLogin: true,
  });
  assert.deepEqual(
    parseSignInOptions({ email_code_login: 1, privacy_policy_url: "/legal/p" }),
    { emailCodeLogin: false, privacyPolicyUrl: "/legal/p" },
  );
  for (const url of ["http://x.test", "//evil.test", "javascript:alert(1)"])
    assert.equal(
      parseSignInOptions({ privacy_policy_url: url }).privacyPolicyUrl,
      undefined,
    );
  assert.equal(
    privacyPolicyUrl(
      { emailCodeLogin: false },
      { login_agreement_documents: [{ id: "privacy" }] },
    ),
    "/legal/privacy",
  );
  assert.equal(
    privacyPolicyUrl(
      { emailCodeLogin: false, privacyPolicyUrl: "https://p.test" },
      { login_agreement_documents: [{ id: "privacy" }] },
    ),
    "https://p.test",
  );
  assert.equal(privacyPolicyUrl({ emailCodeLogin: false }, {}), undefined);
});
