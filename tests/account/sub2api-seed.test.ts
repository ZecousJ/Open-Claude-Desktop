import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BODY_RULES,
  ComplianceRequiredError,
  validateRequest,
} from "../../scripts/sub2api-admin";
import {
  ConfigError,
  loadConfig,
  main,
  mergePricing,
  parseEnvFile,
  seed,
} from "../../scripts/sub2api-seed";

// Synthetic values only. The upstream never receives a request in these tests.
const UPSTREAM_KEY = "fixture-upstream-key-0000";
const USER_PASSWORD = "fixture-user-pass-0000";
const env = {
  SUB2API_URL: "http://127.0.0.1:1",
  SUB2API_ADMIN_API_KEY: "fixture-admin-key",
  CLAUDEX_UPSTREAM_BASE_URL: "http://127.0.0.1:9/v1",
  CLAUDEX_UPSTREAM_API_KEY: UPSTREAM_KEY,
  CLAUDEX_MODELS: "fixture-model-a, fixture-model-b",
  CLAUDEX_MODEL_MAPPING: "fixture-model-b=fixture-upstream-b",
  CLAUDEX_PRICE_INPUT_USD_PER_MTOK: "3",
  CLAUDEX_PRICE_OUTPUT_USD_PER_MTOK: "15",
  CLAUDEX_PLAN_DAILY_USD: "2",
  CLAUDEX_PLAN_WEEKLY_USD: "10",
  CLAUDEX_PLAN_MONTHLY_USD: "30",
  CLAUDEX_REGISTRATION: "invite",
  CLAUDEX_TEST_USER_EMAIL: "user1@example.test",
  CLAUDEX_TEST_USER_PASSWORD: USER_PASSWORD,
};

test("offline dry run prints every write in order, sends nothing and hides secrets", async () => {
  const lines: string[] = [];
  const config = loadConfig(env, true);
  const actions = await seed(config, {
    dryRun: true,
    fetch: () => {
      throw Error("an offline dry run must not send requests");
    },
    log: (line) => lines.push(line),
  });
  const output = lines.join("\n");
  const requests = lines.filter((line) => /^(GET|POST|PUT) /.test(line));
  assert.deepEqual(
    requests.map((line) => line.split("  #")[0]),
    [
      "GET /api/v1/admin/compliance",
      "GET /api/v1/admin/groups/all?include_inactive=true",
      "POST /api/v1/admin/groups",
      "POST /api/v1/admin/groups",
      "GET /api/v1/admin/accounts?platform=openai&search=claudex-upstream&page_size=100",
      "POST /api/v1/admin/accounts",
      "GET /api/v1/admin/channels?search=claudex-pricing&page_size=100",
      "POST /api/v1/admin/channels",
      "GET /api/v1/admin/settings",
      "PUT /api/v1/admin/settings",
      "GET /api/v1/admin/users?search=user1%40example.test&page_size=100",
      "POST /api/v1/admin/users",
      "POST /api/v1/admin/subscriptions/assign",
    ],
  );
  assert.ok(!output.includes(UPSTREAM_KEY) && !output.includes(USER_PASSWORD));
  assert.match(output, /"api_key": "<redacted>"/);
  assert.match(output, /"weekly_limit_usd": 10/);
  assert.match(output, /"input_price": 0\.000003/);
  assert.match(output, /"group_id": "<id:group claudex-pro>"/);
  assert.match(
    output,
    /Idempotency-Key: claudex-seed-[0-9a-f]{16}-[0-9a-f]{32}/,
  );
  assert.ok(actions.every((action) => action.result === "planned"));
});

