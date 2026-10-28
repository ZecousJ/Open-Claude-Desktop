/**
 * Minimal client for the admin API of the Claudex server, the Sub2API fork in
 * backend/ of this repository. Used only by the operator seed script
 * (scripts/sub2api-seed.ts). Claudex never ships an admin credential: this
 * runs on an operator machine against their own deployment.
 *
 * Request bodies are checked against the Gin binding rules of the fork's
 * handler structs (Sub2API v0.2.8, commit a3eb7ef, plus the changes listed in
 * backend/CLAUDEX_CHANGES.md). Gin's ShouldBindJSON silently ignores unknown
 * JSON keys, so a misspelt field would be dropped without an error; every body
 * is therefore limited to the JSON tags of the handler struct cited next to
 * each rule. Paths below are relative to the Claudex repository root
 * (backend/backend is the fork's Go module); tests/sub2api-seed.test.ts checks
 * that every cited file exists.
 */
import { createHash, randomBytes } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json | undefined;
}

/** Placeholder for an id that only exists after a write (dry-run output). */
export type Id = number | string;

export interface AdminRequest {
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: JsonObject;
}

export class ComplianceRequiredError extends Error {
  constructor(readonly version?: string) {
    super(
      "Sub2API refuses admin requests until the owner accepts its deployment compliance commitment in the admin console (423 ADMIN_COMPLIANCE_ACK_REQUIRED). Nothing was changed.",
    );
  }
}

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Rule = (body: JsonObject, errors: string[]) => void;
interface BodyRule {
  source: string;
  /** JSON keys the handler binds; any other key in a body is an error. */
  keys: string[];
  /**
   * The body is the server's own GET answer sent back with the fields in
   * `keys` changed (a whole-setting PUT), so the other keys are the server's
   * and are passed through instead of rejected.
   */
  echoesServerState?: boolean;
  check?: Rule;
}

const GROUP_PLATFORMS = [
  "anthropic",
  "openai",
  "gemini",
  "antigravity",
  "grok",
  "kimi",
  "zhipu",
  "deepseek",
  "minimax",
  "opencode_go",
  "composite",
];
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isIdList = (value: unknown) =>
  Array.isArray(value) &&
  value.every(
    (id) => (isNumber(id) && id > 0) || typeof id === "string", // string = dry-run placeholder
  );
