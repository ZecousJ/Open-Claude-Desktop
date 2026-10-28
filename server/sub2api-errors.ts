import type { LimitReason } from "../shared/usage-api";
import {
  parseRefusal,
  requestIdPattern,
  type ClaudexRefusal,
  type GatewayRefusalDetails,
} from "../shared/claudex-contract";

/**
 * A Sub2API gateway refusal in terms the person can act on. `exceeded`
 * marks limits that keep refusing until a window resets or the plan
 * changes, which the usage banner shows as its exceeded state.
 *
 * A Claudex service explains its refusals in a `claudex` object; the
 * details it gives (`claudex` itself, `resetsAt`, `action`, `reprovision`,
 * `signedOut`, `models`) travel with the refusal to the main process.
 * `reason` keeps its banner meaning (which limit, in the banner's words);
 * the service's own reason code is `claudex.reason`.
 */
export interface GatewayRefusal extends GatewayRefusalDetails {
  status: number;
  code: string;
  reason?: LimitReason;
  exceeded: boolean;
  /** The device key was refused; the main process provisions it again. */
  invalidKey: boolean;
  message: string;
}

/**
 * Error bodies larger than this are not read for a `claudex` object: the
 * Claudex service only adds one to bodies of at most 64 KB (design 2.7), so
 * a larger body did not come from it.
 */
export const maxClaudexBodyBytes = 64 * 1024;

const text = (value: unknown) => (typeof value === "string" ? value : "");

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Code and message from `{code, message}` or OpenAI's `{error:{type|code, message}}`. */
function fields(body: string, parsed = parseBody(body)) {
  if (parsed === undefined) return { code: "", message: body.slice(0, 500) };
  const data =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  const nested =
    data.error && typeof data.error === "object"
      ? (data.error as Record<string, unknown>)
      : {};
  return {
    code: text(data.code) || text(nested.code) || text(nested.type),
    message: text(data.message) || text(nested.message),
  };
}

const windowMessages: Record<"daily" | "weekly" | "monthly", string> = {
  daily:
    "You’ve reached your plan’s daily usage limit. Requests resume when the daily window resets.",
  weekly:
    "You’ve reached your plan’s weekly usage limit. Requests resume when the weekly window resets.",
  monthly:
    "You’ve reached your plan’s monthly usage limit. Requests resume when the monthly window resets.",
};

/** Which plan window a limit message names (Sub2API reuses one code for all three). */
function windowOf(code: string, message: string) {
  const key = `${code} ${message}`.toLowerCase().replace(/_/g, " ");
  if (/daily|\b1d\b|日限额/.test(key)) return "daily" as const;
  if (/weekly|\b7d\b|7天/.test(key)) return "weekly" as const;
  if (/monthly/.test(key)) return "monthly" as const;
  return undefined;
}

/** Plan windows by the service's window label. */
const windowReasons: Record<string, LimitReason> = {
  "1d": "daily",
  "7d": "weekly",
  "30d": "monthly",
};

/**
 * The banner's reason for a structured refusal (design 4.3): the window for
 * plan and platform limits, `session`/`model` for Claudex usage rules, and
 * the plan state for key, balance and subscription refusals. Refusals that
 * are no lasting limit (request rate, key, group, account, update) have none.
 */
export function limitReasonOf(detail: ClaudexRefusal): LimitReason | undefined {
  const window = detail.window && windowReasons[detail.window];
  switch (detail.kind) {
    case "usage_limit":
      if (window) return window;
      // A window the service did not name: the reason code says it.
      if (/_DAILY_/.test(detail.reason)) return "daily";
      if (/_WEEKLY_/.test(detail.reason)) return "weekly";
      if (/_MONTHLY_/.test(detail.reason)) return "monthly";
      return undefined;
    case "rule_limit":
      // The service names the rule's kind (R13); older services leave it
      // out and the models and window tell.
      if (detail.ruleKind === "session") return "session";
      if (detail.ruleKind === "models") return "model";
      if (detail.ruleKind === "all_models") return window || undefined;
      // Only a per-model rule names models (the session and all-models
      // rules cover every model).
      if (detail.models?.length) return "model";
      if (detail.window && /^\d+[mh]$/.test(detail.window)) return "session";
      return window || undefined;
    case "key_limit":
      return "key-quota";
    case "balance":
      return "balance";
    case "subscription":
      return "subscription";
    default:
      return undefined;
  }
}

/** Kinds that keep refusing until a window resets or the plan changes. */
const lastingKinds = new Set([
  "usage_limit",
  "rule_limit",
  "key_limit",
  "balance",
  "subscription",
]);

/** Text for the person: printable, one line, as the service wrote it. */
const plainMessage = (value: string) =>
  value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 1000);

/** The `claudex` object of an error body, when it may be used. */
function claudexDetail(status: number, body: string, parsed: unknown) {
  // Checked on characters first so a huge body is not encoded.
  if (
    body.length > maxClaudexBodyBytes ||
    new TextEncoder().encode(body).length > maxClaudexBodyBytes
  )
    return undefined;
  return parseRefusal(status, parsed);
}

