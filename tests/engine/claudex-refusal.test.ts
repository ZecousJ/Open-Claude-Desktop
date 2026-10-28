import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  describeStreamRefusal,
  describeSub2ApiRefusal,
  limitReasonOf,
  maxClaudexBodyBytes,
  refusalFollowUp,
  type GatewayRefusal,
} from "../../server/sub2api-errors";
import { Gateway } from "../../electron/engine/gateway";
import type { AppContext } from "../../electron/app/app-context";
import { currentGlobalLimit, holdGlobalLimit } from "../../electron/ipc/usage";
import { RemoteHost } from "../../electron/remote/host";
import { handleRefusal } from "../../electron/remote/host-wiring";
import { refreshRefusalReason } from "../../electron/sub2api/session";
import {
  claudexErrorCodes,
  parseRefusalDetail,
} from "../../shared/claudex-contract";

type Json = Record<string, any>;

const fixtures = fileURLToPath(
  new URL(
    "../../backend/backend/internal/claudex/contract/testdata/",
    import.meta.url,
  ),
);
function fixture(name: string): { status: number; body: Json } {
  return JSON.parse(
    fs.readFileSync(path.join(fixtures, `refusal.${name}.json`), "utf8"),
  );
}
const describe = (status: number, body: unknown, now = 0) =>
  describeSub2ApiRefusal(status, JSON.stringify(body), now);

/** A refusal the Claudex service writes: the upstream fields plus its `claudex` object. */
function refused(upstream: Json, claudex: Json) {
  return {
    ...upstream,
    claudex: { v: 1, reprovision: false, action: "none", ...claudex },
  };
}

// ---------------------------------------------------------------------------
// One case per reason of the service's decision table (design 2.7), plus the
// usage rules (2.6) and the required update (2.2).

