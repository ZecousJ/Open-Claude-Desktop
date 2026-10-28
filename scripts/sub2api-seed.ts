/**
 * Operator seed for a Claudex server (the Sub2API fork in backend/).
 *
 * Run it only after the owner has personally accepted the deployment
 * compliance commitment in the admin console; until then every admin route
 * answers 423 and this script stops before writing anything. It never accepts
 * that commitment itself.
 *
 *   npx tsx scripts/sub2api-seed.ts --env deploy/sub2api/seed.env [--dry-run [--live-reads]] [--claudex-provisioning]
 *
 * Idempotent: each entity is looked up by name first and only missing or
 * different fields are written. --claudex-provisioning also makes the seed's
 * subscription group the default group of Claudex device provisioning. See
 * deploy/sub2api/seed.env.example for the inputs and docs/self-hosting.md for
 * the runbook.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  AdminApiError,
  ComplianceRequiredError,
  SECRET,
  idempotencyKey,
  newRunId,
  redactBody,
  sendAdmin,
  validateRequest,
  type AdminAuth,
  type AdminRequest,
  type Fetch,
  type Id,
  type JsonObject,
} from "./sub2api-admin";

export interface SeedConfig {
  url: string;
  auth: AdminAuth;
  platform: string;
  upstream: {
    name: string;
    baseUrl: string;
    apiKey: string;
    concurrency: number;
    priority: number;
    rotateKey: boolean;
  };
  models: string[];
  defaultModel: string;
  modelMapping: Record<string, string>;
  pricePerToken: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  standardGroup: { name: string; description: string; rateMultiplier: number };
  planGroup: {
    name: string;
    description: string;
    rateMultiplier: number;
    dailyUsd?: number;
    weeklyUsd?: number;
    monthlyUsd?: number;
  };
  channelName: string;
  settings: {
    siteName: string;
    siteSubtitle?: string;
    registration: "closed" | "open" | "invite";
    emailVerify?: boolean;
  };
  testUser?: {
    email: string;
    password: string;
    concurrency: number;
    validityDays: number;
  };
}

export { redactBody };

/** Parses KEY=VALUE lines (a small subset of dotenv: # comments, optional quotes). */
export function parseEnvFile(text: string) {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (!match || line.trimStart().startsWith("#")) continue;
    let value = match[2].trim();
    const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "");
    values[match[1]] = value;
  }
  return values;
}

export class ConfigError extends Error {}

/**
 * Builds the seed configuration from environment variables. Secrets may be
 * absent in dry-run mode; they are never printed either way.
 */