test("configuration lists every missing input and never needs secrets for a dry run", () => {
  assert.throws(
    () => loadConfig({}, false),
    (error: Error) =>
      error instanceof ConfigError &&
      [
        "SUB2API_URL",
        "SUB2API_ADMIN_API_KEY",
        "CLAUDEX_UPSTREAM_BASE_URL",
        "CLAUDEX_UPSTREAM_API_KEY",
        "CLAUDEX_MODELS",
        "CLAUDEX_PRICE_INPUT_USD_PER_MTOK",
      ].every((key) => error.message.includes(key)),
  );
  const {
    SUB2API_ADMIN_API_KEY: _admin,
    CLAUDEX_UPSTREAM_API_KEY: _key,
    CLAUDEX_TEST_USER_PASSWORD: _password,
    ...public_
  } = env;
  const config = loadConfig(public_, true);
  assert.equal(config.upstream.apiKey, "<redacted>");
  assert.deepEqual(config.modelMapping, {
    "fixture-model-a": "fixture-model-a",
    "fixture-model-b": "fixture-upstream-b",
  });
  assert.throws(
    () => loadConfig({ ...env, CLAUDEX_DEFAULT_MODEL: "other" }, false),
    /CLAUDEX_DEFAULT_MODEL/,
  );
  assert.throws(
    () => loadConfig({ ...env, CLAUDEX_PLAN_WEEKLY_USD: "0" }, false),
    /CLAUDEX_PLAN_WEEKLY_USD must be greater than 0/,
  );
});

test("request bodies are limited to the Sub2API handler fields and rules", () => {
  const group = {
    name: "g",
    platform: "openai",
    rate_multiplier: 1,
    subscription_type: "subscription",
  };
  validateRequest({
    method: "POST",
    path: "/api/v1/admin/groups",
    body: group,
  });
  assert.throws(
    () =>
      validateRequest({
        method: "POST",
        path: "/api/v1/admin/groups",
        body: { ...group, weekly_limit: 5 },
      }),
    /fields not in .*group_handler\.go.*weekly_limit/,
  );
  assert.throws(
    () =>
      validateRequest({
        method: "POST",
        path: "/api/v1/admin/groups",
        body: { ...group, rate_multiplier: 0 },
      }),
    /rate_multiplier must be > 0/,
  );
  assert.throws(
    () =>
      validateRequest({
        method: "PUT",
        path: "/api/v1/admin/groups/4",
        body: { model_allowlist: { enabled: true, models: [] } },
      }),
    /empty model list/,
  );
  assert.throws(
    () =>
      validateRequest({
        method: "POST",
        path: "/api/v1/admin/channels",
        body: {
          name: "c",
          model_pricing: [{ models: ["m"], billing_mode: "video" }],
        },
      }),
    /billing_mode must be one of token, per_request, image/,
  );
  assert.throws(
    () =>
      validateRequest({
        method: "POST",
        path: "/api/v1/admin/subscriptions/assign",
        body: { user_id: 1, group_id: 2, validity_days: 40000 },
      }),
    /validity_days/,
  );
});

test("env files parse comments, quotes and export prefixes", () => {
  assert.deepEqual(
    parseEnvFile(
      '# comment\nexport A=1\nB="two words"\nC=three # trailing\n\nD=\nE="quoted # kept" # note\n',
    ),
    { A: "1", B: "two words", C: "three", D: "", E: "quoted # kept" },
  );
});

type Row = Record<string, unknown>;

/**
 * The design's default claudex_provisioning setting (section 2.5), as the
 * server stores it, plus a field the seed does not know (a later server
 * version may add one), which a whole-setting write must keep.
 */
const PROVISIONING_DEFAULT: Row = {
  enabled: true,
  strategy: "subscription_then_default",
  default_group_id: null,
  allowed_group_ids: [],
  on_signup: { grant_default_group: false },
  key_defaults: {
    quota_usd: 0,
    expires_in_days: null,
    rate_limit_5h: 0,
    rate_limit_1d: 0,
    rate_limit_7d: 0,
  },
  max_devices_per_user: 5,
  field_from_a_later_server: "kept",
};

/**
 * In-memory stand-in for the admin API of the Claudex server. Response
 * envelopes and paging follow backend/backend/internal/pkg/response/response.go;
 * the compliance guard follows
 * backend/backend/internal/server/middleware/admin_compliance.go and the
 * step-up refusal backend/backend/internal/server/middleware/step_up.go.
 * `provisioning` absent = a server without Claudex device provisioning (404).
 */
