/**
 * The Claudex service's wire contract (design §1.8–§2.11, package C1): the
 * `X-Claudex-*` request headers, the TypeScript types of every user and
 * public `/api/v1/claudex/*` answer, and the parsers that turn the service's
 * snake_case JSON into those types. Other client packages import from here
 * and never read the service's JSON themselves.
 *
 * Parsers take the envelope's `data` (what `requestJson` returns), ignore
 * unknown fields (newer services add fields), give missing optional sections
 * as `undefined`, and throw `ContractError` with the field's path when a
 * required field is missing or has the wrong type. Text is cut to a bound
 * length and links that are not https are dropped, since the answers come
 * from a server the administrator runs, not from this build.
 *
 * The provider service child uses only the headers and the refusal checks,
 * which do not need zod; the zod schemas are built on first use, so a bundle
 * that does not call the other parsers leaves zod out. The renderer may
 * import the types only.
 */
import { z, type ZodType } from "zod";
import {
  attachmentTypes,
  type ClientPolicy,
  type ConnectorRule,
  type PolicyMode,
} from "./client-policy";
import type { CatalogEffort, ModelCatalogItem } from "./model-catalog-api";
import type { Protocol } from "./types";

/** `api_version` of `GET /api/v1/claudex/release` this client speaks. */
export const claudexApiVersion = 1;
/** `schema_version` of the bootstrap document this client speaks. */
export const claudexSchemaVersion = 1;

// ---------------------------------------------------------------------------
// Request headers (design 1.9)

export const claudexHeaderNames = {
  version: "X-Claudex-Version",
  platform: "X-Claudex-Platform",
  arch: "X-Claudex-Arch",
  deviceId: "X-Claudex-Device-Id",
} as const;

export const claudexPlatforms = ["darwin", "win32", "linux"] as const;
export type ClaudexPlatform = (typeof claudexPlatforms)[number];
export const claudexArches = ["arm64", "x64"] as const;
export type ClaudexArch = (typeof claudexArches)[number];

/** The build that sends a request; values the service would refuse are left out. */
export interface ClaudexClientInfo {
  /** `app.getVersion()`. */
  version?: string;
  /** `process.platform`. */
  platform?: string;
  /** `process.arch`. */
  arch?: string;
}

/** The service's version pattern (semver-like, at most 32 characters). */
const versionPattern =
  /^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]{1,32})?(\+[0-9A-Za-z.-]{1,32})?$/;
const uuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const validClaudexVersion = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 32 && versionPattern.test(value);
export const validDeviceId = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value);

/**
 * The `X-Claudex-*` headers for a request to the Claudex (Sub2API) service.
 * The service answers 400 CLAUDEX_INVALID_CLIENT_HEADER to a malformed
 * header, so a value it would refuse (an ia32 build, a version with spaces)
 * is not sent at all. The device id belongs on panel requests only, never on
 * the gateway (`/v1`), and never in a URL or body where logs would keep it.
 */
export function claudexHeaders(
  info: ClaudexClientInfo,
  deviceId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (validClaudexVersion(info.version))
    headers[claudexHeaderNames.version] = info.version;
  if ((claudexPlatforms as readonly string[]).includes(info.platform ?? ""))
    headers[claudexHeaderNames.platform] = info.platform!;
  if ((claudexArches as readonly string[]).includes(info.arch ?? ""))
    headers[claudexHeaderNames.arch] = info.arch!;
  if (validDeviceId(deviceId)) headers[claudexHeaderNames.deviceId] = deviceId;
  return headers;
}

// ---------------------------------------------------------------------------
// Error codes (design 1.8, plus the bootstrap section codes of B9)

/** The `reason` (envelope) or `code` (middleware, gateway) the service answers with. */
export const claudexErrorCodes = {
  sessionRevoked: "CLAUDEX_SESSION_REVOKED",
  sessionCheckFailed: "CLAUDEX_SESSION_CHECK_FAILED",
  invalidClientHeader: "CLAUDEX_INVALID_CLIENT_HEADER",
  settingInvalid: "CLAUDEX_SETTING_INVALID",
  upgradeRequired: "CLAUDEX_UPGRADE_REQUIRED",
  groupNotFound: "CLAUDEX_GROUP_NOT_FOUND",
  userNotFound: "CLAUDEX_USER_NOT_FOUND",
  deviceInvalid: "CLAUDEX_DEVICE_INVALID",
  deviceLimit: "CLAUDEX_DEVICE_LIMIT",
  deviceRegistrationThrottled: "CLAUDEX_DEVICE_REGISTRATION_THROTTLED",
  deviceKeysDisabled: "CLAUDEX_DEVICE_KEYS_DISABLED",
  deviceKeyManaged: "CLAUDEX_DEVICE_KEY_MANAGED",
  deviceNotFound: "CLAUDEX_DEVICE_NOT_FOUND",
  noPlan: "CLAUDEX_NO_PLAN",
  userApiKeysDisabled: "CLAUDEX_USER_API_KEYS_DISABLED",
  usageLimitExceeded: "CLAUDEX_USAGE_LIMIT_EXCEEDED",
  audioDisabled: "CLAUDEX_AUDIO_DISABLED",
  audioTooLarge: "CLAUDEX_AUDIO_TOO_LARGE",
  consentRequired: "CLAUDEX_CONSENT_REQUIRED",
  reportQuotaExceeded: "CLAUDEX_REPORT_QUOTA_EXCEEDED",
  feedbackDisabled: "CLAUDEX_FEEDBACK_DISABLED",
  checkoutUnavailable: "CLAUDEX_CHECKOUT_UNAVAILABLE",
  checkoutNotFound: "CLAUDEX_CHECKOUT_NOT_FOUND",
  /** Bootstrap `errors[].code`: a section took longer than its budget. */
  sectionTimeout: "CLAUDEX_SECTION_TIMEOUT",
  /** Bootstrap `errors[].code`: a section failed without a named reason. */
  sectionFailed: "CLAUDEX_SECTION_FAILED",
} as const;

// ---------------------------------------------------------------------------
// Parsing support

/** A service answer that does not match the contract. */
export class ContractError extends Error {
  readonly code = "CONTRACT_INVALID";
  constructor(
    /** The endpoint or section, e.g. "bootstrap" or "policy". */
    readonly endpoint: string,
    /** The field, e.g. "policy.links.help" or "items[0].id"; "" for the whole body. */
    readonly path: string,
    detail: string,
  ) {
    super(
      `The Claudex service sent an unexpected ${endpoint} answer` +
        (path ? ` at ${path}` : "") +
        ` (${detail}).`,
    );
    this.name = "ContractError";
  }
}

function formatPath(path: readonly PropertyKey[]) {
  return path
    .map((key, index) =>
      typeof key === "number"
        ? `[${key}]`
        : `${index ? "." : ""}${String(key)}`,
    )
    .join("");
}
function parseWith<T>(endpoint: string, schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new ContractError(
    endpoint,
    formatPath(issue?.path ?? []),
    issue?.message ?? "invalid",
  );
}

/** `data` of a `{code:0, message, data}` envelope; other values are returned as they are. */
export function envelopeData(body: unknown): unknown {
  if (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as { code?: unknown }).code === 0 &&
    "data" in body
  )
    return (body as { data: unknown }).data;
  return body;
}