/**
 * Maps one Sub2API gateway error response; undefined when it is not a Sub2API refusal.
 *
 * A Claudex service explains a 401, 402, 403, 426 or 429 refusal in a
 * `claudex` object (version 1, bodies of at most 64 KB); that explanation
 * is used as it is. Without one (an older or unmodified Sub2API service, a
 * non-device key, or any other status) the code and message are matched as
 * before; that mapping is kept only for older services.
 *
 * `now` dates a reset the service gave only as seconds to wait;
 * `requestId` is the answer's `X-Client-Request-ID`, kept for diagnostics.
 */
export function describeSub2ApiRefusal(
  status: number,
  body: string,
  now = Date.now(),
  requestId?: string | null,
): GatewayRefusal | undefined {
  const refusal = describeRefusal(status, body, now);
  if (refusal && requestId && requestIdPattern.test(requestId))
    refusal.requestId = requestId;
  return refusal;
}

function describeRefusal(
  status: number,
  body: string,
  now: number,
): GatewayRefusal | undefined {
  const parsed = parseBody(body);
  const legacy = describeLegacyRefusal(status, body, parsed);
  const detail = claudexDetail(status, body, parsed);
  if (!detail) return legacy;
  const code = fields(body, parsed).code.toUpperCase();
  const signedOut = detail.reason === "DEVICE_REVOKED";
  const refusal: GatewayRefusal = {
    status,
    code: code || detail.reason,
    exceeded: lastingKinds.has(detail.kind),
    // A signed-out device registers again only after the next sign-in.
    invalidKey: detail.reprovision && !signedOut,
    message:
      plainMessage(detail.message) ||
      legacy?.message ||
      "The Claudex service refused this request.",
    claudex: detail,
    action: detail.action,
    reprovision: detail.reprovision,
    signedOut,
  };
  const reason = limitReasonOf(detail);
  if (reason) refusal.reason = reason;
  const resetsAt =
    detail.resetsAt ??
    (detail.retryAfterSeconds
      ? now + detail.retryAfterSeconds * 1000
      : undefined);
  if (resetsAt !== undefined) refusal.resetsAt = resetsAt;
  if (detail.models?.length) refusal.models = detail.models;
  return refusal;
}

export interface RefusalFollowUp {
  reprovision: boolean;
  signOut: boolean;
  refreshRelease: boolean;
  /** The window-wide notice this refusal calls for, if any. */
  globalLimit?: GlobalLimitKind;
}
export type GlobalLimitKind = "session" | "rate-limit";

/**
 * What the main process does after a refusal besides the banner: issue the
 * device key again, end the remote session, read the release information again
 * (an update is required; its download address comes only from the release
 * information, never from the refusal), or show the window's global limit
 * notice.
 *
 * `claudexService` says the answer came from a Claudex service: only then are
 * its explanations acted on (on an older service the fields could come from an
 * upstream relay), and only its refusals sign the device out.
 */
export function refusalFollowUp(
  refusal: GatewayRefusal,
  claudexService = true,
): RefusalFollowUp {
  const claudex = claudexService ? refusal.claudex : undefined;
  const signOut =
    claudexService &&
    (refusal.signedOut === true || claudex?.reason === "DEVICE_REVOKED");
  const reprovision =
    !signOut &&
    (claudexService
      ? (refusal.reprovision ?? claudex?.reprovision ?? refusal.invalidKey)
      : refusal.invalidKey);
  const follow: RefusalFollowUp = {
    reprovision,
    signOut,
    refreshRelease:
      claudexService &&
      (claudex?.reason === "UPGRADE_REQUIRED" ||
        claudex?.kind === "upgrade" ||
        refusal.action === "update" ||
        refusal.status === 426),
  };
  const global = signOut ? undefined : globalLimitOf(refusal, claudex);
  if (global) follow.globalLimit = global;
  return follow;
}

/**
 * The 5-hour session limit (every model is refused until it resets) and the
 * service's request rate limit. Per-model, weekly and account refusals keep
 * only the banner.
 */
function globalLimitOf(
  refusal: GatewayRefusal,
  claudex: ClaudexRefusal | undefined,
): GlobalLimitKind | undefined {
  if (claudex?.kind === "rate_limit") return "rate-limit";
  if (refusal.reason === "session") return "session";
  return undefined;
}

/**
 * The older mapping, by code and message: Sub2API services without the
 * Claudex module do not explain their refusals, so their wording (English
 * and Chinese) is matched here.
 */
