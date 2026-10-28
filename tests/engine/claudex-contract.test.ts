import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  checkoutLinkBody,
  claudexHeaders,
  ContractError,
  deviceRegistrationBody,
  diagnosticsBody,
  envelopeData,
  feedbackBody,
  gatewayRefusalDetails,
  parseBootstrap,
  parseCheckoutLink,
  parseCheckoutSession,
  parseDeviceList,
  parseDeviceRegistration,
  parseDeviceRevoked,
  parseDiagnosticsAccepted,
  parseFeedbackAccepted,
  parseModelCatalog,
  parsePolicy,
  parseRefusal,
  parseRefusalDetail,
  parseRelease,
  parseUsageStatus,
  parseVoice,
  parseWebConsole,
  parseWebSessionList,
  parseWebSessionRevoked,
  refusalStatuses,
  type ClaudexRefusal,
} from "../../shared/claudex-contract";
import {
  claudexClientInfo,
  errorFromResponse,
  metadataNumber,
  requestJson,
  requestJsonResult,
  retryAfterSeconds,
  Sub2ApiError,
} from "../../electron/sub2api/http";
import { Sub2ApiClient } from "../../electron/sub2api/client";
import { Gateway } from "../../electron/engine/gateway";
import { ProviderServiceClient } from "../../electron/engine/provider-service-client";
import type { GatewayRefusal } from "../../server/sub2api-errors";
import type { Provider } from "../../shared/types";
import { connectorAllowed } from "../../shared/client-policy-rules";
import {
  failCode,
  MemoryBootstrapSource,
  MockSub2Api,
  mockBootstrapSource,
  ok,
  type MockOptions,
} from "../support/sub2api-mock";

type Json = Record<string, any>;
const fixtureDir = fileURLToPath(
  new URL(
    "../../backend/backend/internal/claudex/contract/testdata/",
    import.meta.url,
  ),
);
const fixture = (name: string): Json =>
  JSON.parse(fs.readFileSync(path.join(fixtureDir, `${name}.json`), "utf8"));
const data = (name: string): Json => envelopeData(fixture(name)) as Json;
const clone = <T>(value: T): T => structuredClone(value);
/** A copy of `value` without the field at `at`. */
function without(value: Json, at: (string | number)[]) {
  const copy = clone(value);
  let target: any = copy;
  for (const key of at.slice(0, -1)) target = target[key];
  delete target[at.at(-1)!];
  return copy;
}
/** The smallest bootstrap the parser accepts, for section fixtures. */
const minimalBootstrap = {
  schema_version: 1,
  server: { site_name: "Claudex", version: "0.2.8", timezone: "UTC" },
  features: {},
  errors: [],
};

// ---------------------------------------------------------------------------
// Fixtures

/** How each fixture is checked; every file in testdata must be listed. */
const fixtureChecks: Record<string, (name: string) => void> = {
  "web-console.": (name) => parseWebConsole(data(name)),
  "release.": (name) => parseRelease(data(name)),
  "policy.group": (name) => parsePolicy(data(name)),
  "models.group": (name) => parseModelCatalog(data(name)),
  "devices.registered": (name) => parseDeviceRegistration(data(name)),
  "devices.list": (name) => parseDeviceList(data(name)),
  "devices.revoked": (name) => parseDeviceRevoked(data(name)),
  "web-sessions.list": (name) => parseWebSessionList(data(name)),
  "web-sessions.revoked": (name) => parseWebSessionRevoked(data(name)),
  "usage-status.": (name) => parseUsageStatus(data(name)),
  "bootstrap.": (name) => parseBootstrap(data(name)),
  "section.": (name) =>
    parseBootstrap({ ...minimalBootstrap, ...fixture(name) }),
  "diagnostics.accepted": (name) => parseDiagnosticsAccepted(data(name)),
  "feedback.accepted": (name) => parseFeedbackAccepted(data(name)),
  "feedback.excerpt-dropped": (name) => parseFeedbackAccepted(data(name)),
  "payment-checkout-links.created": (name) => parseCheckoutLink(data(name)),
  "payment-checkout.": (name) => parseCheckoutSession(data(name)),
  "refusal.": (name) => {
    const { status, body } = fixture(name);
    assert(parseRefusal(status, body), `${name} explains the refusal`);
  },
  "devices.register-request": (name) =>
    assert.deepEqual(
      deviceRegistrationBody({
        deviceName: "Ada's MacBook Pro",
        platform: "darwin",
        arch: "arm64",
        appVersion: "1.3.2",
      }),
      fixture(name),
    ),
  "diagnostics.request": (name) => {
    const [report] = fixture(name).reports;
    assert.deepEqual(
      diagnosticsBody([
        {
          id: report.id,
          occurredAt: Date.parse(report.occurred_at),
          kind: report.kind,
          code: report.code,
          message: report.message,
          requestId: report.request_id,
          model: report.model,
          appVersion: report.app_version,
          codexVersion: report.codex_version,
          platform: report.platform,
          arch: report.arch,
          osVersion: report.os_version,
          context: report.context,
        },
      ]),
      fixture(name),
    );
  },
  "feedback.request": (name) => {
    const value = fixture(name);
    assert.deepEqual(
      feedbackBody({
        id: value.id,
        rating: value.rating,
        categories: value.categories,
        comment: value.comment,
        model: value.model,
        requestId: value.request_id,
        conversationExcerpt: null,
        appVersion: value.app_version,
        platform: value.platform,
      }),
      value,
    );
  },
  "payment-checkout-links.request": (name) =>
    assert.deepEqual(
      checkoutLinkBody({
        orderId: 1024,
        resumeToken: "eyJvcmRlcl9pZCI6MTAyNH0.c2lnbmF0dXJl",
        clientSecret: "pi_3QabcDEF_secret_ghiJKL",
        currency: "USD",
      }),
      fixture(name),
    ),
  // Administrator settings and endpoints: I1 reads them; they only need to be JSON here.
  "setting.": (name) => assert(fixture(name)),
  "admin-": (name) => assert(fixture(name)),
};
const errorFixture = /-error$/;

test("every contract fixture is classified and accepted by its parser", () => {
  const names = fs
    .readdirSync(fixtureDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -5))
    .sort();
  assert(names.length >= 40, "the fixtures are present");
  for (const name of names) {
    if (errorFixture.test(name)) {
      const { status, body } = fixture(name);
      const error = errorFromResponse(status, body);
      assert.equal(error.status, status, name);
      assert.equal(error.code, body.reason ?? body.code, name);
      continue;
    }
    const check = Object.entries(fixtureChecks).find(([prefix]) =>
      name.startsWith(prefix),
    )?.[1];
    assert(check, `${name}.json is not classified in fixtureChecks`);
    check(name);
  }
});

test("workflow default-on entitlement is independent of availability and plan labels", () => {
  assert.equal(
    parsePolicy({ ...data("policy.group"), workflows_default_on: false })
      .workflowsDefaultOn,
    false,
  );
  assert.equal(
    parsePolicy({ ...data("policy.group"), workflows_default_on: true })
      .workflowsDefaultOn,
    true,
  );
  assert.equal(parsePolicy(data("policy.group")).workflowsDefaultOn, undefined);
});