function mockSub2Api(
  acknowledged: boolean,
  options: { provisioning?: Row; stepUp?: boolean } = {},
) {
  const state = {
    groups: [] as Row[],
    accounts: [] as Row[],
    channels: [] as Row[],
    users: [] as Row[],
    subscriptions: [] as Row[],
    settings: {
      site_name: "Sub2API",
      site_subtitle: "Subscription to API Conversion Platform",
      registration_enabled: false,
      invitation_code_enabled: false,
      email_verify_enabled: false,
      smtp_host: "",
    } as Row,
    provisioning: options.provisioning
      ? (JSON.parse(JSON.stringify(options.provisioning)) as Row)
      : undefined,
  };
  const writes: {
    method: string;
    path: string;
    headers: http.IncomingHttpHeaders;
  }[] = [];
  // backend/backend/internal/service/idempotency.go: a repeated key replays the
  // stored response for 24 hours instead of running the write again.
  const replay = new Map<string, unknown>();
  let nextId = 10;
  const redact = (account: Row) => {
    const { api_key: _secret, ...credentials } = account.credentials as Row;
    return { ...account, credentials };
  };
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};
    const url = new URL(request.url ?? "/", "http://mock");
    const send = (status: number, payload: unknown) =>
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(payload));
    const key = String(request.headers["idempotency-key"] ?? "");
    const ok = (data: unknown) => {
      if (request.method === "POST" && key) replay.set(key, data);
      send(200, { code: 0, message: "success", data });
    };
    const page = (items: Row[]) =>
      ok({ items, total: items.length, page: 1, page_size: 100, pages: 1 });
    if (request.headers["x-api-key"] !== "fixture-admin-key")
      return send(401, {
        code: "INVALID_ADMIN_KEY",
        message: "Invalid admin API key",
      });
    if (url.pathname === "/api/v1/admin/compliance")
      return ok({ required: !acknowledged, version: "v2026.06.10" });
    if (!acknowledged)
      return send(423, {
        code: "ADMIN_COMPLIANCE_ACK_REQUIRED",
        message: "administrator compliance acknowledgement is required",
        metadata: { version: "v2026.06.10" },
      });
    if (request.method === "POST" && replay.has(key))
      return send(200, { code: 0, message: "success", data: replay.get(key) });
    if (request.method !== "GET")
      writes.push({
        method: request.method!,
        path: url.pathname,
        headers: request.headers,
      });
    const search = url.searchParams.get("search") ?? "";
    const idMatch = /\/(\d+)$/.exec(url.pathname);
    const find = (rows: Row[]) =>
      rows.find((row) => row.id === Number(idMatch![1]))!;
    const route = `${request.method} ${url.pathname.replace(/\/\d+$/, "/:id")}`;
    switch (route) {
      case "GET /api/v1/admin/groups/all":
        return ok(state.groups);
      case "POST /api/v1/admin/groups": {
        const group = {
          daily_limit_usd: null,
          weekly_limit_usd: null,
          monthly_limit_usd: null,
          status: "active",
          ...body,
          id: nextId++,
        };
        state.groups.push(group);
        return ok(group);
      }
      case "PUT /api/v1/admin/groups/:id":
        return ok(Object.assign(find(state.groups), body));
      case "GET /api/v1/admin/accounts":
        return page(
          state.accounts
            .filter((row) => String(row.name).includes(search))
            .map(redact),
        );
      case "POST /api/v1/admin/accounts": {
        const account = { ...body, id: nextId++, status: "active" };
        state.accounts.push(account);
        return ok(redact(account));
      }
      case "PUT /api/v1/admin/accounts/:id": {
        // admin_account.go UpdateAccount + MergePreservingSensitiveCreds:
        // sent credentials replace every non-secret key; api_key is kept
        // when it is not sent.
        const account = find(state.accounts);
        const stored = account.credentials as Row;
        const credentials = body.credentials
          ? {
              ...body.credentials,
              ...(body.credentials.api_key === undefined &&
              stored.api_key !== undefined
                ? { api_key: stored.api_key }
                : {}),
            }
          : stored;
        Object.assign(account, body, { credentials });
        return ok(redact(account));
      }
      case "GET /api/v1/admin/channels":
        return page(
          state.channels.filter((row) => String(row.name).includes(search)),
        );
      case "POST /api/v1/admin/channels": {
        const channel = {
          ...body,
          id: nextId++,
          status: "active",
          model_pricing: body.model_pricing.map(
            (entry: Row, index: number) => ({
              id: index + 1,
              cache_write_price: null,
              cache_read_price: null,
              ...entry,
            }),
          ),
        };
        state.channels.push(channel);
        return ok(channel);
      }
      case "PUT /api/v1/admin/channels/:id":
        return ok(Object.assign(find(state.channels), body));
      case "GET /api/v1/admin/settings":
        return ok(state.settings);
      case "PUT /api/v1/admin/settings":
        Object.assign(state.settings, body);
        return ok(state.settings);
      case "GET /api/v1/admin/users":
        return page(
          state.users.filter((row) => String(row.email).includes(search)),
        );
      case "POST /api/v1/admin/users": {
        const { password: _password, ...user } = body;
        const row = { ...user, id: nextId++, status: "active", balance: 0 };
        state.users.push(row);
        return ok(row);
      }
      case "GET /api/v1/admin/subscriptions":
        return page(
          state.subscriptions.filter(
            (row) =>
              row.user_id === Number(url.searchParams.get("user_id")) &&
              row.group_id === Number(url.searchParams.get("group_id")),
          ),
        );
      case "POST /api/v1/admin/subscriptions/assign": {
        const row = {
          id: nextId++,
          user_id: body.user_id,
          group_id: body.group_id,
          status: "active",
          expires_at: new Date(
            Date.now() + body.validity_days * 86400e3,
          ).toISOString(),
        };
        state.subscriptions.push(row);
        return ok(row);
      }
      case "GET /api/v1/admin/claudex/provisioning":
        if (!state.provisioning) break;
        return ok(state.provisioning);
      case "PUT /api/v1/admin/claudex/provisioning":
        if (!state.provisioning) break;
        if (options.stepUp)
          return send(403, {
            code: "STEP_UP_ADMIN_API_KEY_FORBIDDEN",
            message:
              "Admin API key cannot access this endpoint; a two-factor verified admin session is required",
          });
        // The whole setting is replaced by the body.
        state.provisioning = body;
        return ok(state.provisioning);
    }
    send(404, { code: 404, message: `no mock for ${route}` });
  });
  return { server, state, writes };
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("a live run creates the Claudex setup once and a second run writes nothing", async (t) => {
  const mock = mockSub2Api(true);
  const url = await listen(mock.server);
  t.after(() => mock.server.close());
  const config = loadConfig({ ...env, SUB2API_URL: url }, false);

  const first = await seed(config, { log: () => {} });
  assert.deepEqual(
    first.map((action) => `${action.result} ${action.entity}`),
    [
      "created group",
      "created group",
      "created account",
      "created channel",
      "updated settings",
      "created user",
      "created subscription",
    ],
  );
  const [standard, plan] = mock.state.groups;
  assert.equal(standard.subscription_type, "standard");
  assert.equal(plan.subscription_type, "subscription");
  assert.deepEqual(
    [plan.daily_limit_usd, plan.weekly_limit_usd, plan.monthly_limit_usd],
    [2, 10, 30],
  );
  assert.deepEqual(plan.model_allowlist, {
    enabled: true,
    models: ["fixture-model-a", "fixture-model-b"],
  });
  assert.equal(plan.default_mapped_model, "fixture-model-a");
  const [account] = mock.state.accounts;
  assert.equal(account.type, "apikey");
  assert.deepEqual(account.group_ids, [standard.id, plan.id]);
  assert.deepEqual(account.credentials, {
    api_key: UPSTREAM_KEY,
    base_url: "http://127.0.0.1:9/v1",
    model_mapping: {
      "fixture-model-a": "fixture-model-a",
      "fixture-model-b": "fixture-upstream-b",
    },
  });
  const [price] = mock.state.channels[0].model_pricing as Record<
    string,
    unknown
  >[];
  assert.equal(price.input_price, 3 / 1e6);
  assert.equal(price.output_price, 15 / 1e6);
  assert.equal(mock.state.settings.site_name, "Claudex");
  assert.equal(mock.state.settings.registration_enabled, true);
  assert.equal(mock.state.settings.invitation_code_enabled, true);
  assert.equal(
    mock.state.settings.site_subtitle,
    "Subscription to API Conversion Platform",
  );
  assert.equal(mock.state.subscriptions[0].group_id, plan.id);
  for (const write of mock.writes) {
    assert.equal(write.headers["x-api-key"], "fixture-admin-key");
    if (write.method === "POST")
      assert.match(String(write.headers["idempotency-key"]), /^claudex-seed-/);
  }

  const writesBefore = mock.writes.length;
  const second = await seed(config, { log: () => {} });
  assert.ok(second.every((action) => action.result === "unchanged"));
  assert.equal(mock.writes.length, writesBefore);

  // Changed operator inputs converge with targeted updates; the stored key stays.
  const changed = loadConfig(
    {
      ...env,
      SUB2API_URL: url,
      CLAUDEX_MODELS: "fixture-model-a,fixture-model-b,fixture-model-c",
      CLAUDEX_PRICE_OUTPUT_USD_PER_MTOK: "12",
    },
    false,
  );
  const third = await seed(changed, { log: () => {} });
  assert.deepEqual(
    third
      .filter((a) => a.result === "updated")
      .map((a) => `${a.entity}: ${a.detail}`),
    [
      "group: model_allowlist",
      "group: model_allowlist",
      "account: credentials.model_mapping",
      "channel: model_pricing",
    ],
  );
  assert.equal(
    (account.credentials as Record<string, unknown>).api_key,
    UPSTREAM_KEY,
  );
  assert.equal(
    (mock.state.channels[0].model_pricing as Record<string, unknown>[])[0]
      .output_price,
    12 / 1e6,
  );
});