function oneOf(
  body: JsonObject,
  key: string,
  allowed: string[],
  errors: string[],
) {
  const value = body[key];
  if (value !== undefined && !allowed.includes(String(value)))
    errors.push(`${key} must be one of ${allowed.join(", ")}`);
}
function required(body: JsonObject, keys: string[], errors: string[]) {
  for (const key of keys)
    if (body[key] === undefined || body[key] === null || body[key] === "")
      errors.push(`${key} is required`);
}
function limits(body: JsonObject, errors: string[]) {
  // optionalLimitField: a number, a numeric string or null (null = unlimited).
  for (const key of [
    "daily_limit_usd",
    "weekly_limit_usd",
    "monthly_limit_usd",
  ])
    if (body[key] !== undefined && body[key] !== null && !isNumber(body[key]))
      errors.push(`${key} must be a number or null`);
}
function allowlist(body: JsonObject, errors: string[]) {
  // backend/backend/internal/service/group_model_allowlist.go normalizeGroupModelAllowlist:
  // enabled with an empty list is a 400; "*" is only allowed at the end.
  const value = body.model_allowlist as JsonObject | undefined;
  if (value === undefined) return;
  const models = value.models;
  if (
    typeof value.enabled !== "boolean" ||
    (models !== undefined &&
      (!Array.isArray(models) || models.some((m) => typeof m !== "string")))
  )
    return void errors.push("model_allowlist must be {enabled, models[]}");
  const list = (models ?? []) as string[];
  if (value.enabled && !list.some((model) => model.trim()))
    errors.push("model_allowlist cannot be enabled with an empty model list");
  if (list.some((model) => model.replace(/\*$/, "").includes("*")))
    errors.push('model_allowlist: "*" is only allowed at the end of an entry');
}
function groupRule(creating: boolean): Rule {
  return (body, errors) => {
    if (creating) required(body, ["name"], errors);
    oneOf(body, "platform", GROUP_PLATFORMS, errors);
    oneOf(body, "subscription_type", ["standard", "subscription"], errors);
    // backend/backend/internal/service/admin_group.go CreateGroup: "rate_multiplier must be > 0".
    if (
      (creating || body.rate_multiplier !== undefined) &&
      !(isNumber(body.rate_multiplier) && body.rate_multiplier > 0)
    )
      errors.push("rate_multiplier must be > 0");
    limits(body, errors);
    allowlist(body, errors);
  };
}
const GROUP_KEYS = [
  "name",
  "description",
  "platform",
  "rate_multiplier",
  "subscription_type",
  "daily_limit_usd",
  "weekly_limit_usd",
  "monthly_limit_usd",
  "default_mapped_model",
  "model_allowlist",
];
function credentials(body: JsonObject, errors: string[], creating: boolean) {
  const value = body.credentials;
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return void errors.push("credentials must be an object");
  const creds = value as JsonObject;
  if (creating) required(creds, ["api_key", "base_url"], errors);
  if (creds.base_url !== undefined) {
    try {
      const url = new URL(String(creds.base_url));
      if (!["http:", "https:"].includes(url.protocol) || url.username)
        throw Error();
    } catch {
      errors.push(
        "credentials.base_url must be an http(s) URL without userinfo",
      );
    }
  }
  const mapping = creds.model_mapping;
  if (
    mapping !== undefined &&
    (!mapping ||
      typeof mapping !== "object" ||
      Array.isArray(mapping) ||
      Object.values(mapping).some((target) => typeof target !== "string"))
  )
    errors.push("credentials.model_mapping must map model names to strings");
}
function pricing(body: JsonObject, errors: string[]) {
  const entries = body.model_pricing;
  if (entries === undefined) return;
  if (!Array.isArray(entries))
    return void errors.push("model_pricing must be an array");
  for (const [index, raw] of entries.entries()) {
    const entry = raw as JsonObject;
    const label = `model_pricing[${index}]`;
    const models = entry.models;
    // channelModelPricingRequest: models required,min=1,max=100; prices omitempty,min=0.
    if (
      !Array.isArray(models) ||
      models.length < 1 ||
      models.length > 100 ||
      models.some((model) => typeof model !== "string" || !model)
    )
      errors.push(`${label}.models must hold 1-100 model names`);
    oneOf(entry, "billing_mode", ["token", "per_request", "image"], errors);
    // Prices are *float64 with min=0: a number >= 0, or null for "not set".
    for (const key of [
      "input_price",
      "output_price",
      "cache_write_price",
      "cache_write_1h_price",
      "cache_read_price",
    ])
      if (
        entry[key] !== undefined &&
        entry[key] !== null &&
        !(isNumber(entry[key]) && (entry[key] as number) >= 0)
      )
        errors.push(`${label}.${key} must be a number >= 0 or null`);
    const extra = Object.keys(entry).filter(
      (key) => !PRICING_KEYS.includes(key),
    );
    if (extra.length)
      errors.push(`${label} has fields Sub2API ignores: ${extra.join(", ")}`);
  }
}
// Every JSON key of channelModelPricingRequest, so entries the operator added
// in the console survive a seed update unchanged.
const PRICING_KEYS = [
  "platform",
  "models",
  "billing_mode",
  "input_price",
  "output_price",
  "cache_write_price",
  "cache_write_1h_price",
  "cache_read_price",
  "fast_multiplier",
  "flex_multiplier",
  "reasoning_effort_multipliers",
  "image_input_price",
  "image_output_price",
  "per_request_price",
  "intervals",
  "time_pricing",
];