test("the policy fixture becomes the client's policy, Bypass never among the modes", () => {
  assert.deepEqual(parsePolicy(data("policy.group")), {
    revision: 17,
    groupId: 4,
    permissionModes: ["auto", "manual", "acceptEdits", "plan"],
    incognito: true,
    webSearch: true,
    webSearchDefault: false,
    workflows: true,
    workflowApprovalRequired: false,
    voice: true,
    localMcpEditing: true,
    remoteImages: true,
    remoteImageDomains: null,
    externalLinks: true,
    // Developer Mode is allowed unless the service turns it off.
    developerModeEnabled: true,
    desktopExtensionsEnabled: true,
    developerMcpEnabled: true,
    trustedLinkDomains: [],
    connectors: [
      { name: "github", urlPrefix: "https://api.githubcopilot.com/mcp" },
      { name: "linear" },
      {
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/shared"],
      },
    ],
    attachments: {
      maxBytes: 10485760,
      types: [
        "png",
        "jpg",
        "jpeg",
        "webp",
        "gif",
        "txt",
        "md",
        "csv",
        "ts",
        "py",
        "json",
      ],
    },
    links: {
      help: "https://docs.example.com",
      getMoreUsage: "https://claudex.example.com/plans",
      learnMore: [
        { label: "Usage policy", url: "https://claudex.example.com/policy" },
      ],
    },
    usageBanner: { warnPercent: 80 },
    planLabel: "Max",
    scheduledTasks: { enabled: true, maxTasks: null },
    approvalsAlwaysAllow: true,
    memory: {
      enabled: true,
      searchChats: true,
      generate: true,
      defaultOn: false,
      model: null,
    },
    research: { enabled: true, xSearch: true, maxSearchesPerTurn: 30 },
    browser: {
      enabled: true,
      externalSites: true,
      allowScript: true,
      devServers: true,
      blockedDomains: ["mail.example.com"],
    },
    sshRemote: true,
    codexRuntimeMirror: "https://registry.npmmirror.com/",
    computerUse: {
      enabled: false,
      allowFullControl: true,
      deniedApps: ["com.apple.Terminal"],
      maxActionsPerTurn: null,
    },
  });
  const hostile = {
    ...data("policy.group"),
    permission_modes: ["bypass", "plan", "future-mode"],
    connectors: [
      { name: "a", url_prefix: "http://insecure.example/mcp" },
      { name: "bad name!" },
      "linear",
      { name: "tool", command: "npx tool" },
      { name: "loose", args: ["-y", "pkg"] },
      { name: "odd", command: "npx", args: ["-y", 7] },
      { name: "bare", command: "node", args: [] },
    ],
    links: {
      ...data("policy.group").links,
      help: "http://docs.example.com",
      apps: "javascript:alert(1)",
      learn_more: [
        { label: "Fine", url: "https://ok.example" },
        { label: "Plain", url: "http://plain.example" },
      ],
    },
    trusted_link_domains: ["docs.example.com", "*.example.org", "Bad Host", 7],
    remote_image_domains: ["images.example.com", "https://not-a-host"],
    usage_banner: { warn_percent: 150 },
  };
  const policy = parsePolicy(hostile);
  assert.deepEqual(policy.permissionModes, ["plan"]);
  assert.deepEqual(policy.connectors, [
    { name: "linear" },
    { name: "tool", command: "npx tool" },
    { name: "bare", command: "node" },
  ]);
  // A rule with arguments allows exactly that program started that way.
  const withArgs = parsePolicy(data("policy.group"));
  const server = {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/shared"],
  };
  assert.equal(connectorAllowed(withArgs, "filesystem", server), true);
  assert.equal(
    connectorAllowed(withArgs, "filesystem", { ...server, args: ["-y"] }),
    false,
  );
  assert.equal(
    connectorAllowed(withArgs, "filesystem", { command: "npx" }),
    false,
  );
  assert.equal(policy.links.help, undefined);
  assert.equal(policy.links.apps, undefined);
  assert.deepEqual(policy.links.learnMore, [
    { label: "Fine", url: "https://ok.example" },
  ]);
  assert.deepEqual(policy.trustedLinkDomains, [
    "docs.example.com",
    "*.example.org",
  ]);
  assert.deepEqual(policy.remoteImageDomains, ["images.example.com"]);
  assert.equal(policy.usageBanner.warnPercent, 99);
});

test("the round-2 policy blocks are optional, complete when sent, and never loosen", () => {
  // An older service sends none of them: the policy still applies, and the
  // client reads each absence on its own terms (see client-policy.test.ts).
  const {
    memory: _memory,
    research: _research,
    browser: _browser,
    ssh_remote: _ssh,
    codex_runtime_mirror: _mirror,
    computer_use: _computerUse,
    ...older
  } = data("policy.group");
  const parsed = parsePolicy(older);
  for (const key of [
    "memory",
    "research",
    "browser",
    "sshRemote",
    "codexRuntimeMirror",
    "computerUse",
  ])
    assert.equal(key in parsed, false, key);

  // A block that is sent must be complete, like every other policy field.
  assert.throws(
    () => parsePolicy({ ...data("policy.group"), memory: { enabled: true } }),
    ContractError,
  );
  assert.throws(
    () =>
      parsePolicy({
        ...data("policy.group"),
        computer_use: { enabled: "yes" },
      }),
    ContractError,
  );

  const policy = parsePolicy({
    ...data("policy.group"),
    web_search: false,
    memory: {
      enabled: false,
      search_chats: true,
      generate: true,
      default_on: true,
      model: "gpt-5.5-mini",
    },
    research: { enabled: true, x_search: true, max_searches_per_turn: 5000 },
    browser: {
      enabled: true,
      external_sites: false,
      allow_script: false,
      dev_servers: false,
      blocked_domains: [
        "mail.example.com",
        "https://bad/",
        7,
        "*.bank.example",
      ],
    },
    ssh_remote: false,
    codex_runtime_mirror: "http://mirror.example.com/",
    computer_use: {
      enabled: true,
      allow_full_control: false,
      denied_apps: [" com.apple.Terminal ", "rm -rf /;", "cmd.exe"],
      max_actions_per_turn: 5000,
    },
  });
  // Memory off turns its switches off; web search off turns Research off.
  assert.deepEqual(policy.memory, {
    enabled: false,
    searchChats: false,
    generate: false,
    defaultOn: false,
    model: "gpt-5.5-mini",
  });
  assert.deepEqual(policy.research, {
    enabled: false,
    xSearch: false,
    maxSearchesPerTurn: 200,
  });
  assert.deepEqual(policy.browser, {
    enabled: true,
    externalSites: false,
    allowScript: false,
    devServers: false,
    blockedDomains: ["mail.example.com", "*.bank.example"],
  });
  assert.equal(policy.sshRemote, false);
  assert.equal(policy.codexRuntimeMirror, null, "only an https mirror is used");
  assert.deepEqual(policy.computerUse, {
    enabled: true,
    allowFullControl: false,
    deniedApps: ["com.apple.Terminal", "cmd.exe"],
    maxActionsPerTurn: 1000,
  });
});