/** An https link without credentials; anything else reads as null. */
export function httpsUrl(value: unknown, max = 2000): string | null {
  if (typeof value !== "string" || !value || value.length > max) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname &&
      !url.username &&
      !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Answer types

/** `GET /api/v1/claudex/web-console` (public). */
export interface ClaudexWebConsole {
  /** The service's web console is for administrators only. */
  adminOnly: boolean;
}

export const releaseStates = [
  "unknown",
  "current",
  "available",
  "required",
] as const;
export type ReleaseState = (typeof releaseStates)[number];

/** `GET /api/v1/claudex/release` (public) and the bootstrap section "release" (design 2.2). */
export interface ClaudexRelease {
  desktopUpdaterConfig?: import("./update-policy").DesktopUpdaterConfig;
  /** Only on `GET /claudex/release`. */
  apiVersion?: number;
  /** The service's own build; only on `GET /claudex/release`. */
  server?: { version: string; buildType: string };
  channel: string | null;
  latestVersion: string | null;
  minimumVersion: string | null;
  /** This build against the published versions (the service compares `X-Claudex-Version`). */
  state: ReleaseState;
  /** The gateway refuses builds below the minimum version. */
  enforced: boolean;
  /** An https download for this platform and architecture, else null. */
  downloadUrl: string | null;
  sha256: string | null;
  releaseNotesUrl: string | null;
  /** Markdown; render without raw HTML or remote images. */
  releaseNotesMd: string | null;
  publishedAt: number | null;
  /** The desktop interface pack published without an installer (docs/releasing.md). */
  ui?: ClaudexUiPack | null;
  /** Windows: this build's app files without the installer (ClaudexAppPack). */
  appPack?: ClaudexAppPack | null;
}

/**
 * A Windows build's app files without its installer: a zip of resources/
 * less the Codex folder, for an install on the same Electron `runtime` whose
 * Codex files hash to `keep` (electron/updates/app-pack.ts). It updates
 * without running a new program, which Smart App Control blocks while the
 * installer is unsigned.
 */
export interface ClaudexAppPack {
  url: string;
  sha256: string;
  runtime: string;
  keep: string;
}

/** A signed desktop interface pack: `bridge` is the lowest bridge level that can run it. */
export interface ClaudexUiPack {
  version: string;
  bridge: number;
  url: string;
  sha256: string;
}

/** `GET /api/v1/claudex/policy` and bootstrap "policy" (design 2.3), in the client's terms. */
export interface ClaudexPolicy extends Omit<
  ClientPolicy,
  "update" | "pending"
> {
  /** The plan group the policy was resolved for; null without a plan. */
  groupId: number | null;
}

/**
 * `GET /api/v1/claudex/models` and bootstrap "models" (design 2.4): the
 * administrator's catalog for the plan group, not yet intersected with the
 * gateway's `/v1/models` (package C2 does that); `hidden` entries belong
 * under More models (owner decision 11).
 */
export interface ClaudexModelCatalog {
  groupId: number | null;
  defaultModel: string | null;
  items: ModelCatalogItem[];
}

/** The plan group the service chose for this account (bootstrap `plan`, design 2.5). */
export interface ClaudexPlan {
  groupId: number;
  groupName: string;
  /** The group's platform: openai, anthropic, gemini, … */
  platform: string;
  /** How the desktop talks to the gateway for this group. */
  protocol: Protocol;
  /** "subscription" or "standard" (balance-billed). */
  subscriptionType: string;
  subscriptionId: number | null;
  expiresAt: number | null;
  subscribed: boolean;
}

/** This device's registration as bootstrap reports it (`device`). */
export interface ClaudexDeviceStatus {
  registered: boolean;
  /** The device's row id; null when it is not registered. */
  id: number | null;
  /** Group of the device key the service holds; null without one. */
  keyGroupId: number | null;
  revoked: boolean;
  /** Register again (`POST /claudex/devices`) before using the gateway. */
  reprovisionNeeded: boolean;
  /**
   * The device's usable keys, one per group, the plan group's first (MG).
   * Empty from a service before MG.
   */
  keys: ClaudexDeviceKeyStatus[];
}

/** A group the device holds a key for, as bootstrap `device.keys` lists it (no key). */
export interface ClaudexDeviceKeyStatus {
  apiKeyId: number;
  groupId: number;
  groupName: string;
  platform: string;
  protocol: Protocol;
  /** The plan group's key (`apiKey` of the registration). */
  primary: boolean;
}

/** One key of a registration (`api_keys`, MG): the key of one group. */
export interface ClaudexGroupKey {
  id: number;
  key: string;
  status: string;
  groupId: number;
  groupName: string;
  platform: string;
  protocol: Protocol;
  primary: boolean;
}

export interface ClaudexDevice {
  id: number;
  deviceName: string;
  platform: string;
  arch: string;
  appVersion: string;
  createdAt: number | null;
  lastSeenAt: number | null;
}

/**
 * `POST /api/v1/claudex/devices`. `apiKey.key` is the device key in clear:
 * it goes to the provider vault only, never to the window or a log.
 */
export interface ClaudexDeviceRegistration {
  device: ClaudexDevice;
  /**
   * The plan group's key; null for an account without a plan group, which signs
   * in anyway and runs on its balance alone.
   */
  apiKey: { id: number; key: string; status: string } | null;
  /**
   * Every key of the device, one per group the account may use, the plan
   * group's first (MG). Empty from a service before MG: `apiKey` alone then.
   */
  apiKeys: ClaudexGroupKey[];
  /** A new device row. */
  created: boolean;
  /** The key moved to the current plan group. */
  moved: boolean;
  /** A new key replaced a revoked, expired or missing one. */
  rotated: boolean;
  plan: ClaudexPlan | null;
}

/** `GET /api/v1/claudex/devices`: this account's devices (no keys). */
export interface ClaudexDeviceList {
  items: {
    id: number;
    deviceName: string;
    platform: string;
    arch: string;
    appVersion: string;
    groupId: number | null;
    /** The device that sent the request (`X-Claudex-Device-Id`). */
    current: boolean;
    revoked: boolean;
    lastSeenAt: number | null;
    createdAt: number | null;
    /**
     * When the device's current sign-in began; its first registration
     * (`createdAt`) from a service before claudex_0141.
     */
    signedInAt: number | null;
    location?: { city: string; region: string; country: string } | null;
  }[];
  /** Most devices this account may sign in on. */
  limit: number;
}

/**
 * `GET /api/v1/claudex/web/sessions`: the account's active browser
 * sessions of the web app (W-AUTH), newest first.
 */
export interface ClaudexWebSessionList {
  items: {
    id: number;
    userAgent: string;
    /** The session the request's access token belongs to. */
    current: boolean;
    createdAt: number | null;
    lastSeenAt: number | null;
    expiresAt: number | null;
    location?: { city: string; region: string; country: string } | null;
  }[];
}

export const usageWindowKinds = [
  "session",
  "all_models",
  "models",
  "daily",
  "monthly",
  "key",
] as const;
export type UsageWindowKind = (typeof usageWindowKinds)[number];

export interface ClaudexUsageWindow {
  /** Stable id such as "rule:3" or "subscription:weekly". */
  id: string;
  /** "rule", "subscription" or "key". */
  source: string;
  kind: UsageWindowKind;
  /** "Current session", "All models", a rule's label such as "Opus". */
  label: string;
  /** "5h", "7d", … */
  window: string;
  windowSeconds: number;
  usedUsd: number;
  limitUsd: number;
  /** Whole percent used, 0–100. */
  percent: number;
  /** The window has started (a first request opened it). */
  active: boolean;
  windowStart: number | null;
  resetsAt: number | null;
  /** Model patterns of a per-model rule; null for all models. */
  models: string[] | null;
  exceeded: boolean;
}
/** `GET /api/v1/claudex/usage-status` (design 2.6). */
export interface ClaudexUsageStatus {
  plan: {
    groupId: number;
    groupName: string;
    subscriptionId: number | null;
    /** "subscription" or "balance". */
    billingMode: string;
  };
  /** In the service's order; windows of kinds this build does not know are left out. */
  windows: ClaudexUsageWindow[];
  balance: { balanceUsd: number } | null;
  blocked: {
    blocked: boolean;
    windowId: string | null;
    reason: string | null;
    resetsAt: number | null;
  };
  updatedAt: number | null;
}

/**
 * Bootstrap section "voice" (design 2.8): dictation only. Read aloud was
 * removed (owner decision 19); a `speech` block the service still sends is
 * ignored. Dictation streams over the realtime WebSocket (owner decision
 * 18), which takes no model or file size, so those may be absent.
 */
export interface ClaudexVoice {
  transcription: {
    enabled: boolean;
    model: string | null;
    maxBytes: number | null;
    maxSeconds: number | null;
  };
  /** Turned on and usable with this plan. */
  available: { transcription: boolean };
}

export interface DiagnosticsAccepted {
  accepted: number;
  duplicates: number;
  dropped: number;
}
export interface FeedbackAccepted {
  accepted: boolean;
  duplicate: boolean;
  /** The service does not keep conversation excerpts; the rest was saved. */
  excerptDropped: boolean;
}

/** `POST /claudex/payment/checkout-links`: open `<service>/desktop-pay#t=<token>`. */
export interface ClaudexCheckoutLink {
  token: string;
  expiresAt: number;
}
/** `POST /claudex/payment/checkout` (public; the `/desktop-pay` page reads it). */
export interface ClaudexCheckoutSession {
  orderId: number;
  /** PENDING until paid; keys are only present while pending. */
  status: string;
  provider: string;
  amount: number;
  payAmount: number;
  currency: string;
  expiresAt: number | null;
  stripe: { publishableKey: string; clientSecret: string } | null;
  airwallex: {
    env: string;
    intentId: string;
    clientSecret: string;
    currency: string;
    countryCode: string;
  } | null;
  resultPath: string;
}

/** What the service offers this account; a missing flag reads as false. */
export interface ClaudexFeatures {
  deviceKeys: boolean;
  usageStatus: boolean;
  structuredRefusals: boolean;
  modelCatalog: boolean;
  voiceTranscription: boolean;
  payment: boolean;
  /** Stripe and Airwallex can be paid in the system browser (`/desktop-pay`). */
  desktopCheckout: boolean;
  redeem: boolean;
  diagnostics: boolean;
  feedback: boolean;
  selfDelete: boolean;
  announcements: boolean;
}
const featureKeys = {
  deviceKeys: "device_keys",
  usageStatus: "usage_status",
  structuredRefusals: "structured_refusals",
  modelCatalog: "model_catalog",
  voiceTranscription: "voice_transcription",
  payment: "payment",
  desktopCheckout: "desktop_checkout",
  redeem: "redeem",
  diagnostics: "diagnostics",
  feedback: "feedback",
  selfDelete: "self_delete",
  announcements: "announcements",
} as const satisfies Record<keyof ClaudexFeatures, string>;

export interface ClaudexUsageSection {
  rulesEnabled: boolean;
  /** Show the Current session row even before a first request. */
  hasSessionWindow: boolean;
}
export interface ClaudexFeedbackSection {
  diagnostics: { enabled: boolean };
  feedback: { enabled: boolean; allowConversationExcerpt: boolean };
}

/**
 * `GET /api/v1/claudex/bootstrap` (design 2.10): everything the desktop
 * needs after sign-in, in one answer. A section the service could not
 * produce is absent and named in `errors`.
 */
export interface ClaudexBootstrap {
  schemaVersion: number;
  generatedAt: number | null;
  server: { siteName: string; version: string; timezone: string };
  plan?: ClaudexPlan;
  device?: ClaudexDeviceStatus;
  policy?: ClaudexPolicy;
  models?: ClaudexModelCatalog;
  release?: ClaudexRelease;
  voice?: ClaudexVoice;
  usage?: ClaudexUsageSection;
  feedback?: ClaudexFeedbackSection;
  features: ClaudexFeatures;
  /** Sections that failed: CLAUDEX_SECTION_TIMEOUT, CLAUDEX_SECTION_FAILED or the section's own reason. */
  errors: { section: string; code: string }[];
}

/**
 * The current bootstrap of the signed-in remote account. Package C2
 * implements it (`electron/sub2api/claudex-bootstrap.ts`); C4–C7 read
 * features and sections through it only.
 */
export interface BootstrapSource {
  /** The last bootstrap received; undefined before the first one or for local accounts. */
  current(): ClaudexBootstrap | undefined;
  /** Asks the service again (with `If-None-Match`); resolves to the current value. */
  refresh(): Promise<ClaudexBootstrap | undefined>;
  /** Called after each change; returns the unsubscribe function. */
  onChange(
    listener: (bootstrap: ClaudexBootstrap | undefined) => void,
  ): () => void;
}

// ---------------------------------------------------------------------------
// Structured refusals: the gateway's top-level `claudex` object (design 2.7).
// Read in the provider service child, so checked by hand rather than with zod.

/** Only these statuses carry a refusal the client may act on. */
export const refusalStatuses: readonly number[] = [401, 402, 403, 426, 429];
export const refusalActions = [
  "wait",
  "get_more_usage",
  "contact_admin",
  "sign_in",
  "update",
  "none",
] as const;
export type ClaudexRefusalAction = (typeof refusalActions)[number];

/**
 * Why the gateway refused a request, as the service explains it. There is
 * deliberately no download address: a gateway error body can come from an
 * upstream relay, so update links are taken from the release information
 * only (design 4.3).
 */
export interface ClaudexRefusal {
  v: 1;
  /** e.g. SUBSCRIPTION_WEEKLY_LIMIT, RULE_LIMIT, DEVICE_REVOKED, UPGRADE_REQUIRED. */
  reason: string;
  /** usage_limit, rule_limit, subscription, key_limit, key, balance, rate_limit, group, account, upgrade, unknown. */
  kind: string;
  /** "5h", "1d", "7d", "30d" when a window is involved. */
  window?: string;
  resetsAt?: number;
  retryAfterSeconds?: number;
  limitUsd?: number;
  usedUsd?: number;
  ruleId?: number;
  /**
   * Which kind of usage rule refused (RULE_LIMIT only): "session" (the
   * hours-long window over all models), "all_models" or "models". Older
   * services leave it out; the window and models then tell them apart.
   */
  ruleKind?: string;
  /** A usage rule's label such as "Opus". */
  label?: string;
  /** Model patterns of the rule that refused; the other models still work. */
  models?: string[];
  /** Register the device again (a new or moved key fixes it). */
  reprovision: boolean;
  action: ClaudexRefusalAction;
  minimumVersion?: string;
  latestVersion?: string;
  /** English text for the person. */
  message: string;
}

const refusalReason = /^[A-Z][A-Z0-9_]{0,63}$/;
const refusalKind = /^[a-z0-9_]{1,32}$/;
const refusalWindow = /^\d{1,4}[mhdw]$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isEpochMs = (value: unknown): value is number =>
  isAmount(value) && value > 0 && value < 8.64e15;
const isAction = (value: unknown): value is ClaudexRefusalAction =>
  (refusalActions as readonly unknown[]).includes(value);

/** The `claudex` object itself; throws ContractError when it cannot be used. */
export function parseRefusalDetail(value: unknown): ClaudexRefusal {
  if (!isObject(value)) throw new ContractError("refusal", "", "not an object");
  if (value.v !== 1)
    throw new ContractError("refusal", "v", "expected version 1");
  if (typeof value.reason !== "string" || !refusalReason.test(value.reason))
    throw new ContractError("refusal", "reason", "expected a reason code");
  const refusal: ClaudexRefusal = {
    v: 1,
    reason: value.reason,
    kind:
      typeof value.kind === "string" && refusalKind.test(value.kind)
        ? value.kind
        : "unknown",
    reprovision: value.reprovision === true,
    action: isAction(value.action) ? value.action : "none",
    message:
      typeof value.message === "string" ? value.message.slice(0, 1000) : "",
  };
  if (typeof value.window === "string" && refusalWindow.test(value.window))
    refusal.window = value.window;
  const resetsAt =
    typeof value.resets_at === "string" ? Date.parse(value.resets_at) : NaN;
  if (isEpochMs(resetsAt)) refusal.resetsAt = resetsAt;
  if (isCount(value.retry_after_seconds))
    refusal.retryAfterSeconds = value.retry_after_seconds;
  if (isAmount(value.limit_usd)) refusal.limitUsd = value.limit_usd;
  if (isAmount(value.used_usd)) refusal.usedUsd = value.used_usd;
  if (Number.isSafeInteger(value.rule_id))
    refusal.ruleId = value.rule_id as number;
  if (typeof value.rule_kind === "string" && refusalKind.test(value.rule_kind))
    refusal.ruleKind = value.rule_kind;
  if (typeof value.label === "string" && value.label)
    refusal.label = value.label.slice(0, 100);
  if (Array.isArray(value.models)) {
    const models = value.models
      .filter((model): model is string => typeof model === "string")
      .slice(0, 50)
      .map((model) => model.slice(0, 200));
    if (models.length) refusal.models = models;
  }
  if (validClaudexVersion(value.minimum_version))
    refusal.minimumVersion = value.minimum_version;
  if (validClaudexVersion(value.latest_version))
    refusal.latestVersion = value.latest_version;
  return refusal;
}
/**
 * The refusal an error body explains, or undefined: only for 401, 402, 403,
 * 426 and 429 answers, only version 1, and never throwing (an error answer
 * without a usable `claudex` object keeps the older mapping).
 */
export function parseRefusal(
  status: number,
  body: unknown,
): ClaudexRefusal | undefined {
  if (!refusalStatuses.includes(status) || !isObject(body)) return undefined;
  try {
    return parseRefusalDetail(body.claudex);
  } catch {
    return undefined;
  }
}

/**
 * The fields a gateway refusal gains from a `claudex` object (package C3
 * derives them in `describeSub2ApiRefusal`). The provider service child
 * sends them to the main process, which checks each one again.
 */
export interface GatewayRefusalDetails {
  claudex?: ClaudexRefusal;
  /** When the refusing window resets, epoch ms. */
  resetsAt?: number;
  action?: ClaudexRefusalAction;
  /** Register this device again. */
  reprovision?: boolean;
  /** The device was signed out (DEVICE_REVOKED): end the remote session. */
  signedOut?: boolean;
  /** Only these models are refused; the rest keep working. */
  models?: string[];
  /** The gateway's `X-Client-Request-ID`, so a report can name the request. */
  requestId?: string;
}
/** A request id as Sub2API writes it (a UUID or a caller's correlation id). */
export const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const modelList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 50 &&
  value.every((model) => typeof model === "string" && model.length <= 200);
/** A parsed refusal that crossed a process boundary; unknown keys are dropped, a bad field rejects it. */
function refusalValue(value: unknown): ClaudexRefusal | undefined {
  if (
    !isObject(value) ||
    value.v !== 1 ||
    typeof value.reason !== "string" ||
    !refusalReason.test(value.reason) ||
    typeof value.kind !== "string" ||
    !refusalKind.test(value.kind) ||
    typeof value.reprovision !== "boolean" ||
    !isAction(value.action) ||
    typeof value.message !== "string" ||
    value.message.length > 1000
  )
    return undefined;
  const refusal: ClaudexRefusal = {
    v: 1,
    reason: value.reason,
    kind: value.kind,
    reprovision: value.reprovision,
    action: value.action,
    message: value.message,
  };
  const optional: [keyof ClaudexRefusal, (item: unknown) => boolean][] = [
    ["window", (item) => typeof item === "string" && refusalWindow.test(item)],
    ["resetsAt", isEpochMs],
    ["retryAfterSeconds", isCount],
    ["limitUsd", isAmount],
    ["usedUsd", isAmount],
    ["ruleId", Number.isSafeInteger],
    ["ruleKind", (item) => typeof item === "string" && refusalKind.test(item)],
    ["label", (item) => typeof item === "string" && item.length <= 100],
    ["models", modelList],
    ["minimumVersion", validClaudexVersion],
    ["latestVersion", validClaudexVersion],
  ];
  for (const [key, valid] of optional) {
    if (value[key] === undefined) continue;
    if (!valid(value[key])) return undefined;
    (refusal as unknown as Record<string, unknown>)[key] = value[key];
  }
  return refusal;
}
/** The details that pass the checks, each checked on its own; others are left out. */
export function gatewayRefusalDetails(value: {
  [K in keyof GatewayRefusalDetails]?: unknown;
}): GatewayRefusalDetails {
  const details: GatewayRefusalDetails = {};
  const claudex = refusalValue(value.claudex);
  if (claudex) details.claudex = claudex;
  if (isEpochMs(value.resetsAt)) details.resetsAt = value.resetsAt;
  if (isAction(value.action)) details.action = value.action;
  if (typeof value.reprovision === "boolean")
    details.reprovision = value.reprovision;
  if (typeof value.signedOut === "boolean") details.signedOut = value.signedOut;
  if (modelList(value.models)) details.models = value.models;
  if (
    typeof value.requestId === "string" &&
    requestIdPattern.test(value.requestId)
  )
    details.requestId = value.requestId;
  return details;
}

// ---------------------------------------------------------------------------
// Request bodies

/** The request body of `POST /claudex/devices`; the device id travels in `X-Claudex-Device-Id`. */
export interface DeviceRegistrationRequest {
  deviceName: string;
  platform: string;
  arch: string;
  appVersion: string;
  /** A group the person picked; null lets the service choose the plan. */
  groupId?: number | null;
}
export function deviceRegistrationBody(request: DeviceRegistrationRequest) {
  return {
    // Control characters are stripped on the service too; the name is only for administrators.
    device_name: request.deviceName
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, 100),
    platform: request.platform,
    arch: request.arch,
    app_version: request.appVersion.slice(0, 32),
    group_id: request.groupId ?? null,
  };
}