interface Case {
  status: number;
  upstream: Json;
  claudex: Json;
  /** The banner's reason, or undefined. */
  reason: string | undefined;
  exceeded: boolean;
  invalidKey?: boolean;
  signedOut?: boolean;
}
const resets = "2026-09-29T00:00:00Z";
const cases: Record<string, Case> = {
  SUBSCRIPTION_DAILY_LIMIT: {
    status: 429,
    upstream: { code: "USAGE_LIMIT_EXCEEDED", message: "daily" },
    claudex: {
      kind: "usage_limit",
      window: "1d",
      resets_at: resets,
      action: "wait",
      message: "You've reached your daily usage limit. It resets Sep 29.",
    },
    reason: "daily",
    exceeded: true,
  },
  SUBSCRIPTION_WEEKLY_LIMIT: {
    status: 429,
    upstream: { code: "USAGE_LIMIT_EXCEEDED", message: "weekly" },
    claudex: {
      kind: "usage_limit",
      window: "7d",
      resets_at: resets,
      action: "get_more_usage",
      message: "You've reached your weekly usage limit.",
    },
    reason: "weekly",
    exceeded: true,
  },
  SUBSCRIPTION_MONTHLY_LIMIT: {
    status: 429,
    upstream: { code: "billing_error", message: "x" },
    // No window named: the reason code gives it.
    claudex: {
      kind: "usage_limit",
      action: "wait",
      message: "You've reached your monthly usage limit.",
    },
    reason: "monthly",
    exceeded: true,
  },
  SUBSCRIPTION_EXPIRED: {
    status: 403,
    upstream: { code: "SUBSCRIPTION_INVALID", message: "expired" },
    claudex: {
      kind: "subscription",
      action: "contact_admin",
      message: "Your subscription has expired. Contact your administrator.",
    },
    reason: "subscription",
    exceeded: true,
  },
  SUBSCRIPTION_SUSPENDED: {
    status: 403,
    upstream: { code: "SUBSCRIPTION_INVALID", message: "suspended" },
    claudex: {
      kind: "subscription",
      action: "contact_admin",
      message: "Your subscription is suspended. Contact your administrator.",
    },
    reason: "subscription",
    exceeded: true,
  },
  SUBSCRIPTION_NOT_FOUND: {
    status: 403,
    upstream: { code: "SUBSCRIPTION_NOT_FOUND", message: "x" },
    claudex: {
      kind: "subscription",
      action: "contact_admin",
      reprovision: true,
      message: "You don't have an active subscription for this plan.",
    },
    reason: "subscription",
    exceeded: true,
    invalidKey: true,
  },
  KEY_5H_LIMIT: {
    status: 429,
    upstream: { error: { type: "rate_limit_exceeded", message: "x" } },
    claudex: {
      kind: "key_limit",
      window: "5h",
      resets_at: resets,
      action: "wait",
      message: "This device has reached its 5-hour limit.",
    },
    reason: "key-quota",
    exceeded: true,
  },
  KEY_1D_LIMIT: {
    status: 429,
    upstream: { code: "API_KEY_RATE_1D_EXCEEDED", message: "x" },
    claudex: {
      kind: "key_limit",
      window: "1d",
      resets_at: resets,
      action: "wait",
      message: "This device has reached its daily limit.",
    },
    reason: "key-quota",
    exceeded: true,
  },
  KEY_7D_LIMIT: {
    status: 429,
    upstream: { code: "API_KEY_RATE_7D_EXCEEDED", message: "x" },
    claudex: {
      kind: "key_limit",
      window: "7d",
      resets_at: resets,
      action: "wait",
      message: "This device has reached its 7-day limit.",
    },
    reason: "key-quota",
    exceeded: true,
  },
  KEY_QUOTA_EXHAUSTED: {
    status: 429,
    upstream: { code: "API_KEY_QUOTA_EXHAUSTED", message: "x" },
    claudex: {
      kind: "key_limit",
      action: "contact_admin",
      message: "This device has used its full quota.",
    },
    reason: "key-quota",
    exceeded: true,
  },
  KEY_EXPIRED: {
    status: 403,
    upstream: { code: "API_KEY_EXPIRED", message: "x" },
    claudex: {
      kind: "key",
      reprovision: true,
      message: "This device's key has expired. Claudex will set up a new one.",
    },
    reason: undefined,
    exceeded: false,
    invalidKey: true,
  },
  DEVICE_REVOKED: {
    status: 401,
    upstream: { code: "API_KEY_DISABLED", message: "API key is disabled" },
    claudex: {
      kind: "key",
      action: "sign_in",
      message: "This device was signed out. Sign in again to keep working.",
    },
    reason: undefined,
    exceeded: false,
    signedOut: true,
  },
  KEY_DISABLED: {
    status: 401,
    upstream: { code: "API_KEY_DISABLED", message: "API key is disabled" },
    claudex: {
      kind: "key",
      reprovision: true,
      message: "This device's key is no longer active.",
    },
    reason: undefined,
    exceeded: false,
    invalidKey: true,
  },
  BALANCE_INSUFFICIENT: {
    status: 403,
    upstream: { code: "INSUFFICIENT_BALANCE", message: "x" },
    claudex: {
      kind: "balance",
      action: "get_more_usage",
      message: "Your balance is too low for this request.",
    },
    reason: "balance",
    exceeded: true,
  },
  USER_RPM_LIMIT: {
    status: 429,
    upstream: { error: { type: "rate_limit_exceeded", message: "rpm" } },
    claudex: {
      kind: "rate_limit",
      window: "1m",
      retry_after_seconds: 12,
      action: "wait",
      message: "Too many requests. Try again in 12 seconds.",
    },
    reason: undefined,
    exceeded: false,
  },
  GROUP_RPM_LIMIT: {
    status: 429,
    upstream: { error: { type: "rate_limit_exceeded", message: "rpm" } },
    claudex: {
      kind: "rate_limit",
      window: "1m",
      action: "wait",
      message: "Too many requests. Try again in a moment.",
    },
    reason: undefined,
    exceeded: false,
  },
  PLATFORM_DAILY_QUOTA: {
    status: 429,
    upstream: { code: "rate_limit_exceeded", message: "x" },
    claudex: {
      kind: "usage_limit",
      window: "1d",
      resets_at: resets,
      action: "wait",
      message: "You've reached your daily usage quota.",
    },
    reason: "daily",
    exceeded: true,
  },
  PLATFORM_WEEKLY_QUOTA: {
    status: 429,
    upstream: { code: "rate_limit_exceeded", message: "x" },
    claudex: {
      kind: "usage_limit",
      window: "7d",
      action: "wait",
      message: "You've reached your weekly usage quota.",
    },
    reason: "weekly",
    exceeded: true,
  },
  PLATFORM_MONTHLY_QUOTA: {
    status: 429,
    upstream: { code: "rate_limit_exceeded", message: "x" },
    claudex: {
      kind: "usage_limit",
      window: "30d",
      action: "wait",
      message: "You've reached your monthly usage quota.",
    },
    reason: "monthly",
    exceeded: true,
  },
  GROUP_UNAVAILABLE: {
    status: 403,
    upstream: { code: "GROUP_DISABLED", message: "x" },
    claudex: {
      kind: "group",
      reprovision: true,
      message: "This device's plan is no longer available.",
    },
    reason: undefined,
    exceeded: false,
    invalidKey: true,
  },
  USER_INACTIVE: {
    status: 403,
    upstream: { code: "USER_INACTIVE", message: "x" },
    claudex: {
      kind: "account",
      action: "contact_admin",
      message: "Your account is disabled. Contact your administrator.",
    },
    reason: undefined,
    exceeded: false,
  },
  UNKNOWN: {
    status: 403,
    upstream: { code: "SOMETHING_NEW", message: "x" },
    claudex: { kind: "unknown", message: "The request was refused." },
    reason: undefined,
    exceeded: false,
  },
  UPGRADE_REQUIRED: {
    status: 426,
    upstream: { code: "CLAUDEX_UPGRADE_REQUIRED", message: "x" },
    claudex: {
      kind: "upgrade",
      action: "update",
      minimum_version: "1.2.0",
      latest_version: "1.4.0",
      message: "This version of Claudex (1.1.0) is no longer supported.",
    },
    reason: undefined,
    exceeded: false,
  },
};