export function loadConfig(
  env: Record<string, string | undefined>,
  dryRun: boolean,
): SeedConfig {
  const errors: string[] = [];
  const get = (key: string) => env[key]?.trim() || undefined;
  const need = (key: string, secret = false) => {
    const value = get(key);
    if (!value && !(secret && dryRun)) errors.push(`${key} is required`);
    return value ?? (secret ? SECRET : "");
  };
  const number = (key: string, fallback?: number, min = 0) => {
    const raw = get(key);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min) {
      errors.push(`${key} must be a number >= ${min}`);
      return fallback;
    }
    return value;
  };
  const positive = (key: string, fallback?: number) => {
    const value = number(key, fallback);
    if (value !== undefined && value <= 0) {
      errors.push(`${key} must be greater than 0`);
      return fallback;
    }
    return value;
  };
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = number(key, fallback, min) ?? fallback;
    if (!Number.isInteger(value) || value > max) {
      errors.push(`${key} must be an integer from ${min} to ${max}`);
      return fallback;
    }
    return value;
  };
  const flag = (key: string) => {
    const raw = get(key)?.toLowerCase();
    if (raw === undefined) return undefined;
    if (["1", "true", "yes"].includes(raw)) return true;
    if (["0", "false", "no"].includes(raw)) return false;
    errors.push(`${key} must be true or false`);
    return undefined;
  };
  const httpUrl = (key: string) => {
    const value = need(key);
    if (!value) return value;
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username)
        throw Error();
    } catch {
      errors.push(`${key} must be an http(s) URL without userinfo`);
    }
    return value;
  };

  const url = httpUrl("SUB2API_URL");
  const auth: AdminAuth = {
    apiKey: get("SUB2API_ADMIN_API_KEY"),
    token: get("SUB2API_ADMIN_TOKEN"),
  };
  if (!dryRun && !auth.apiKey && !auth.token)
    errors.push("SUB2API_ADMIN_API_KEY (or SUB2API_ADMIN_TOKEN) is required");

  const models = [
    ...new Set(
      (get("CLAUDEX_MODELS") ?? "")
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
  if (!models.length) errors.push("CLAUDEX_MODELS is required");
  if (models.some((model) => model.includes("*")))
    errors.push("CLAUDEX_MODELS must list exact model names");
  const defaultModel = get("CLAUDEX_DEFAULT_MODEL") ?? models[0] ?? "";
  if (models.length && !models.includes(defaultModel))
    errors.push("CLAUDEX_DEFAULT_MODEL must be one of CLAUDEX_MODELS");
  const modelMapping = Object.fromEntries(models.map((m) => [m, m]));
  for (const pair of (get("CLAUDEX_MODEL_MAPPING") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const [from, to] = pair.split("=").map((part) => part?.trim());
    if (!from || !to || !models.includes(from))
      errors.push(
        `CLAUDEX_MODEL_MAPPING entry "${pair}" must be <model in CLAUDEX_MODELS>=<upstream model>`,
      );
    else modelMapping[from] = to;
  }

  const perToken = (key: string) => {
    const value = number(key);
    return value === undefined ? undefined : value / 1_000_000;
  };
  need("CLAUDEX_PRICE_INPUT_USD_PER_MTOK");
  need("CLAUDEX_PRICE_OUTPUT_USD_PER_MTOK");

  const registration = (get("CLAUDEX_REGISTRATION") ?? "closed").toLowerCase();
  if (!["closed", "open", "invite"].includes(registration))
    errors.push("CLAUDEX_REGISTRATION must be closed, open or invite");

  const platform = get("CLAUDEX_UPSTREAM_PLATFORM") ?? "openai";
  const email = get("CLAUDEX_TEST_USER_EMAIL");
  const password = get("CLAUDEX_TEST_USER_PASSWORD");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors.push("CLAUDEX_TEST_USER_EMAIL must be an email address");
  if (email && !password && !dryRun)
    errors.push(
      "CLAUDEX_TEST_USER_PASSWORD is required with CLAUDEX_TEST_USER_EMAIL",
    );
  if (password && password.length < 6)
    errors.push("CLAUDEX_TEST_USER_PASSWORD must be at least 6 characters");
  if (password && !email)
    errors.push(
      "CLAUDEX_TEST_USER_EMAIL is required with CLAUDEX_TEST_USER_PASSWORD",
    );

  const config: SeedConfig = {
    url,
    auth,
    platform,
    upstream: {
      name: get("CLAUDEX_UPSTREAM_NAME") ?? "claudex-upstream",
      baseUrl: httpUrl("CLAUDEX_UPSTREAM_BASE_URL"),
      apiKey: need("CLAUDEX_UPSTREAM_API_KEY", true),
      concurrency: integer("CLAUDEX_UPSTREAM_CONCURRENCY", 3, 1, 10000),
      priority: integer("CLAUDEX_UPSTREAM_PRIORITY", 1, 0, 10000),
      rotateKey: flag("CLAUDEX_UPSTREAM_ROTATE_KEY") ?? false,
    },
    models,
    defaultModel,
    modelMapping,
    pricePerToken: {
      input: perToken("CLAUDEX_PRICE_INPUT_USD_PER_MTOK") ?? 0,
      output: perToken("CLAUDEX_PRICE_OUTPUT_USD_PER_MTOK") ?? 0,
      cacheRead: perToken("CLAUDEX_PRICE_CACHE_READ_USD_PER_MTOK"),
      cacheWrite: perToken("CLAUDEX_PRICE_CACHE_WRITE_USD_PER_MTOK"),
    },
    standardGroup: {
      name: get("CLAUDEX_STANDARD_GROUP") ?? "claudex-standard",
      description:
        get("CLAUDEX_STANDARD_DESCRIPTION") ??
        "Claudex pay-as-you-go (balance)",
      rateMultiplier: positive("CLAUDEX_STANDARD_RATE_MULTIPLIER", 1) ?? 1,
    },
    planGroup: {
      name: get("CLAUDEX_PLAN_GROUP") ?? "claudex-pro",
      description:
        get("CLAUDEX_PLAN_DESCRIPTION") ?? "Claudex subscription plan",
      rateMultiplier: positive("CLAUDEX_PLAN_RATE_MULTIPLIER", 1) ?? 1,
      dailyUsd: positive("CLAUDEX_PLAN_DAILY_USD"),
      weeklyUsd: positive("CLAUDEX_PLAN_WEEKLY_USD"),
      monthlyUsd: positive("CLAUDEX_PLAN_MONTHLY_USD"),
    },
    channelName: get("CLAUDEX_CHANNEL_NAME") ?? "claudex-pricing",
    settings: {
      siteName: get("CLAUDEX_SITE_NAME") ?? "Claudex",
      siteSubtitle: get("CLAUDEX_SITE_SUBTITLE"),
      registration: registration as SeedConfig["settings"]["registration"],
      emailVerify: flag("CLAUDEX_EMAIL_VERIFY"),
    },
    testUser: email
      ? {
          email,
          password: password ?? SECRET,
          concurrency: integer("CLAUDEX_TEST_USER_CONCURRENCY", 3, 1, 10000),
          validityDays: integer("CLAUDEX_TEST_USER_DAYS", 30, 1, 36500),
        }
      : undefined,
  };
  if (config.standardGroup.name === config.planGroup.name)
    errors.push("CLAUDEX_STANDARD_GROUP and CLAUDEX_PLAN_GROUP must differ");
  if (errors.length) throw new ConfigError(errors.join("\n"));
  return config;
}

// ---------------------------------------------------------------------------
// Desired request bodies. Field names follow the handler structs cited in
// scripts/sub2api-admin.ts BODY_RULES; validateRequest enforces them.

function groupBody(
  config: SeedConfig,
  group: SeedConfig["standardGroup"] & Partial<SeedConfig["planGroup"]>,
  subscription: boolean,
): JsonObject {
  const body: JsonObject = {
    name: group.name,
    description: group.description,
    platform: config.platform,
    subscription_type: subscription ? "subscription" : "standard",
    rate_multiplier: group.rateMultiplier,
    model_allowlist: { enabled: true, models: config.models },
    // backend/backend/internal/service/openai_model_mapping.go resolveOpenAIForwardModel:
    // the upstream fallback when an account mapping has no entry. Only openai
    // (and composite) groups keep it (openai_messages_dispatch.go).
    ...(config.platform === "openai"
      ? { default_mapped_model: config.modelMapping[config.defaultModel] }
      : {}),
  };
  // null = unlimited (group_handler.go optionalLimitField, admin_group.go
  // normalizeLimit); 0 would block all usage. Sent every time so a limit the
  // operator removed from the env file is cleared on the next run.
  if (subscription) {
    body.daily_limit_usd = group.dailyUsd ?? null;
    body.weekly_limit_usd = group.weeklyUsd ?? null;
    body.monthly_limit_usd = group.monthlyUsd ?? null;
  }
  return body;
}

function pricingEntry(config: SeedConfig): JsonObject {
  const price = config.pricePerToken;
  return {
    platform: config.platform,
    models: config.models,
    billing_mode: "token",
    input_price: price.input,
    output_price: price.output,
    // null = not set, so a cache price removed from the env file is cleared.
    cache_read_price: price.cacheRead ?? null,
    cache_write_price: price.cacheWrite ?? null,
  };
}

/**
 * The channel's pricing list with the seed's entry in place. A group belongs
 * to at most one channel (backend/backend/internal/service/channel_service.go
 * ErrGroupAlreadyInChannel), so
 * prices the operator added in the console for other models live in this
 * channel too: they are kept, minus any model the seed now prices itself.
 */
export function mergePricing(
  current: Record<string, unknown>[],
  managed: JsonObject,
): { list: JsonObject[]; changed: boolean } {
  const models = new Set(managed.models as string[]);
  const sorted = (entry: Record<string, unknown>) => ({
    ...entry,
    models: [...((entry.models as string[]) ?? [])].sort(),
  });
  const ours: Record<string, unknown>[] = [];
  const others: JsonObject[] = [];
  let trimmed = false;
  for (const { id: _id, ...entry } of current) {
    const entryModels = (entry.models as string[]) ?? [];
    const kept = entryModels.filter((model) => !models.has(model));
    if (!kept.length) ours.push(entry);
    else {
      trimmed ||= kept.length !== entryModels.length;
      others.push({ ...(entry as JsonObject), models: kept });
    }
  }
  const changed =
    trimmed || ours.length !== 1 || !same(sorted(ours[0]), sorted(managed));
  return { list: [...others, managed], changed };
}

function settingsBody(config: SeedConfig): JsonObject {
  const s = config.settings;
  return {
    site_name: s.siteName,
    ...(s.siteSubtitle !== undefined ? { site_subtitle: s.siteSubtitle } : {}),
    registration_enabled: s.registration !== "closed",
    invitation_code_enabled: s.registration === "invite",
    ...(s.emailVerify !== undefined
      ? { email_verify_enabled: s.emailVerify }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Comparison helpers: only fields present in the current record are compared,
// so the seed never rewrites what it cannot see.

const nearlyEqual = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
function same(current: unknown, desired: unknown): boolean {
  if (typeof current === "number" && typeof desired === "number")
    return nearlyEqual(current, desired);
  if (Array.isArray(current) && Array.isArray(desired))
    return (
      current.length === desired.length &&
      current.every((item, index) => same(item, desired[index]))
    );
  if (
    current &&
    desired &&
    typeof current === "object" &&
    typeof desired === "object"
  ) {
    const keys = Object.keys(desired as object);
    return keys.every((key) =>
      same(
        (current as Record<string, unknown>)[key],
        (desired as Record<string, unknown>)[key],
      ),
    );
  }
  return current === desired;
}
export function changedFields(
  current: Record<string, unknown>,
  desired: JsonObject,
): JsonObject {
  const changed: JsonObject = {};
  for (const [key, value] of Object.entries(desired))
    if (!same(current[key], value)) changed[key] = value;
  return changed;
}
const sortedIds = (ids: Id[]) => [...ids].map(String).sort();

// ---------------------------------------------------------------------------

export interface SeedAction {
  entity: string;
  name: string;
  result: "created" | "updated" | "unchanged" | "planned";
  detail?: string;
}

export interface SeedOptions {
  dryRun?: boolean;
  /** In dry-run mode, read the current state from the server (GET only). */
  liveReads?: boolean;
  /**
   * Also make the seed's subscription group the default group of Claudex
   * device provisioning (the group new desktop devices get their key in).
   */
  claudexProvisioning?: boolean;
  fetch?: Fetch;
  log?: (line: string) => void;
}

interface ListPage {
  items?: Record<string, unknown>[];
}

export async function seed(config: SeedConfig, options: SeedOptions = {}) {
  const log = options.log ?? ((line: string) => console.log(line));
  const dryRun = options.dryRun ?? false;
  const liveReads = dryRun && (options.liveReads ?? false);
  const runId = newRunId();
  const actions: SeedAction[] = [];

  const print = (request: AdminRequest, note: string) => {
    log(`${request.method} ${request.path}${note ? `  # ${note}` : ""}`);
    if (request.method === "POST")
      log(`Idempotency-Key: ${idempotencyKey(request, runId)}`);
    if (request.body) log(JSON.stringify(redactBody(request.body), null, 2));
  };
  const read = async <T>(
    path: string,
    empty: T,
    assumption = "assumed empty",
  ): Promise<T> => {
    const request: AdminRequest = { method: "GET", path };
    if (dryRun && !liveReads) {
      print(request, `read; ${assumption} in an offline dry run`);
      return empty;
    }
    return ((await sendAdmin(
      config.url,
      config.auth,
      request,
      options.fetch,
      runId,
    )) ?? empty) as T;
  };
  const write = async (
    request: AdminRequest,
    label: string,
  ): Promise<Record<string, unknown>> => {
    validateRequest(request);
    if (dryRun) {
      print(request, `write (dry run): ${label}`);
      return { id: `<id:${label}>`, ...request.body };
    }
    return (await sendAdmin(
      config.url,
      config.auth,
      request,
      options.fetch,
      runId,
    )) as Record<string, unknown>;
  };
  const record = (action: SeedAction) => {
    if (dryRun && action.result !== "unchanged") action.result = "planned";
    actions.push(action);
  };

  // 1. Compliance gate. /admin/compliance is the one admin route the guard
  // lets through (backend/backend/internal/server/middleware/admin_compliance.go).
  const compliance = await read<{ required?: boolean; version?: string }>(
    "/api/v1/admin/compliance",
    { required: false },
    "assumed accepted",
  );
  if (compliance.required !== false)
    throw new ComplianceRequiredError(compliance.version);

  // 1b. Claudex provisioning is read before any write, so a server without
  // it stops the run with nothing changed.
  let provisioning: Record<string, unknown> | undefined;
  if (options.claudexProvisioning) {
    try {
      provisioning = await read<Record<string, unknown>>(
        PROVISIONING_PATH,
        {},
        "the stored setting is assumed; the write sends it back whole",
      );
    } catch (error) {
      if (error instanceof AdminApiError && error.status === 404)
        throw Error(
          `This server has no Claudex device provisioning (GET ${PROVISIONING_PATH} answered 404). Update the Claudex server or run the seed without --claudex-provisioning. Nothing was changed.`,
        );
      throw error;
    }
  }

  // 2. Plan groups (Sub2API "groups": the plan and model-access unit).
  const groups = await read<Record<string, unknown>[]>(
    "/api/v1/admin/groups/all?include_inactive=true",
    [],
  );
  const groupIds: Id[] = [];
  for (const [group, subscription] of [
    [config.standardGroup, false],
    [config.planGroup, true],
  ] as const) {
    const desired = groupBody(config, group, subscription);
    const existing = groups.find((item) => item.name === group.name);
    if (!existing) {
      const created = await write(
        { method: "POST", path: "/api/v1/admin/groups", body: desired },
        `group ${group.name}`,
      );
      groupIds.push(created.id as Id);
      record({ entity: "group", name: group.name, result: "created" });
      continue;
    }
    for (const key of ["platform", "subscription_type"])
      if (existing[key] !== desired[key])
        throw Error(
          `Group "${group.name}" already exists with ${key}=${String(existing[key])}; Sub2API ties billing to it, so the seed will not change it. Rename the group in the env file or fix it in the admin console.`,
        );
    const changes = changedFields(existing, desired);
    delete changes.name;
    if (Object.keys(changes).length) {
      await write(
        {
          method: "PUT",
          path: `/api/v1/admin/groups/${existing.id}`,
          body: changes,
        },
        `group ${group.name}`,
      );
      record({
        entity: "group",
        name: group.name,
        result: "updated",
        detail: Object.keys(changes).join(", "),
      });
    } else record({ entity: "group", name: group.name, result: "unchanged" });
    groupIds.push(existing.id as Id);
  }
  const planId = groupIds[1];

  // 3. Upstream account.
  const accounts = await read<ListPage>(
    `/api/v1/admin/accounts?platform=${encodeURIComponent(config.platform)}&search=${encodeURIComponent(config.upstream.name)}&page_size=100`,
    {},
  );
  const account = accounts.items?.find(
    (item) => item.name === config.upstream.name,
  );
  const credentials: JsonObject = {
    base_url: config.upstream.baseUrl,
    model_mapping: config.modelMapping,
  };
  if (!account) {
    await write(
      {
        method: "POST",
        path: "/api/v1/admin/accounts",
        body: {
          name: config.upstream.name,
          notes: "Managed by Claudex seed-claudex",
          platform: config.platform,
          type: "apikey",
          credentials: { api_key: config.upstream.apiKey, ...credentials },
          concurrency: config.upstream.concurrency,
          priority: config.upstream.priority,
          group_ids: groupIds,
        },
      },
      `account ${config.upstream.name}`,
    );
    record({
      entity: "account",
      name: config.upstream.name,
      result: "created",
    });
  } else {
    const change: JsonObject = {};
    const bound = (account.group_ids as Id[] | undefined) ?? [];
    if (groupIds.some((id) => !sortedIds(bound).includes(String(id))))
      change.group_ids = [...new Set([...bound, ...groupIds])];
    // Stored credentials come back without api_key (dto/credentials_redact.go);
    // omitting it on update keeps the stored key. Every other credential key
    // is replaced by what is sent (account_credentials_redact.go
    // MergePreservingSensitiveCreds), so the current non-secret keys, such as
    // ones set in the console, are sent back unchanged.
    const stored = (account.credentials as JsonObject | undefined) ?? {};
    const creds = changedFields(stored, credentials);
    if (config.upstream.rotateKey) creds.api_key = config.upstream.apiKey;
    if (Object.keys(creds).length)
      change.credentials = { ...stored, ...credentials, ...creds };
    if (Object.keys(change).length) {
      await write(
        {
          method: "PUT",
          path: `/api/v1/admin/accounts/${account.id}`,
          body: change,
        },
        `account ${config.upstream.name}`,
      );
      record({
        entity: "account",
        name: config.upstream.name,
        result: "updated",
        detail: [
          ...(change.group_ids ? ["group_ids"] : []),
          ...Object.keys(creds).map((key) => `credentials.${key}`),
        ].join(", "),
      });
    } else
      record({
        entity: "account",
        name: config.upstream.name,
        result: "unchanged",
      });
  }

  // 4. Channel pricing (per token; the console shows $/MTok).
  const channels = await read<ListPage>(
    `/api/v1/admin/channels?search=${encodeURIComponent(config.channelName)}&page_size=100`,
    {},
  );
  const channel = channels.items?.find(
    (item) => item.name === config.channelName,
  );
  if (!channel) {
    await write(
      {
        method: "POST",
        path: "/api/v1/admin/channels",
        body: {
          name: config.channelName,
          description: "Claudex model pricing",
          group_ids: groupIds,
          model_pricing: [pricingEntry(config)],
        },
      },
      `channel ${config.channelName}`,
    );
    record({ entity: "channel", name: config.channelName, result: "created" });
  } else {
    const change: JsonObject = {};
    const bound = (channel.group_ids as Id[] | undefined) ?? [];
    if (groupIds.some((id) => !sortedIds(bound).includes(String(id))))
      change.group_ids = [...new Set([...bound, ...groupIds])];
    const merged = mergePricing(
      (channel.model_pricing as Record<string, unknown>[]) ?? [],
      pricingEntry(config),
    );
    if (merged.changed) change.model_pricing = merged.list;
    if (Object.keys(change).length) {
      await write(
        {
          method: "PUT",
          path: `/api/v1/admin/channels/${channel.id}`,
          body: change,
        },
        `channel ${config.channelName}`,
      );
      record({
        entity: "channel",
        name: config.channelName,
        result: "updated",
        detail: Object.keys(change).join(", "),
      });
    } else
      record({
        entity: "channel",
        name: config.channelName,
        result: "unchanged",
      });
  }

  // 5. Public settings Claudex reads from GET /api/v1/settings/public.
  const settings = await read<Record<string, unknown>>(
    "/api/v1/admin/settings",
    {},
  );
  const settingChanges = changedFields(settings, settingsBody(config));
  if (Object.keys(settingChanges).length) {
    await write(
      { method: "PUT", path: "/api/v1/admin/settings", body: settingChanges },
      "settings",
    );
    record({
      entity: "settings",
      name: "public",
      result: "updated",
      detail: Object.keys(settingChanges).join(", "),
    });
  } else record({ entity: "settings", name: "public", result: "unchanged" });

  // 6. Test user with a subscription to the plan group.
  const user = config.testUser;
  if (user) {
    const users = await read<ListPage>(
      `/api/v1/admin/users?search=${encodeURIComponent(user.email)}&page_size=100`,
      {},
    );
    let userRecord = users.items?.find(
      (item) => String(item.email).toLowerCase() === user.email.toLowerCase(),
    );
    if (!userRecord) {
      userRecord = await write(
        {
          method: "POST",
          path: "/api/v1/admin/users",
          body: {
            email: user.email,
            password: user.password,
            username: "Claudex test user",
            notes: "Created by Claudex seed-claudex",
            role: "user",
            concurrency: user.concurrency,
          },
        },
        `user ${user.email}`,
      );
      record({ entity: "user", name: user.email, result: "created" });
    } else record({ entity: "user", name: user.email, result: "unchanged" });

    const subscriptions =
      typeof userRecord.id === "number" && typeof planId === "number"
        ? await read<ListPage>(
            `/api/v1/admin/subscriptions?user_id=${userRecord.id}&group_id=${planId}&page_size=100`,
            {},
          )
        : ({} as ListPage);
    const active = subscriptions.items?.find(
      (item) =>
        item.status === "active" &&
        Date.parse(String(item.expires_at)) > Date.now(),
    );
    if (!active) {
      await write(
        {
          method: "POST",
          path: "/api/v1/admin/subscriptions/assign",
          body: {
            user_id: userRecord.id as Id,
            group_id: planId,
            validity_days: user.validityDays,
            notes: "Claudex test subscription",
          },
        },
        `subscription ${user.email} -> ${config.planGroup.name}`,
      );
      record({
        entity: "subscription",
        name: `${user.email} -> ${config.planGroup.name}`,
        result: "created",
      });
    } else
      record({
        entity: "subscription",
        name: `${user.email} -> ${config.planGroup.name}`,
        result: "unchanged",
        detail: `expires ${String(active.expires_at)}`,
      });
  }

  // 7. Claudex device provisioning: new desktop devices get their key in the
  // plan group (strategy "fixed"), or in it unless the user has another
  // subscription (strategy "subscription_then_default").
  if (provisioning) {
    const change: JsonObject = {};
    if (String(provisioning.default_group_id) !== String(planId))
      change.default_group_id = planId;
    // An empty list allows every group; a non-empty one must hold the plan.
    const allowed = provisioning.allowed_group_ids;
    if (
      Array.isArray(allowed) &&
      allowed.length &&
      !allowed.map(String).includes(String(planId))
    )
      change.allowed_group_ids = [...(allowed as Id[]), planId];
    if (Object.keys(change).length) {
      try {
        await write(
          {
            method: "PUT",
            path: PROVISIONING_PATH,
            // The whole setting: fields the seed does not manage keep their values.
            body: { ...(provisioning as JsonObject), ...change },
          },
          "claudex provisioning",
        );
      } catch (error) {
        if (error instanceof AdminApiError && error.code.startsWith("STEP_UP_"))
          throw Error(
            `${error.message}\nStep-up verification is on, so the admin API key cannot change Claudex provisioning. Set its default group to "${config.planGroup.name}" in the admin console; everything else has been seeded.`,
          );
        throw error;
      }
      record({
        entity: "claudex provisioning",
        name: "default group",
        result: "updated",
        detail: Object.keys(change).join(", "),
      });
    } else
      record({
        entity: "claudex provisioning",
        name: "default group",
        result: "unchanged",
      });
  }
  return actions;
}

const PROVISIONING_PATH = "/api/v1/admin/claudex/provisioning";

const USAGE =
  "Usage: npx tsx scripts/sub2api-seed.ts [--env FILE] [--dry-run [--live-reads]] [--claudex-provisioning]";
const FLAGS = ["--dry-run", "--live-reads", "--claudex-provisioning", "--env"];

export async function main(argv: string[], env = process.env) {
  const dryRun = argv.includes("--dry-run");
  const liveReads = argv.includes("--live-reads");
  const claudexProvisioning = argv.includes("--claudex-provisioning");
  const envIndex = argv.indexOf("--env");
  const unknown = argv.filter(
    (arg, index) =>
      !FLAGS.includes(arg) && !(envIndex >= 0 && index === envIndex + 1),
  );
  // --live-reads alone must not turn into a real run that writes.
  if (
    unknown.length ||
    (envIndex >= 0 && !argv[envIndex + 1]) ||
    (liveReads && !dryRun)
  ) {
    console.error(USAGE);
    return 2;
  }
  let values: Record<string, string | undefined> = { ...env };
  if (envIndex >= 0) {
    // The env file wins over the inherited shell so a run is reproducible.
    values = {
      ...values,
      ...parseEnvFile(fs.readFileSync(argv[envIndex + 1], "utf8")),
    };
  }
  try {
    const config = loadConfig(values, dryRun);
    if (liveReads && !config.auth.apiKey && !config.auth.token)
      throw new ConfigError(
        "SUB2API_ADMIN_API_KEY (or SUB2API_ADMIN_TOKEN) is required with --live-reads",
      );
    if (dryRun)
      console.log(
        `# Dry run against ${config.url}: ${liveReads ? "reads are live, " : "no requests are sent, "}writes are printed and not sent. Secrets are shown as ${SECRET}.`,
      );
    const actions = await seed(config, {
      dryRun,
      liveReads,
      claudexProvisioning,
    });
    for (const action of actions)
      console.log(
        `${action.result.padEnd(9)} ${action.entity} ${action.name}${action.detail ? ` (${action.detail})` : ""}`,
      );
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Seed configuration is incomplete:\n${error.message}`);
      return 2;
    }
    if (error instanceof ComplianceRequiredError) {
      console.error(error.message);
      return 3;
    }
    console.error(
      error instanceof AdminApiError || error instanceof Error
        ? error.message
        : String(error),
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