/**
 * What a diagnostic report is about. The client sends turn_error,
 * gateway_refusal, crash (main process exceptions and processes that ended
 * unexpectedly), mcp_start_failed (a hash of the server's name only) and
 * provision_failed (issuing the device key again). update_failed stays
 * unused: Claudex has no automatic updater, the person downloads updates.
 */
export const diagnosticKinds = [
  "turn_error",
  "gateway_refusal",
  "crash",
  "update_failed",
  "mcp_start_failed",
  "provision_failed",
] as const;
export type DiagnosticKind = (typeof diagnosticKinds)[number];
/** Context keys the service keeps; others are dropped there too. */
export const diagnosticContextKeys = [
  "surface",
  "reason",
  "http_status",
  "retry_count",
  "feature",
] as const;

/** One report (design 2.9); without prompts, replies or file paths (package C7 redacts first). */
export interface DiagnosticReport {
  /** UUID, so a retried upload is not stored twice. */
  id: string;
  occurredAt: number;
  kind: DiagnosticKind;
  code: string;
  /** At most 300 characters. */
  message: string;
  requestId?: string;
  model?: string;
  appVersion: string;
  codexVersion?: string;
  platform: string;
  arch: string;
  osVersion?: string;
  context?: Partial<
    Record<(typeof diagnosticContextKeys)[number], string | number | boolean>
  >;
}
/** `POST /claudex/diagnostics`; sent only with the person's consent. */
export function diagnosticsBody(reports: DiagnosticReport[]) {
  return {
    consent: true as const,
    reports: reports.slice(0, 50).map((report) => ({
      id: report.id,
      occurred_at: new Date(report.occurredAt).toISOString(),
      kind: report.kind,
      code: report.code.slice(0, 64),
      message: report.message.slice(0, 300),
      request_id: (report.requestId ?? "").slice(0, 128),
      model: (report.model ?? "").slice(0, 200),
      app_version: report.appVersion.slice(0, 32),
      codex_version: (report.codexVersion ?? "").slice(0, 32),
      platform: report.platform.slice(0, 16),
      arch: report.arch.slice(0, 16),
      os_version: (report.osVersion ?? "").slice(0, 64),
      context: Object.fromEntries(
        Object.entries(report.context ?? {}).filter(
          ([key, value]) =>
            (diagnosticContextKeys as readonly string[]).includes(key) &&
            (typeof value !== "string" || value.length <= 200),
        ),
      ),
    })),
  };
}