test("every reason of the service's refusal table maps to a banner reason and flags", () => {
  for (const [code, item] of Object.entries(cases)) {
    const refusal = describe(
      item.status,
      refused(item.upstream, { reason: code, ...item.claudex }),
    );
    assert.ok(refusal, code);
    assert.equal(refusal.claudex?.reason, code, code);
    assert.equal(refusal.reason, item.reason, code);
    assert.equal(refusal.exceeded, item.exceeded, code);
    assert.equal(refusal.invalidKey, item.invalidKey ?? false, code);
    assert.equal(refusal.reprovision, item.claudex.reprovision ?? false, code);
    assert.equal(refusal.signedOut, item.signedOut ?? false, code);
    assert.equal(refusal.action, item.claudex.action ?? "none", code);
    // The service's English message, as it wrote it.
    assert.equal(refusal.message, item.claudex.message, code);
    assert.equal(refusal.status, item.status, code);
  }
});

test("usage rules: session, all-models and per-model limits keep their banner meaning", () => {
  const rule = (window: string, models?: string[]) =>
    describe(
      429,
      refused(
        { code: "CLAUDEX_USAGE_LIMIT_EXCEEDED", message: "x" },
        {
          reason: "RULE_LIMIT",
          kind: "rule_limit",
          window,
          resets_at: "2026-10-02T08:00:00Z",
          action: "wait",
          message: "You've reached your session limit.",
          ...(models ? { models } : {}),
        },
      ),
    )!;
  assert.equal(rule("5h").reason, "session");
  assert.equal(rule("90m").reason, "session");
  assert.equal(rule("7d").reason, "weekly");
  assert.equal(rule("1d").reason, "daily");
  assert.equal(rule("30d").reason, "monthly");
  // An all-models rule over a window the banner cannot name.
  assert.equal(rule("3d").reason, undefined);
  assert.equal(rule("3d").exceeded, true);
  const opus = rule("7d", ["claude-opus-*"]);
  assert.equal(opus.reason, "model");
  assert.deepEqual(opus.models, ["claude-opus-*"]);
  assert.equal(rule("5h").models, undefined);

  // The fixture shared with the service's contract tests.
  const { status, body } = fixture("rule-limit");
  const fromFixture = describeSub2ApiRefusal(status, JSON.stringify(body))!;
  assert.deepEqual(
    {
      code: fromFixture.code,
      reason: fromFixture.reason,
      exceeded: fromFixture.exceeded,
      resetsAt: fromFixture.resetsAt,
      models: fromFixture.models,
      message: fromFixture.message,
    },
    {
      code: "CLAUDEX_USAGE_LIMIT_EXCEEDED",
      reason: "model",
      exceeded: true,
      resetsAt: Date.parse("2026-10-02T08:00:00Z"),
      models: ["claude-opus-*"],
      message: "You've reached the Opus limit. It resets Oct 2, 8:00 AM UTC.",
    },
  );
});