test("a re-run keeps console changes and clears values removed from the env file", async (t) => {
  const mock = mockSub2Api(true);
  const url = await listen(mock.server);
  t.after(() => mock.server.close());
  const withCache = {
    ...env,
    SUB2API_URL: url,
    CLAUDEX_PRICE_CACHE_READ_USD_PER_MTOK: "0.3",
  };
  await seed(loadConfig(withCache, false), { log: () => {} });

  // The operator edits things in the console between runs.
  const [account] = mock.state.accounts;
  (account.credentials as Record<string, unknown>).custom_user_agent = "ops";
  const [channel] = mock.state.channels;
  (channel.model_pricing as Record<string, unknown>[]).push({
    id: 99,
    platform: "openai",
    models: ["console-model"],
    billing_mode: "per_request",
    per_request_price: 0.01,
  });
  // ...and deletes the standard group, which the next run must recreate.
  const deleted = mock.state.groups.shift()!;

  const {
    CLAUDEX_PLAN_DAILY_USD: _daily,
    CLAUDEX_PRICE_CACHE_READ_USD_PER_MTOK: _cache,
    ...rest
  } = withCache;
  await seed(
    loadConfig(
      {
        ...rest,
        CLAUDEX_UPSTREAM_BASE_URL: "http://127.0.0.1:9/v2",
      },
      false,
    ),
    { log: () => {} },
  );

  const standard = mock.state.groups.find(
    (group) => group.name === "claudex-standard",
  )!;
  assert.notEqual(standard.id, deleted.id, "a new group, not a replayed id");
  const plan = mock.state.groups.find((group) => group.name === "claudex-pro")!;
  assert.equal(plan.daily_limit_usd, null);
  assert.equal(plan.weekly_limit_usd, 10);
  assert.deepEqual(account.credentials, {
    api_key: UPSTREAM_KEY,
    base_url: "http://127.0.0.1:9/v2",
    custom_user_agent: "ops",
    model_mapping: {
      "fixture-model-a": "fixture-model-a",
      "fixture-model-b": "fixture-upstream-b",
    },
  });
  assert.ok((account.group_ids as number[]).includes(standard.id as number));
  const pricing = channel.model_pricing as Record<string, unknown>[];
  assert.deepEqual(
    pricing.map((entry) => [entry.models, entry.cache_read_price]),
    [
      [["console-model"], undefined],
      [["fixture-model-a", "fixture-model-b"], null],
    ],
  );
  assert.equal(pricing[0].per_request_price, 0.01);
  assert.equal(pricing[0].id, undefined);
});