export interface ReplyFeedbackReport {
  /** UUID. */
  id: string;
  rating: "up" | "down";
  categories: string[];
  /** What the person wrote in the feedback dialog. */
  comment: string;
  model?: string;
  requestId?: string;
  /** Only when the person ticked "Include this conversation"; null otherwise. */
  conversationExcerpt: string | null;
  appVersion: string;
  platform: string;
}
/** `POST /claudex/feedback`; sent only with the person's consent. */
export function feedbackBody(report: ReplyFeedbackReport) {
  return {
    consent: true as const,
    id: report.id,
    rating: report.rating,
    categories: report.categories.slice(0, 20).map((item) => item.slice(0, 64)),
    comment: report.comment.slice(0, 4000),
    model: (report.model ?? "").slice(0, 200),
    request_id: (report.requestId ?? "").slice(0, 128),
    conversation_excerpt:
      report.conversationExcerpt === null
        ? null
        : report.conversationExcerpt.slice(0, 20_000),
    app_version: report.appVersion.slice(0, 32),
    platform: report.platform.slice(0, 16),
  };
}

/** From the `POST /api/v1/payment/orders` answer (design 2.11); `clientSecret` never goes into a URL. */
export interface CheckoutLinkRequest {
  orderId: number;
  resumeToken: string;
  clientSecret: string;
  intentId?: string;
  currency?: string;
  countryCode?: string;
  paymentEnv?: string;
}
export function checkoutLinkBody(request: CheckoutLinkRequest) {
  return {
    order_id: request.orderId,
    resume_token: request.resumeToken,
    client_secret: request.clientSecret,
    intent_id: request.intentId ?? "",
    currency: request.currency ?? "",
    country_code: request.countryCode ?? "",
    payment_env: request.paymentEnv ?? "",
  };
}

// ---------------------------------------------------------------------------
// Parsers

export const parseWebConsole = (data: unknown) =>
  parseWith("web-console", schemas().webConsole, data);
export const parseRelease = (data: unknown) =>
  parseWith("release", schemas().release, data);
export const parsePolicy = (data: unknown) =>
  parseWith("policy", schemas().policy, data);
export const parseModelCatalog = (data: unknown) =>
  parseWith("models", schemas().catalog, data);
export const parseDeviceRegistration = (data: unknown) =>
  parseWith("devices", schemas().registration, data);
export const parseDeviceList = (data: unknown) =>
  parseWith("devices", schemas().deviceList, data);
/** `DELETE /claudex/devices/current` and `DELETE /claudex/devices/:id`. */
export const parseDeviceRevoked = (data: unknown) =>
  parseWith("devices", schemas().deviceRevoked, data);
export const parseWebSessionList = (data: unknown) =>
  parseWith("web/sessions", schemas().webSessionList, data);
/** `DELETE /claudex/web/sessions/:id`. */
export const parseWebSessionRevoked = (data: unknown) =>
  parseWith("web/sessions", schemas().webSessionRevoked, data);
