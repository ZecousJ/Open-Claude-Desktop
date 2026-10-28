/**
 * A small in-process stand-in for the Claudex service: the Sub2API user API and
 * gateway (shaped after responses recorded from an unmodified local instance;
 * no Sub2API code is used, only the HTTP contract is imitated) and the Claudex
 * routes of the design.
 *
 * `options.claudex = false` is an older Sub2API without the Claudex module:
 * every Claudex route, `/claudex/release` included, answers 404.
 *
 * Other packages extend it without editing this file: `mock.route()` adds or
 * overrides a route, and `options` change what the built-in routes answer.
 */
import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  claudexHeaderNames,
  parseBootstrap,
  type BootstrapSource,
  type ClaudexBootstrap,
} from "../../shared/claudex-contract";
import { requestJsonResult, type Fetch } from "../../electron/sub2api/http";

type Json = Record<string, unknown>;

export interface MockUser {
  id: number;
  email: string;
  password: string;
  username?: string;
  totp?: string;
  /** US dollars; `GET /user/profile`. */
  balance?: number;
}
export interface MockKey {
  id: number;
  user_id: number;
  name: string;
  key: string;
  group_id: number | null;
  status: string;
}
/** A row of `claudex_devices`. */
export interface MockDevice {
  id: number;
  userId: number;
  /** The raw id from `X-Claudex-Device-Id` (the service stores only its hash). */
  deviceId: string;
  keyId: number | null;
  groupId: number | null;
  deviceName: string;
  platform: string;
  arch: string;
  appVersion: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  revokedReason: "" | "user" | "admin" | "revoke_all";
  /** Registration times, for the 60 s throttle. */
  registrations: number[];
  /** The device's keys of its other groups (MG), by group id. */
  groupKeys?: Record<number, number>;
}
/** A payment order (`/api/v1/payment/orders`). */
export interface MockOrder {
  id: number;
  user_id: number;
  amount: number;
  pay_amount: number;
  fee_rate: number;
  currency: string;
  payment_type: string;
  out_trade_no: string;
  status: string;
  order_type: string;
  plan_id: number | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  completed_at: string | null;
  /** Only in the create answer. */
  resume_token: string;
  client_secret: string;
  intent_id: string;
}
/** The fork's `claudex_client_release` stable channel (design 2.2). */
export interface MockRelease {
  latest_version?: string;
  minimum_version?: string;
  published_at?: string;
  release_notes_url?: string;
  release_notes_md?: string;
  downloads?: Record<string, { url: string; sha256?: string } | null>;
  enforce_minimum_on_gateway?: boolean;
}

export interface MockOptions {
  settings?: Json;
  users?: MockUser[];
  groups?: Json[];
  subscriptions?: Json[];
  progress?: unknown[];
  /** Response for gateway GET /v1/models: models or an error body and status. */
  models?: { status: number; body: unknown };
  keyUsage?: unknown;
  /** Response for POST /v1/responses and /v1/chat/completions. */
  gateway?: { status: number; body: unknown };
  accessTtlSeconds?: number;

  /** false: an older Sub2API without the Claudex module. Default true. */
  claudex?: boolean;
  /**
   * false: `POST /api/v1/keys` answers 403 CLAUDEX_USER_API_KEYS_DISABLED as a
   * fresh fork does (owner decision 17). Default true, for the legacy flow.
   */
  userApiKeys?: boolean;
  /** `GET /claudex/web-console`; default true. */
  webConsoleAdminOnly?: boolean;
  /** The service's build; default "0.2.8+claudex.1". */
  serverVersion?: string;
  /** The stable channel; default nothing published (state "unknown"). */
  release?: MockRelease;
  /** The resolved policy (`GET /claudex/policy` data); default the built-in policy. */
  policy?: Json;
  /** The model catalog (`GET /claudex/models` data); default empty. */
  catalog?: Json;
  /** `claudex_provisioning.enabled`; default true. */
  deviceKeys?: boolean;
  /** Most active devices per user; default 5 (owner decision 9). */
  deviceLimit?: number;
  /** The third registration of one device within 60 s answers 429; default true. */
  registrationThrottle?: boolean;
  /** The plan group when no subscription applies (`default_group_id`). */
  defaultGroupId?: number;
  /**
   * Other groups a device gets a key for besides the plan group (MG); a
   * service before MG sends no `api_keys` and no `device.keys` when unset.
   */
  keyGroups?: Json[];
  /** `GET /v1/models` by the key's group (MG); `models` otherwise. */
  modelsByGroup?: Record<number, string[]>;
  /** `GET /claudex/usage-status` data; default no windows. */
  usageStatus?: Json;
  /** `claudex_voice` (realtime dictation only); default off. */
  voice?: {
    transcription?: {
      enabled: boolean;
      /** Not sent by the service; only for tests of older answers. */
      model?: string;
      max_bytes?: number;
      /** Sent as `max_session_seconds`. */
      max_seconds?: number;
    };
  };
  /** `claudex_feedback`; default both off. */
  feedback?: {
    diagnostics?: boolean;
    feedback?: boolean;
    allowConversationExcerpt?: boolean;
  };
  /** Payment (`/api/v1/payment/*`); default off. */
  payment?: {
    enabled?: boolean;
    /** Payment types offered; default alipay, stripe and airwallex. */
    types?: string[];
    plans?: Json[];
  };
  /** Codes `POST /api/v1/redeem` accepts, with what each adds. */
  redeemCodes?: Record<
    string,
    { type: string; value: number; group_id?: number }
  >;
  /**
   * A gateway refusal for POST /v1/responses and /v1/chat/completions, with
   * the `claudex` object the service adds for device keys (or every key with
   * `allKeys`, as the usage-rule 429 does).
   */
  refusal?: {
    status: number;
    code: string;
    message: string;
    claudex?: Json;
    shape?: "middleware" | "openai";
    allKeys?: boolean;
  };
}

/** One request to a route: parsed body, path parameters and who sent it. */
export interface MockRequest {
  method: string;
  path: string;
  url: URL;
  headers: http.IncomingHttpHeaders;
  /** The JSON body, or {} when there is none or it is not JSON. */
  body: Json;
  raw: Buffer;
  params: Record<string, string>;
  /** The signed-in user (routes with `auth: "user"`). */
  userId?: number;
  /** The gateway key (routes with `auth: "key"`). */
  key?: MockKey;
}
export interface MockReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}
export type MockHandler = (
  request: MockRequest,
) => MockReply | Promise<MockReply>;
export type MockAuth = "user" | "key" | "none";

/** A success envelope. */
export const ok = (
  data: unknown,
  headers?: Record<string, string>,
): MockReply => ({
  status: 200,
  body: { code: 0, message: "success", data },
  headers,
});
/** An envelope error (`response.ErrorFrom`): metadata values are strings, as infraerrors sends them. */
export const fail = (
  status: number,
  message: string,
  reason: string,
  metadata?: Record<string, string>,
): MockReply => ({
  status,
  body: { code: status, message, reason, ...(metadata ? { metadata } : {}) },
});
/** A middleware or gateway error `{code:"STRING", message}`. */
export const failCode = (
  status: number,
  code: string,
  message: string,
  extra?: Json,
): MockReply => ({ status, body: { code, message, ...extra } });