test("limitReasonOf covers every kind without a lasting limit", () => {
  const detail = (kind: string, window?: string) =>
    parseRefusalDetail({ v: 1, reason: "X", kind, window });
  for (const kind of [
    "rate_limit",
    "key",
    "group",
    "account",
    "upgrade",
    "unknown",
  ])
    assert.equal(limitReasonOf(detail(kind, "7d")), undefined, kind);
  assert.equal(limitReasonOf(detail("usage_limit")), undefined);
});

test("shared fixtures: each maps as the service means it", () => {
  const weekly = fixture("subscription-weekly-limit");
  const refusal = describeSub2ApiRefusal(
    weekly.status,
    JSON.stringify(weekly.body),
  )!;
  assert.equal(refusal.reason, "weekly");
  assert.equal(refusal.exceeded, true);
  assert.equal(refusal.resetsAt, Date.parse("2026-09-29T00:00:00Z"));
  assert.equal(refusal.action, "get_more_usage");
  assert.equal(refusal.code, "USAGE_LIMIT_EXCEEDED");

  const quota = fixture("key-quota-exhausted");
  const key = describeSub2ApiRefusal(quota.status, JSON.stringify(quota.body))!;
  // The OpenAI-shaped body keeps its upstream code; the message is the service's English one.
  assert.equal(key.code, "INSUFFICIENT_QUOTA");
  assert.equal(key.reason, "key-quota");
  assert.equal(
    key.message,
    "This device has used its full quota. Contact your administrator.",
  );

  const revoked = fixture("device-revoked");
  const signedOut = describeSub2ApiRefusal(
    revoked.status,
    JSON.stringify(revoked.body),
  )!;
  // The older mapping read this body as a disabled key with no follow-up.
  assert.equal(signedOut.signedOut, true);
  assert.equal(signedOut.invalidKey, false);
  assert.deepEqual(refusalFollowUp(signedOut), {
    reprovision: false,
    signOut: true,
    refreshRelease: false,
  });
});