/**
 * `GET /claudex/native-sessions`: the phone apps' sign-ins (the upstream
 * bearer flow), most recently used first; the web sessions' shape.
 */
export const parseNativeSessionList = (data: unknown) =>
  parseWith("native-sessions", schemas().webSessionList, data);
/** `DELETE /claudex/native-sessions/:id`. */
export const parseNativeSessionRevoked = (data: unknown) =>
  parseWith("native-sessions", schemas().webSessionRevoked, data);
export const parseUsageStatus = (data: unknown) =>
  parseWith("usage-status", schemas().usageStatus, data);
export const parseVoice = (data: unknown) =>
  parseWith("voice", schemas().voice, data);
export const parseDiagnosticsAccepted = (data: unknown) =>
  parseWith("diagnostics", schemas().diagnosticsAccepted, data);
export const parseFeedbackAccepted = (data: unknown) =>
  parseWith("feedback", schemas().feedbackAccepted, data);
export const parseCheckoutLink = (data: unknown) =>
  parseWith("payment/checkout-links", schemas().checkoutLink, data);
export const parseCheckoutSession = (data: unknown) =>
  parseWith("payment/checkout", schemas().checkoutSession, data);
export const parseBootstrap = (data: unknown) =>
  parseWith("bootstrap", schemas().bootstrap, data);

let built: ReturnType<typeof buildSchemas> | undefined;
/** The zod schemas, built on first use (so bundles that never parse leave zod out). */
const schemas = () => (built ??= buildSchemas());