/** Keyed by "METHOD route" with :id for path parameters. */
export const BODY_RULES: Record<string, BodyRule> = {
  "POST /api/v1/admin/groups": {
    source:
      "backend/backend/internal/handler/admin/group_handler.go CreateGroupRequest; backend/backend/internal/service/admin_group.go CreateGroup",
    keys: GROUP_KEYS,
    check: groupRule(true),
  },
  "PUT /api/v1/admin/groups/:id": {
    source:
      "backend/backend/internal/handler/admin/group_handler.go UpdateGroupRequest (pointer fields: omitted = unchanged)",
    keys: GROUP_KEYS,
    check: groupRule(false),
  },
  "POST /api/v1/admin/accounts": {
    source:
      "backend/backend/internal/handler/admin/account_handler.go CreateAccountRequest (type oneof oauth setup-token apikey upstream bedrock service_account)",
    keys: [
      "name",
      "notes",
      "platform",
      "type",
      "credentials",
      "concurrency",
      "priority",
      "group_ids",
    ],
    check: (body, errors) => {
      required(body, ["name", "platform", "type", "credentials"], errors);
      oneOf(
        body,
        "type",
        [
          "oauth",
          "setup-token",
          "apikey",
          "upstream",
          "bedrock",
          "service_account",
        ],
        errors,
      );
      credentials(body, errors, true);
      if (body.group_ids !== undefined && !isIdList(body.group_ids))
        errors.push("group_ids must be a list of ids");
    },
  },
  "PUT /api/v1/admin/accounts/:id": {
    source:
      "backend/backend/internal/handler/admin/account_handler.go UpdateAccountRequest; credentials merge keeps stored secrets: backend/backend/internal/service/account_credentials_redact.go MergePreservingSensitiveCreds",
    keys: ["credentials", "group_ids"],
    check: (body, errors) => {
      credentials(body, errors, false);
      if (body.group_ids !== undefined && !isIdList(body.group_ids))
        errors.push("group_ids must be a list of ids");
    },
  },
  "POST /api/v1/admin/channels": {
    source:
      "backend/backend/internal/handler/admin/channel_handler.go createChannelRequest / channelModelPricingRequest",
    keys: ["name", "description", "group_ids", "model_pricing"],
    check: (body, errors) => {
      required(body, ["name"], errors);
      if (String(body.name ?? "").length > 100)
        errors.push("name must be at most 100 characters");
      pricing(body, errors);
    },
  },
  "PUT /api/v1/admin/channels/:id": {
    source:
      "backend/backend/internal/handler/admin/channel_handler.go updateChannelRequest",
    keys: ["group_ids", "model_pricing"],
    check: pricing,
  },
  "PUT /api/v1/admin/settings": {
    source:
      "backend/backend/internal/handler/admin/setting_handler_update.go UpdateSettingsRequest; omitted keys keep their value: backend/backend/internal/handler/admin/setting_handler_partial_payload_test.go",
    keys: [
      "site_name",
      "site_subtitle",
      "registration_enabled",
      "invitation_code_enabled",
      "email_verify_enabled",
    ],
    check: (body, errors) => {
      for (const key of [
        "registration_enabled",
        "invitation_code_enabled",
        "email_verify_enabled",
      ])
        if (body[key] !== undefined && typeof body[key] !== "boolean")
          errors.push(`${key} must be a boolean`);
    },
  },
  "POST /api/v1/admin/users": {
    source:
      "backend/backend/internal/handler/admin/user_handler.go CreateUserRequest (email required,email; password required,min=6; role oneof admin user)",
    keys: [
      "email",
      "password",
      "username",
      "notes",
      "role",
      "concurrency",
      "allowed_groups",
    ],
    check: (body, errors) => {
      required(body, ["email", "password"], errors);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email ?? "")))
        errors.push("email must be an email address");
      if (String(body.password ?? "").length < 6)
        errors.push("password must be at least 6 characters");
      // Creating an admin needs TOTP step-up (user_handler.go Create); the seed only makes users.
      if (body.role !== undefined && body.role !== "user")
        errors.push("role must be user");
    },
  },
  "POST /api/v1/admin/subscriptions/assign": {
    source:
      "backend/backend/internal/handler/admin/subscription_handler.go AssignSubscriptionRequest (validity_days max=36500)",
    keys: ["user_id", "group_id", "validity_days", "notes"],
    check: (body, errors) => {
      required(body, ["user_id", "group_id"], errors);
      const days = body.validity_days;
      if (
        days !== undefined &&
        !(
          Number.isInteger(days) &&
          (days as number) >= 1 &&
          (days as number) <= 36500
        )
      )
        errors.push("validity_days must be an integer from 1 to 36500");
    },
  },
  // Claudex device provisioning (seed --claudex-provisioning). The setting is
  // read with GET and written back whole, so fields the seed does not manage
  // keep their stored values.
  "PUT /api/v1/admin/claudex/provisioning": {
    source:
      "Claudex server design section 2.5, setting claudex_provisioning (package B4, backend/backend/internal/claudex/devices)",
    keys: ["default_group_id", "allowed_group_ids"],
    echoesServerState: true,
    check: (body, errors) => {
      const id = body.default_group_id;
      if (!(
        (Number.isInteger(id) && (id as number) > 0) ||
        typeof id === "string" // dry-run placeholder
      ))
        errors.push("default_group_id must be a group id");
      if (
        body.allowed_group_ids !== undefined &&
        body.allowed_group_ids !== null &&
        !isIdList(body.allowed_group_ids)
      )
        errors.push("allowed_group_ids must be a list of ids");
      if (body.enabled !== undefined && typeof body.enabled !== "boolean")
        errors.push("enabled must be a boolean");
    },
  },
};