/** The ETag the service computes: sha256 of the JSON without the ignored keys, first 16 bytes. */
export function mockETag(data: unknown, ignore: string[] = []) {
  const value =
    data && typeof data === "object" && !Array.isArray(data)
      ? Object.fromEntries(
          Object.entries(data).filter(([key]) => !ignore.includes(key)),
        )
      : data;
  const sum = createHash("sha256").update(JSON.stringify(value)).digest();
  return `W/"${sum.subarray(0, 16).toString("base64url")}"`;
}
function matchesETag(header: string | undefined, etag: string) {
  if (!header) return false;
  const want = etag.replace(/^W\//, "");
  return header
    .split(",")
    .map((item) => item.trim())
    .some((item) => item === "*" || item.replace(/^W\//, "") === want);
}
/** Semver-like precedence (pre-release before release, `+build` ignored). */
export function compareVersions(a: string, b: string) {
  const split = (value: string) => {
    const [core, pre] = value.split("+")[0].split(/-(.*)/s);
    return {
      nums: core.split(".").map(Number),
      pre: pre ? pre.split(".") : [],
    };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 4; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q))
      return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const iso = (ms: number) => new Date(ms).toISOString();
const uuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const versionPattern =
  /^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]{1,32})?(\+[0-9A-Za-z.-]{1,32})?$/;
const headerChecks: [string, (value: string) => boolean][] = [
  [
    claudexHeaderNames.platform,
    (v) => ["darwin", "win32", "linux"].includes(v),
  ],
  [claudexHeaderNames.arch, (v) => ["arm64", "x64"].includes(v)],
  [claudexHeaderNames.version, (v) => v.length <= 32 && versionPattern.test(v)],
  [claudexHeaderNames.deviceId, (v) => uuidPattern.test(v)],
];
/** Every attachment type the policy knows (design 2.3). */
const allAttachmentTypes =
  "png jpg jpeg webp gif pdf docx pptx xlsx txt md csv ts tsx js jsx py json yaml yml html css rs go java c cpp xml toml log".split(
    " ",
  );
const publicClaudexRoutes = new Set([
  "GET /api/v1/claudex/web-console",
  "GET /api/v1/claudex/release",
  "POST /api/v1/claudex/payment/checkout",
]);

interface CustomRoute {
  method: string;
  pattern: RegExp;
  names: string[];
  auth: MockAuth;
  handler: MockHandler;
}

export class MockSub2Api {
  url = "";
  /** "METHOD /path" of every request, in order. */
  calls: string[] = [];
  /** Every request's method, path and headers (lower-case names). */
  requests: {
    method: string;
    path: string;
    headers: http.IncomingHttpHeaders;
  }[] = [];
  keys: MockKey[] = [];
  /** POST, PUT and DELETE requests to `/api/v1/keys` (the legacy provisioning path). */
  keyWrites = 0;
  devices: MockDevice[] = [];
  orders: MockOrder[] = [];
  /** Accepted `POST /claudex/diagnostics` reports and `POST /claudex/feedback` bodies. */
  diagnostics: Json[] = [];
  feedback: Json[] = [];
  refreshTokens = new Map<string, number>();
  accessTokens = new Map<
    string,
    { userId: number; expiresAt: number; issuedAt: number }
  >();
  /** Per user: tokens issued at or before this time are signed out (revoke-all, H9b). */
  sessionsRevokedAt = new Map<number, number>();
  gatewayAuth: string[] = [];
  private server?: http.Server;
  private nextKey = 1;
  private nextDevice = 1;
  private nextOrder = 1000;
  private pending2fa = new Map<string, number>();
  private checkoutTokens = new Map<
    string,
    { orderId: number; expiresAt: number }
  >();
  private customRoutes: CustomRoute[] = [];
  constructor(public options: MockOptions = {}) {}
  get users() {
    return this.options.users ?? [];
  }
  private get claudex() {
    return this.options.claudex !== false;
  }

  /**
   * Adds a route answered before the built-in ones. `path` may name
   * parameters (`/api/v1/payment/orders/:id`). By default `/api/v1/*` needs
   * a signed-in user and `/v1/*` a gateway key; `auth` changes that.
   */
  route(
    method: string,
    path: string,
    handler: MockHandler,
    options: { auth?: MockAuth } = {},
  ) {
    const names: string[] = [];
    const pattern = new RegExp(
      "^" +
        path
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/:(\w+)/g, (_m, name) => {
            names.push(name);
            return "([^/]+)";
          }) +
        "$",
    );
    const auth =
      options.auth ??
      (path.startsWith("/api/v1/")
        ? "user"
        : path.startsWith("/v1/")
          ? "key"
          : "none");
    this.customRoutes.unshift({
      method: method.toUpperCase(),
      pattern,
      names,
      auth,
      handler,
    });
    return this;
  }

  private issue(userId: number) {
    const access = `at_${randomBytes(16).toString("hex")}`;
    const refresh = `rt_${randomBytes(32).toString("hex")}`;
    const ttl = this.options.accessTtlSeconds ?? 86400;
    const now = Date.now();
    this.accessTokens.set(access, {
      userId,
      expiresAt: now + ttl * 1000,
      issuedAt: now,
    });
    this.refreshTokens.set(refresh, userId);
    const user = this.users.find((item) => item.id === userId)!;
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: ttl,
      token_type: "Bearer",
      user: {
        id: user.id,
        email: user.email,
        username: user.username ?? "",
        role: "user",
        balance: user.balance ?? 0,
      },
    };
  }
  /** Invalidates every access token, as if they had expired. */
  expireAccessTokens() {
    this.accessTokens.clear();
  }
  /** The signed-in user, "revoked" for a signed-out session (H9b), or undefined. */
  private authUser(req: http.IncomingMessage): number | "revoked" | undefined {
    const token = String(req.headers.authorization ?? "").replace(
      /^Bearer /,
      "",
    );
    const entry = this.accessTokens.get(token);
    if (!entry || entry.expiresAt <= Date.now()) return undefined;
    const revokedAt = this.sessionsRevokedAt.get(entry.userId);
    if (this.claudex && revokedAt !== undefined && entry.issuedAt <= revokedAt)
      return "revoked";
    return entry.userId;
  }
  private keyUser(req: http.IncomingMessage) {
    const token = String(req.headers.authorization ?? "").replace(
      /^Bearer /,
      "",
    );
    this.gatewayAuth.push(token);
    return this.keys.find((key) => key.key === token);
  }
  async start() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve),
    );
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this.url;
  }
  async close() {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  // ---- plan, policy, catalog and bootstrap state

  /** The plan group (design 2.5): longest active subscription, else the default group, else the lowest usable group. */
  planFor(userId: number, requested?: number | null): Json | undefined {
    const groups = (this.options.groups ?? []).filter(
      (group) => (group.status ?? "active") === "active",
    );
    const byId = new Map(groups.map((group) => [group.id as number, group]));
    const subscriptions = (this.options.subscriptions ?? [])
      .filter((item) => (item.status ?? "active") === "active")
      .map((item) => ({
        item,
        group:
          (item.group as Json | undefined) ?? byId.get(item.group_id as number),
      }))
      .filter((entry) => entry.group);
    const ref = (group: Json, subscription?: Json): Json => ({
      group_id: group.id,
      group_name: group.name ?? "",
      platform: group.platform ?? "",
      protocol: group.platform === "openai" ? "responses" : "chat",
      subscription_type: group.subscription_type ?? "standard",
      subscription_id: subscription?.id ?? null,
      expires_at: subscription?.expires_at ?? null,
      subscribed: !!subscription,
    });
    if (requested != null) {
      const subscribed = subscriptions.find(
        (entry) => entry.group!.id === requested,
      );
      if (subscribed) return ref(subscribed.group!, subscribed.item);
      if (byId.has(requested)) return ref(byId.get(requested)!);
    }
    const latest = subscriptions.sort(
      (a, b) =>
        Date.parse(String(b.item.expires_at ?? "9999")) -
          Date.parse(String(a.item.expires_at ?? "9999")) ||
        (a.group!.id as number) - (b.group!.id as number),
    )[0];
    if (latest) return ref(latest.group!, latest.item);
    const fallback =
      (this.options.defaultGroupId !== undefined &&
        byId.get(this.options.defaultGroupId)) ||
      [...groups].sort((a, b) => (a.id as number) - (b.id as number))[0];
    return fallback ? ref(fallback) : undefined;
  }
  /** The policy one user gets (`GET /claudex/policy`). */
  policyFor(userId: number): Json {
    const plan = this.planFor(userId);
    const settings = this.options.settings ?? {};
    const purchase =
      settings.purchase_subscription_enabled === true
        ? (settings.purchase_subscription_url as string | undefined) || null
        : null;
    return {
      revision: 0,
      group_id: plan?.group_id ?? null,
      permission_modes: ["auto", "manual", "acceptEdits", "plan"],
      incognito: true,
      web_search: true,
      web_search_default: false,
      voice: true,
      local_mcp_editing: true,
      remote_images: true,
      remote_image_domains: null,
      external_links: true,
      trusted_link_domains: [],
      connectors: null,
      attachments: { max_bytes: null, types: allAttachmentTypes },
      links: {
        help: (settings.doc_url as string | undefined) || null,
        plans: purchase,
        apps: null,
        get_more_usage: purchase,
        usage_learn_more: null,
        learn_more: [],
      },
      usage_banner: { warn_percent: 80 },
      plan_label: null,
      scheduled_tasks: { enabled: true, max_tasks: null },
      approvals_always_allow: true,
      ...this.options.policy,
    };
  }
  catalogFor(userId: number): Json {
    return {
      group_id: this.planFor(userId)?.group_id ?? null,
      default_model: null,
      items: [],
      ...this.options.catalog,
    };
  }
  /** The release fields for a platform, architecture and version (design 2.2). */
  releaseFor(platform: string, arch: string, version: string): Json {
    const release = this.options.release;
    const latest = release?.latest_version ?? null;
    const minimum = release?.minimum_version ?? null;
    const download =
      platform && arch
        ? release?.downloads?.[`${platform}-${arch}`]
        : undefined;
    const state =
      !latest || !version
        ? "unknown"
        : minimum && compareVersions(version, minimum) < 0
          ? "required"
          : compareVersions(version, latest) < 0
            ? "available"
            : "current";
    return {
      channel: release ? "stable" : null,
      latest_version: latest,
      minimum_version: minimum,
      state,
      enforced: release?.enforce_minimum_on_gateway === true,
      download_url: download?.url ?? null,
      sha256: download?.sha256 || null,
      release_notes_url: release?.release_notes_url ?? null,
      release_notes_md: release?.release_notes_md ?? null,
      published_at: release?.published_at ?? null,
    };
  }
  /** The realtime dictation section as the service sends it (B7, owner decisions 18/19). */
  private voiceSection(plan: Json | undefined): Json {
    const openai = plan?.platform === "openai";
    const stt = this.options.voice?.transcription;
    const on = !!stt?.enabled;
    return {
      transcription: on
        ? {
            enabled: true,
            protocol: "websocket",
            path: "/v1/audio/realtime/transcriptions",
            audio: { format: "pcm_s16le", sample_rate: 16000, channels: 1 },
            max_session_seconds: stt.max_seconds ?? 600,
            max_bytes: stt.max_bytes ?? 19200000,
            idle_timeout_seconds: 30,
            // Not sent by the service; kept for tests of older answers.
            ...(stt.model ? { model: stt.model } : {}),
          }
        : {
            enabled: false,
            protocol: "websocket",
            path: null,
            audio: null,
            max_session_seconds: 0,
            max_bytes: 0,
            idle_timeout_seconds: 0,
          },
      available: { transcription: on && openai },
    };
  }
  usageStatusFor(userId: number): Json {
    const plan = this.planFor(userId);
    const user = this.users.find((item) => item.id === userId);
    return {
      plan: {
        group_id: plan?.group_id ?? 0,
        group_name: plan?.group_name ?? "",
        subscription_id: plan?.subscription_id ?? null,
        billing_mode: plan?.subscribed ? "subscription" : "balance",
      },
      windows: [],
      balance: { balance_usd: user?.balance ?? 0 },
      blocked: {
        blocked: false,
        window_id: null,
        reason: null,
        resets_at: null,
      },
      updated_at: iso(Date.now()),
      ...this.options.usageStatus,
    };
  }
  /** Bootstrap `device` for a user and the raw device id (design 2.5). */
  deviceStatus(userId: number, deviceId: string, plan: Json | undefined): Json {
    const device = this.devices.find(
      (item) => item.userId === userId && item.deviceId === deviceId,
    );
    const key =
      device?.keyId != null
        ? this.keys.find((item) => item.id === device.keyId)
        : undefined;
    const extra = this.options.keyGroups;
    const groupKeys = (extra ?? []).map((group) => {
      const id = device?.groupKeys?.[group.id as number];
      return { group, key: this.keys.find((item) => item.id === id) };
    });
    return {
      registered: !!device,
      id: device?.id ?? null,
      key_group_id: key?.group_id ?? null,
      revoked: !!device?.revokedAt,
      // Without a plan group the device holds no key (balance only).
      reprovision_needed: !plan
        ? !device || !!device.revokedAt || device.keyId != null
        : !device ||
          !!device.revokedAt ||
          !key ||
          key.status !== "active" ||
          (plan !== undefined && key.group_id !== plan.group_id) ||
          groupKeys.some((item) => item.key?.status !== "active"),
      ...(extra
        ? {
            keys: [
              ...(key && plan
                ? [
                    {
                      api_key_id: key.id,
                      group_id: key.group_id,
                      group_name: plan.group_name,
                      platform: plan.platform,
                      protocol: plan.protocol,
                      primary: true,
                    },
                  ]
                : []),
              ...groupKeys
                .filter((item) => item.key?.status === "active")
                .map(({ group, key }) => ({
                  api_key_id: key!.id,
                  group_id: group.id,
                  group_name: group.name,
                  platform: group.platform,
                  protocol: group.platform === "openai" ? "responses" : "chat",
                  primary: false,
                })),
            ],
          }
        : {}),
    };
  }
  bootstrapFor(userId: number, headers: http.IncomingHttpHeaders): Json {
    const header = (name: string) => String(headers[name.toLowerCase()] ?? "");
    const plan = this.planFor(userId);
    const voice = this.voiceSection(plan);
    const usage = this.usageStatusFor(userId);
    const feedback = this.options.feedback ?? {};
    const payment = this.options.payment?.enabled === true;
    const data: Json = {
      schema_version: 1,
      generated_at: iso(Date.now()),
      server: {
        site_name: String(this.options.settings?.site_name ?? "Sub2API"),
        version: this.options.serverVersion ?? "0.2.8+claudex.1",
        timezone: "UTC",
      },
      ...(plan ? { plan } : {}),
      device: this.deviceStatus(
        userId,
        header(claudexHeaderNames.deviceId),
        plan,
      ),
      policy: this.policyFor(userId),
      models: this.catalogFor(userId),
      release: this.releaseFor(
        header(claudexHeaderNames.platform),
        header(claudexHeaderNames.arch),
        header(claudexHeaderNames.version),
      ),
      voice,
      usage: {
        rules_enabled: (usage.windows as Json[]).some(
          (item) => item.source === "rule",
        ),
        has_session_window: (usage.windows as Json[]).some(
          (item) => item.kind === "session",
        ),
      },
      feedback: {
        diagnostics: { enabled: feedback.diagnostics === true },
        feedback: {
          enabled: feedback.feedback === true,
          allow_conversation_excerpt:
            feedback.allowConversationExcerpt === true,
        },
      },
      features: {
        device_keys: this.options.deviceKeys !== false,
        usage_status: true,
        structured_refusals: true,
        model_catalog: true,
        voice_transcription: (voice.available as Json).transcription,
        voice_speech: false,
        payment,
        desktop_checkout: payment,
        redeem: true,
        diagnostics: feedback.diagnostics === true,
        feedback: feedback.feedback === true,
        self_delete: false,
        announcements: true,
      },
      errors: plan ? [] : [{ section: "plan", code: "CLAUDEX_NO_PLAN" }],
    };
    return data;
  }
  private isDeviceKey(key: MockKey) {
    return this.devices.some((device) => device.keyId === key.id);
  }

  // ---- request handling

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    this.calls.push(route);
    this.requests.push({ method, path: url.pathname, headers: req.headers });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body: Json = {};
    if (
      raw.length &&
      !/multipart|octet-stream/.test(String(req.headers["content-type"] ?? ""))
    )
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          body = parsed as Json;
      } catch {
        /* Not JSON; handlers read `raw`. */
      }
    const request: MockRequest = {
      method,
      path: url.pathname,
      url,
      headers: req.headers,
      body,
      raw,
      params: {},
    };
    let reply: MockReply;
    try {
      reply = await this.dispatch(request, req);
    } catch (error) {
      reply = fail(
        500,
        error instanceof Error ? error.message : String(error),
        "",
      );
    }
    const payload =
      reply.body === undefined
        ? undefined
        : Buffer.isBuffer(reply.body) || reply.body instanceof Uint8Array
          ? Buffer.from(reply.body)
          : Buffer.from(JSON.stringify(reply.body));
    res.writeHead(reply.status, {
      ...(payload &&
      !(Buffer.isBuffer(reply.body) || reply.body instanceof Uint8Array)
        ? { "content-type": "application/json" }
        : {}),
      ...reply.headers,
    });
    res.end(payload);
  }

  private unauthorized = () => failCode(401, "INVALID_TOKEN", "Invalid token");
  private revoked = () =>
    failCode(
      401,
      "CLAUDEX_SESSION_REVOKED",
      "This session was signed out. Sign in again.",
    );

  private async dispatch(
    request: MockRequest,
    req: http.IncomingMessage,
  ): Promise<MockReply> {
    const { method, path } = request;
    const route = `${method} ${path}`;
    for (const custom of this.customRoutes) {
      if (custom.method !== method) continue;
      const match = custom.pattern.exec(path);
      if (!match) continue;
      request.params = Object.fromEntries(
        custom.names.map((name, index) => [
          name,
          decodeURIComponent(match[index + 1]),
        ]),
      );
      if (custom.auth === "user") {
        const user = this.authUser(req);
        if (user === "revoked") return this.revoked();
        if (!user) return this.unauthorized();
        request.userId = user;
      } else if (custom.auth === "key") {
        const key = this.keyUser(req);
        if (!key) return failCode(401, "INVALID_API_KEY", "Invalid API key");
        request.key = key;
      }
      return await custom.handler(request);
    }

    const { body } = request;
    if (route === "GET /api/v1/settings/public")
      return ok({
        registration_enabled: false,
        email_verify_enabled: false,
        invitation_code_enabled: false,
        promo_code_enabled: true,
        totp_enabled: false,
        site_name: "Sub2API",
        ...this.options.settings,
      });
    if (route === "POST /api/v1/auth/login") {
      const user = this.users.find(
        (item) => item.email === body.email && item.password === body.password,
      );
      if (!user)
        return fail(401, "invalid email or password", "INVALID_CREDENTIALS");
      if (user.totp) {
        const temp = randomBytes(8).toString("hex");
        this.pending2fa.set(temp, user.id);
        return ok({
          requires_2fa: true,
          temp_token: temp,
          user_email_masked: "u***@example.test",
        });
      }
      return ok(this.issue(user.id));
    }
    if (route === "POST /api/v1/auth/login/2fa") {
      const userId = this.pending2fa.get(String(body.temp_token));
      if (!userId)
        return fail(
          400,
          "Invalid or expired 2FA session",
          "CLAUDEX_2FA_SESSION_EXPIRED",
        );
      const user = this.users.find((item) => item.id === userId)!;
      if (body.totp_code !== user.totp)
        return fail(400, "invalid totp code", "TOTP_INVALID_CODE");
      this.pending2fa.delete(String(body.temp_token));
      return ok(this.issue(userId));
    }
    if (route === "POST /api/v1/auth/register") {
      if (!this.options.settings?.registration_enabled)
        return fail(
          403,
          "registration is currently disabled",
          "REGISTRATION_DISABLED",
        );
      if (
        this.options.settings?.invitation_code_enabled &&
        body.invitation_code !== "INVITE-1"
      )
        return fail(
          400,
          "invalid or used invitation code",
          "INVITATION_CODE_INVALID",
        );
      const user = {
        id: this.users.length + 100,
        email: String(body.email),
        password: String(body.password),
      };
      this.options.users = [...this.users, user];
      return ok(this.issue(user.id));
    }
    if (route === "POST /api/v1/auth/refresh") {
      const userId = this.refreshTokens.get(String(body.refresh_token));
      if (!userId)
        return fail(401, "invalid refresh token", "REFRESH_TOKEN_INVALID");
      // Rotation: the used token stops working.
      this.refreshTokens.delete(String(body.refresh_token));
      const { user: _user, ...pair } = this.issue(userId);
      return ok(pair);
    }
    if (route === "POST /api/v1/auth/logout") {
      this.refreshTokens.delete(String(body.refresh_token));
      return ok({ message: "Logged out successfully" });
    }
    if (path.startsWith("/api/v1/claudex/") || path === "/api/v1/claudex") {
      if (!this.claudex) return fail(404, "not found", "NOT_FOUND");
      for (const [name, valid] of headerChecks) {
        const value = request.headers[name.toLowerCase()];
        if (value !== undefined && !valid(String(value).trim()))
          return fail(
            400,
            `Invalid ${name} header`,
            "CLAUDEX_INVALID_CLIENT_HEADER",
            {
              header: name,
            },
          );
      }
      if (publicClaudexRoutes.has(route)) return this.claudexPublic(request);
    }
    if (path.startsWith("/api/v1/")) {
      const user = this.authUser(req);
      if (user === "revoked") return this.revoked();
      if (!user) return this.unauthorized();
      request.userId = user;
      if (path.startsWith("/api/v1/claudex/")) return this.claudexUser(request);
      return this.userApi(request);
    }
    if (path.startsWith("/v1/")) {
      const key = this.keyUser(req);
      if (!key) return failCode(401, "INVALID_API_KEY", "Invalid API key");
      request.key = key;
      return this.gateway(request);
    }
    return { status: 404, body: { message: "not found" } };
  }

  private userApi(request: MockRequest): MockReply {
    const { method, path, body } = request;
    const route = `${method} ${path}`;
    const userId = request.userId!;
    const user = this.users.find((item) => item.id === userId)!;
    if (route === "POST /api/v1/auth/revoke-all-sessions") {
      for (const [token, owner] of this.refreshTokens)
        if (owner === userId) this.refreshTokens.delete(token);
      if (this.claudex) {
        // H9: every device of the user is signed out and its key disabled;
        // the user's own keys are never touched (owner decision 13).
        const now = Date.now();
        this.sessionsRevokedAt.set(userId, now);
        for (const device of this.devices)
          if (device.userId === userId && !device.revokedAt) {
            device.revokedAt = iso(now);
            device.revokedReason = "revoke_all";
            const key = this.keys.find((item) => item.id === device.keyId);
            if (key) key.status = "disabled";
          }
      }
      return ok({ message: "All sessions have been revoked." });
    }
    if (route === "GET /api/v1/auth/me")
      return ok({
        id: user.id,
        email: user.email,
        username: user.username ?? "",
      });
    if (route === "GET /api/v1/user/profile")
      return ok({
        id: user.id,
        email: user.email,
        username: user.username ?? "",
        role: "user",
        balance: user.balance ?? 0,
        status: "active",
      });
    if (route === "GET /api/v1/groups/available")
      return ok(this.options.groups ?? []);
    if (route === "GET /api/v1/subscriptions/active")
      return ok(this.options.subscriptions ?? []);
    if (route === "GET /api/v1/subscriptions/progress")
      return ok(this.options.progress ?? []);
    if (path === "/api/v1/keys" || path.startsWith("/api/v1/keys/"))
      return this.keysApi(request, userId);
    if (path.startsWith("/api/v1/payment/"))
      return this.paymentApi(request, userId);
    if (route === "POST /api/v1/redeem") {
      const code = this.options.redeemCodes?.[String(body.code)];
      if (!code)
        return fail(404, "redeem code not found", "REDEEM_CODE_NOT_FOUND");
      delete this.options.redeemCodes![String(body.code)];
      if (code.type === "balance")
        user.balance = (user.balance ?? 0) + code.value;
      const group = (this.options.groups ?? []).find(
        (item) => item.id === code.group_id,
      );
      const redeemed = {
        id: this.nextOrder++,
        code: String(body.code),
        type: code.type,
        value: code.value,
        status: "used",
        used_by: userId,
        used_at: iso(Date.now()),
        created_at: iso(Date.now()),
        group_id: code.group_id ?? null,
        validity_days: code.type === "subscription" ? 30 : 0,
        ...(group ? { group } : {}),
      };
      this.redeemed.push(redeemed);
      return ok(redeemed);
    }
    if (route === "GET /api/v1/redeem/history")
      return ok(this.redeemed.filter((item) => item.used_by === userId));
    return fail(404, "not found", "NOT_FOUND");
  }
  private redeemed: Json[] = [];

  private keysApi(request: MockRequest, userId: number): MockReply {
    const { method, path, body, url } = request;
    if (method !== "GET") this.keyWrites++;
    const managed = (key: MockKey) => this.claudex && this.isDeviceKey(key);
    if (method === "GET" && path === "/api/v1/keys") {
      const search = url.searchParams.get("search") ?? "";
      const page = Number(url.searchParams.get("page") ?? 1);
      const size = Number(url.searchParams.get("page_size") ?? 20);
      const mine = this.keys
        .filter((key) => key.user_id === userId && key.name.includes(search))
        // H13: device keys are listed without the secret.
        .map((key) =>
          managed(key)
            ? { ...key, key: `${key.key.slice(0, 5)}…${key.key.slice(-4)}` }
            : key,
        );
      return ok({
        items: mine.slice((page - 1) * size, page * size),
        total: mine.length,
        page,
        page_size: size,
        pages: Math.max(1, Math.ceil(mine.length / size)),
      });
    }
    if (method === "POST" && path === "/api/v1/keys") {
      if (this.claudex && this.options.userApiKeys === false)
        return fail(
          403,
          "Creating API keys is turned off on this server. Contact your administrator.",
          "CLAUDEX_USER_API_KEYS_DISABLED",
        );
      const key: MockKey = {
        id: this.nextKey++,
        user_id: userId,
        name: String(body.name),
        key: `sk-${randomBytes(32).toString("hex")}`,
        group_id: typeof body.group_id === "number" ? body.group_id : null,
        status: "active",
      };
      this.keys.push(key);
      return ok(key);
    }
    const one = /^\/api\/v1\/keys\/(\d+)$/.exec(path);
    if (one && (method === "PUT" || method === "DELETE")) {
      const key = this.keys.find(
        (item) => item.id === Number(one[1]) && item.user_id === userId,
      );
      if (!key) return fail(404, "not found", "API_KEY_NOT_FOUND");
      if (managed(key))
        return fail(
          403,
          "This key belongs to a Claudex desktop sign-in. Sign out of that device instead.",
          "CLAUDEX_DEVICE_KEY_MANAGED",
        );
      if (method === "DELETE") {
        this.keys = this.keys.filter((item) => item !== key);
        return ok({ message: "API key deleted successfully" });
      }
      if (typeof body.group_id === "number") key.group_id = body.group_id;
      if (typeof body.status === "string") key.status = body.status;
      return ok(key);
    }
    return fail(404, "not found", "NOT_FOUND");
  }

  private claudexPublic(request: MockRequest): MockReply {
    const { path, url, headers, body } = request;
    const header = (name: string) => String(headers[name.toLowerCase()] ?? "");
    if (path === "/api/v1/claudex/web-console")
      return ok(
        { admin_only: this.options.webConsoleAdminOnly !== false },
        { "Cache-Control": "public, max-age=60" },
      );
    if (path === "/api/v1/claudex/release")
      return ok(
        {
          api_version: 1,
          server: {
            version: this.options.serverVersion ?? "0.2.8+claudex.1",
            build_type: "source",
          },
          ...this.releaseFor(
            url.searchParams.get("platform") ??
              header(claudexHeaderNames.platform),
            url.searchParams.get("arch") ?? header(claudexHeaderNames.arch),
            url.searchParams.get("version") ??
              header(claudexHeaderNames.version),
          ),
        },
        {
          "Cache-Control": "public, max-age=60",
          Vary: "X-Claudex-Platform, X-Claudex-Arch, X-Claudex-Version",
        },
      );
    // POST /api/v1/claudex/payment/checkout
    const entry = this.checkoutTokens.get(String(body.token ?? ""));
    const order =
      entry && this.orders.find((item) => item.id === entry.orderId);
    if (!entry || !order || entry.expiresAt <= Date.now())
      return fail(
        404,
        "This checkout link has expired. Go back to Claudex to try again.",
        "CLAUDEX_CHECKOUT_NOT_FOUND",
      );
    const pending = order.status === "PENDING";
    return ok(
      {
        order_id: order.id,
        status: order.status,
        provider: order.payment_type,
        amount: order.amount,
        pay_amount: order.pay_amount,
        currency: order.currency,
        expires_at: order.expires_at,
        stripe:
          pending && order.payment_type === "stripe"
            ? {
                publishable_key: "pk_test_mock",
                client_secret: order.client_secret,
              }
            : null,
        airwallex:
          pending && order.payment_type === "airwallex"
            ? {
                env: "demo",
                intent_id: order.intent_id,
                client_secret: order.client_secret,
                currency: order.currency,
                country_code: "US",
              }
            : null,
        result_path: `/payment/result?resume_token=${order.resume_token}`,
      },
      { "Cache-Control": "no-store" },
    );
  }

  private etagged(
    request: MockRequest,
    data: Json,
    ignore: string[] = [],
  ): MockReply {
    const etag = mockETag(data, ignore);
    const headers = {
      ETag: etag,
      "Cache-Control": "private, no-cache",
      Vary: "Authorization, X-Claudex-Platform, X-Claudex-Version, X-Claudex-Device-Id",
    };
    if (
      matchesETag(request.headers["if-none-match"] as string | undefined, etag)
    )
      return { status: 304, headers };
    return ok(data, headers);
  }

  private claudexUser(request: MockRequest): MockReply {
    const { method, path, headers, body } = request;
    const route = `${method} ${path}`;
    const userId = request.userId!;
    const deviceId = String(
      headers[claudexHeaderNames.deviceId.toLowerCase()] ?? "",
    );
    const noStore = { "Cache-Control": "no-store" };
    if (route === "GET /api/v1/claudex/capabilities")
      return ok(
        {
          api_version: 1,
          features: [
            "webconsole",
            "client-release",
            "client-policy",
            "model-catalog",
            "devices",
            "usage-rules",
            "refusal",
            "voice",
            "feedback",
            "bootstrap",
            "payment",
          ],
        },
        noStore,
      );
    if (route === "GET /api/v1/claudex/bootstrap")
      return this.etagged(request, this.bootstrapFor(userId, headers), [
        "generated_at",
      ]);
    if (route === "GET /api/v1/claudex/policy")
      return this.etagged(request, this.policyFor(userId));
    if (route === "GET /api/v1/claudex/models")
      return this.etagged(request, this.catalogFor(userId));
    if (route === "GET /api/v1/claudex/usage-status")
      return ok(this.usageStatusFor(userId), noStore);
    if (route === "POST /api/v1/claudex/devices")
      return this.registerDevice(request);
    if (route === "GET /api/v1/claudex/devices")
      return ok(
        {
          items: this.devices
            .filter((device) => device.userId === userId)
            .map((device) => ({
              id: device.id,
              device_name: device.deviceName,
              platform: device.platform,
              arch: device.arch,
              app_version: device.appVersion,
              group_id: device.groupId,
              current: device.deviceId === deviceId,
              revoked: !!device.revokedAt,
              last_seen_at: device.lastSeenAt,
              created_at: device.createdAt,
            })),
          limit: this.options.deviceLimit ?? 5,
        },
        noStore,
      );
    const revoke = /^DELETE \/api\/v1\/claudex\/devices\/(current|\d+)$/.exec(
      route,
    );
    if (revoke) {
      const device = this.devices.find(
        (item) =>
          item.userId === userId &&
          (revoke[1] === "current"
            ? item.deviceId === deviceId
            : item.id === Number(revoke[1])),
      );
      if (!device)
        return fail(
          404,
          "This device is not signed in to Claudex.",
          "CLAUDEX_DEVICE_NOT_FOUND",
        );
      device.revokedAt = iso(Date.now());
      device.revokedReason = "user";
      const key = this.keys.find((item) => item.id === device.keyId);
      if (key) key.status = "disabled";
      return ok({ revoked: true }, noStore);
    }
    if (
      route === "POST /api/v1/claudex/diagnostics" ||
      route === "POST /api/v1/claudex/feedback"
    ) {
      const diagnostics = route.endsWith("diagnostics");
      const settings = this.options.feedback ?? {};
      if (!(diagnostics ? settings.diagnostics : settings.feedback))
        return fail(
          404,
          "Reporting is turned off on this server.",
          "CLAUDEX_FEEDBACK_DISABLED",
        );
      if (body.consent !== true)
        return fail(
          400,
          "Reports need the person's consent.",
          "CLAUDEX_CONSENT_REQUIRED",
        );
      if (diagnostics) {
        const reports = Array.isArray(body.reports)
          ? (body.reports as Json[])
          : [];
        let duplicates = 0;
        for (const report of reports.slice(0, 50)) {
          if (this.diagnostics.some((item) => item.id === report.id))
            duplicates++;
          else
            this.diagnostics.push({
              ...report,
              // The service keeps no upstream text for refusals.
              ...(report.kind === "gateway_refusal" ? { message: "" } : {}),
            });
        }
        return ok(
          {
            accepted: Math.min(reports.length, 50) - duplicates,
            duplicates,
            dropped: 0,
          },
          noStore,
        );
      }
      const duplicate = this.feedback.some((item) => item.id === body.id);
      const excerptDropped =
        body.conversation_excerpt != null &&
        settings.allowConversationExcerpt !== true;
      if (!duplicate)
        this.feedback.push({
          ...body,
          conversation_excerpt: excerptDropped
            ? null
            : (body.conversation_excerpt ?? null),
        });
      return ok(
        { accepted: true, duplicate, excerpt_dropped: excerptDropped },
        noStore,
      );
    }
    if (route === "POST /api/v1/claudex/payment/checkout-links") {
      const order = this.orders.find((item) => item.id === body.order_id);
      const valid =
        order &&
        order.user_id === userId &&
        order.status === "PENDING" &&
        Date.parse(order.expires_at) > Date.now() &&
        body.resume_token === order.resume_token &&
        (order.payment_type === "stripe"
          ? String(body.client_secret ?? "").startsWith(
              `${order.out_trade_no}_secret_`,
            )
          : order.payment_type === "airwallex" &&
            body.intent_id === order.out_trade_no);
      if (!valid)
        return fail(
          409,
          "This order can't be paid in the browser.",
          "CLAUDEX_CHECKOUT_UNAVAILABLE",
        );
      const token = randomBytes(32).toString("base64url");
      const expiresAt = Math.min(
        Date.now() + 30 * 60_000,
        Date.parse(order.expires_at),
      );
      this.checkoutTokens.set(token, { orderId: order.id, expiresAt });
      return ok({ token, expires_at: iso(expiresAt) }, noStore);
    }
    return fail(404, "not found", "NOT_FOUND");
  }

  /**
   * An account without a plan group still registers: the device row has no key,
   * and every key it held is deleted.
   */
  private registerWithoutPlan(
    request: MockRequest,
    deviceId: string,
    found: MockDevice | undefined,
    now: number,
  ): MockReply {
    const userId = request.userId!;
    const body = request.body;
    let device = found;
    const created = !device;
    if (!device) {
      const limit = this.options.deviceLimit ?? 5;
      const active = this.devices.filter(
        (item) => item.userId === userId && !item.revokedAt,
      ).length;
      if (active >= limit)
        return fail(
          409,
          `You're signed in to Claudex on ${limit} devices, the most your account allows. Sign out on one of them, then sign in again.`,
          "CLAUDEX_DEVICE_LIMIT",
          { limit: String(limit), active: String(active) },
        );
      device = {
        id: this.nextDevice++,
        userId,
        deviceId,
        keyId: null,
        groupId: null,
        deviceName: "",
        platform: "",
        arch: "",
        appVersion: "",
        createdAt: iso(now),
        lastSeenAt: iso(now),
        revokedAt: null,
        revokedReason: "",
        registrations: [],
      };
      this.devices.push(device);
    }
    const held = new Set<number>([
      ...(device.keyId != null ? [device.keyId] : []),
      ...Object.values(device.groupKeys ?? {}),
    ]);
    this.keys = this.keys.filter((key) => !held.has(key.id));
    device.keyId = null;
    device.groupId = null;
    device.groupKeys = {};
    device.revokedAt = null;
    device.revokedReason = "";
    device.registrations.push(now);
    device.deviceName = String(body.device_name ?? "").slice(0, 100);
    device.platform = String(body.platform ?? "");
    device.arch = String(body.arch ?? "");
    device.appVersion = String(body.app_version ?? "").slice(0, 32);
    device.lastSeenAt = iso(now);
    return ok({
      device: {
        id: device.id,
        device_name: device.deviceName,
        platform: device.platform,
        arch: device.arch,
        app_version: device.appVersion,
        created_at: device.createdAt,
        last_seen_at: device.lastSeenAt,
      },
      api_key: null,
      api_keys: [],
      created,
      moved: false,
      rotated: false,
      plan: null,
    });
  }

  /** `POST /api/v1/claudex/devices` (design 2.5): idempotent per (user, device). */
  private registerDevice(request: MockRequest): MockReply {
    const userId = request.userId!;
    const { body, headers } = request;
    const deviceId = String(
      headers[claudexHeaderNames.deviceId.toLowerCase()] ?? "",
    );
    if (!deviceId)
      return fail(
        400,
        "X-Claudex-Device-Id is required.",
        "CLAUDEX_DEVICE_INVALID",
        {
          field: "X-Claudex-Device-Id",
          rule: "required",
        },
      );
    if (this.options.deviceKeys === false)
      return fail(
        403,
        "Your administrator has turned off Claudex sign-in for this service.",
        "CLAUDEX_DEVICE_KEYS_DISABLED",
      );
    const now = Date.now();
    let device = this.devices.find(
      (item) => item.userId === userId && item.deviceId === deviceId,
    );
    if (device && this.options.registrationThrottle !== false) {
      device.registrations = device.registrations.filter(
        (at) => at > now - 60_000,
      );
      if (device.registrations.length >= 2)
        return fail(
          429,
          "Too many sign-in attempts from this device. Try again in a minute.",
          "CLAUDEX_DEVICE_REGISTRATION_THROTTLED",
        );
    }
    const plan = this.planFor(
      userId,
      typeof body.group_id === "number" ? body.group_id : null,
    );
    if (!plan) return this.registerWithoutPlan(request, deviceId, device, now);
    const groupId = plan.group_id as number;
    const hash = createHash("sha256")
      .update(`claudex-device\n${deviceId}`)
      .digest("hex");
    const newKey = () => {
      const key: MockKey = {
        id: this.nextKey++,
        user_id: userId,
        name: `claudex-device:${hash.slice(0, 12)}`,
        key: `sk-${randomBytes(32).toString("hex")}`,
        group_id: groupId,
        status: "active",
      };
      this.keys.push(key);
      return key;
    };
    const active = this.devices.filter(
      (item) => item.userId === userId && !item.revokedAt,
    ).length;
    const limit = this.options.deviceLimit ?? 5;
    const overLimit = () =>
      fail(
        409,
        `You're signed in to Claudex on ${limit} devices, the most your account allows. Sign out on one of them, then sign in again.`,
        "CLAUDEX_DEVICE_LIMIT",
        { limit: String(limit), active: String(active) },
      );
    let created = false;
    let moved = false;
    let rotated = false;
    let key: MockKey | undefined;
    if (!device) {
      if (active >= limit) return overLimit();
      // Owner decision 10: a legacy key of this device is disabled, not adopted.
      for (const legacy of this.keys)
        if (
          legacy.user_id === userId &&
          legacy.name === `claudex-desktop:${deviceId}` &&
          legacy.status === "active"
        )
          legacy.status = "disabled";
      key = newKey();
      device = {
        id: this.nextDevice++,
        userId,
        deviceId,
        keyId: key.id,
        groupId,
        deviceName: "",
        platform: "",
        arch: "",
        appVersion: "",
        createdAt: iso(now),
        lastSeenAt: iso(now),
        revokedAt: null,
        revokedReason: "",
        registrations: [],
      };
      this.devices.push(device);
      created = true;
    } else if (device.revokedAt) {
      const token = String(headers.authorization ?? "").replace(/^Bearer /, "");
      const issuedAt = this.accessTokens.get(token)?.issuedAt ?? 0;
      if (
        (device.revokedReason === "admin" ||
          device.revokedReason === "revoke_all") &&
        issuedAt <= Date.parse(device.revokedAt)
      )
        return this.revoked();
      if (active >= limit) return overLimit();
      this.keys = this.keys.filter((item) => item.id !== device!.keyId);
      key = newKey();
      device.keyId = key.id;
      device.revokedAt = null;
      device.revokedReason = "";
      rotated = true;
    } else {
      key = this.keys.find((item) => item.id === device!.keyId);
      if (!key || key.status !== "active") {
        this.keys = this.keys.filter((item) => item !== key);
        key = newKey();
        device.keyId = key.id;
        rotated = true;
      } else if (key.group_id !== groupId) {
        key.group_id = groupId;
        moved = true;
      }
    }
    // MG: one more key per other group, reused while it is active.
    const extraKeys = (this.options.keyGroups ?? []).map((group) => {
      const gid = group.id as number;
      device!.groupKeys ??= {};
      let own = this.keys.find(
        (item) =>
          item.id === device!.groupKeys![gid] && item.status === "active",
      );
      if (!own || rotated) {
        own = { ...newKey(), group_id: gid };
        this.keys[this.keys.length - 1] = own;
        device!.groupKeys[gid] = own.id;
      }
      return {
        id: own.id,
        key: own.key,
        status: own.status,
        group_id: gid,
        group_name: group.name,
        platform: group.platform,
        protocol: group.platform === "openai" ? "responses" : "chat",
        primary: false,
      };
    });
    device.registrations.push(now);
    device.groupId = groupId;
    device.deviceName = String(body.device_name ?? "").slice(0, 100);
    device.platform = String(body.platform ?? "");
    device.arch = String(body.arch ?? "");
    device.appVersion = String(body.app_version ?? "").slice(0, 32);
    device.lastSeenAt = iso(now);
    return ok(
      {
        device: {
          id: device.id,
          device_name: device.deviceName,
          platform: device.platform,
          arch: device.arch,
          app_version: device.appVersion,
          created_at: device.createdAt,
          last_seen_at: device.lastSeenAt,
        },
        api_key: { id: key.id, key: key.key, status: key.status },
        ...(this.options.keyGroups
          ? {
              api_keys: [
                {
                  id: key.id,
                  key: key.key,
                  status: key.status,
                  group_id: groupId,
                  group_name: plan.group_name,
                  platform: plan.platform,
                  protocol: plan.protocol,
                  primary: true,
                },
                ...extraKeys,
              ],
            }
          : {}),
        created,
        moved,
        rotated,
        plan,
      },
      { "Cache-Control": "no-store" },
    );
  }

  /** Marks an order paid and completed, as the payment provider's callback would. */
  completeOrder(id: number) {
    const order = this.orders.find((item) => item.id === id);
    if (!order) throw Error(`No order ${id}`);
    order.status = "COMPLETED";
    order.paid_at = order.completed_at = iso(Date.now());
  }
  private paymentApi(request: MockRequest, userId: number): MockReply {
    const { method, path, body, url } = request;
    const route = `${method} ${path}`;
    const payment = this.options.payment ?? {};
    const types = payment.types ?? ["alipay", "stripe", "airwallex"];
    const sanitize = (order: MockOrder) => {
      const {
        resume_token: _r,
        client_secret: _c,
        intent_id: _i,
        ...rest
      } = order;
      return rest;
    };
    if (route === "GET /api/v1/payment/config")
      return ok({
        enabled: payment.enabled === true,
        min_amount: 1,
        max_amount: 1000,
        daily_limit: 0,
        order_timeout_minutes: 30,
        max_pending_orders: 3,
        enabled_payment_types: types,
        balance_disabled: false,
        balance_recharge_multiplier: 1,
        subscription_usd_to_cny_rate: 0,
        recharge_fee_rate: 0,
        help_text: "",
        help_image_url: "",
      });
    if (payment.enabled !== true)
      return fail(403, "payment is not enabled", "PAYMENT_DISABLED");
    if (route === "GET /api/v1/payment/checkout-info")
      return ok({
        methods: Object.fromEntries(
          types.map((type) => [
            type,
            {
              payment_type: type,
              currency: type === "alipay" ? "CNY" : "USD",
              fee_rate: 0,
              daily_limit: 0,
              single_min: 1,
              single_max: 1000,
            },
          ]),
        ),
        global_min: 1,
        global_max: 1000,
        plans: payment.plans ?? [],
        balance_disabled: false,
        balance_recharge_multiplier: 1,
        subscription_usd_to_cny_rate: 0,
        recharge_fee_rate: 0,
        help_text: "",
        help_image_url: "",
        stripe_publishable_key: types.includes("stripe") ? "pk_test_mock" : "",
        alipay_force_qrcode: false,
        alipay_mobile_precreate_deep_link: false,
      });
    if (route === "POST /api/v1/payment/orders") {
      const type = String(body.payment_type ?? "");
      if (!types.includes(type))
        return fail(
          400,
          "payment type not available",
          "PAYMENT_TYPE_UNAVAILABLE",
        );
      const plan = (payment.plans ?? []).find(
        (item) => item.id === body.plan_id,
      );
      const amount =
        body.order_type === "subscription"
          ? Number(plan?.price ?? 0)
          : Number(body.amount ?? 0);
      if (!(amount > 0)) return fail(400, "invalid amount", "INVALID_AMOUNT");
      const id = this.nextOrder++;
      const now = Date.now();
      const trade =
        type === "stripe"
          ? `pi_mock${id}`
          : type === "airwallex"
            ? `int_mock${id}`
            : `T${id}`;
      const order: MockOrder = {
        id,
        user_id: userId,
        amount,
        pay_amount: amount,
        fee_rate: 0,
        currency: type === "alipay" ? "CNY" : "USD",
        payment_type: type,
        out_trade_no: trade,
        status: "PENDING",
        order_type: String(body.order_type ?? "balance"),
        plan_id: typeof body.plan_id === "number" ? body.plan_id : null,
        created_at: iso(now),
        expires_at: iso(now + 30 * 60_000),
        paid_at: null,
        completed_at: null,
        resume_token: `rt.${randomBytes(12).toString("base64url")}`,
        client_secret:
          type === "stripe"
            ? `${trade}_secret_${randomBytes(6).toString("hex")}`
            : type === "airwallex"
              ? `cs_${randomBytes(12).toString("hex")}`
              : "",
        intent_id: type === "airwallex" ? trade : "",
      };
      this.orders.push(order);
      return ok({
        order_id: order.id,
        amount: order.amount,
        pay_amount: order.pay_amount,
        fee_rate: 0,
        status: "PENDING",
        payment_type: type,
        out_trade_no: trade,
        ...(type === "alipay"
          ? { pay_url: `https://pay.example.test/alipay/${id}` }
          : {}),
        ...(type === "wxpay"
          ? { qr_code: `weixin://wxpay/bizpayurl?pr=${id}` }
          : {}),
        ...(order.client_secret ? { client_secret: order.client_secret } : {}),
        ...(order.intent_id ? { intent_id: order.intent_id } : {}),
        ...(type === "stripe" || type === "airwallex"
          ? { currency: order.currency, resume_token: order.resume_token }
          : {}),
        ...(type === "airwallex"
          ? { country_code: "US", payment_env: "demo" }
          : {}),
        expires_at: order.expires_at,
      });
    }
    if (route === "GET /api/v1/payment/orders/my") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const size = Number(url.searchParams.get("page_size") ?? 20);
      const mine = this.orders
        .filter((order) => order.user_id === userId)
        .reverse();
      return ok({
        items: mine.slice((page - 1) * size, page * size).map(sanitize),
        total: mine.length,
        page,
        page_size: size,
        pages: Math.max(1, Math.ceil(mine.length / size)),
      });
    }
    const one = /^\/api\/v1\/payment\/orders\/(\d+)(\/cancel)?$/.exec(path);
    const order =
      one &&
      this.orders.find(
        (item) => item.id === Number(one[1]) && item.user_id === userId,
      );
    if (one && !order) return fail(404, "order not found", "ORDER_NOT_FOUND");
    if (one && method === "GET" && !one[2]) return ok(sanitize(order!));
    if (one && method === "POST" && one[2]) {
      if (order!.status !== "PENDING")
        return fail(409, "order cannot be cancelled", "ORDER_NOT_CANCELLABLE");
      order!.status = "CANCELLED";
      return ok({ message: "order cancelled" });
    }
    return fail(404, "not found", "NOT_FOUND");
  }

  private gateway(request: MockRequest): MockReply {
    const { method, path, raw, body } = request;
    const route = `${method} ${path}`;
    const key = request.key!;
    const device = this.devices.find((item) => item.keyId === key.id);
    if (key.status !== "active") {
      const detail =
        this.claudex && device
          ? device.revokedAt
            ? {
                v: 1,
                reason: "DEVICE_REVOKED",
                kind: "key",
                reprovision: false,
                action: "sign_in",
                message:
                  "This device was signed out. Sign in again to keep working.",
              }
            : {
                v: 1,
                reason: "KEY_DISABLED",
                kind: "key",
                reprovision: true,
                action: "none",
                message: "This device's key is disabled.",
              }
          : undefined;
      return failCode(
        401,
        "API_KEY_DISABLED",
        "API key is disabled",
        detail ? { claudex: detail } : {},
      );
    }
    const byGroup = this.options.modelsByGroup;
    if (route === "GET /v1/models" && byGroup && key.group_id !== null)
      return {
        status: 200,
        body: {
          object: "list",
          data: (byGroup[key.group_id] ?? []).map((id) => ({ id })),
        },
      };
    if (route === "GET /v1/models") {
      const models = this.options.models ?? {
        status: 200,
        body: { object: "list", data: [] },
      };
      return { status: models.status, body: models.body };
    }
    if (route === "GET /v1/usage")
      return {
        status: 200,
        body: this.options.keyUsage ?? { rate_limits: [] },
      };
    // The service has no HTTP audio routes: dictation is the realtime
    // WebSocket (owner decision 18) and read aloud was removed (decision 19).
    if (path === "/v1/audio/transcriptions" || path === "/v1/audio/speech")
      return {
        status: 404,
        body: { error: { message: "Not Found", type: "not_found_error" } },
      };
    const refusal = this.options.refusal;
    if (refusal) {
      const withDetail =
        refusal.claudex &&
        this.claudex &&
        (refusal.allKeys || this.isDeviceKey(key));
      const base =
        refusal.shape === "openai"
          ? {
              error: {
                message: refusal.message,
                type: refusal.code.toLowerCase(),
                code: refusal.code,
              },
            }
          : { code: refusal.code, message: refusal.message };
      const retry = refusal.claudex?.retry_after_seconds;
      return {
        status: refusal.status,
        body: withDetail ? { ...base, claudex: refusal.claudex } : base,
        headers:
          typeof retry === "number"
            ? { "Retry-After": String(retry) }
            : undefined,
      };
    }
    const gateway = this.options.gateway ?? {
      status: 403,
      body: {
        code: "INSUFFICIENT_BALANCE",
        message: "Insufficient account balance",
      },
    };
    // The service drops an upstream `claudex` object on device-key errors (design 2.7 step 3).
    let answer = gateway.body;
    if (
      this.claudex &&
      this.isDeviceKey(key) &&
      gateway.status >= 400 &&
      answer &&
      typeof answer === "object" &&
      "claudex" in answer
    ) {
      const { claudex: _dropped, ...rest } = answer as Json;
      answer = rest;
    }
    return { status: gateway.status, body: answer };
  }
}