test("catalog, registration, usage, release and checkout fixtures map field by field", () => {
  const catalog = parseModelCatalog(data("models.group"));
  assert.equal(catalog.defaultModel, "gpt-5.5");
  assert.deepEqual(catalog.items[0], {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Our smartest model for complex work",
    badges: ["new"],
    sort: 10,
    hidden: false,
    isDefault: true,
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    contextWindow: 400000,
    autoCompactTokens: 320000,
    usageHint: "1.5× usage",
    webSearch: "native",
    xSearch: false,
    groupId: 4,
  });
  assert.equal(catalog.items[1].autoCompactTokens, undefined);
  // A model without efforts, context or name (B3 omits efforts when not configured).
  const bare = parseModelCatalog({
    group_id: null,
    default_model: null,
    items: [{ id: "gpt-4.1", hidden: true, badges: ["legacy", "!!"] }],
  });
  assert.deepEqual(bare.items[0], {
    id: "gpt-4.1",
    displayName: "gpt-4.1",
    description: "",
    badges: ["legacy"],
    sort: 0,
    hidden: true,
    isDefault: false,
    usageHint: "",
  });
  // An older service's fast flag is ignored (R6); search capabilities this
  // build does not know read as none, and X search needs native web search.
  const searches = parseModelCatalog({
    group_id: 4,
    default_model: null,
    items: [
      { id: "old", fast: true },
      { id: "grok-4", web_search: "native", x_search: true },
      { id: "future", web_search: "hosted", x_search: true },
    ],
  });
  assert.equal("fast" in searches.items[0], false);
  assert.equal(searches.items[0].webSearch, undefined);
  assert.deepEqual(
    searches.items.slice(1).map((entry) => [entry.webSearch, entry.xSearch]),
    [
      ["native", true],
      ["none", false],
    ],
  );

  const registration = parseDeviceRegistration(data("devices.registered"));
  assert.equal(registration.apiKey?.id, 812);
  assert.match(registration.apiKey?.key, /^sk-9c1[0-9a-f]{61}$/);
  // MG: one key per group, the plan group's first.
  assert.deepEqual(
    registration.apiKeys.map((key) => [
      key.id,
      key.groupId,
      key.groupName,
      key.platform,
      key.protocol,
      key.primary,
    ]),
    [
      [812, 4, "claudex-pro", "openai", "responses", true],
      [813, 11, "claudex-grok", "grok", "chat", false],
    ],
  );
  assert.equal(registration.apiKeys[0].key, registration.apiKey?.key);
  // A service before MG sends api_key alone.
  const single = data("devices.registered");
  delete single.api_keys;
  assert.deepEqual(parseDeviceRegistration(single).apiKeys, []);
  // An account without a plan group signs in with no key (balance only).
  const planless = data("devices.registered");
  planless.api_key = null;
  planless.api_keys = [];
  planless.plan = null;
  const none = parseDeviceRegistration(planless);
  assert.equal(none.apiKey, null);
  assert.deepEqual(none.apiKeys, []);
  assert.equal(none.plan, null);
  assert.equal(registration.moved, true);
  assert.equal(
    registration.device.createdAt,
    Date.parse("2026-09-26T02:10:00Z"),
  );
  assert.deepEqual(registration.plan, {
    groupId: 4,
    groupName: "claudex-pro",
    platform: "openai",
    protocol: "responses",
    subscriptionType: "subscription",
    subscriptionId: 77,
    expiresAt: Date.parse("2026-10-25T00:00:00Z"),
    subscribed: true,
  });

  const usage = parseUsageStatus(data("usage-status.plan"));
  assert.deepEqual(
    usage.windows.map((item) => [item.kind, item.label, item.percent]),
    [
      ["session", "Current session", 24],
      ["all_models", "All models", 30],
      ["models", "Opus", 0],
      ["daily", "Daily", 20],
      ["key", "This device · 5 hours", 25],
    ],
  );
  assert.equal(usage.windows[0].resetsAt, Date.parse("2026-09-26T06:00:00Z"));
  assert.equal(usage.windows[2].resetsAt, null);
  assert.deepEqual(usage.windows[2].models, ["claude-opus-*"]);
  assert.deepEqual(usage.balance, { balanceUsd: 12.34 });
  // A window of a kind this build does not know is left out.
  const future = data("usage-status.plan");
  future.windows.push({ ...future.windows[0], id: "x", kind: "hourly" });
  assert.equal(parseUsageStatus(future).windows.length, 5);

  const release = parseRelease(data("release.available"));
  assert.equal(release.apiVersion, 1);
  assert.deepEqual(release.server, {
    version: "0.2.8+claudex.1",
    buildType: "source",
  });
  assert.equal(release.state, "available");
  assert.equal(
    release.downloadUrl,
    "https://dl.example.com/Claudex-1.4.0-arm64.zip",
  );
  assert.equal(release.publishedAt, Date.parse("2026-09-20T08:00:00Z"));
  const unconfigured = parseRelease(data("release.unconfigured"));
  assert.equal(unconfigured.state, "unknown");
  assert.equal(unconfigured.downloadUrl, null);
  const hostileRelease = parseRelease({
    ...data("release.available"),
    state: "brand-new",
    download_url: "file:///Applications/Evil.app",
    sha256: "not-hex",
  });
  assert.equal(hostileRelease.state, "unknown");
  assert.equal(hostileRelease.downloadUrl, null);
  assert.equal(hostileRelease.sha256, null);

  assert.deepEqual(parseCheckoutLink(data("payment-checkout-links.created")), {
    token: "q2hX4v9LmN0pQrStUvWxYz1234567890abcdefABCDE",
    expiresAt: Date.parse("2026-09-26T02:40:00Z"),
  });
  const paid = parseCheckoutSession(data("payment-checkout.paid"));
  assert.equal(paid.stripe, null);
  assert.equal(
    parseCheckoutSession(data("payment-checkout.airwallex")).airwallex
      ?.intentId,
    "int_hkdmr7v4f2",
  );
  // The realtime section (owner decision 18): max_session_seconds is the
  // session limit; protocol, path, audio and idle timeout are not needed.
  assert.deepEqual(parseVoice(fixture("section.voice").voice), {
    transcription: {
      enabled: true,
      model: null,
      maxBytes: 19200000,
      maxSeconds: 600,
    },
    available: { transcription: true },
  });
  // Turned off, the service sends zero limits: no limits, not "0 seconds".
  assert.deepEqual(
    parseVoice({
      transcription: {
        enabled: false,
        protocol: "websocket",
        path: null,
        audio: null,
        max_session_seconds: 0,
        max_bytes: 0,
        idle_timeout_seconds: 0,
      },
      available: { transcription: false },
    }).transcription,
    { enabled: false, model: null, maxBytes: null, maxSeconds: null },
  );
  // Read aloud was removed (owner decision 19): a speech block is ignored.
  assert.equal(
    "speech" in
      parseVoice({
        transcription: { enabled: false },
        speech: { enabled: true, model: "tts" },
        available: { transcription: false, speech: true },
      }),
    false,
  );
  // The realtime endpoint takes no model or file size (owner decision 18).
  assert.deepEqual(
    parseVoice({
      transcription: { enabled: true, max_seconds: 300 },
      available: { transcription: true },
    }).transcription,
    { enabled: true, model: null, maxBytes: null, maxSeconds: 300 },
  );
});

test("bootstrap sections are optional and failed ones are named in errors", () => {
  const full = parseBootstrap(data("bootstrap.full"));
  assert.equal(full.schemaVersion, 1);
  assert.equal(full.server.siteName, "Claudex");
  assert.equal(full.plan?.groupId, 4);
  assert.equal(full.device?.reprovisionNeeded, false);
  // MG: the device's keys by group, without the keys themselves.
  assert.deepEqual(full.device?.keys, [
    {
      apiKeyId: 812,
      groupId: 4,
      groupName: "claudex-pro",
      platform: "openai",
      protocol: "responses",
      primary: true,
    },
    {
      apiKeyId: 813,
      groupId: 11,
      groupName: "claudex-grok",
      platform: "grok",
      protocol: "chat",
      primary: false,
    },
  ]);
  assert.equal(full.models?.items[0].groupId, 4);
  assert.equal(full.policy?.planLabel, "Max");
  assert.equal(full.models?.items.length, 2);
  assert.equal(full.release?.state, "available");
  assert.equal(full.release?.apiVersion, undefined);
  assert.equal(full.voice?.transcription.maxBytes, 19200000);
  assert.equal(full.voice?.transcription.maxSeconds, 600);
  assert.deepEqual(full.usage, { rulesEnabled: true, hasSessionWindow: true });
  assert.deepEqual(full.feedback, {
    diagnostics: { enabled: false },
    feedback: { enabled: false, allowConversationExcerpt: false },
  });
  assert.deepEqual(full.features, {
    deviceKeys: true,
    usageStatus: true,
    structuredRefusals: true,
    modelCatalog: true,
    voiceTranscription: true,
    payment: true,
    desktopCheckout: true,
    redeem: true,
    diagnostics: false,
    feedback: false,
    selfDelete: false,
    announcements: true,
  });
  const degraded = parseBootstrap(data("bootstrap.degraded"));
  assert.equal(degraded.plan, undefined);
  assert.equal(degraded.voice, undefined);
  assert.equal(degraded.policy?.groupId, null);
  assert.deepEqual(degraded.errors, [
    { section: "plan", code: "CLAUDEX_NO_PLAN" },
    { section: "voice", code: "CLAUDEX_SECTION_TIMEOUT" },
  ]);
  // Newer services: unknown fields, sections and features are ignored; missing features read as off.
  const newer = parseBootstrap({
    ...data("bootstrap.full"),
    schema_version: 2,
    future_section: { anything: true },
    policy: { ...data("bootstrap.full").policy, future_field: [1, 2] },
    features: { device_keys: true, teleport: true },
  });
  assert.equal(newer.schemaVersion, 2);
  assert.deepEqual(newer.policy, full.policy);
  assert.equal(newer.features.deviceKeys, true);
  assert.equal(newer.features.payment, false);
  assert.equal("futureSection" in newer || "future_section" in newer, false);
});