export function routeOf(request: AdminRequest) {
  const path = request.path
    .split("?")[0]
    .replace(/\/(\d+|<[^/]+>)(?=\/|$)/g, "/:id");
  return `${request.method} ${path}`;
}

/** Throws when a write body would be rejected, or partly ignored, by the server. */
export function validateRequest(request: AdminRequest) {
  if (request.method === "GET") return;
  const rule = BODY_RULES[routeOf(request)];
  if (!rule) throw Error(`No admin API body rule for ${routeOf(request)}.`);
  const body = request.body ?? {};
  const errors: string[] = [];
  const unknown = rule.echoesServerState
    ? []
    : Object.keys(body).filter((key) => !rule.keys.includes(key));
  if (unknown.length)
    errors.push(`fields not in ${rule.source}: ${unknown.join(", ")}`);
  rule.check?.(body, errors);
  if (errors.length)
    throw Error(`${routeOf(request)} body is invalid: ${errors.join("; ")}.`);
}

export const SECRET = "<redacted>";

/** Replaces secrets in a body copy before it is printed or hashed. */
export function redactBody(
  body: JsonObject | undefined,
): JsonObject | undefined {
  if (!body) return body;
  const copy = JSON.parse(JSON.stringify(body)) as JsonObject;
  if (typeof copy.password === "string") copy.password = SECRET;
  const creds = copy.credentials as JsonObject | undefined;
  if (creds && typeof creds.api_key === "string") creds.api_key = SECRET;
  return copy;
}

/** A fresh value per seed run, so Idempotency-Keys never repeat across runs. */
export function newRunId() {
  return randomBytes(8).toString("hex");
}

/**
 * Idempotency-Key for one write of one run (Sub2API accepts 1-128 printable
 * ASCII). Sub2API replays a stored response for a repeated key for 24 hours
 * (backend/backend/internal/service/idempotency.go DefaultTTL), so a key reused by a
 * later run would hand back the id of an entity the operator has since
 * deleted; the run id prevents that. Cross-run idempotency comes from the
 * seed's lookups by name instead. Secrets are redacted before hashing.
 */
export function idempotencyKey(request: AdminRequest, runId: string) {
  const digest = createHash("sha256")
    .update(
      `${request.method} ${request.path} ${JSON.stringify(redactBody(request.body) ?? null)}`,
    )
    .digest("hex");
  return `claudex-seed-${runId}-${digest.slice(0, 32)}`;
}

export interface AdminAuth {
  apiKey?: string;
  token?: string;
}

export type Fetch = typeof fetch;

/**
 * Sends one admin request and unwraps Sub2API's {code:0, data} envelope
 * (backend/backend/internal/pkg/response/response.go).
 */
export async function sendAdmin(
  baseUrl: string,
  auth: AdminAuth,
  request: AdminRequest,
  fetchImpl: Fetch = fetch,
  runId = newRunId(),
): Promise<unknown> {
  validateRequest(request);
  const headers: Record<string, string> = { accept: "application/json" };
  // backend/backend/internal/server/middleware/admin_auth.go: x-api-key first, then a Bearer JWT.
  if (auth.apiKey) headers["x-api-key"] = auth.apiKey;
  else if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (request.body) headers["content-type"] = "application/json";
  if (request.method === "POST")
    headers["idempotency-key"] = idempotencyKey(request, runId);
  const response = await fetchImpl(new URL(request.path, baseUrl), {
    method: request.method,
    headers,
    body: request.body ? JSON.stringify(request.body) : undefined,
    redirect: "error",
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Non-JSON (a proxy error page) falls through to the status check.
  }
  // backend/backend/internal/server/middleware/admin_compliance.go AdminComplianceGuard.
  if (
    response.status === 423 ||
    payload.code === "ADMIN_COMPLIANCE_ACK_REQUIRED"
  ) {
    const metadata = payload.metadata as Record<string, string> | undefined;
    throw new ComplianceRequiredError(metadata?.version);
  }
  if (!response.ok || (payload.code !== 0 && payload.code !== undefined))
    throw new AdminApiError(
      response.status,
      String(payload.reason || payload.code || response.status),
      `${request.method} ${request.path.split("?")[0]} failed with HTTP ${response.status}: ${String(payload.message ?? "no message").slice(0, 300)}`,
    );
  return payload.data;
}