function buildSchemas() {
  const cut = (max: number) => (value: string) => value.slice(0, max);
  const text = (max: number) => z.string().transform(cut(max));
  /** Text that may be null or absent; null either way. */
  const optionalText = (max: number) =>
    text(max)
      .nullish()
      .transform((value) => value ?? null);
  /** Text where an absent value reads as "". */
  const emptyText = (max: number) =>
    text(max)
      .nullish()
      .transform((value) => value ?? "");
  const int = z
    .number()
    .int()
    .refine(Number.isSafeInteger, "expected a safe integer");
  const count = int.refine((value) => value >= 0, "expected a count");
  const optionalInt = int.nullish().transform((value) => value ?? null);
  const amount = z.number().refine(Number.isFinite, "expected a finite number");
  const flag = z
    .boolean()
    .nullish()
    .transform((value) => value === true);
  /** An RFC 3339 time as epoch milliseconds; null when absent or unreadable. */
  const time = z
    .string()
    .nullish()
    .transform((value) => {
      const at = value ? Date.parse(value) : NaN;
      return Number.isFinite(at) ? at : null;
    });
  const link = z
    .string()
    .nullish()
    .transform((value) => httpsUrl(value));
  /** Items that do not match `item` are dropped instead of failing the answer. */
  const lenientList = <T>(item: ZodType<T>, max: number) =>
    z
      .array(z.unknown())
      .nullish()
      .transform((values) =>
        (values ?? [])
          .flatMap((value) => {
            const parsed = item.safeParse(value);
            return parsed.success ? [parsed.data] : [];
          })
          .slice(0, max),
      );
  const version = z
    .string()
    .nullish()
    .transform((value) => (validClaudexVersion(value) ? value : null));

  // GET /claudex/web-console
  const webConsole = z
    .object({ admin_only: z.boolean() })
    .transform((wire): ClaudexWebConsole => ({ adminOnly: wire.admin_only }));

  // GET /claudex/release and bootstrap "release". `state` is required, so an
  // answer without release information cannot read as "current"; states
  // this build does not know read as "unknown".
  const releaseFields = {
    desktop_updater_config: z
      .object({
        check_interval_ticks: z.unknown().optional(),
        staged_peek_min_interval_minutes: z.unknown().optional(),
      })
      .nullish(),
    channel: optionalText(36),
    latest_version: version,
    minimum_version: version,
    state: z
      .string()
      .transform((value): ReleaseState =>
        (releaseStates as readonly string[]).includes(value)
          ? (value as ReleaseState)
          : "unknown",
      ),
    enforced: flag,
    download_url: link,
    sha256: z
      .string()
      .nullish()
      .transform((value) =>
        value && /^[0-9a-f]{64}$/.test(value) ? value : null,
      ),
    release_notes_url: link,
    release_notes_md: optionalText(20_000),
    published_at: time,
    // A pack missing any part is not offered.
    ui: z
      .object({
        version: z.string().max(64).nullish(),
        bridge: z.number().int().positive().nullish(),
        url: link,
        sha256: z.string().nullish(),
      })
      .nullish()
      .transform((value): ClaudexUiPack | null =>
        value?.version &&
        value.bridge &&
        value.url &&
        value.sha256 &&
        /^[0-9a-f]{64}$/.test(value.sha256)
          ? {
              version: value.version,
              bridge: value.bridge,
              url: value.url,
              sha256: value.sha256,
            }
          : null,
      ),
    app_pack: z
      .object({
        url: link,
        sha256: z.string().nullish(),
        runtime: z.string().max(32).nullish(),
        keep: z.string().nullish(),
      })
      .nullish()
      .transform((value): ClaudexAppPack | null =>
        value?.url &&
        value.runtime &&
        value.sha256 &&
        value.keep &&
        /^[0-9a-f]{64}$/.test(value.sha256) &&
        /^[0-9a-f]{64}$/.test(value.keep)
          ? {
              url: value.url,
              sha256: value.sha256,
              runtime: value.runtime,
              keep: value.keep,
            }
          : null,
      ),
  };
  const releaseOf = (
    wire: z.output<z.ZodObject<typeof releaseFields>>,
  ): ClaudexRelease => ({
    ...(wire.desktop_updater_config
      ? {
          desktopUpdaterConfig: {
            ...(typeof wire.desktop_updater_config.check_interval_ticks ===
            "number"
              ? {
                  check_interval_ticks:
                    wire.desktop_updater_config.check_interval_ticks,
                }
              : {}),
            ...(typeof wire.desktop_updater_config
              .staged_peek_min_interval_minutes === "number"
              ? {
                  staged_peek_min_interval_minutes:
                    wire.desktop_updater_config
                      .staged_peek_min_interval_minutes,
                }
              : {}),
          },
        }
      : {}),
    channel: wire.channel,
    latestVersion: wire.latest_version,
    minimumVersion: wire.minimum_version,
    state: wire.state,
    enforced: wire.enforced,
    downloadUrl: wire.download_url,
    sha256: wire.sha256,
    releaseNotesUrl: wire.release_notes_url,
    releaseNotesMd: wire.release_notes_md,
    publishedAt: wire.published_at,
    ui: wire.ui,
    appPack: wire.app_pack,
  });
  const releaseSection = z.object(releaseFields).transform(releaseOf);
  const release = z
    .object({
      ...releaseFields,
      api_version: int,
      server: z
        .object({ version: text(64), build_type: emptyText(32) })
        .nullish(),
    })
    .transform((wire): ClaudexRelease => ({
      apiVersion: wire.api_version,
      ...(wire.server
        ? {
            server: {
              version: wire.server.version,
              buildType: wire.server.build_type,
            },
          }
        : {}),
      ...releaseOf(wire),
    }));

  // GET /claudex/policy and bootstrap "policy". Every field is required: a
  // policy the service did not fully send is not used (C2 falls back to its
  // cache or the offline policy).
  const policyModes: readonly PolicyMode[] = [
    "auto",
    "manual",
    "acceptEdits",
    "plan",
  ];
  const hostPattern =
    /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const domains = (values: unknown[]) =>
    values
      .filter(
        (value): value is string =>
          typeof value === "string" &&
          value.length <= 253 &&
          hostPattern.test(value),
      )
      .slice(0, 100);
  const connectorName = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
  /**
   * A rule whose address is not https, or whose arguments come without a
   * program, is dropped whole, so it allows nothing. `args` bind a local
   * program exactly (the client matches program and arguments both), so a
   * rule read without them would never match a server started with any.
   */
  const connectorRule = z.union([
    connectorName.transform((name): ConnectorRule => ({ name })),
    z
      .object({
        name: connectorName,
        url_prefix: z.string().max(2000).nullish(),
        command: z.string().max(1000).nullish(),
        // At most 50 arguments of 500 characters on the service; UTF-16 may count twice that.
        args: z.array(z.string().max(1000)).max(50).nullish(),
      })
      .refine(
        (rule) => !rule.url_prefix || httpsUrl(rule.url_prefix) !== null,
        "expected an https url_prefix",
      )
      .refine(
        (rule) => !rule.args?.length || !!rule.command,
        "expected args only with a command",
      )
      .transform((rule): ConnectorRule => ({
        name: rule.name,
        ...(rule.url_prefix ? { urlPrefix: rule.url_prefix } : {}),
        ...(rule.command ? { command: rule.command } : {}),
        ...(rule.command && rule.args?.length ? { args: rule.args } : {}),
      })),
  ]);
  const learnMoreLink = z
    .object({ label: z.string().min(1).max(60), url: z.string() })
    .refine((item) => httpsUrl(item.url) !== null, "expected an https url")
    .transform((item) => ({ label: item.label, url: item.url }));
  // Round-2 blocks. Each is optional, so an older service's policy still parses
  // (the field is then absent); a block that is sent must be complete.
  const catalogModelId = z
    .string()
    .regex(/^[^\s*]{1,200}$/)
    .nullable();
  const memoryPolicy = z
    .object({
      enabled: z.boolean(),
      search_chats: z.boolean(),
      generate: z.boolean(),
      default_on: z.boolean(),
      model: catalogModelId,
    })
    .nullish();
  const researchPolicy = z
    .object({
      enabled: z.boolean(),
      x_search: z.boolean(),
      max_searches_per_turn: int.refine((value) => value >= 1),
    })
    .nullish();
  const browserPolicy = z
    .object({
      enabled: z.boolean(),
      external_sites: z.boolean(),
      allow_script: z.boolean(),
      dev_servers: z.boolean(),
      blocked_domains: z.array(z.unknown()).nullable(),
    })
    .nullish();
  const appName = /^[A-Za-z0-9._ -]{1,200}$/;
  const computerUsePolicy = z
    .object({
      enabled: z.boolean(),
      allow_full_control: z.boolean(),
      denied_apps: z.array(z.unknown()).nullable(),
      max_actions_per_turn: int.refine((value) => value >= 1).nullable(),
    })
    .nullish();
  const policy = z
    .object({
      revision: count,
      group_id: optionalInt,
      permission_modes: z.array(z.string()).max(20),
      incognito: z.boolean(),
      web_search: z.boolean(),
      web_search_default: z.boolean(),
      voice: z.boolean(),
      local_mcp_editing: z.boolean(),
      developer_mode_enabled: z.boolean().optional(),
      desktop_extensions_enabled: z.boolean().optional(),
      developer_mcp_enabled: z.boolean().optional(),
      remote_images: z.boolean(),
      remote_image_domains: z.array(z.unknown()).nullable(),
      external_links: z.boolean(),
      trusted_link_domains: z.array(z.unknown()).nullable(),
      connectors: z.array(z.unknown()).nullable(),
      attachments: z.object({
        max_bytes: count.nullable(),
        types: z.array(z.unknown()).nullable(),
      }),
      links: z.object({
        help: link,
        plans: link,
        apps: link,
        get_more_usage: link,
        usage_learn_more: link,
        learn_more: lenientList(learnMoreLink, 10),
      }),
      usage_banner: z.object({ warn_percent: int }),
      plan_label: optionalText(40),
      scheduled_tasks: z.object({
        enabled: z.boolean(),
        max_tasks: count.nullable(),
        approval_lifetime_days: count.nullable().optional(),
      }),
      approvals_always_allow: z.boolean(),
      memory: memoryPolicy,
      research: researchPolicy,
      browser: browserPolicy,
      ssh_remote: z.boolean().nullish(),
      codex_runtime_mirror: z.string().nullish(),
      computer_use: computerUsePolicy,
      workflows: z.boolean().nullish(),
      workflows_default_on: z.boolean().nullish(),
      workflow_approval_required: z.boolean().nullish(),
    })
    .transform((wire): ClaudexPolicy => {
      const links: ClientPolicy["links"] = {
        learnMore: wire.links.learn_more,
      };
      if (wire.links.help) links.help = wire.links.help;
      if (wire.links.plans) links.plans = wire.links.plans;
      if (wire.links.apps) links.apps = wire.links.apps;
      if (wire.links.get_more_usage)
        links.getMoreUsage = wire.links.get_more_usage;
      if (wire.links.usage_learn_more)
        links.usageLearnMore = wire.links.usage_learn_more;
      return {
        revision: wire.revision,
        groupId: wire.group_id,
        // Bypass permissions is never the policy's (owner decision 3): a
        // "bypass" entry, which the service cannot send, is dropped.
        permissionModes: policyModes.filter((mode) =>
          wire.permission_modes.includes(mode),
        ),
        incognito: wire.incognito,
        webSearch: wire.web_search,
        webSearchDefault: wire.web_search_default,
        voice: wire.voice,
        localMcpEditing: wire.local_mcp_editing,
        developerModeEnabled: wire.developer_mode_enabled ?? true,
        ...(wire.desktop_extensions_enabled !== undefined
          ? { desktopExtensionsEnabled: wire.desktop_extensions_enabled }
          : {}),
        ...(wire.developer_mcp_enabled !== undefined
          ? { developerMcpEnabled: wire.developer_mcp_enabled }
          : {}),
        remoteImages: wire.remote_images,
        remoteImageDomains:
          wire.remote_image_domains === null
            ? null
            : domains(wire.remote_image_domains),
        externalLinks: wire.external_links,
        trustedLinkDomains: domains(wire.trusted_link_domains ?? []),
        connectors:
          wire.connectors === null
            ? null
            : wire.connectors
                .flatMap((value) => {
                  const rule = connectorRule.safeParse(value);
                  return rule.success ? [rule.data] : [];
                })
                .slice(0, 200),
        attachments: {
          maxBytes: wire.attachments.max_bytes,
          types: attachmentTypes.filter((type) =>
            (wire.attachments.types ?? []).includes(type),
          ),
        },
        links,
        usageBanner: {
          warnPercent: Math.min(
            99,
            Math.max(1, wire.usage_banner.warn_percent),
          ),
        },
        planLabel: wire.plan_label || null,
        scheduledTasks: {
          enabled: wire.scheduled_tasks.enabled,
          ...(wire.scheduled_tasks.approval_lifetime_days != null
            ? {
                approvalLifetimeDays:
                  wire.scheduled_tasks.approval_lifetime_days,
              }
            : {}),
          maxTasks:
            wire.scheduled_tasks.max_tasks === null
              ? null
              : Math.min(100, wire.scheduled_tasks.max_tasks),
        },
        approvalsAlwaysAllow: wire.approvals_always_allow,
        ...(wire.memory
          ? {
              memory: {
                enabled: wire.memory.enabled,
                // The service turns the switches off with memory; so does the client.
                searchChats: wire.memory.enabled && wire.memory.search_chats,
                generate: wire.memory.enabled && wire.memory.generate,
                defaultOn: wire.memory.enabled && wire.memory.default_on,
                model: wire.memory.model,
              },
            }
          : {}),
        ...(wire.research
          ? {
              research: {
                // Research and X search need web search.
                enabled: wire.web_search && wire.research.enabled,
                xSearch: wire.web_search && wire.research.x_search,
                maxSearchesPerTurn: Math.min(
                  200,
                  wire.research.max_searches_per_turn,
                ),
              },
            }
          : {}),
        ...(wire.browser
          ? {
              browser: {
                enabled: wire.browser.enabled,
                externalSites: wire.browser.external_sites,
                allowScript: wire.browser.allow_script,
                devServers: wire.browser.dev_servers,
                blockedDomains: (wire.browser.blocked_domains ?? [])
                  .filter(
                    (value): value is string =>
                      typeof value === "string" &&
                      value.length <= 253 &&
                      hostPattern.test(value),
                  )
                  .slice(0, 200),
              },
            }
          : {}),
        ...(typeof wire.ssh_remote === "boolean"
          ? { sshRemote: wire.ssh_remote }
          : {}),
        ...(typeof wire.workflows === "boolean"
          ? { workflows: wire.workflows }
          : {}),
        ...(typeof wire.workflows_default_on === "boolean"
          ? { workflowsDefaultOn: wire.workflows_default_on }
          : {}),
        ...(typeof wire.workflow_approval_required === "boolean"
          ? { workflowApprovalRequired: wire.workflow_approval_required }
          : {}),
        ...(wire.codex_runtime_mirror !== undefined
          ? {
              // Only an https address is used; anything else means the npm registry.
              codexRuntimeMirror: httpsUrl(wire.codex_runtime_mirror),
            }
          : {}),
        ...(wire.computer_use
          ? {
              computerUse: {
                enabled: wire.computer_use.enabled,
                allowFullControl: wire.computer_use.allow_full_control,
                deniedApps: (wire.computer_use.denied_apps ?? [])
                  .filter(
                    (value): value is string =>
                      typeof value === "string" && appName.test(value.trim()),
                  )
                  .map((value) => value.trim())
                  .slice(0, 100),
                maxActionsPerTurn:
                  wire.computer_use.max_actions_per_turn === null
                    ? null
                    : Math.min(1000, wire.computer_use.max_actions_per_turn),
              },
            }
          : {}),
      };
    });

  // GET /claudex/models and bootstrap "models"
  const catalogEfforts: readonly CatalogEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  const badge = z.string().regex(/^[A-Za-z0-9 .×x+-]{1,16}$/);
  const modelId = z.string().min(1).max(200);
  const catalogItem = z
    .object({
      id: modelId,
      display_name: emptyText(100),
      description: emptyText(500),
      badges: lenientList(badge, 3),
      sort: int.nullish().transform((value) => value ?? 0),
      hidden: flag,
      default: flag,
      efforts: z.array(z.unknown()).nullish(),
      default_effort: z.string().nullish(),
      context_window: count.nullish(),
      auto_compact_tokens: count.nullish(),
      // Fast mode was dropped (R6): an older service's `fast` is ignored.
      usage_hint: emptyText(40),
      minimum_desktop_version: z.string().nullish(),
      // Absent (an older service): the client decides as before.
      web_search: z.string().nullish(),
      x_search: z.boolean().nullish(),
      // The group whose device key serves the model (MG).
      group_id: int.nullish(),
    })
    .transform((wire): ModelCatalogItem => {
      const item: ModelCatalogItem = {
        id: wire.id,
        displayName: wire.display_name || wire.id,
        description: wire.description,
        badges: wire.badges,
        sort: wire.sort,
        hidden: wire.hidden,
        isDefault: wire.default,
        usageHint: wire.usage_hint,
        ...(wire.minimum_desktop_version
          ? { minimumDesktopVersion: wire.minimum_desktop_version }
          : {}),
      };
      if (typeof wire.group_id === "number" && wire.group_id > 0)
        item.groupId = wire.group_id;
      if (typeof wire.web_search === "string") {
        // A capability this build does not know is no search it can use.
        item.webSearch = wire.web_search === "native" ? "native" : "none";
        item.xSearch = item.webSearch === "native" && wire.x_search === true;
      }
      if (wire.efforts) {
        const efforts = catalogEfforts.filter((effort) =>
          wire.efforts!.includes(effort),
        );
        item.efforts = efforts;
        if (efforts.includes(wire.default_effort as CatalogEffort))
          item.defaultEffort = wire.default_effort as CatalogEffort;
      }
      if (wire.context_window) item.contextWindow = wire.context_window;
      if (wire.auto_compact_tokens)
        item.autoCompactTokens = wire.auto_compact_tokens;
      return item;
    });
  const catalog = z
    .object({
      group_id: optionalInt,
      default_model: modelId.nullish().transform((value) => value ?? null),
      items: z.array(catalogItem).max(2000),
    })
    .transform((wire): ClaudexModelCatalog => ({
      groupId: wire.group_id,
      defaultModel: wire.default_model,
      items: wire.items,
    }));

  // Devices (design 2.5)
  const plan = z
    .object({
      group_id: int,
      group_name: emptyText(100),
      platform: emptyText(50),
      protocol: z.string().nullish(),
      subscription_type: emptyText(50),
      subscription_id: optionalInt,
      expires_at: time,
      subscribed: flag,
    })
    .transform((wire): ClaudexPlan => ({
      groupId: wire.group_id,
      groupName: wire.group_name,
      platform: wire.platform,
      protocol:
        wire.protocol === "responses" || wire.protocol === "chat"
          ? wire.protocol
          : wire.platform.toLowerCase() === "openai"
            ? "responses"
            : "chat",
      subscriptionType: wire.subscription_type,
      subscriptionId: wire.subscription_id,
      expiresAt: wire.expires_at,
      subscribed: wire.subscribed,
    }));
  const protocolOf = (wire: { protocol?: string | null; platform: string }) =>
    wire.protocol === "responses" || wire.protocol === "chat"
      ? wire.protocol
      : wire.platform.toLowerCase() === "openai"
        ? "responses"
        : "chat";
  const deviceKeyStatus = z
    .object({
      api_key_id: int,
      group_id: int,
      group_name: emptyText(100),
      platform: emptyText(50),
      protocol: z.string().nullish(),
      primary: flag,
    })
    .transform((wire): ClaudexDeviceKeyStatus => ({
      apiKeyId: wire.api_key_id,
      groupId: wire.group_id,
      groupName: wire.group_name,
      platform: wire.platform,
      protocol: protocolOf(wire),
      primary: wire.primary,
    }));
  const deviceStatus = z
    .object({
      registered: z.boolean(),
      id: optionalInt,
      key_group_id: optionalInt,
      revoked: flag,
      reprovision_needed: z.boolean(),
      keys: z.array(deviceKeyStatus).max(50).nullish(),
    })
    .transform((wire): ClaudexDeviceStatus => ({
      registered: wire.registered,
      id: wire.id,
      keyGroupId: wire.key_group_id,
      revoked: wire.revoked,
      reprovisionNeeded: wire.reprovision_needed,
      keys: wire.keys ?? [],
    }));
  const device = z
    .object({
      id: int,
      device_name: emptyText(100),
      platform: emptyText(16),
      arch: emptyText(16),
      app_version: emptyText(32),
      created_at: time,
      last_seen_at: time,
    })
    .transform((wire): ClaudexDevice => ({
      id: wire.id,
      deviceName: wire.device_name,
      platform: wire.platform,
      arch: wire.arch,
      appVersion: wire.app_version,
      createdAt: wire.created_at,
      lastSeenAt: wire.last_seen_at,
    }));
  const apiKeyText = z
    .string()
    .regex(/^[\x21-\x7e]{8,16000}$/, "expected an API key");
  const groupKey = z
    .object({
      id: int,
      key: apiKeyText,
      status: emptyText(32),
      group_id: int,
      group_name: emptyText(100),
      platform: emptyText(50),
      protocol: z.string().nullish(),
      primary: flag,
    })
    .transform((wire): ClaudexGroupKey => ({
      id: wire.id,
      key: wire.key,
      status: wire.status,
      groupId: wire.group_id,
      groupName: wire.group_name,
      platform: wire.platform,
      protocol: protocolOf(wire),
      primary: wire.primary,
    }));
  const registration = z
    .object({
      device,
      api_key: z
        .object({
          id: int,
          key: apiKeyText,
          status: emptyText(32),
        })
        .nullish(),
      api_keys: z.array(groupKey).max(50).nullish(),
      created: flag,
      moved: flag,
      rotated: flag,
      plan: plan.nullish(),
    })
    .transform((wire): ClaudexDeviceRegistration => ({
      device: wire.device,
      apiKey: wire.api_key
        ? {
            id: wire.api_key.id,
            key: wire.api_key.key,
            status: wire.api_key.status,
          }
        : null,
      apiKeys: wire.api_keys ?? [],
      created: wire.created,
      moved: wire.moved,
      rotated: wire.rotated,
      plan: wire.plan ?? null,
    }));
  const deviceList = z
    .object({
      items: z
        .array(
          z.object({
            id: int,
            device_name: emptyText(100),
            platform: emptyText(16),
            arch: emptyText(16),
            app_version: emptyText(32),
            group_id: optionalInt,
            current: flag,
            revoked: flag,
            last_seen_at: time,
            created_at: time,
            signed_in_at: time,
            location_info: z
              .object({
                city: emptyText(100),
                region: emptyText(100),
                country: emptyText(100),
              })
              .nullish(),
          }),
        )
        .max(1000),
      limit: count,
    })
    .transform((wire): ClaudexDeviceList => ({
      items: wire.items.map((item) => ({
        id: item.id,
        deviceName: item.device_name,
        platform: item.platform,
        arch: item.arch,
        appVersion: item.app_version,
        groupId: item.group_id,
        current: item.current,
        revoked: item.revoked,
        lastSeenAt: item.last_seen_at,
        createdAt: item.created_at,
        signedInAt: item.signed_in_at ?? item.created_at,
        location: item.location_info ?? null,
      })),
      limit: wire.limit,
    }));
  const webSessionList = z
    .object({
      items: z
        .array(
          z.object({
            id: int,
            user_agent: emptyText(256),
            current: flag,
            created_at: time,
            last_seen_at: time,
            expires_at: time,
            location_info: z
              .object({
                city: emptyText(100),
                region: emptyText(100),
                country: emptyText(100),
              })
              .nullish(),
          }),
        )
        .max(1000),
    })
    .transform((wire): ClaudexWebSessionList => ({
      items: wire.items.map((item) => ({
        id: item.id,
        userAgent: item.user_agent,
        current: item.current,
        createdAt: item.created_at,
        lastSeenAt: item.last_seen_at,
        expiresAt: item.expires_at,
        location: item.location_info ?? null,
      })),
    }));
  const webSessionRevoked = z
    .object({ id: int, revoked: z.boolean() })
    .transform((wire) => ({ id: wire.id, revoked: wire.revoked }));
  const deviceRevoked = z
    .object({ revoked: z.boolean() })
    .transform((wire) => ({ revoked: wire.revoked }));

  // GET /claudex/usage-status (design 2.6)
  const usageWindow = z.object({
    id: text(100),
    source: emptyText(32),
    kind: z.string(),
    label: text(100),
    window: emptyText(16),
    window_seconds: count.nullish().transform((value) => value ?? 0),
    used_usd: amount,
    limit_usd: amount,
    percent: amount.transform((value) =>
      Math.max(0, Math.min(100, Math.round(value))),
    ),
    active: flag,
    window_start: time,
    resets_at: time,
    models: z.array(text(200)).max(50).nullish(),
    exceeded: flag,
  });
  const usageStatus = z
    .object({
      plan: z.object({
        group_id: int,
        group_name: emptyText(100),
        subscription_id: optionalInt,
        billing_mode: emptyText(32),
      }),
      windows: z.array(usageWindow).max(100),
      balance: z.object({ balance_usd: amount }).nullish(),
      blocked: z
        .object({
          blocked: flag,
          window_id: optionalText(100),
          reason: optionalText(100),
          resets_at: time,
        })
        .nullish(),
      updated_at: time,
    })
    .transform((wire): ClaudexUsageStatus => ({
      plan: {
        groupId: wire.plan.group_id,
        groupName: wire.plan.group_name,
        subscriptionId: wire.plan.subscription_id,
        billingMode: wire.plan.billing_mode,
      },
      windows: wire.windows.flatMap((item) =>
        (usageWindowKinds as readonly string[]).includes(item.kind)
          ? [
              {
                id: item.id,
                source: item.source,
                kind: item.kind as UsageWindowKind,
                label: item.label,
                window: item.window,
                windowSeconds: item.window_seconds,
                usedUsd: item.used_usd,
                limitUsd: item.limit_usd,
                percent: item.percent,
                active: item.active,
                windowStart: item.window_start,
                resetsAt: item.resets_at,
                models: item.models ?? null,
                exceeded: item.exceeded,
              },
            ]
          : [],
      ),
      balance: wire.balance ? { balanceUsd: wire.balance.balance_usd } : null,
      blocked: {
        blocked: wire.blocked?.blocked ?? false,
        windowId: wire.blocked?.window_id ?? null,
        reason: wire.blocked?.reason ?? null,
        resetsAt: wire.blocked?.resets_at ?? null,
      },
      updatedAt: wire.updated_at,
    }));

  // Bootstrap "voice" (design 2.8)
  const voice = z
    .object({
      transcription: z.object({
        enabled: z.boolean(),
        model: optionalText(200),
        max_bytes: count.nullish(),
        // The realtime endpoint (owner decision 18) sends max_session_seconds;
        // max_seconds is the earlier name. 0 means "off".
        max_session_seconds: count.nullish(),
        max_seconds: count.nullish(),
      }),
      available: z.object({ transcription: z.boolean() }),
    })
    .transform((wire): ClaudexVoice => ({
      transcription: {
        enabled: wire.transcription.enabled,
        model: wire.transcription.model,
        maxBytes: wire.transcription.max_bytes || null,
        maxSeconds:
          wire.transcription.max_session_seconds ||
          wire.transcription.max_seconds ||
          null,
      },
      available: { transcription: wire.available.transcription },
    }));

  // Diagnostics and reply feedback (design 2.9)
  const diagnosticsAccepted = z
    .object({
      accepted: count,
      duplicates: count.nullish(),
      dropped: count.nullish(),
    })
    .transform((wire): DiagnosticsAccepted => ({
      accepted: wire.accepted,
      duplicates: wire.duplicates ?? 0,
      dropped: wire.dropped ?? 0,
    }));
  const feedbackAccepted = z
    .object({
      accepted: z.boolean(),
      duplicate: flag,
      excerpt_dropped: flag,
    })
    .transform((wire): FeedbackAccepted => ({
      accepted: wire.accepted,
      duplicate: wire.duplicate,
      excerptDropped: wire.excerpt_dropped,
    }));

  // Desktop checkout (design 2.11)
  const checkoutLink = z
    .object({
      token: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/),
      expires_at: z
        .string()
        .refine(
          (value) => Number.isFinite(Date.parse(value)),
          "expected an RFC 3339 time",
        ),
    })
    .transform((wire): ClaudexCheckoutLink => ({
      token: wire.token,
      expiresAt: Date.parse(wire.expires_at),
    }));
  const checkoutSession = z
    .object({
      order_id: int,
      status: text(32),
      provider: emptyText(32),
      amount: amount,
      pay_amount: amount,
      currency: emptyText(8),
      expires_at: time,
      stripe: z
        .object({ publishable_key: text(500), client_secret: text(500) })
        .nullish(),
      airwallex: z
        .object({
          env: emptyText(16),
          intent_id: text(200),
          client_secret: text(2000),
          currency: emptyText(8),
          country_code: emptyText(8),
        })
        .nullish(),
      result_path: z
        .string()
        .max(2000)
        .refine((value) => value.startsWith("/"), "expected a path"),
    })
    .transform((wire): ClaudexCheckoutSession => ({
      orderId: wire.order_id,
      status: wire.status,
      provider: wire.provider,
      amount: wire.amount,
      payAmount: wire.pay_amount,
      currency: wire.currency,
      expiresAt: wire.expires_at,
      stripe: wire.stripe
        ? {
            publishableKey: wire.stripe.publishable_key,
            clientSecret: wire.stripe.client_secret,
          }
        : null,
      airwallex: wire.airwallex
        ? {
            env: wire.airwallex.env,
            intentId: wire.airwallex.intent_id,
            clientSecret: wire.airwallex.client_secret,
            currency: wire.airwallex.currency,
            countryCode: wire.airwallex.country_code,
          }
        : null,
      resultPath: wire.result_path,
    }));

  // GET /claudex/bootstrap (design 2.10)
  const bootstrap = z
    .object({
      schema_version: int,
      generated_at: time,
      server: z.object({
        site_name: emptyText(100),
        version: emptyText(64),
        timezone: emptyText(64),
      }),
      plan: plan.nullish(),
      device: deviceStatus.nullish(),
      policy: policy.nullish(),
      models: catalog.nullish(),
      release: releaseSection.nullish(),
      voice: voice.nullish(),
      usage: z
        .object({ rules_enabled: flag, has_session_window: flag })
        .nullish(),
      feedback: z
        .object({
          diagnostics: z.object({ enabled: flag }),
          feedback: z.object({
            enabled: flag,
            allow_conversation_excerpt: flag,
          }),
        })
        .nullish(),
      features: z.record(z.string(), z.unknown()),
      errors: lenientList(
        z.object({
          section: text(32),
          code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
        }),
        20,
      ),
    })
    .transform((wire): ClaudexBootstrap => {
      const features = Object.fromEntries(
        Object.entries(featureKeys).map(([key, wireKey]) => [
          key,
          wire.features[wireKey] === true,
        ]),
      ) as unknown as ClaudexFeatures;
      const result: ClaudexBootstrap = {
        schemaVersion: wire.schema_version,
        generatedAt: wire.generated_at,
        server: {
          siteName: wire.server.site_name,
          version: wire.server.version,
          timezone: wire.server.timezone,
        },
        features,
        errors: wire.errors,
      };
      if (wire.plan) result.plan = wire.plan;
      if (wire.device) result.device = wire.device;
      if (wire.policy) result.policy = wire.policy;
      if (wire.models) result.models = wire.models;
      if (wire.release) result.release = wire.release;
      if (wire.voice) result.voice = wire.voice;
      if (wire.usage)
        result.usage = {
          rulesEnabled: wire.usage.rules_enabled,
          hasSessionWindow: wire.usage.has_session_window,
        };
      if (wire.feedback)
        result.feedback = {
          diagnostics: { enabled: wire.feedback.diagnostics.enabled },
          feedback: {
            enabled: wire.feedback.feedback.enabled,
            allowConversationExcerpt:
              wire.feedback.feedback.allow_conversation_excerpt,
          },
        };
      return result;
    });

  return {
    webConsole,
    release,
    policy,
    catalog,
    registration,
    deviceList,
    webSessionList,
    webSessionRevoked,
    deviceRevoked,
    usageStatus,
    voice,
    diagnosticsAccepted,
    feedbackAccepted,
    checkoutLink,
    checkoutSession,
    bootstrap,
  };
}