test("pricing merge trims models the seed now prices and keeps the rest", () => {
  const managed = {
    platform: "openai",
    models: ["a", "b"],
    billing_mode: "token",
    input_price: 1,
    output_price: 2,
    cache_read_price: null,
    cache_write_price: null,
  };
  assert.equal(
    mergePricing([{ id: 1, ...managed, models: ["b", "a"] }], managed).changed,
    false,
  );
  const merged = mergePricing(
    [
      { id: 1, ...managed, models: ["a"] },
      { id: 2, models: ["b", "c"], billing_mode: "token", input_price: 5 },
    ],
    managed,
  );
  assert.equal(merged.changed, true);
  assert.deepEqual(merged.list, [
    { models: ["c"], billing_mode: "token", input_price: 5 },
    managed,
  ]);
  for (const entry of merged.list)
    validateRequest({
      method: "PUT",
      path: "/api/v1/admin/channels/1",
      body: { model_pricing: [entry] },
    });
});

test("before the owner accepts the compliance commitment the seed writes nothing", async (t) => {
  const mock = mockSub2Api(false);
  const url = await listen(mock.server);
  t.after(() => mock.server.close());
  await assert.rejects(
    seed(loadConfig({ ...env, SUB2API_URL: url }, false), { log: () => {} }),
    ComplianceRequiredError,
  );
  assert.equal(mock.writes.length, 0);

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-seed-"));
  const file = path.join(folder, "seed.env");
  fs.writeFileSync(
    file,
    Object.entries({ ...env, SUB2API_URL: url })
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
  const error = console.error;
  console.error = () => {};
  try {
    assert.equal(await main(["--env", file], {}), 3);
    assert.equal(await main(["--bogus"], {}), 2);
    // --live-reads without --dry-run would otherwise be a real, writing run.
    assert.equal(await main(["--env", file, "--live-reads"], {}), 2);
  } finally {
    console.error = error;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("--claudex-provisioning reads the setting before any write and writes it back last", async () => {
  const lines: string[] = [];
  await seed(loadConfig(env, true), {
    dryRun: true,
    claudexProvisioning: true,
    fetch: () => {
      throw Error("an offline dry run must not send requests");
    },
    log: (line) => lines.push(line),
  });
  const requests = lines
    .filter((line) => /^(GET|POST|PUT) /.test(line))
    .map((line) => line.split("  #")[0]);
  assert.deepEqual(requests.slice(0, 2), [
    "GET /api/v1/admin/compliance",
    "GET /api/v1/admin/claudex/provisioning",
  ]);
  assert.equal(requests.at(-1), "PUT /api/v1/admin/claudex/provisioning");
  assert.match(
    lines.join("\n"),
    /"default_group_id": "<id:group claudex-pro>"/,
  );
});

test("a live run with --claudex-provisioning sets the default group once and keeps the rest", async (t) => {
  const mock = mockSub2Api(true, {
    provisioning: { ...PROVISIONING_DEFAULT, allowed_group_ids: [3] },
  });
  const url = await listen(mock.server);
  t.after(() => mock.server.close());
  const config = loadConfig({ ...env, SUB2API_URL: url }, false);

  const first = await seed(config, {
    log: () => {},
    claudexProvisioning: true,
  });
  const plan = mock.state.groups.find((group) => group.name === "claudex-pro")!;
  assert.deepEqual(first.at(-1), {
    entity: "claudex provisioning",
    name: "default group",
    result: "updated",
    detail: "default_group_id, allowed_group_ids",
  });
  // Written back whole: the fields the seed does not manage are unchanged.
  assert.deepEqual(mock.state.provisioning, {
    ...PROVISIONING_DEFAULT,
    default_group_id: plan.id,
    allowed_group_ids: [3, plan.id],
  });
  const puts = mock.writes.filter(
    (write) => write.path === "/api/v1/admin/claudex/provisioning",
  );
  assert.deepEqual(
    puts.map((write) => write.method),
    ["PUT"],
  );

  const writesBefore = mock.writes.length;
  const second = await seed(config, {
    log: () => {},
    claudexProvisioning: true,
  });
  assert.ok(second.every((action) => action.result === "unchanged"));
  assert.equal(mock.writes.length, writesBefore);
});

test("--claudex-provisioning stops before any write on a server without it", async (t) => {
  const mock = mockSub2Api(true);
  const url = await listen(mock.server);
  t.after(() => mock.server.close());
  await assert.rejects(
    seed(loadConfig({ ...env, SUB2API_URL: url }, false), {
      log: () => {},
      claudexProvisioning: true,
    }),
    /no Claudex device provisioning .*Nothing was changed/,
  );
  assert.equal(mock.writes.length, 0);
});

test("with step-up verification on, the provisioning write points to the console", async (t) => {
  const mock = mockSub2Api(true, {
    provisioning: PROVISIONING_DEFAULT,
    stepUp: true,
  });
  const url = await listen(mock.server);
  t.after(() => mock.server.close());
  await assert.rejects(
    seed(loadConfig({ ...env, SUB2API_URL: url }, false), {
      log: () => {},
      claudexProvisioning: true,
    }),
    /Step-up verification is on.*"claudex-pro" in the admin console/s,
  );
  assert.deepEqual(mock.state.provisioning, PROVISIONING_DEFAULT);
});

test("before the owner accepts the compliance commitment --claudex-provisioning writes nothing either", async (t) => {
  const mock = mockSub2Api(false, { provisioning: PROVISIONING_DEFAULT });
  const url = await listen(mock.server);
  t.after(() => mock.server.close());
  await assert.rejects(
    seed(loadConfig({ ...env, SUB2API_URL: url }, false), {
      log: () => {},
      claudexProvisioning: true,
    }),
    ComplianceRequiredError,
  );

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-seed-"));
  const file = path.join(folder, "seed.env");
  fs.writeFileSync(
    file,
    Object.entries({ ...env, SUB2API_URL: url })
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
  const error = console.error;
  const log = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    assert.equal(await main(["--env", file, "--claudex-provisioning"], {}), 3);
    assert.equal(
      await main(
        ["--env", file, "--dry-run", "--live-reads", "--claudex-provisioning"],
        {},
      ),
      3,
    );
  } finally {
    console.error = error;
    console.log = log;
    fs.rmSync(folder, { recursive: true, force: true });
  }
  assert.equal(mock.writes.length, 0);
  assert.deepEqual(mock.state.provisioning, PROVISIONING_DEFAULT);
});

test("every fork source file and symbol the admin client cites exists", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const texts = [
    ...Object.values(BODY_RULES).map((rule) => rule.source),
    fs.readFileSync(path.join(root, "scripts/sub2api-admin.ts"), "utf8"),
    fs.readFileSync(path.join(root, "scripts/sub2api-seed.ts"), "utf8"),
  ];
  const cited: string[] = [];
  for (const text of texts)
    for (const [, file, symbol] of text.matchAll(
      /(backend\/backend\/[\w./-]+\.go)(?:\s+([A-Za-z_]\w*))?/g,
    )) {
      const full = path.join(root, file);
      assert.ok(fs.existsSync(full), `${file} does not exist in the fork`);
      if (symbol)
        assert.ok(
          fs.readFileSync(full, "utf8").includes(symbol),
          `${file} has no ${symbol}`,
        );
      cited.push(file);
    }
  assert.ok(new Set(cited).size >= 10, "the citations were not found");
});