function describeLegacyRefusal(
  status: number,
  body: string,
  parsed: unknown,
): GatewayRefusal | undefined {
  const { code, message } = fields(body, parsed);
  const upper = code.toUpperCase();
  const lower = message.toLowerCase();
  const refusal = (
    reason: LimitReason | undefined,
    exceeded: boolean,
    text: string,
    invalidKey = false,
  ): GatewayRefusal => ({
    status,
    code: upper,
    reason,
    exceeded,
    invalidKey,
    message: text,
  });
  if (
    upper === "INVALID_API_KEY" ||
    (status === 401 && /invalid api key/.test(lower))
  )
    return refusal(
      undefined,
      false,
      "This device’s Claudex key is no longer valid. Claudex is requesting a new one; send your message again in a moment.",
      true,
    );
  if (
    upper === "INSUFFICIENT_BALANCE" ||
    /insufficient (account )?balance/.test(lower)
  )
    return refusal(
      "balance",
      true,
      "Your Claudex balance is used up. Add funds to keep going.",
    );
  if (
    [
      "DAILY_LIMIT_EXCEEDED",
      "WEEKLY_LIMIT_EXCEEDED",
      "MONTHLY_LIMIT_EXCEEDED",
    ].includes(upper)
  )
    return refusal(
      windowOf(upper, "")!,
      true,
      windowMessages[windowOf(upper, "")!],
    );
  if (
    upper === "USAGE_LIMIT_EXCEEDED" ||
    /usage (limit exceeded|quota exhausted)/.test(lower)
  ) {
    const window = windowOf("", lower);
    return refusal(
      window,
      true,
      window
        ? windowMessages[window]
        : "You’ve reached your plan’s usage limit. Requests resume when the limit resets.",
    );
  }
  if (
    upper === "API_KEY_QUOTA_EXHAUSTED" ||
    upper === "INSUFFICIENT_QUOTA" ||
    (upper.startsWith("API_KEY_RATE_") && upper.endsWith("_EXCEEDED")) ||
    /(额度|限额)已用完/.test(message)
  ) {
    // A key's rolling 5h/1d/7d caps and its total quota share this wording.
    const scope = `${upper} ${message}`.toLowerCase().replace(/_/g, " ");
    if (/5小时|\b5h\b/.test(scope))
      return refusal(
        "key-quota",
        true,
        "This device has reached its 5-hour spending cap. Requests resume as older usage leaves the window.",
      );
    const window = windowOf(upper, message);
    return refusal(
      "key-quota",
      true,
      window === "daily"
        ? "This device has reached its daily spending cap. Requests resume as older usage leaves the window."
        : window === "weekly"
          ? "This device has reached its 7-day spending cap. Requests resume as older usage leaves the window."
          : "This device’s key has used its whole quota. Ask your administrator to raise it.",
    );
  }
  if (
    upper === "SUBSCRIPTION_EXPIRED" ||
    /subscription has expired/.test(lower)
  )
    return refusal(
      "subscription",
      true,
      "Your Claudex plan has expired. Renew it or ask your administrator.",
    );
  if (
    upper === "SUBSCRIPTION_SUSPENDED" ||
    /subscription is suspended/.test(lower)
  )
    return refusal(
      "subscription",
      true,
      "Your Claudex plan is suspended. Contact your administrator.",
    );
  if (upper === "SUBSCRIPTION_INVALID" || upper === "SUBSCRIPTION_NOT_FOUND")
    return refusal(
      "subscription",
      true,
      "Your account has no active plan for this service. Contact your administrator.",
    );
  // The key's group was deleted, disabled or closed to this person: the plan
  // changed, so the key is issued again in the current plan's group.
  if (
    upper === "GROUP_DELETED" ||
    upper === "GROUP_DISABLED" ||
    upper === "GROUP_NOT_ALLOWED"
  )
    return refusal(
      undefined,
      false,
      "Your Claudex plan changed. Claudex is updating this device’s key; send your message again in a moment.",
      true,
    );
  if (upper === "API_KEY_DISABLED")
    return refusal(
      undefined,
      false,
      "This device’s Claudex key is disabled. Turn it back on in your account or ask your administrator.",
    );
  if (upper === "API_KEY_EXPIRED")
    return refusal(
      undefined,
      false,
      "This device’s Claudex key has expired. Ask your administrator to renew it.",
    );
  if (upper === "USER_INACTIVE" || upper === "USER_NOT_ACTIVE")
    return refusal(
      undefined,
      false,
      "This account is disabled. Contact your administrator.",
    );
  if (upper === "USER_NOT_FOUND")
    return refusal(
      undefined,
      false,
      "This account no longer exists on the Claudex service. Contact your administrator.",
    );
  if (status === 429)
    return refusal(
      undefined,
      false,
      "Too many requests right now. Wait a moment and try again.",
    );
  if (status === 403 && /model/.test(lower))
    return refusal(
      undefined,
      false,
      "Your plan does not include this model. Choose another model.",
    );
  return undefined;
}

/**
 * The error of a `response.failed` event that ended a started stream. Only
 * Sub2API's named refusals count: an upstream or server failure keeps the
 * agent's own error rather than reading as a rate limit.
 */
export function describeStreamRefusal(
  error: unknown,
): GatewayRefusal | undefined {
  return describeSub2ApiRefusal(0, JSON.stringify({ error: error ?? {} }));
}