test("a missing required field names its path", () => {
  const cases: [
    string,
    (value: unknown) => unknown,
    Json,
    (string | number)[],
    string,
  ][] = [
    [
      "web-console",
      parseWebConsole,
      data("web-console.default"),
      ["admin_only"],
      "admin_only",
    ],
    ["release", parseRelease, data("release.available"), ["state"], "state"],
    [
      "release",
      parseRelease,
      data("release.available"),
      ["api_version"],
      "api_version",
    ],
    ["policy", parsePolicy, data("policy.group"), ["connectors"], "connectors"],
    [
      "policy",
      parsePolicy,
      data("policy.group"),
      ["usage_banner", "warn_percent"],
      "usage_banner.warn_percent",
    ],
    [
      "policy",
      parsePolicy,
      data("policy.group"),
      ["scheduled_tasks", "enabled"],
      "scheduled_tasks.enabled",
    ],
    [
      "models",
      parseModelCatalog,
      data("models.group"),
      ["items", 1, "id"],
      "items[1].id",
    ],
    [
      "devices",
      parseDeviceRegistration,
      data("devices.registered"),
      ["api_key", "key"],
      "api_key.key",
    ],
    [
      "devices",
      parseDeviceRegistration,
      data("devices.registered"),
      ["device", "id"],
      "device.id",
    ],
    ["devices", parseDeviceList, data("devices.list"), ["limit"], "limit"],
    [
      "web/sessions",
      parseWebSessionList,
      data("web-sessions.list"),
      ["items", 0, "id"],
      "items[0].id",
    ],
    [
      "devices",
      parseDeviceRevoked,
      data("devices.revoked"),
      ["revoked"],
      "revoked",
    ],
    [
      "usage-status",
      parseUsageStatus,
      data("usage-status.plan"),
      ["windows", 0, "used_usd"],
      "windows[0].used_usd",
    ],
    [
      "usage-status",
      parseUsageStatus,
      data("usage-status.plan"),
      ["plan", "group_id"],
      "plan.group_id",
    ],
    [
      "voice",
      parseVoice,
      fixture("section.voice").voice,
      ["transcription", "enabled"],
      "transcription.enabled",
    ],
    [
      "bootstrap",
      parseBootstrap,
      data("bootstrap.full"),
      ["policy", "revision"],
      "policy.revision",
    ],
    [
      "bootstrap",
      parseBootstrap,
      data("bootstrap.full"),
      ["device", "reprovision_needed"],
      "device.reprovision_needed",
    ],
    [
      "bootstrap",
      parseBootstrap,
      data("bootstrap.full"),
      ["voice", "available"],
      "voice.available",
    ],
    [
      "bootstrap",
      parseBootstrap,
      data("bootstrap.full"),
      ["release", "state"],
      "release.state",
    ],
    [
      "bootstrap",
      parseBootstrap,
      data("bootstrap.full"),
      ["features"],
      "features",
    ],
    [
      "bootstrap",
      parseBootstrap,
      data("bootstrap.full"),
      ["schema_version"],
      "schema_version",
    ],
    [
      "diagnostics",
      parseDiagnosticsAccepted,
      data("diagnostics.accepted"),
      ["accepted"],
      "accepted",
    ],
    [
      "feedback",
      parseFeedbackAccepted,
      data("feedback.accepted"),
      ["accepted"],
      "accepted",
    ],
    [
      "payment/checkout-links",
      parseCheckoutLink,
      data("payment-checkout-links.created"),
      ["token"],
      "token",
    ],
    [
      "payment/checkout",
      parseCheckoutSession,
      data("payment-checkout.stripe"),
      ["result_path"],
      "result_path",
    ],
    [
      "refusal",
      parseRefusalDetail,
      fixture("refusal.rule-limit").body.claudex,
      ["reason"],
      "reason",
    ],
  ];
  for (const [endpoint, parse, value, at, expected] of cases) {
    assert.throws(
      () => parse(without(value, at)),
      (error: unknown) =>
        error instanceof ContractError &&
        error.endpoint === endpoint &&
        error.path === expected &&
        error.message.includes(expected),
      `${endpoint} without ${expected}`,
    );
  }
  // Wrong types are reported the same way.
  assert.throws(
    () => parsePolicy({ ...data("policy.group"), incognito: "yes" }),
    (error: unknown) =>
      error instanceof ContractError && error.path === "incognito",
  );
  assert.throws(
    () =>
      parseDeviceRegistration({
        ...data("devices.registered"),
        api_key: { id: 1, key: "short", status: "active" },
      }),
    (error: unknown) =>
      error instanceof ContractError && error.path === "api_key.key",
  );
});

test("refusal details are read only from 401, 402, 403, 426 and 429 version-1 bodies, without a download address", () => {
  const upgrade = fixture("refusal.upgrade-required");
  const detail = parseRefusal(upgrade.status, upgrade.body)!;
  assert.deepEqual(detail, {
    v: 1,
    reason: "UPGRADE_REQUIRED",
    kind: "upgrade",
    reprovision: false,
    action: "update",
    minimumVersion: "1.2.0",
    latestVersion: "1.4.0",
    message:
      "This version of Claudex (1.1.0) is no longer supported. Update to 1.4.0 to keep working.",
  });
  assert.equal("downloadUrl" in detail, false);
  const rule = fixture("refusal.rule-limit");
  assert.deepEqual(parseRefusal(rule.status, rule.body), {
    v: 1,
    reason: "RULE_LIMIT",
    kind: "rule_limit",
    window: "7d",
    resetsAt: Date.parse("2026-10-02T08:00:00Z"),
    retryAfterSeconds: 412800,
    limitUsd: 20,
    usedUsd: 20.13,
    ruleId: 5,
    label: "Opus",
    models: ["claude-opus-*"],
    reprovision: false,
    action: "wait",
    message: "You've reached the Opus limit. It resets Oct 2, 8:00 AM UTC.",
  });
  for (const status of [200, 400, 404, 409, 413, 500, 502, 503])
    assert.equal(parseRefusal(status, rule.body), undefined, String(status));
  for (const status of refusalStatuses)
    assert(parseRefusal(status, rule.body), String(status));
  assert.equal(
    parseRefusal(429, {
      ...rule.body,
      claudex: { ...rule.body.claudex, v: 2 },
    }),
    undefined,
  );
  assert.equal(
    parseRefusal(429, {
      ...rule.body,
      claudex: { ...rule.body.claudex, reason: "lower" },
    }),
    undefined,
  );
  assert.equal(
    parseRefusal(429, { code: "X", message: "no detail" }),
    undefined,
  );
  assert.equal(parseRefusal(429, "not an object"), undefined);
  // Unknown actions and kinds from a newer service stay usable.
  const newer = parseRefusal(429, {
    claudex: {
      v: 1,
      reason: "NEW_THING",
      kind: "Weird Kind",
      action: "teleport",
      message: "m",
    },
  })!;
  assert.equal(newer.action, "none");
  assert.equal(newer.kind, "unknown");
});