test("a required update refreshes the release information and never carries the refusal's download address", () => {
  const { status, body } = fixture("upgrade-required");
  assert.match(JSON.stringify(body), /dl\.example\.com/);
  const refusal = describeSub2ApiRefusal(status, JSON.stringify(body))!;
  assert.equal(refusal.status, 426);
  assert.equal(refusal.action, "update");
  assert.equal(refusal.claudex?.minimumVersion, "1.2.0");
  assert.equal(
    refusal.message,
    "This version of Claudex (1.1.0) is no longer supported. Update to 1.4.0 to keep working.",
  );
  assert.doesNotMatch(JSON.stringify(refusal), /dl\.example\.com|download/i);
  assert.deepEqual(refusalFollowUp(refusal), {
    reprovision: false,
    signOut: false,
    refreshRelease: true,
  });
  // A re-issued key is the only follow-up of a disabled key.
  const disabled = describe(
    401,
    refused(
      { code: "API_KEY_DISABLED", message: "x" },
      { reason: "KEY_DISABLED", kind: "key", reprovision: true, message: "m" },
    ),
  )!;
  assert.deepEqual(refusalFollowUp(disabled), {
    reprovision: true,
    signOut: false,
    refreshRelease: false,
  });
});

test("a claudex object is ignored outside the five refusal statuses, in other versions and in bodies over 64 KB", () => {
  const detail = {
    reason: "DEVICE_REVOKED",
    kind: "key",
    action: "sign_in",
    message: "This device was signed out.",
  };
  // 400 and 500 answers: the older mapping, or nothing.
  assert.equal(
    describe(400, refused({ code: "BAD_REQUEST", message: "x" }, detail)),
    undefined,
  );
  assert.equal(
    describe(500, refused({ code: "UPSTREAM", message: "x" }, detail)),
    undefined,
  );
  const legacy = describe(
    500,
    refused({ code: "INSUFFICIENT_BALANCE", message: "x" }, detail),
  )!;
  assert.equal(legacy.claudex, undefined);
  assert.equal(legacy.signedOut, undefined);
  assert.equal(legacy.reason, "balance");
  // Another version is not read.
  const v2 = describe(401, {
    code: "API_KEY_DISABLED",
    message: "API key is disabled",
    claudex: { ...detail, v: 2 },
  })!;
  assert.equal(v2.claudex, undefined);
  assert.equal(v2.signedOut, undefined);

  // Exactly at the limit it is read; one byte over, the older mapping decides.
  const base = JSON.stringify(
    refused(
      { code: "API_KEY_DISABLED", message: "API key is disabled" },
      detail,
    ),
  );
  const padded = (bytes: number) =>
    base.replace(
      '"message":"API key is disabled"',
      `"message":"API key is disabled","pad":"${"x".repeat(bytes - base.length - 9)}"`,
    );
  assert.equal(
    Buffer.byteLength(padded(maxClaudexBodyBytes)),
    maxClaudexBodyBytes,
  );
  assert.equal(
    describeSub2ApiRefusal(401, padded(maxClaudexBodyBytes))?.signedOut,
    true,
  );
  const over = describeSub2ApiRefusal(401, padded(maxClaudexBodyBytes + 1))!;
  assert.equal(over.claudex, undefined);
  assert.equal(over.signedOut, undefined);
  assert.match(over.message, /disabled/);
  // Counted in bytes, not characters.
  const wide = base.replace(
    '"message":"API key is disabled"',
    `"message":"${"额".repeat(maxClaudexBodyBytes / 3)}"`,
  );
  assert(wide.length < maxClaudexBodyBytes);
  assert.equal(describeSub2ApiRefusal(401, wide)?.claudex, undefined);
});

test("reset times come from resets_at, else from the seconds to wait", () => {
  const at = (claudex: Json) =>
    describe(
      429,
      refused(
        { code: "x" },
        {
          reason: "USER_RPM_LIMIT",
          kind: "rate_limit",
          message: "m",
          ...claudex,
        },
      ),
      1_000_000,
    )!.resetsAt;
  assert.equal(at({ retry_after_seconds: 12 }), 1_012_000);
  assert.equal(
    at({ retry_after_seconds: 12, resets_at: resets }),
    Date.parse(resets),
  );
  assert.equal(at({}), undefined);
});