/**
 * An in-memory `BootstrapSource` for packages that read the bootstrap
 * (C4–C7). `load` answers `refresh()`; without it the value only changes
 * through `set()`.
 */
export class MemoryBootstrapSource implements BootstrapSource {
  refreshes = 0;
  private listeners = new Set<(value: ClaudexBootstrap | undefined) => void>();
  constructor(
    private value?: ClaudexBootstrap,
    private load?: () => Promise<ClaudexBootstrap | undefined>,
  ) {}
  current() {
    return this.value;
  }
  async refresh() {
    this.refreshes++;
    if (this.load) this.set(await this.load());
    return this.value;
  }
  set(value: ClaudexBootstrap | undefined) {
    this.value = value;
    for (const listener of this.listeners) listener(value);
  }
  onChange(listener: (value: ClaudexBootstrap | undefined) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** A BootstrapSource that reads the mock's bootstrap with an access token (and ETag). */
export function mockBootstrapSource(
  mock: MockSub2Api,
  accessToken: string,
  deviceId = randomUUID(),
  fetchImpl: Fetch = fetch,
) {
  let etag: string | undefined;
  const source: MemoryBootstrapSource = new MemoryBootstrapSource(
    undefined,
    async () => {
      const result = await requestJsonResult(
        fetchImpl,
        `${mock.url}/api/v1/claudex/bootstrap`,
        {
          token: accessToken,
          deviceId,
          ifNoneMatch: etag,
        },
      );
      if (result.notModified) return source.current();
      etag = result.etag;
      return parseBootstrap(result.data);
    },
  );
  return source;
}

/** A reversible stand-in for Electron safeStorage. */
export const fakeCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) =>
    Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x5a)),
  decryptString: (value: Buffer) =>
    Buffer.from(value.map((byte) => byte ^ 0x5a)).toString(),
};