test("the X-Claudex headers leave out values the service would refuse", () => {
  const id = "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11";
  assert.deepEqual(
    claudexHeaders({ version: "1.3.2", platform: "darwin", arch: "arm64" }, id),
    {
      "X-Claudex-Version": "1.3.2",
      "X-Claudex-Platform": "darwin",
      "X-Claudex-Arch": "arm64",
      "X-Claudex-Device-Id": id,
    },
  );
  assert.deepEqual(
    claudexHeaders(
      { version: "1.3.2 beta", platform: "aix", arch: "ia32" },
      "not-a-uuid",
    ),
    {},
  );
  assert.deepEqual(claudexHeaders({ version: "0.2.8+claudex.1" }), {
    "X-Claudex-Version": "0.2.8+claudex.1",
  });
  const info = claudexClientInfo();
  assert.equal(
    info.version,
    JSON.parse(fs.readFileSync("package.json", "utf8")).version,
  );
  assert.equal(info.platform, process.platform);
  assert.equal(info.arch, process.arch);
});

// ---------------------------------------------------------------------------
// Transport

const user = { id: 3, email: "bob@example.test", password: "bob-password" };
const pro = {
  id: 4,
  name: "Claudex Pro",
  platform: "openai",
  subscription_type: "subscription",
  status: "active",
};
async function startMock(t: TestContext, options: MockOptions = {}) {
  const mock = new MockSub2Api({ users: [user], groups: [pro], ...options });
  await mock.start();
  t.after(() => mock.close());
  return mock;
}
async function login(mock: MockSub2Api) {
  const result = (await requestJson(fetch, `${mock.url}/api/v1/auth/login`, {
    method: "POST",
    body: { email: user.email, password: user.password },
  })) as Json;
  return String(result.access_token);
}
const lowerHeaders = (headers: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
const claudexOnly = (headers: http.IncomingHttpHeaders) =>
  Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.startsWith("x-claudex-")),
  );

test("panel requests carry this build's X-Claudex headers and the device id only when asked", async (t) => {
  const mock = await startMock(t);
  const expected = lowerHeaders(claudexHeaders(claudexClientInfo()));
  assert.equal(expected["x-claudex-version"], claudexClientInfo().version);
  // The existing client's calls carry them without any change on its side.
  await new Sub2ApiClient(mock.url).publicSettings();
  const token = await login(mock);
  for (const request of mock.requests)
    assert.deepEqual(claudexOnly(request.headers), expected, request.path);
  const deviceId = "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11";
  await requestJson(fetch, `${mock.url}/api/v1/claudex/devices`, {
    token,
    deviceId,
  });
  assert.equal(mock.requests.at(-1)!.headers["x-claudex-device-id"], deviceId);
  // Tests (and callers that know better) can name the client.
  await requestJson(fetch, `${mock.url}/api/v1/claudex/web-console`, {
    client: { version: "2.0.0-beta.1", platform: "win32", arch: "x64" },
  });
  assert.deepEqual(claudexOnly(mock.requests.at(-1)!.headers), {
    "x-claudex-version": "2.0.0-beta.1",
    "x-claudex-platform": "win32",
    "x-claudex-arch": "x64",
  });
});

test("ETag answers: 304 keeps the caller's copy, a change sends a new one", async (t) => {
  const mock = await startMock(t);
  const token = await login(mock);
  const url = `${mock.url}/api/v1/claudex/policy`;
  const first = await requestJsonResult(fetch, url, { token });
  assert(!first.notModified);
  assert.match(first.etag ?? "", /^W\/"[A-Za-z0-9_-]{22}"$/);
  assert.equal(parsePolicy(first.data).revision, 0);
  const again = await requestJsonResult(fetch, url, {
    token,
    ifNoneMatch: first.etag,
  });
  assert.deepEqual(again, { notModified: true, status: 304, etag: first.etag });
  assert.equal(mock.requests.at(-1)!.headers["if-none-match"], first.etag);
  mock.options.policy = { revision: 18, plan_label: "Max" };
  const changed = await requestJsonResult(fetch, url, {
    token,
    ifNoneMatch: first.etag,
  });
  assert(!changed.notModified);
  assert.notEqual(changed.etag, first.etag);
  assert.equal(parsePolicy(changed.data).planLabel, "Max");
  // Bootstrap's ETag leaves out generated_at.
  const boot = await requestJsonResult(
    fetch,
    `${mock.url}/api/v1/claudex/bootstrap`,
    { token },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const bootAgain = await requestJsonResult(
    fetch,
    `${mock.url}/api/v1/claudex/bootstrap`,
    { token, ifNoneMatch: boot.etag },
  );
  assert.equal(bootAgain.notModified, true);
  // requestJson keeps its old contract: the data, never a 304.
  assert.equal(
    (await requestJson(fetch, url, { token })) instanceof Object,
    true,
  );
});

test("errors keep code and message for older services and gain detail, metadata and Retry-After from Claudex ones", async (t) => {
  const mock = await startMock(t);
  const token = await login(mock);
  const limit = fixture("devices.limit-error");
  const rule = fixture("refusal.rule-limit");
  mock
    .route("GET", "/api/v1/test/limit", () => ({
      status: limit.status,
      body: limit.body,
    }))
    .route("GET", "/api/v1/test/refusal/:status", (request) => ({
      status: Number(request.params.status),
      body: rule.body,
      headers: request.url.searchParams.has("header")
        ? { "Retry-After": "Wed, 21 Oct 2037 07:28:00 GMT" }
        : undefined,
    }))
    .route("GET", "/api/v1/test/legacy", () =>
      failCode(403, "INSUFFICIENT_BALANCE", "Insufficient account balance"),
    )
    .route("GET", "/api/v1/test/envelope", () => ({
      status: 200,
      body: {
        code: 1,
        message: "busy",
        reason: "SOMETHING",
        metadata: { a: "1" },
        data: null,
      },
    }));
  const call = async (route: string) => {
    try {
      await requestJson(fetch, `${mock.url}/api/v1/test/${route}`, { token });
    } catch (error) {
      assert(error instanceof Sub2ApiError);
      return error;
    }
    throw Error("expected an error");
  };
  const limited = await call("limit");
  assert.equal(limited.status, 409);
  assert.equal(limited.code, "CLAUDEX_DEVICE_LIMIT");
  assert.match(limited.message, /on 5 devices/);
  assert.deepEqual(limited.metadata, { limit: "5", active: "5" });
  assert.equal(metadataNumber(limited, "limit"), 5);
  assert.equal(metadataNumber(limited, "missing"), undefined);
  assert.equal(limited.detail, undefined);

  for (const status of [400, 401, 402, 403, 426, 429, 500]) {
    const error = await call(`refusal/${status}`);
    assert.equal(error.code, "CLAUDEX_USAGE_LIMIT_EXCEEDED");
    assert.equal(
      error.detail?.reason,
      refusalStatuses.includes(status) ? "RULE_LIMIT" : undefined,
      String(status),
    );
  }
  // Retry-After: the header wins; without it the refusal's own seconds.
  assert.equal((await call("refusal/429")).retryAfter, 412800);
  const dated = await call("refusal/429?header=1");
  assert(dated.retryAfter! > 300_000_000);
  assert.equal(retryAfterSeconds("120"), 120);
  assert.equal(retryAfterSeconds("soon"), undefined);
  assert.equal(retryAfterSeconds("Thu, 01 Jan 1970 00:01:00 GMT", 0), 60);

  const legacy = await call("legacy");
  assert.equal(legacy.code, "INSUFFICIENT_BALANCE");
  assert.equal(legacy.message, "Insufficient account balance");
  assert.equal(legacy.detail, undefined);
  assert.equal(legacy.metadata, undefined);
  assert.equal(legacy.retryAfter, undefined);
  const envelope = await call("envelope");
  assert.equal(envelope.code, "SOMETHING");
  assert.deepEqual(envelope.metadata, { a: "1" });
  // The session revocation answer (H9b) is a plain middleware error.
  const revoked = fixture("session.revoked-error");
  assert.equal(
    errorFromResponse(revoked.status, revoked.body).code,
    "CLAUDEX_SESSION_REVOKED",
  );
});

// ---------------------------------------------------------------------------
// Gateway and provider service

async function upstream(t: TestContext, seen: http.IncomingHttpHeaders[]) {
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    if (req.url?.endsWith("/models"))
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ id: "m" }] }));
    else
      res
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          `data: ${JSON.stringify({ type: "response.completed", response: { usage: {} } })}\n\n`,
        );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