test("the service's message is kept to one printable line; an empty one falls back", () => {
  const message = (text: string, upstream: Json = { code: "x" }) =>
    describe(
      403,
      refused(upstream, {
        reason: "BALANCE_INSUFFICIENT",
        kind: "balance",
        message: text,
      }),
    )!.message;
  assert.equal(message("Low\nbalance\u0007 "), "Low balance");
  // The older wording when the service gave none.
  assert.equal(
    message("", { code: "INSUFFICIENT_BALANCE" }),
    "Your Claudex balance is used up. Add funds to keep going.",
  );
  assert.equal(message(""), "The Claudex service refused this request.");
});

test("an older service's refusals map exactly as before", () => {
  // Without a claudex object nothing new appears on the refusal.
  const old = describe(429, {
    code: "USAGE_LIMIT_EXCEEDED",
    message: "weekly usage limit exceeded",
  })!;
  assert.deepEqual(old, {
    status: 429,
    code: "USAGE_LIMIT_EXCEEDED",
    reason: "weekly",
    exceeded: true,
    invalidKey: false,
    message:
      "You’ve reached your plan’s weekly usage limit. Requests resume when the weekly window resets.",
  });
  // A stream that fails mid-reply is read by the older mapping only.
  assert.equal(
    describeStreamRefusal({
      code: "rate_limit_exceeded",
      message: "x",
      claudex: { v: 1, reason: "DEVICE_REVOKED", kind: "key" },
    }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Through the gateway: the refusal Codex sees and the one the app receives.

async function service(
  t: TestContext,
  reply: { status: number; body: string; headers?: Record<string, string> },
) {
  const server = http.createServer((_req, res) => {
    res.writeHead(reply.status, {
      "content-type": "application/json",
      ...reply.headers,
    });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
async function send(t: TestContext, baseUrl: string) {
  const refusals: GatewayRefusal[] = [];
  const bridge = new Gateway(
    () => ({
      provider: {
        id: "sub2api",
        name: "Claudex",
        model: "claude-opus-4",
        models: [],
        baseUrl,
        protocol: "responses",
        backend: "sub2api",
      },
      apiKey: "device-key-secret",
    }),
    undefined,
    undefined,
    undefined,
    (refusal) => refusals.push(refusal),
  );
  await bridge.start();
  t.after(() => bridge.close());
  const response = await fetch(`${bridge.url}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify({ model: "claude-opus-4", input: "hello" }),
  });
  return { response, refusals };
}

test("the gateway hands the structured refusal on and answers Codex in the service's words", async (t) => {
  const { status, body } = fixture("rule-limit");
  const { response, refusals } = await send(
    t,
    await service(t, { status, body: JSON.stringify(body) }),
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    error: {
      message: "You've reached the Opus limit. It resets Oct 2, 8:00 AM UTC.",
      code: "CLAUDEX_USAGE_LIMIT_EXCEEDED",
    },
  });
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].reason, "model");
  assert.deepEqual(refusals[0].models, ["claude-opus-*"]);
  assert.equal(refusals[0].claudex?.ruleId, 5);
});

test("the gateway ignores a claudex object in an error body over 64 KB", async (t) => {
  const body = JSON.stringify({
    code: "API_KEY_DISABLED",
    message: "API key is disabled",
    pad: "x".repeat(maxClaudexBodyBytes),
    claudex: {
      v: 1,
      reason: "DEVICE_REVOKED",
      kind: "key",
      reprovision: false,
      action: "sign_in",
      message: "This device was signed out.",
    },
  });
  const { response, refusals } = await send(
    t,
    await service(t, { status: 401, body }),
  );
  assert.equal(response.status, 401);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].claudex, undefined);
  assert.equal(refusals[0].signedOut, undefined);
  assert.equal(refusals[0].code, "API_KEY_DISABLED");
});

// ---------------------------------------------------------------------------
// R13-B: the follow-up the main process acts on.

test("the rule kind the service names decides a rule refusal's banner reason", () => {
  const { status, body } = fixture("usage-limit");
  const refusal = describeSub2ApiRefusal(status, JSON.stringify(body))!;
  assert.equal(refusal.claudex?.ruleKind, "session");
  assert.equal(refusal.reason, "session");
  // A 5-hour session refuses every model: the window's corner notice too.
  assert.equal(refusalFollowUp(refusal).globalLimit, "session");
  const rule = (claudex: Json) =>
    limitReasonOf(
      parseRefusalDetail({
        v: 1,
        reason: "RULE_LIMIT",
        kind: "rule_limit",
        reprovision: false,
        action: "wait",
        message: "m",
        ...claudex,
      }),
    );
  // The kind wins over what the window and models would suggest.
  assert.equal(rule({ rule_kind: "models", window: "7d" }), "model");
  assert.equal(rule({ rule_kind: "all_models", window: "7d" }), "weekly");
  assert.equal(
    rule({ rule_kind: "all_models", window: "5h", models: ["x"] }),
    undefined,
  );
  assert.equal(rule({ rule_kind: "session", window: "7d" }), "session");
  // Without it (older services) the models and window still tell.
  assert.equal(rule({ window: "5h" }), "session");
  assert.equal(rule({ models: ["claude-opus-*"], window: "7d" }), "model");
  // A malformed kind is dropped.
  assert.equal(
    parseRefusalDetail({
      v: 1,
      reason: "RULE_LIMIT",
      kind: "rule_limit",
      rule_kind: "Session Limit!",
    }).ruleKind,
    undefined,
  );
});

test("the corner notice is for the session and rate limits only", () => {
  const rate = describe(
    429,
    refused(
      { code: "RATE_LIMITED", message: "slow down" },
      {
        reason: "RATE_LIMITED",
        kind: "rate_limit",
        retry_after_seconds: 30,
        action: "wait",
        message: "Too many requests.",
      },
    ),
    1_000,
  )!;
  assert.equal(rate.resetsAt, 31_000);
  assert.equal(refusalFollowUp(rate).globalLimit, "rate-limit");
  const weekly = fixture("subscription-weekly-limit");
  assert.equal(
    refusalFollowUp(
      describeSub2ApiRefusal(weekly.status, JSON.stringify(weekly.body))!,
    ).globalLimit,
    undefined,
  );
  const model = fixture("rule-limit");
  assert.equal(
    refusalFollowUp(
      describeSub2ApiRefusal(model.status, JSON.stringify(model.body))!,
    ).globalLimit,
    undefined,
  );
  // An older service's 429 is not explained: no corner notice.
  const legacy = describe(429, { code: "RATE_LIMITED", message: "x" })!;
  assert.equal(refusalFollowUp(legacy, false).globalLimit, undefined);
});

test("an older service's refusal is not acted on beyond re-issuing a refused key", () => {
  const revoked = fixture("device-revoked");
  const refusal = describeSub2ApiRefusal(
    revoked.status,
    JSON.stringify(revoked.body),
  )!;
  // The same body from a service without the Claudex module.
  assert.deepEqual(refusalFollowUp(refusal, false), {
    reprovision: false,
    signOut: false,
    refreshRelease: false,
  });
  const upgrade = fixture("upgrade-required");
  assert.equal(
    refusalFollowUp(
      describeSub2ApiRefusal(upgrade.status, JSON.stringify(upgrade.body))!,
      false,
    ).refreshRelease,
    false,
  );
  const invalid = describe(401, { code: "INVALID_API_KEY", message: "x" })!;
  assert.equal(refusalFollowUp(invalid, false).reprovision, true);
  // A bare 426 from a Claudex service still reads the release again.
  assert.equal(
    refusalFollowUp({
      status: 426,
      code: "UPGRADE_REQUIRED",
      exceeded: false,
      invalidKey: false,
      message: "Update Claudex.",
    }).refreshRelease,
    true,
  );
});

test("the request id comes from the answer's header, checked", () => {
  const { status, body } = fixture("rule-limit");
  const text = JSON.stringify(body);
  assert.equal(
    describeSub2ApiRefusal(status, text, 0, "0f0e-11aa")?.requestId,
    "0f0e-11aa",
  );
  assert.equal(
    describeSub2ApiRefusal(status, text, 0, "bad id\nwith lines")?.requestId,
    undefined,
  );
  assert.equal(describeSub2ApiRefusal(status, text, 0)?.requestId, undefined);
});

test("the gateway passes the service's request id on with the refusal", async (t) => {
  const { status, body } = fixture("rule-limit");
  const { refusals } = await send(
    t,
    await service(t, {
      status,
      body: JSON.stringify(body),
      headers: {
        "X-Client-Request-ID": "3b8c2f7e-6a51-4c1e-9d2a-0f3e9b7c1a55",
      },
    }),
  );
  assert.equal(refusals[0].requestId, "3b8c2f7e-6a51-4c1e-9d2a-0f3e9b7c1a55");
});

// ---------------------------------------------------------------------------
// R13-B: the remote host's handling (426 reads the release once in 30 s).

function hostWith(members: Record<string, unknown>) {
  return new Proxy(members, {
    get: (target, key) =>
      key in target
        ? target[key as string]
        : () => {
            throw Error(`AppContext.${String(key)} is not faked`);
          },
  }) as unknown as AppContext;
}

test("a 426 reads the bootstrap's release again, once however many requests fail", async () => {
  let reads = 0;
  let policies = 0;
  const members: Record<string, unknown> = {
    refreshPolicy: () => void policies++,
    push: () => {},
    activeAccount: undefined,
  };
  const backend = {
    kind: "claudex",
    bootstrap: { refresh: async () => void reads++ },
    recordRefusal: () => {},
  };
  const host = new RemoteHost(hostWith(members), backend as never);
  members.remote = host;
  const { status, body } = fixture("upgrade-required");
  const refusal = describeSub2ApiRefusal(status, JSON.stringify(body))!;
  for (let i = 0; i < 3; i++) handleRefusal(hostWith(members), refusal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  // Once for each refusal, and once more after the release was read.
  assert.equal(policies, 4);
  // Thirty seconds later the next refusal reads it again.
  assert.equal(host.refreshRelease(Date.now() + 30_001), true);
  assert.equal(host.refreshRelease(Date.now() + 30_002), false);
});

test("a session limit holds the corner notice until its reset; a rate limit a minute", () => {
  const host = {} as RemoteHost;
  const now = 1_000_000;
  holdGlobalLimit(host, "session", { resetsAt: now + 60_000 }, now);
  assert.deepEqual(currentGlobalLimit(host, now + 1), {
    kind: "session",
    resetsAt: now + 60_000,
  });
  assert.equal(currentGlobalLimit(host, now + 60_000), undefined);
  // Without a reset time a rate limit holds a minute.
  holdGlobalLimit(host, "rate-limit", {}, now);
  assert.deepEqual(currentGlobalLimit(host, now + 59_000), {
    kind: "rate-limit",
    resetsAt: null,
  });
  assert.equal(currentGlobalLimit(host, now + 60_001), undefined);
});

test("a changed password signs the device out with its own reason", () => {
  assert.equal(refreshRefusalReason("TOKEN_REVOKED"), "password-changed");
  assert.equal(
    refreshRefusalReason(claudexErrorCodes.sessionRevoked),
    "revoked",
  );
  for (const code of [
    "REFRESH_TOKEN_INVALID",
    "REFRESH_TOKEN_EXPIRED",
    "REFRESH_TOKEN_REUSED",
    "",
  ])
    assert.equal(refreshRefusalReason(code), "session-expired");
});