test("the gateway names this build to the Claudex service only, never with the device id", async (t) => {
  const seen: http.IncomingHttpHeaders[] = [];
  const baseUrl = await upstream(t, seen);
  const expected = lowerHeaders(claudexHeaders(claudexClientInfo()));
  for (const backend of ["sub2api", undefined] as const) {
    const provider: Provider = {
      id: "p",
      name: "P",
      baseUrl,
      protocol: "responses",
      model: "m",
      models: ["m"],
      ...(backend ? { backend } : {}),
    };
    const bridge = new Gateway(() => ({ provider, apiKey: "secret" }));
    await bridge.start();
    t.after(() => bridge.close());
    const response = await fetch(`${bridge.url}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "m", input: "hi", stream: true }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(
      claudexOnly(seen.at(-1)!),
      backend ? expected : {},
      backend ?? "local provider",
    );
    assert.equal(seen.at(-1)!["x-claudex-device-id"], undefined);
  }
});

async function providerServiceScript(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "provider-service.cjs");
  await build({
    entryPoints: ["server/provider-service.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: script,
    logLevel: "silent",
  });
  return { root, script };
}

test("the provider service child sends this build's version from its parent, and none to other providers", async (t) => {
  const { root, script } = await providerServiceScript(t);
  const mock = await startMock(t);
  mock.keys.push({
    id: 1,
    user_id: 3,
    name: "device",
    key: `sk-${"b".repeat(64)}`,
    group_id: 4,
    status: "active",
  });
  const provider: Provider = {
    id: "sub2api",
    name: "Sub2API",
    baseUrl: `${mock.url}/v1`,
    protocol: "responses",
    model: "m",
    models: ["m"],
    backend: "sub2api",
  };
  const client = new ProviderServiceClient(
    script,
    root,
    provider,
    "",
    "cd".repeat(32),
  );
  t.after(() => client.close());
  const previous = process.env.CLAUDEX_APP_VERSION;
  process.env.CLAUDEX_APP_VERSION = "7.8.9-rc.1";
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDEX_APP_VERSION;
    else process.env.CLAUDEX_APP_VERSION = previous;
  });
  await client.remoteModels(provider, `sk-${"b".repeat(64)}`);
  const models = mock.requests.at(-1)!;
  assert.equal(models.path, "/v1/models");
  assert.deepEqual(claudexOnly(models.headers), {
    ...lowerHeaders(
      claudexHeaders({ ...claudexClientInfo(), version: "7.8.9-rc.1" }),
    ),
  });
  await client.remoteKeyUsage(provider, `sk-${"b".repeat(64)}`);
  assert.equal(
    mock.requests.at(-1)!.headers["x-claudex-version"],
    "7.8.9-rc.1",
  );
  assert.equal(mock.requests.at(-1)!.headers["x-claudex-device-id"], undefined);
  // A provider the person added (not the Claudex service) gets no X-Claudex header.
  const seen: http.IncomingHttpHeaders[] = [];
  const other = await upstream(t, seen);
  await client.testProvider(
    { ...provider, id: "local", baseUrl: other, backend: undefined },
    "local-key",
  );
  assert.deepEqual(claudexOnly(seen.at(-1)!), {});
});

test("refusal fields survive the trip from the provider service child, checked field by field", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-refusal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudex: ClaudexRefusal = parseRefusalDetail(
    fixture("refusal.rule-limit").body.claudex,
  );
  const script = path.join(root, "child.cjs");
  fs.writeFileSync(
    script,
    `process.on("message", (m) => {
  if (m.type === "start") {
    process.send({ type: "remoteRefusal", status: 429, code: "CLAUDEX_USAGE_LIMIT_EXCEEDED", reason: "weekly",
      exceeded: true, invalidKey: false, message: "You've reached the Opus limit.",
      claudex: ${JSON.stringify(claudex)}, resetsAt: ${claudex.resetsAt}, action: "wait",
      reprovision: false, signedOut: false, models: ["claude-opus-*"] });
    process.send({ type: "remoteRefusal", status: 401, code: "API_KEY_DISABLED", reason: "${"x".repeat(60)}",
      exceeded: false, invalidKey: false, message: "m", claudex: { v: 2, reason: "X" }, resetsAt: -5,
      action: "explode", reprovision: "yes", signedOut: 1, models: new Array(60).fill("m") });
    process.send({ type: "remoteRefusal", status: 401, code: "API_KEY_DISABLED", message: "x".repeat(1001) });
    process.send({ id: m.id, ok: true, result: { url: "http://127.0.0.1:9/v1", token: process.env.CLAUDEX_APP_VERSION || "" } });
  } else process.send({ id: m.id, ok: true, result: true });
});
process.on("disconnect", () => process.exit(0));
`,
  );
  const refusals: (GatewayRefusal & Json)[] = [];
  const client = new ProviderServiceClient(
    script,
    root,
    {
      id: "sub2api",
      name: "S",
      baseUrl: "http://127.0.0.1:9/v1",
      protocol: "responses",
      model: "m",
      models: [],
      backend: "sub2api",
    },
    "",
    undefined,
    root,
    undefined,
    undefined,
    (refusal) => refusals.push(refusal),
  );
  t.after(() => client.close());
  await client.start();
  // The fork's environment names this build.
  assert.equal(client.token, claudexClientInfo().version);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(refusals, [
    {
      status: 429,
      code: "CLAUDEX_USAGE_LIMIT_EXCEEDED",
      reason: "weekly",
      exceeded: true,
      invalidKey: false,
      message: "You've reached the Opus limit.",
      claudex,
      resetsAt: claudex.resetsAt,
      action: "wait",
      reprovision: false,
      signedOut: false,
      models: ["claude-opus-*"],
    },
    {
      status: 401,
      code: "API_KEY_DISABLED",
      exceeded: false,
      invalidKey: false,
      message: "m",
    },
  ]);
  assert.deepEqual(
    gatewayRefusalDetails({
      claudex: { ...claudex, extra: 1, downloadUrl: "https://x" },
    }),
    {
      claudex,
    },
  );
});

// ---------------------------------------------------------------------------
// The mock service

test("an older service without the Claudex module answers 404 on every Claudex route", async (t) => {
  const mock = await startMock(t, { claudex: false });
  const token = await login(mock);
  for (const [route, auth] of [
    ["/api/v1/claudex/release", false],
    ["/api/v1/claudex/web-console", false],
    ["/api/v1/claudex/bootstrap", true],
    ["/api/v1/claudex/policy", true],
  ] as const)
    await assert.rejects(
      requestJson(fetch, `${mock.url}${route}`, auth ? { token } : {}),
      (error: unknown) => error instanceof Sub2ApiError && error.status === 404,
      route,
    );
  // Its legacy routes still answer as before.
  assert(
    Array.isArray(
      await requestJson(fetch, `${mock.url}/api/v1/groups/available`, {
        token,
      }),
    ),
  );
});

test("the mock's Claudex routes follow the contract the parsers read", async (t) => {
  const mock = await startMock(t, {
    subscriptions: [
      {
        id: 77,
        group_id: 4,
        status: "active",
        expires_at: "2099-01-01T00:00:00Z",
        group: pro,
      },
    ],
    release: {
      latest_version: "1.4.0",
      minimum_version: "1.2.0",
      downloads: {
        "darwin-arm64": { url: "https://dl.example.com/a.zip", sha256: "" },
      },
    },
    voice: { transcription: { enabled: true } },
  });
  const token = await login(mock);
  const release = (version: string) =>
    requestJson(fetch, `${mock.url}/api/v1/claudex/release`, {
      client: { version, platform: "darwin", arch: "arm64" },
    }).then(parseRelease);
  assert.equal((await release("1.1.0")).state, "required");
  assert.equal((await release("1.3.9")).state, "available");
  assert.equal((await release("1.4.0-beta.1")).state, "available");
  assert.equal((await release("1.4.0+build.7")).state, "current");
  assert.equal(
    (await release("1.4.0")).downloadUrl,
    "https://dl.example.com/a.zip",
  );
  assert.deepEqual(
    parseWebConsole(
      await requestJson(fetch, `${mock.url}/api/v1/claudex/web-console`),
    ),
    { adminOnly: true },
  );
  const malformed = await fetch(`${mock.url}/api/v1/claudex/web-console`, {
    headers: { "X-Claudex-Platform": "beos" },
  });
  const refused = errorFromResponse(malformed.status, await malformed.json());
  assert.equal(refused.status, 400);
  assert.equal(refused.code, "CLAUDEX_INVALID_CLIENT_HEADER");
  assert.deepEqual(refused.metadata, { header: "X-Claudex-Platform" });
  const deviceId = "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11";
  const boot = parseBootstrap(
    await requestJson(fetch, `${mock.url}/api/v1/claudex/bootstrap`, {
      token,
      deviceId,
    }),
  );
  assert.equal(boot.plan?.groupId, 4);
  assert.equal(boot.device?.reprovisionNeeded, true);
  assert.equal(boot.voice?.available.transcription, true);
  assert.equal(boot.features.voiceTranscription, true);
  assert.equal(boot.features.payment, false);
  parseModelCatalog(
    await requestJson(fetch, `${mock.url}/api/v1/claudex/models`, { token }),
  );
  parseUsageStatus(
    await requestJson(fetch, `${mock.url}/api/v1/claudex/usage-status`, {
      token,
    }),
  );

  const registration = parseDeviceRegistration(
    await requestJson(fetch, `${mock.url}/api/v1/claudex/devices`, {
      method: "POST",
      token,
      deviceId,
      body: deviceRegistrationBody({
        deviceName: "Test Mac",
        platform: "darwin",
        arch: "arm64",
        appVersion: "0.0.1",
      }),
    }),
  );
  assert.equal(registration.created, true);
  assert.equal(registration.plan?.protocol, "responses");
  assert.match(mock.keys.at(-1)!.name, /^claudex-device:[0-9a-f]{12}$/);
  const after = parseBootstrap(
    await requestJson(fetch, `${mock.url}/api/v1/claudex/bootstrap`, {
      token,
      deviceId,
    }),
  );
  assert.equal(after.device?.reprovisionNeeded, false);
  assert.equal(after.device?.id, registration.device.id);
  const list = parseDeviceList(
    await requestJson(fetch, `${mock.url}/api/v1/claudex/devices`, {
      token,
      deviceId,
    }),
  );
  assert.deepEqual(
    list.items.map((item) => item.current),
    [true],
  );
  // The device flow never writes /api/v1/keys.
  assert.equal(mock.keyWrites, 0);
  // No HTTP audio routes (owner decisions 18/19): dictation is the realtime
  // WebSocket, which scripts/claudex-live-check.ts checks on a live server.
  const transcribed = await fetch(`${mock.url}/v1/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${registration.apiKey?.key}`,
      "Content-Type": "multipart/form-data; boundary=x",
    },
    body: "--x\r\n\r\naudio\r\n--x--",
  });
  assert.equal(transcribed.status, 404);
});

test("device registration is idempotent, limited, throttled and never adopts a legacy key", async (t) => {
  const mock = await startMock(t, {
    subscriptions: [{ id: 77, group_id: 4, status: "active", group: pro }],
    deviceLimit: 1,
  });
  const token = await login(mock);
  const register = (deviceId: string) =>
    requestJson(fetch, `${mock.url}/api/v1/claudex/devices`, {
      method: "POST",
      token,
      deviceId,
      body: deviceRegistrationBody({
        deviceName: "Mac",
        platform: "darwin",
        arch: "arm64",
        appVersion: "0.0.1",
      }),
    }).then(parseDeviceRegistration);
  const first = "11111111-1111-4111-8111-111111111111";
  mock.keys.push({
    id: 99,
    user_id: 3,
    name: `claudex-desktop:${first}`,
    key: `sk-${"c".repeat(64)}`,
    group_id: 4,
    status: "active",
  });
  const a = await register(first);
  const b = await register(first);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.apiKey?.key, a.apiKey?.key);
  assert.equal(mock.keys.find((key) => key.id === 99)!.status, "disabled");
  await assert.rejects(
    register(first),
    (error: unknown) =>
      error instanceof Sub2ApiError &&
      error.code === "CLAUDEX_DEVICE_REGISTRATION_THROTTLED" &&
      error.status === 429,
  );
  await assert.rejects(
    register("22222222-2222-4222-8222-222222222222"),
    (error: unknown) =>
      error instanceof Sub2ApiError &&
      error.code === "CLAUDEX_DEVICE_LIMIT" &&
      metadataNumber(error, "limit") === 1 &&
      metadataNumber(error, "active") === 1,
  );
  mock.options.deviceKeys = false;
  await assert.rejects(
    register("33333333-3333-4333-8333-333333333333"),
    (error: unknown) =>
      error instanceof Sub2ApiError &&
      error.code === "CLAUDEX_DEVICE_KEYS_DISABLED",
  );
  mock.options.subscriptions = [];
  mock.options.groups = [];
  mock.options.deviceKeys = true;
  mock.options.deviceLimit = 5;
  // Balance only: no plan group still registers.
  const planless = await register("33333333-3333-4333-8333-333333333333");
  assert.equal(planless.apiKey, null);
  assert.deepEqual(planless.apiKeys, []);
  assert.equal(planless.plan, null);
  assert.equal(mock.keyWrites, 0);
  // Decision 17: a fork keeps users from creating keys unless the administrator allows it.
  mock.options.userApiKeys = false;
  await assert.rejects(
    requestJson(fetch, `${mock.url}/api/v1/keys`, {
      method: "POST",
      token,
      body: { name: "mine", group_id: 4 },
    }),
    (error: unknown) =>
      error instanceof Sub2ApiError &&
      error.code === "CLAUDEX_USER_API_KEYS_DISABLED",
  );
  assert.equal(mock.keyWrites, 1);
});

test("signing out a device or every device disables device keys only and ends old sessions", async (t) => {
  const mock = await startMock(t, {
    subscriptions: [{ id: 77, group_id: 4, status: "active", group: pro }],
    refusal: {
      status: 429,
      code: "USAGE_LIMIT_EXCEEDED",
      message: "weekly usage limit exceeded",
      claudex: fixture("refusal.subscription-weekly-limit").body.claudex,
    },
  });
  const token = await login(mock);
  const register = (deviceId: string) =>
    requestJson(fetch, `${mock.url}/api/v1/claudex/devices`, {
      method: "POST",
      token,
      deviceId,
      body: {},
    }).then(parseDeviceRegistration);
  const here = "44444444-4444-4444-8444-444444444444";
  const there = "55555555-5555-4555-8555-555555555555";
  const mine = (await register(here)).apiKey!.key;
  const theirs = (await register(there)).apiKey!.key;
  const own = (await requestJson(fetch, `${mock.url}/api/v1/keys`, {
    method: "POST",
    token,
    body: { name: "my own key", group_id: 4 },
  })) as Json;
  const gateway = (key: string) =>
    fetch(`${mock.url}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    }).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as Json,
    }));
  // Structured refusals are added for device keys only.
  const device = await gateway(mine);
  assert.equal(
    parseRefusal(device.status, device.body)?.reason,
    "SUBSCRIPTION_WEEKLY_LIMIT",
  );
  const userKey = await gateway(String(own.key));
  assert.equal(userKey.body.claudex, undefined);
  // The device's own sign-out.
  assert.deepEqual(
    parseDeviceRevoked(
      await requestJson(fetch, `${mock.url}/api/v1/claudex/devices/current`, {
        method: "DELETE",
        token,
        deviceId: here,
      }),
    ),
    { revoked: true },
  );
  const signedOut = await gateway(mine);
  assert.equal(signedOut.status, 401);
  assert.equal(
    parseRefusal(signedOut.status, signedOut.body)?.reason,
    "DEVICE_REVOKED",
  );
  // Every device: device keys stop, the user's own key keeps working, old sessions end.
  await requestJson(fetch, `${mock.url}/api/v1/auth/revoke-all-sessions`, {
    method: "POST",
    token,
    body: {},
  });
  assert.equal((await gateway(theirs)).status, 401);
  assert.equal((await gateway(String(own.key))).status, 429);
  assert.equal(mock.keys.find((key) => key.id === own.id)!.status, "active");
  await assert.rejects(
    requestJson(fetch, `${mock.url}/api/v1/claudex/policy`, { token }),
    (error: unknown) =>
      error instanceof Sub2ApiError &&
      error.status === 401 &&
      error.code === "CLAUDEX_SESSION_REVOKED",
  );
  const fresh = await login(mock);
  assert(
    parsePolicy(
      await requestJson(fetch, `${mock.url}/api/v1/claudex/policy`, {
        token: fresh,
      }),
    ),
  );
});

test("other packages extend the mock with routes and options instead of editing it", async (t) => {
  const mock = await startMock(t, {
    feedback: { feedback: true },
    payment: { enabled: true },
  });
  const token = await login(mock);
  mock.route("GET", "/api/v1/claudex/usage-status", () =>
    ok(data("usage-status.plan")),
  );
  mock.route(
    "GET",
    "/api/v1/claudex/echo/:name",
    (request) => ok({ name: request.params.name }),
    { auth: "none" },
  );
  assert.equal(
    parseUsageStatus(
      await requestJson(fetch, `${mock.url}/api/v1/claudex/usage-status`, {
        token,
      }),
    ).windows.length,
    5,
  );
  assert.deepEqual(
    await requestJson(fetch, `${mock.url}/api/v1/claudex/echo/a%20b`),
    { name: "a b" },
  );

  // Reports: off by default, consent required, excerpts dropped unless allowed.
  await assert.rejects(
    requestJson(fetch, `${mock.url}/api/v1/claudex/diagnostics`, {
      method: "POST",
      token,
      body: fixture("diagnostics.request"),
    }),
    (error: unknown) =>
      error instanceof Sub2ApiError &&
      error.code === "CLAUDEX_FEEDBACK_DISABLED",
  );
  await assert.rejects(
    requestJson(fetch, `${mock.url}/api/v1/claudex/feedback`, {
      method: "POST",
      token,
      body: { ...fixture("feedback.request"), consent: false },
    }),
    (error: unknown) =>
      error instanceof Sub2ApiError &&
      error.code === "CLAUDEX_CONSENT_REQUIRED",
  );
  assert.deepEqual(
    parseFeedbackAccepted(
      await requestJson(fetch, `${mock.url}/api/v1/claudex/feedback`, {
        method: "POST",
        token,
        body: {
          ...fixture("feedback.request"),
          conversation_excerpt: "User: hi",
        },
      }),
    ),
    { accepted: true, duplicate: false, excerptDropped: true },
  );
  assert.equal(mock.feedback[0].conversation_excerpt, null);

  // Stripe in the system browser: a checkout link for the person's own pending order.
  const order = (await requestJson(fetch, `${mock.url}/api/v1/payment/orders`, {
    method: "POST",
    token,
    body: { payment_type: "stripe", order_type: "balance", amount: 20 },
  })) as Json;
  assert.match(String(order.client_secret), /_secret_/);
  await assert.rejects(
    requestJson(fetch, `${mock.url}/api/v1/claudex/payment/checkout-links`, {
      method: "POST",
      token,
      body: checkoutLinkBody({
        orderId: order.order_id,
        resumeToken: order.resume_token,
        clientSecret: "pi_other_secret_x",
      }),
    }),
    (error: unknown) =>
      error instanceof Sub2ApiError &&
      error.code === "CLAUDEX_CHECKOUT_UNAVAILABLE",
  );
  const link = parseCheckoutLink(
    await requestJson(
      fetch,
      `${mock.url}/api/v1/claudex/payment/checkout-links`,
      {
        method: "POST",
        token,
        body: checkoutLinkBody({
          orderId: order.order_id,
          resumeToken: order.resume_token,
          clientSecret: order.client_secret,
        }),
      },
    ),
  );
  const session = () =>
    requestJson(fetch, `${mock.url}/api/v1/claudex/payment/checkout`, {
      method: "POST",
      body: { token: link.token },
    }).then(parseCheckoutSession);
  assert.equal((await session()).stripe?.clientSecret, order.client_secret);
  mock.completeOrder(order.order_id);
  const done = await session();
  assert.equal(done.status, "COMPLETED");
  assert.equal(done.stripe, null);
  const mineOrders = (await requestJson(
    fetch,
    `${mock.url}/api/v1/payment/orders/my`,
    { token },
  )) as Json;
  assert.equal(mineOrders.items[0].client_secret, undefined);
});

test("BootstrapSource: memory source notifies, the mock source revalidates with its ETag", async (t) => {
  const full = parseBootstrap(data("bootstrap.full"));
  const memory = new MemoryBootstrapSource(full);
  const seen: unknown[] = [];
  const stop = memory.onChange((value) => seen.push(value?.schemaVersion));
  assert.equal(memory.current(), full);
  memory.set(undefined);
  stop();
  memory.set(full);
  assert.deepEqual(seen, [undefined]);
  assert.equal(await memory.refresh(), full);

  const mock = await startMock(t);
  const source = mockBootstrapSource(mock, await login(mock));
  const first = await source.refresh();
  assert.equal(first?.server.siteName, "Sub2API");
  const second = await source.refresh();
  assert.equal(second, first, "a 304 keeps the same bootstrap");
  assert.equal(
    mock.requests.at(-1)!.headers["if-none-match"] !== undefined,
    true,
  );
});

test("rule_kind and the request id cross to the main process, checked field by field", () => {
  const claudex = parseRefusalDetail(
    fixture("refusal.usage-limit").body.claudex,
  );
  assert.equal(claudex.ruleKind, "session");
  assert.equal(claudex.label, "Current session");
  // The provider child's copy is checked again in the main process.
  const details = gatewayRefusalDetails({
    claudex,
    requestId: "3b8c2f7e-6a51-4c1e-9d2a-0f3e9b7c1a55",
  });
  assert.equal(details.claudex?.ruleKind, "session");
  assert.equal(details.requestId, "3b8c2f7e-6a51-4c1e-9d2a-0f3e9b7c1a55");
  // A bad rule kind rejects the whole explanation; a bad request id is dropped.
  assert.equal(
    gatewayRefusalDetails({ claudex: { ...claudex, ruleKind: "BAD KIND" } })
      .claudex,
    undefined,
  );
  for (const requestId of ["", "x".repeat(129), "two words", 42])
    assert.equal(gatewayRefusalDetails({ requestId }).requestId, undefined);
  // Older fixtures without the field still parse.
  assert.equal(
    parseRefusalDetail(fixture("refusal.rule-limit").body.claudex).ruleKind,
    undefined,
  );
});

test("unknown errors and envelopes still read as before (old servers)", () => {
  assert.deepEqual(
    errorFromResponse(502, undefined).message,
    "The Claudex service returned HTTP 502.",
  );
  assert.equal(errorFromResponse(502, undefined).code, "HTTP_502");
  const openai = errorFromResponse(429, {
    error: { type: "rate_limit_exceeded", message: "slow down" },
  });
  assert.equal(openai.code, "rate_limit_exceeded");
  assert.equal(openai.message, "slow down");
  assert.equal(openai.detail, undefined);
});
