/**
 * End-to-end check of the Claudex desktop's main-process code against a
 * running Claudex server (the Sub2API fork in backend/), for a development
 * instance such as `scripts/backend/dev-stack.sh up` (package I1).
 *
 *   CLAUDEX_URL=http://127.0.0.1:18080 npx tsx scripts/claudex-live-check.ts
 *
 * checks the public routes only. With --full it also sets up synthetic data
 * through the admin API (all named "i1-…") and drives the real client code
 * (sign-in, bootstrap, device registration, policy and catalog, a chat turn
 * through the provider service child, usage-status, usage-rule and weekly
 * cap refusals, device limit, policy override and Bypass, release notice
 * and the gateway's minimum version, payments against a mock provider,
 * diagnostics and feedback, dictation over the realtime WebSocket,
 * revoke-all, user-created keys and the legacy-key replacement), then
 * removes what the admin API can remove:
 *
 *   CLAUDEX_URL=http://127.0.0.1:18080 \
 *   CLAUDEX_DEV_ENV=work/backend/dev-stack/dev.env \
 *   CLAUDEX_UPSTREAM_BASE_URL=http://<mock container>:8090 \
 *     npx tsx scripts/claudex-live-check.ts --full [--voice-env FILE [--voice-audio FILE.wav]] [--keep]
 *
 * (`dev-stack.sh status` prints the mock's address as the server sees it.)
 * Settings the run changes for a moment (release, policy override, group
 * weekly cap, payment switch, feedback switches, voice switch, the user-key
 * switch) are put back as they were; the policy revision still moves on.
 * The test user's password is reset at every run and only kept in memory.
 *
 * --full only runs after the instance owner has personally accepted the
 * admin compliance commitment (GET /api/v1/admin/compliance answers
 * required=false); it never accepts it and stops before writing anything
 * otherwise. Admin credentials come from CLAUDEX_ADMIN_EMAIL and
 * CLAUDEX_ADMIN_PASSWORD, or ADMIN_EMAIL/ADMIN_PASSWORD in CLAUDEX_DEV_ENV;
 * the mock upstream key from CLAUDEX_UPSTREAM_API_KEY or MOCK_API_KEY there.
 * --voice-env names a file with HIWONDER_ASR_KEY (the realtime transcription
 * key, stored through PUT /admin/claudex/voice and never printed); without
 * it the dictation step only checks that dictation is off. --voice-audio is
 * a 16 kHz mono 16-bit WAV to dictate (default: one second of a tone).
 * Payments use an EasyPay provider in redirect mode whose API base is the
 * mock upstream: an order only yields a URL that is never opened, so no
 * money can move. --keep leaves the rules, catalog entries and settings in
 * place for manual testing.
 *
 * Prints results and every difference between the service's JSON and the
 * shared fixtures (backend/backend/internal/claudex/contract/testdata) as
 * field names and types; never tokens, keys or passwords.
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import {
  claudexErrorCodes,
  parseDeviceList,
  parseModelCatalog,
  parsePolicy,
  parseRelease,
  parseUsageStatus,
  parseVoice,
  parseWebConsole,
  parseRefusal,
} from "../shared/claudex-contract";
import type { Conversation, Provider } from "../shared/types";
import type { GatewayRefusal } from "../server/sub2api-errors";
import { normalizeSub2ApiUrl } from "../server/sub2api-config";
import { BillingSession } from "../electron/account/billing";
import { ClaudexPayment } from "../electron/sub2api/claudex-payment";
import { DiagnosticsReporter } from "../electron/support/diagnostics";
import { reporterClient } from "../electron/support/diagnostics-support";
import { ProviderCredentials } from "../electron/engine/provider-credentials";
import { ProviderServiceClient } from "../electron/engine/provider-service-client";
import { placeholderProvider } from "../electron/account/remote-mode";
import { RemoteBackend } from "../electron/sub2api/backend";
import {
  ClaudexUsageReader,
  fetchUsageStatus,
  planUsageFromStatus,
} from "../electron/sub2api/claudex-usage";
import {
  requestJson,
  requestJsonResult,
  Sub2ApiError,
  type Fetch,
} from "../electron/sub2api/http";
import { RemoteAccounts } from "../electron/sub2api/identity";
import { deviceLimitMessage } from "../electron/sub2api/identity-support";
import { deviceId, deviceKeyName } from "../electron/sub2api/provision";
import type { RemoteSession } from "../electron/sub2api/session";
import { loadConfig, parseEnvFile, seed } from "./sub2api-seed";

const args = process.argv.slice(2);
const full = args.includes("--full");
const keep = args.includes("--keep");
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const baseUrl = normalizeSub2ApiUrl(
  process.env.CLAUDEX_URL ?? process.env.CLAUDEX_SUB2API_URL ?? "",
);
const devEnv = process.env.CLAUDEX_DEV_ENV
  ? parseEnvFile(fs.readFileSync(process.env.CLAUDEX_DEV_ENV, "utf8"))
  : {};
const prefix = "i1";
const fixtures = path.join(
  import.meta.dirname,
  "../backend/backend/internal/claudex/contract/testdata",
);

// ---------------------------------------------------------------------------
// Output

let failed = false;
const say = (line: string) => console.log(line);
const check = (ok: boolean, step: string, detail = "") => {
  if (!ok) failed = true;
  say(`${ok ? "ok  " : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
  return ok;
};
const note = (step: string, detail: string) => say(`      ${step} — ${detail}`);
const section = (title: string) => say(`\n## ${title}`);
const errorText = (error: unknown) =>
  error instanceof Sub2ApiError
    ? `${error.status} ${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
/** Runs a step; a thrown error fails it without stopping the run. */
async function step(name: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    check(false, name, errorText(error));
  }
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------------------
// Contract: every JSON answer the client code received is kept (in memory
// only) and compared with the shared fixtures by field names and types.

interface Exchange {
  method: string;
  path: string;
  status: number;
  body: unknown;
}
const exchanges: Exchange[] = [];
/** The access token of the last user-API request (to show it stops working after revoke-all). */
let lastAccessToken = "";

const recordingFetch: Fetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (url.origin === new URL(baseUrl).origin) {
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    if (auth?.startsWith("Bearer ") && url.pathname.startsWith("/api/v1/"))
      lastAccessToken = auth.slice(7);
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("json") && response.status !== 304) {
      const text = await response.clone().text();
      try {
        exchanges.push({
          method: (init?.method ?? "GET").toUpperCase(),
          path: url.pathname,
          status: response.status,
          body: JSON.parse(text),
        });
      } catch {
        // Not JSON after all.
      }
    }
  }
  return response;
};

type Shape = "null" | "bool" | "number" | "string" | "array" | "object";
const shapeOf = (value: unknown): Shape =>
  value === null || value === undefined
    ? "null"
    : typeof value === "boolean"
      ? "bool"
      : typeof value === "number"
        ? "number"
        : typeof value === "string"
          ? "string"
          : Array.isArray(value)
            ? "array"
            : "object";
/**
 * Objects whose keys are data (channel names, model ids, patch fields,
 * metadata): only the keys both sides have are compared.
 */
const mapPaths =
  /\.(channels|sources|downloads|defaults|patch|metadata)$|\.data\.sources\.[^.]+$/;
/** Field-name and type differences; values and nulls are not compared. */
export function shapeDiff(fixture: unknown, live: unknown, at = "$"): string[] {
  const a = shapeOf(fixture);
  const b = shapeOf(live);
  if (a === "null" || b === "null") return [];
  if (a !== b) return [`${at}: fixture ${a}, service ${b}`];
  const out: string[] = [];
  if (a === "object") {
    const f = fixture as Record<string, unknown>;
    const l = live as Record<string, unknown>;
    if (mapPaths.test(at)) {
      for (const key of Object.keys(f))
        if (key in l) out.push(...shapeDiff(f[key], l[key], `${at}.${key}`));
      return out;
    }
    for (const key of Object.keys(f))
      if (!(key in l)) out.push(`${at}.${key}: in the fixture, not sent`);
      else out.push(...shapeDiff(f[key], l[key], `${at}.${key}`));
    for (const key of Object.keys(l))
      if (!(key in f))
        out.push(`${at}.${key}: sent (${shapeOf(l[key])}), not in the fixture`);
  } else if (a === "array") {
    const f = fixture as unknown[];
    const l = live as unknown[];
    if (f.length && l.length) out.push(...shapeDiff(f[0], l[0], `${at}[]`));
  }
  return out;
}

/** Fixtures of JSON answers, by method, path pattern and status. */
const answerFixtures: {
  method: string;
  path: RegExp;
  status: number;
  fixture: string;
  /** For answers with several fixtures: the one this body matches. */
  when?: (body: unknown) => boolean;
}[] = [
  {
    method: "GET",
    path: /^\/api\/v1\/claudex\/web-console$/,
    status: 200,
    fixture: "web-console.default.json",
  },
  {
    method: "GET",
    path: /^\/api\/v1\/claudex\/release$/,
    status: 200,
    fixture: "release.available.json",
    when: (body) =>
      (body as { data?: { latest_version?: unknown } })?.data?.latest_version !=
      null,
  },
  {
    method: "GET",
    path: /^\/api\/v1\/claudex\/release$/,
    status: 200,
    fixture: "release.unconfigured.json",
  },
  {
    method: "PUT",
    path: /^\/api\/v1\/admin\/claudex\/policy$/,
    status: 400,
    fixture: "admin-policy.bypass-error.json",
  },
  {
    method: "GET",
    path: /^\/api\/v1\/claudex\/bootstrap$/,
    status: 200,
    fixture: "bootstrap.full.json",
  },
  {
    method: "POST",
    path: /^\/api\/v1\/claudex\/devices$/,
    status: 200,
    fixture: "devices.registered.json",
  },
  {
    method: "POST",
    path: /^\/api\/v1\/claudex\/devices$/,
    status: 409,
    fixture: "devices.limit-error.json",
  },
  {
    method: "GET",
    path: /^\/api\/v1\/claudex\/devices$/,
    status: 200,
    fixture: "devices.list.json",
  },
  {
    method: "DELETE",
    path: /^\/api\/v1\/claudex\/devices\/current$/,
    status: 200,
    fixture: "devices.revoked.json",
  },
  {
    method: "GET",
    path: /^\/api\/v1\/claudex\/policy$/,
    status: 200,
    fixture: "policy.group.json",
  },
  {
    method: "GET",
    path: /^\/api\/v1\/claudex\/models$/,
    status: 200,
    fixture: "models.group.json",
  },
  {
    method: "GET",
    path: /^\/api\/v1\/claudex\/usage-status$/,
    status: 200,
    fixture: "usage-status.plan.json",
  },
  {
    method: "POST",
    path: /^\/api\/v1\/claudex\/diagnostics$/,
    status: 200,
    fixture: "diagnostics.accepted.json",
  },
  {
    method: "POST",
    path: /^\/api\/v1\/claudex\/diagnostics$/,
    status: 404,
    fixture: "diagnostics.disabled-error.json",
  },
  {
    method: "POST",
    path: /^\/api\/v1\/claudex\/feedback$/,
    status: 200,
    fixture: "feedback.accepted.json",
  },
  {
    method: "POST",
    path: /^\/api\/v1\/claudex\/payment\/checkout-links$/,
    status: 200,
    fixture: "payment-checkout-links.created.json",
  },
  {
    method: "POST",
    path: /^\/api\/v1\/claudex\/payment\/checkout-links$/,
    status: 409,
    fixture: "payment-checkout-links.unavailable-error.json",
  },
  {
    method: "POST",
    path: /^\/api\/v1\/claudex\/payment\/checkout$/,
    status: 404,
    fixture: "payment-checkout.not-found-error.json",
  },
  {
    method: "*",
    path: /^\/api\/v1\//,
    status: 401,
    fixture: "session.revoked-error.json",
    when: (body) =>
      (body as { code?: unknown })?.code === claudexErrorCodes.sessionRevoked,
  },
  {
    method: "GET",
    path: /^\/api\/v1\/admin\/claudex\/devices$/,
    status: 200,
    fixture: "admin-devices.list.json",
  },
  {
    method: "GET",
    path: /^\/api\/v1\/admin\/claudex\/users\/\d+\/device-limit$/,
    status: 200,
    fixture: "admin-device-limit.get.json",
  },
  {
    method: "GET",
    path: /^\/api\/v1\/admin\/claudex\/policy$/,
    status: 200,
    fixture: "admin-policy.get.json",
  },
  {
    method: "GET",
    path: /^\/api\/v1\/admin\/claudex\/release$/,
    status: 200,
    fixture: "admin-release.get.json",
  },
  {
    method: "GET",
    path: /^\/api\/v1\/admin\/claudex\/web-console$/,
    status: 200,
    fixture: "admin-web-console.get.json",
  },
  {
    method: "GET",
    path: /^\/api\/v1\/admin\/claudex\/models\/candidates$/,
    status: 200,
    fixture: "admin-models.candidates.json",
  },
  {
    method: "POST",
    path: /^\/api\/v1\/admin\/claudex\/usage-rules$/,
    status: 200,
    fixture: "admin-usage-rules.rule.json",
  },
];
/** Gateway answers checked against refusal fixtures (recorded by `gateway()`). */
const gatewayExchanges: {
  label: string;
  fixture: string;
  status: number;
  body: unknown;
}[] = [];

function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"));
}
/** Compares one answer with its fixture: success fixtures are envelopes; error fixtures `{status, body}`. */
function compareWithFixture(name: string, status: number, body: unknown) {
  const fixture = readFixture(name) as Record<string, unknown>;
  const isError = "status" in fixture && "body" in fixture;
  const out: string[] = [];
  if (isError && fixture.status !== status)
    out.push(`status: fixture ${String(fixture.status)}, service ${status}`);
  // The admin fixtures that are a bare `data` value (a rule) are compared with the envelope's data.
  const expected = isError ? fixture.body : fixture;
  const actual =
    !isError &&
    !("code" in fixture) &&
    body &&
    typeof body === "object" &&
    "data" in body
      ? (body as { data: unknown }).data
      : body;
  out.push(...shapeDiff(expected, actual));
  return out;
}
const contractIssues = new Map<string, Set<string>>();
function contractReport() {
  const seen = new Set<string>();
  for (const exchange of exchanges)
    for (const entry of answerFixtures) {
      if (entry.method !== "*" && entry.method !== exchange.method) continue;
      if (!entry.path.test(exchange.path) || entry.status !== exchange.status)
        continue;
      if (entry.when && !entry.when(exchange.body)) continue;
      seen.add(entry.fixture);
      const issues = compareWithFixture(
        entry.fixture,
        exchange.status,
        exchange.body,
      );
      const key = `${entry.fixture} ← ${exchange.method} ${exchange.path.replace(/\/\d+(?=\/|$)/g, "/:id")} ${exchange.status}`;
      const set = contractIssues.get(key) ?? new Set<string>();
      issues.forEach((issue) => set.add(issue));
      contractIssues.set(key, set);
      break;
    }
  for (const item of gatewayExchanges) {
    const key = `${item.fixture} ← ${item.label}`;
    const set = contractIssues.get(key) ?? new Set<string>();
    compareWithFixture(item.fixture, item.status, item.body).forEach((issue) =>
      set.add(issue),
    );
    contractIssues.set(key, set);
  }
  section("Contract (field names and types against the shared fixtures)");
  let differences = 0;
  for (const [key, issues] of contractIssues) {
    if (!issues.size) {
      say(`same  ${key}`);
      continue;
    }
    differences++;
    say(`DIFF  ${key}`);
    for (const issue of issues) say(`        ${issue}`);
  }
  const unused = fs
    .readdirSync(fixtures)
    .filter(
      (name) =>
        name.endsWith(".json") &&
        !seen.has(name) &&
        !gatewayExchanges.some((item) => item.fixture === name),
    );
  note("fixtures not met in this run", unused.join(", ") || "none");
  return differences;
}

// ---------------------------------------------------------------------------
// Admin API (JWT of the admin account; the compliance gate stays in force).

class AdminApi {
  private token = "";
  constructor(
    private email: string,
    private password: string,
  ) {}
  async login() {
    const data = (await requestJson(
      recordingFetch,
      `${baseUrl}/api/v1/auth/login`,
      { method: "POST", body: { email: this.email, password: this.password } },
    )) as { access_token?: string };
    if (!data?.access_token)
      throw Error("The admin sign-in returned no token.");
    this.token = data.access_token;
  }
  get auth() {
    return this.token;
  }
  /** One admin request; resolves to `data` or throws Sub2ApiError. */
  call<T = unknown>(method: string, route: string, body?: unknown) {
    return requestJson(recordingFetch, `${baseUrl}${route}`, {
      method,
      token: this.token,
      body,
    }) as Promise<T>;
  }
}

interface Page<T> {
  items?: T[];
}

// ---------------------------------------------------------------------------
// Client scaffolding: a throwaway data directory per device, as the app keeps
// under its user data folder, and a reversible stand-in for safeStorage.

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) =>
    Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x5a)),
  decryptString: (value: Buffer) =>
    Buffer.from(value.map((byte) => byte ^ 0x5a)).toString(),
};
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-live-"));
let providerScript = "";

interface Desktop {
  root: string;
  accounts: RemoteAccounts;
  session: RemoteSession;
  backend: RemoteBackend;
  credentials: ProviderCredentials;
  provider?: Provider;
  refusals: GatewayRefusal[];
}

/** Signs in on a new "computer" (data directory) with the app's own classes. */
async function signIn(label: string, email: string, password: string) {
  const root = path.join(workRoot, label);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const accounts = new RemoteAccounts(root, baseUrl, cipher, recordingFetch);
  const result = await accounts.login(email, password);
  if (result.kind !== "signedIn")
    throw Error("The test account asks for 2FA; use one without it.");
  result.session.persist();
  const credentials = new ProviderCredentials(root, providerScript, cipher);
  await credentials.initialize([placeholderProvider(accounts)]);
  const desktop: Desktop = {
    root,
    accounts,
    session: result.session,
    backend: new RemoteBackend(accounts, result.session, root),
    credentials,
    refusals: [],
  };
  return desktop;
}

/** The desktop's provider service child, as a conversation starts one. */
function providerService(desktop: Desktop) {
  if (!desktop.provider) throw Error("The desktop has no provider yet.");
  return new ProviderServiceClient(
    providerScript,
    desktop.root,
    desktop.provider,
    desktop.backend.sessionKey(desktop.provider.id),
    desktop.credentials.vaultKey,
    desktop.root,
    undefined,
    undefined,
    (refusal) => desktop.refusals.push(refusal),
  );
}

/** One Responses turn through the provider service child; the reply text or the HTTP status. */
async function turn(desktop: Desktop, model: string, input: string) {
  const service = providerService(desktop);
  try {
    await service.start();
    const response = await fetch(`${service.url}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${service.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input, stream: true }),
    });
    const text = await response.text();
    return {
      status: response.status,
      completed: response.ok && /response\.completed/.test(text),
      body: text.slice(0, 4000),
    };
  } finally {
    await service.close();
  }
}

/** A request with a raw API key straight to the gateway (to see its JSON). */
/** The HTTP status of a WebSocket upgrade with an API key; the socket is closed at once. */
function upgradeStatus(key: string, route: string): Promise<number> {
  const url = new URL(route, baseUrl);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "X-Claudex-Version": "0.0.1",
        "X-Claudex-Platform": "darwin",
        "X-Claudex-Arch": "arm64",
      },
      timeout: 10_000,
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 101);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("timeout", () => request.destroy(Error("upgrade timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function gateway(
  key: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...headers,
      Authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Streams and pages stay text.
  }
  return { status: response.status, body: parsed };
}

/** The last device key the service issued in this run (kept in memory only). */
function lastDeviceKey(): string {
  for (let index = exchanges.length - 1; index >= 0; index--) {
    const item = exchanges[index];
    if (
      item.method === "POST" &&
      item.path === "/api/v1/claudex/devices" &&
      item.status === 200
    ) {
      const key = (item.body as { data?: { api_key?: { key?: unknown } } }).data
        ?.api_key?.key;
      if (typeof key === "string") return key;
    }
  }
  throw Error("No device key was issued in this run.");
}

/** A 16 kHz mono s16le PCM clip: a WAV file's data chunk, or one second of a tone. */
function dictationAudio(file?: string): Buffer {
  if (!file) {
    const samples = Buffer.alloc(32000);
    for (let index = 0; index < 16000; index++)
      samples.writeInt16LE(
        Math.round(3000 * Math.sin((2 * Math.PI * 440 * index) / 16000)),
        index * 2,
      );
    return samples;
  }
  const wav = fs.readFileSync(file);
  if (wav.toString("ascii", 0, 4) !== "RIFF")
    throw Error("--voice-audio must be a WAV file.");
  if (
    wav.readUInt16LE(22) !== 1 ||
    wav.readUInt32LE(24) !== 16000 ||
    wav.readUInt16LE(34) !== 16
  )
    throw Error("--voice-audio must be 16 kHz mono 16-bit PCM.");
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data")
      return wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  throw Error("--voice-audio has no data chunk.");
}

// ---------------------------------------------------------------------------
// Public routes

async function publicChecks() {
  section("Public routes");
  await step("GET /claudex/release", async () => {
    const release = parseRelease(
      await requestJson(recordingFetch, `${baseUrl}/api/v1/claudex/release`),
    );
    check(true, "GET /claudex/release", `state ${release.state}`);
  });
  await step("GET /claudex/web-console", async () => {
    const console = parseWebConsole(
      await requestJson(
        recordingFetch,
        `${baseUrl}/api/v1/claudex/web-console`,
      ),
    );
    check(true, "GET /claudex/web-console", `admin only: ${console.adminOnly}`);
  });
  await step("bad client header", async () => {
    const response = await fetch(`${baseUrl}/api/v1/claudex/release`, {
      headers: { "X-Claudex-Platform": "beos" },
    });
    const body = (await response.json()) as {
      code?: unknown;
      reason?: unknown;
    };
    check(
      response.status === 400 &&
        (body.reason ?? body.code) === "CLAUDEX_INVALID_CLIENT_HEADER",
      "bad X-Claudex-Platform is refused",
      `HTTP ${response.status}`,
    );
  });
  await step("public checkout with an unknown token", async () => {
    try {
      await requestJson(
        recordingFetch,
        `${baseUrl}/api/v1/claudex/payment/checkout`,
        {
          method: "POST",
          body: { token: randomBytes(24).toString("base64url") },
        },
      );
      check(false, "unknown checkout token is refused", "HTTP 200");
    } catch (error) {
      check(
        error instanceof Sub2ApiError && error.status === 404,
        "unknown checkout token is refused",
        errorText(error),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Full run

interface PolicyView {
  revision: number;
  defaults: Record<string, unknown>;
  group_overrides: { group_id: number; patch: Record<string, unknown> }[];
  user_overrides: { user_id: number; patch: Record<string, unknown> }[];
}
/** The admin policy as a PUT body, with the group overrides changed by `edit`. */
function policyBody(
  view: PolicyView,
  edit: (
    overrides: PolicyView["group_overrides"],
  ) => PolicyView["group_overrides"],
) {
  return {
    revision: view.revision,
    defaults: view.defaults ?? {},
    group_overrides: edit(
      (view.group_overrides ?? []).map((item) => ({
        group_id: item.group_id,
        patch: item.patch,
      })),
    ),
    user_overrides: (view.user_overrides ?? []).map((item) => ({
      user_id: item.user_id,
      patch: item.patch,
    })),
  };
}
interface ReleaseView {
  channels: Record<string, unknown>;
  enforce_minimum_on_gateway: boolean;
}

async function policyAndRelease(
  admin: AdminApi,
  desktop: Desktop,
  originals: Originals,
  groupId: number,
) {
  const backend = desktop.backend;
  // Policy: a plan label for the i1 group; Bypass cannot be restricted (decision 3).
  const current = await admin.call<PolicyView>(
    "GET",
    "/api/v1/admin/claudex/policy",
  );
  try {
    await admin.call(
      "PUT",
      "/api/v1/admin/claudex/policy",
      policyBody(current, (list) => [
        ...list.filter((item) => item.group_id !== groupId),
        { group_id: groupId, patch: { permission_modes: ["auto", "bypass"] } },
      ]),
    );
    check(false, "a policy restricting Bypass is refused", "saved");
  } catch (error) {
    check(
      error instanceof Sub2ApiError &&
        error.code === "CLAUDEX_POLICY_INVALID" &&
        error.metadata?.rule === "bypass_not_policy_controlled",
      "a policy restricting Bypass is refused",
      errorText(error),
    );
  }
  const saved = await admin.call<PolicyView>(
    "PUT",
    "/api/v1/admin/claudex/policy",
    policyBody(current, (list) => [
      ...list.filter((item) => item.group_id !== groupId),
      { group_id: groupId, patch: { plan_label: `${prefix} Pro` } },
    ]),
  );
  try {
    await backend.bootstrap.refresh();
    const policy = backend.bootstrap.current()?.policy;
    check(
      policy?.planLabel === `${prefix} Pro` &&
        policy.revision === saved.revision,
      "group override reaches the desktop",
      `plan label "${policy?.planLabel}", revision ${policy?.revision}`,
    );
  } finally {
    const latest = await admin.call<PolicyView>(
      "GET",
      "/api/v1/admin/claudex/policy",
    );
    await admin.call(
      "PUT",
      "/api/v1/admin/claudex/policy",
      policyBody(latest, (list) =>
        list.filter((item) => item.group_id !== groupId),
      ),
    );
  }

  // Release: a newer minimum version; the gateway enforces it only when asked (decision 7).
  const release = originals.release;
  const download = (name: string) => ({
    url: `https://downloads.${prefix}.invalid/${name}`,
    sha256: "",
  });
  await admin.call("PUT", "/api/v1/admin/claudex/release", {
    channels: {
      stable: {
        latest_version: "99.0.0",
        minimum_version: "99.0.0",
        published_at: new Date(Date.now() - 60_000).toISOString(),
        release_notes_url: `https://releases.${prefix}.invalid/99.0.0`,
        release_notes_md: "## 99.0.0\n- Synthetic release of the I1 check.",
        downloads: {
          "darwin-arm64": download("Claudex-99.0.0-arm64.zip"),
          "darwin-x64": download("Claudex-99.0.0-x64.zip"),
          "win32-x64": download("Claudex-Setup-99.0.0.exe"),
          "linux-x64": null,
        },
      },
    },
    enforce_minimum_on_gateway: false,
  });
  try {
    const notice = await desktop.accounts.client.claudexRelease();
    check(
      notice.state === "required" &&
        !notice.enforced &&
        notice.minimumVersion === "99.0.0",
      "release notice for this build",
      `state ${notice.state}, enforced ${notice.enforced}, download ${notice.downloadUrl ? "https" : "none"}`,
    );
    const allowed = await turn(desktop, "gpt-5.5", "Reply with OK.");
    check(
      allowed.completed,
      "gateway does not enforce by default",
      `HTTP ${allowed.status}`,
    );
    await admin.call("PUT", "/api/v1/admin/claudex/release", {
      ...(await admin.call<ReleaseView>(
        "GET",
        "/api/v1/admin/claudex/release",
      )),
      updated_at: undefined,
      enforce_minimum_on_gateway: true,
    });
    const refused = await turn(desktop, "gpt-5.5", "Reply with OK.");
    const refusal = desktop.refusals.at(-1);
    check(
      refused.status === 426 &&
        refusal?.claudex?.reason === "UPGRADE_REQUIRED" &&
        refusal.action === "update",
      "enforced minimum version refuses the device key",
      `HTTP ${refused.status}${refusal ? `: ${refusal.message}` : ""}`,
    );
    const raw = await gateway(lastDeviceKey(), "/v1/models", undefined, {
      "X-Claudex-Version": "0.0.1",
      "X-Claudex-Platform": "darwin",
      "X-Claudex-Arch": "arm64",
    });
    gatewayExchanges.push({
      label: "GET /v1/models (minimum version enforced)",
      fixture: "refusal.upgrade-required.json",
      status: raw.status,
      body: raw.body,
    });
  } finally {
    await admin.call("PUT", "/api/v1/admin/claudex/release", {
      channels: release.channels ?? {},
      enforce_minimum_on_gateway: release.enforce_minimum_on_gateway === true,
    });
  }
  const after = await turn(desktop, "gpt-5.5", "Reply with OK.");
  check(
    after.completed,
    "release restored; turns work again",
    `HTTP ${after.status}`,
  );
}

interface Originals {
  release: ReleaseView;
  provisioning: Record<string, unknown>;
  feedback: Record<string, unknown>;
  voice: {
    transcription?: { enabled?: boolean; api_key_configured?: boolean };
  };
  payment: Record<string, unknown>;
}
interface Created {
  rules: number[];
  catalog: number[];
  diagnostics: string[];
  feedback: string[];
  paymentPlan?: number;
  paymentProvider?: number;
  userKeys: number[];
  desktops: Desktop[];
}

async function fullRun() {
  const adminEmail =
    process.env.CLAUDEX_ADMIN_EMAIL ?? devEnv.ADMIN_EMAIL ?? "";
  const adminPassword =
    process.env.CLAUDEX_ADMIN_PASSWORD ?? devEnv.ADMIN_PASSWORD ?? "";
  const upstreamUrl = process.env.CLAUDEX_UPSTREAM_BASE_URL ?? "";
  const upstreamKey =
    process.env.CLAUDEX_UPSTREAM_API_KEY ?? devEnv.MOCK_API_KEY ?? "";
  if (!adminEmail || !adminPassword || !upstreamUrl || !upstreamKey)
    throw Error(
      "--full needs admin credentials (CLAUDEX_ADMIN_EMAIL/PASSWORD or CLAUDEX_DEV_ENV), CLAUDEX_UPSTREAM_BASE_URL and the upstream key.",
    );
  const admin = new AdminApi(adminEmail, adminPassword);

  section("Admin preflight");
  await admin.login();
  const compliance = await admin.call<{ required?: boolean }>(
    "GET",
    "/api/v1/admin/compliance",
  );
  if (compliance?.required !== false)
    throw Error(
      "The admin compliance commitment has not been accepted on this instance. Its owner must accept it in the console; nothing was changed.",
    );
  check(
    true,
    "compliance commitment accepted by the owner",
    "admin routes open",
  );
  const originals: Originals = {
    provisioning: await admin.call("GET", "/api/v1/admin/claudex/provisioning"),
    feedback: await admin.call(
      "GET",
      "/api/v1/admin/claudex/feedback-settings",
    ),
    voice: await admin.call("GET", "/api/v1/admin/claudex/voice"),
    payment: await admin.call("GET", "/api/v1/admin/payment/config"),
    release: await admin.call("GET", "/api/v1/admin/claudex/release"),
  };
  for (const route of [
    "/api/v1/admin/claudex/policy",
    "/api/v1/admin/claudex/release",
    "/api/v1/admin/claudex/web-console",
    "/api/v1/admin/claudex/models/candidates",
  ])
    await step(`GET ${route}`, async () => {
      await admin.call("GET", route);
    });
  const created: Created = {
    rules: [],
    catalog: [],
    diagnostics: [],
    feedback: [],
    userKeys: [],
    desktops: [],
  };

  // -- Synthetic data, with the operator seed (scripts/sub2api-seed.ts).
  section("Synthetic data (i1-*)");
  const settings = await admin.call<Record<string, unknown>>(
    "GET",
    "/api/v1/admin/settings",
  );
  const email = `${prefix}-user@claudex.local`;
  const password = randomBytes(12).toString("hex");
  const models = ["gpt-5.5", "gpt-5.4-mini", "mock-echo"];
  const config = loadConfig(
    {
      SUB2API_URL: baseUrl,
      SUB2API_ADMIN_TOKEN: admin.auth,
      CLAUDEX_UPSTREAM_NAME: `${prefix}-mock-upstream`,
      CLAUDEX_UPSTREAM_PLATFORM: "openai",
      CLAUDEX_UPSTREAM_BASE_URL: upstreamUrl,
      CLAUDEX_UPSTREAM_API_KEY: upstreamKey,
      CLAUDEX_MODELS: models.join(","),
      CLAUDEX_DEFAULT_MODEL: "gpt-5.5",
      CLAUDEX_PRICE_INPUT_USD_PER_MTOK: "2",
      CLAUDEX_PRICE_OUTPUT_USD_PER_MTOK: "8",
      CLAUDEX_CHANNEL_NAME: `${prefix}-pricing`,
      CLAUDEX_STANDARD_GROUP: `${prefix}-standard`,
      CLAUDEX_PLAN_GROUP: `${prefix}-pro`,
      CLAUDEX_PLAN_DESCRIPTION: "I1 synthetic subscription plan",
      CLAUDEX_PLAN_WEEKLY_USD: "50",
      // The instance's own public settings, so the seed changes none of them.
      CLAUDEX_SITE_NAME: String(settings.site_name || "Claudex"),
      CLAUDEX_SITE_SUBTITLE: String(settings.site_subtitle ?? ""),
      CLAUDEX_REGISTRATION: settings.invitation_code_enabled
        ? "invite"
        : settings.registration_enabled
          ? "open"
          : "closed",
      CLAUDEX_TEST_USER_EMAIL: email,
      CLAUDEX_TEST_USER_PASSWORD: password,
    },
    false,
  );
  const actions = await seed(config, { log: () => {} });
  check(
    !actions.some(
      (item) => item.entity === "settings" && item.result !== "unchanged",
    ),
    "seed (groups, upstream account, pricing, user, subscription)",
    actions.map((item) => `${item.entity} ${item.result}`).join(", "),
  );
  const users = await admin.call<Page<{ id: number; email: string }>>(
    "GET",
    `/api/v1/admin/users?search=${encodeURIComponent(email)}&page_size=20`,
  );
  const user = users.items?.find((item) => item.email === email);
  if (!user) throw Error("The seeded test user is missing.");
  const groups = await admin.call<Page<{ id: number; name: string }>>(
    "GET",
    `/api/v1/admin/groups?search=${prefix}-pro&page_size=50`,
  );
  const plan = groups.items?.find((item) => item.name === `${prefix}-pro`);
  if (!plan) throw Error("The seeded plan group is missing.");
  // A fresh password each run (an existing user keeps the old one otherwise).
  await admin.call("PUT", `/api/v1/admin/users/${user.id}`, { password });
  // Start from no devices. A sign-in in the same second as the revoke-all
  // works (R13: only sessions signed out by it are refused), so no wait.
  await admin.call(
    "POST",
    `/api/v1/admin/claudex/users/${user.id}/devices/revoke-all`,
    {},
  );
  await admin
    .call("DELETE", `/api/v1/admin/claudex/users/${user.id}/device-limit`)
    .catch(() => {});
  // Provisioning stays as it is: the test user's subscription picks the plan
  // (strategy subscription_then_default); no default group is needed.
  // Leftovers of an earlier run.
  const rules = await admin.call<{ items?: { id: number; label: string }[] }>(
    "GET",
    "/api/v1/admin/claudex/usage-rules",
  );
  for (const rule of rules.items ?? [])
    if (rule.label.startsWith(`${prefix} `))
      await admin.call(
        "DELETE",
        `/api/v1/admin/claudex/usage-rules/${rule.id}`,
      );
  const catalog = await admin.call<
    | { items?: { id: number; display_name: string }[] }
    | { id: number; display_name: string }[]
  >("GET", "/api/v1/admin/claudex/models");
  for (const entry of Array.isArray(catalog) ? catalog : (catalog.items ?? []))
    if (entry.display_name.startsWith(`${prefix} `))
      await admin.call("DELETE", `/api/v1/admin/claudex/models/${entry.id}`);
  check(
    true,
    "test user ready",
    `user ${user.id}, plan group ${plan.id}, devices revoked, password reset`,
  );

  // -- Usage rules and the model catalog.
  await step("usage rules", async () => {
    const session = await admin.call<{ id: number }>(
      "POST",
      "/api/v1/admin/claudex/usage-rules",
      {
        group_id: plan.id,
        kind: "session",
        label: `${prefix} session`,
        window_seconds: 5 * 3600,
        limit_usd: 5,
        enabled: true,
        show_in_client: true,
        sort_order: 1,
      },
    );
    const echo = await admin.call<{ id: number }>(
      "POST",
      "/api/v1/admin/claudex/usage-rules",
      {
        group_id: plan.id,
        kind: "models",
        label: `${prefix} echo`,
        model_patterns: ["mock-echo"],
        window_seconds: 7 * 86400,
        limit_usd: 0.00000001,
        enabled: true,
        show_in_client: true,
        sort_order: 2,
      },
    );
    created.rules.push(session.id, echo.id);
    check(
      true,
      "usage rules created",
      `5h session $5, weekly mock-echo $0.00000001`,
    );
  });
  await step("model catalog", async () => {
    const main = await admin.call<{ id: number }>(
      "POST",
      "/api/v1/admin/claudex/models",
      {
        model_id: "gpt-5.5",
        group_id: plan.id,
        display_name: `${prefix} GPT-5.5`,
        description: "Synthetic catalog entry for the I1 check",
        badges: ["new"],
        sort_order: 1,
        hidden: false,
        is_default: true,
        supported_efforts: ["low", "medium", "high"],
        default_effort: "medium",
        context_window: 400000,
        auto_compact_tokens: 320000,
        fast_tier: false,
        usage_hint: "",
      },
    );
    const hidden = await admin.call<{ id: number }>(
      "POST",
      "/api/v1/admin/claudex/models",
      {
        model_id: "mock-echo",
        group_id: plan.id,
        display_name: `${prefix} Echo`,
        description: "Hidden: listed under More models",
        sort_order: 9,
        hidden: true,
        is_default: false,
      },
    );
    created.catalog.push(main.id, hidden.id);
    check(
      true,
      "model catalog entries created",
      "gpt-5.5 default, mock-echo hidden",
    );
  });

  try {
    await desktopScenarios(admin, originals, created, {
      email,
      password,
      userId: user.id,
      groupId: plan.id,
    });
  } finally {
    if (keep) note("cleanup", "skipped (--keep)");
    else await cleanup(admin, originals, created, user.id);
  }
}

async function desktopScenarios(
  admin: AdminApi,
  originals: Originals,
  created: Created,
  account: { email: string; password: string; userId: number; groupId: number },
) {
  // -- Sign-in, bootstrap, device registration, policy and catalog.
  section("Sign-in, bootstrap and device registration");
  const desktop = await signIn("desktop-1", account.email, account.password);
  created.desktops.push(desktop);
  check(true, "login", `account ${desktop.session.accountId}`);
  const restored = await new RemoteAccounts(
    desktop.root,
    baseUrl,
    cipher,
    recordingFetch,
  ).restore();
  check(
    restored?.account.id === desktop.session.accountId,
    "session restore",
    "saved session restored with a rotated refresh token",
  );
  if (restored) {
    // The restored session holds the newest refresh token.
    desktop.session = restored.session;
    desktop.backend = new RemoteBackend(
      desktop.accounts,
      restored.session,
      desktop.root,
    );
  }
  desktop.provider = await desktop.backend.prepare(desktop.credentials);
  const backend = desktop.backend;
  check(backend.kind === "claudex", "service kind", String(backend.kind));
  check(
    backend.plan?.groupId === account.groupId && backend.plan.subscribed,
    "plan from the service",
    `${backend.plan?.name} (group ${backend.plan?.groupId}, ${backend.plan?.subscribed ? "subscription" : "balance"}, ${desktop.provider.protocol})`,
  );
  const boot = backend.bootstrap.current();
  check(
    !!boot && boot.features.deviceKeys && !!boot.device,
    "bootstrap",
    boot
      ? `sections: ${Object.keys(
          backend.bootstrap.rawSection("features") ? boot : {},
        )
          .filter(
            (key) =>
              (boot as unknown as Record<string, unknown>)[key] !== undefined,
          )
          .join(", ")}`
      : "none",
  );
  check(
    desktop.provider.models.includes("gpt-5.5") &&
      desktop.provider.model === "gpt-5.5",
    "models through the device key",
    `${desktop.provider.models.join(", ")}; default ${desktop.provider.model}`,
  );
  const shown = backend.catalog;
  check(
    !!shown &&
      shown.items.some(
        (item) =>
          item.id === "gpt-5.5" && item.displayName === `${prefix} GPT-5.5`,
      ) &&
      shown.items.some((item) => item.id === "mock-echo" && item.hidden),
    "catalog met with the gateway's list",
    shown
      ? shown.items
          .map(
            (item) =>
              `${item.id}${item.hidden ? " (More models)" : ""} "${item.displayName}"`,
          )
          .join(", ")
      : "none",
  );
  await backend.prepare(desktop.credentials);
  const token = () => desktop.session.authorized(async (value) => value);
  const devices = parseDeviceList(
    await desktop.session.authorized((value) =>
      requestJson(recordingFetch, `${baseUrl}/api/v1/claudex/devices`, {
        token: value,
        deviceId: backend.deviceId,
      }),
    ),
  );
  check(
    devices.items.filter((item) => !item.revoked).length === 1 &&
      devices.items.some((item) => item.current),
    "one device after two prepares",
    `${devices.items.length} device(s), limit ${devices.limit}`,
  );
  await step("policy and catalog routes", async () => {
    const first = await desktop.session.authorized((value) =>
      desktop.accounts.client.policy(value, backend.deviceId),
    );
    if (first.notModified) throw Error("The first policy read answered 304.");
    const policy = parsePolicy(first.data);
    const again = await desktop.session.authorized((value) =>
      desktop.accounts.client.policy(value, backend.deviceId, first.etag),
    );
    check(
      !!first.etag && again.notModified,
      "GET /claudex/policy with If-None-Match",
      `revision ${policy.revision}, ETag ${first.etag ? "sent" : "missing"}, second read ${again.status}`,
    );
    const catalogAnswer = await desktop.session.authorized((value) =>
      requestJsonResult(recordingFetch, `${baseUrl}/api/v1/claudex/models`, {
        token: value,
        deviceId: backend.deviceId,
      }),
    );
    if (catalogAnswer.notModified) throw Error("unexpected 304");
    const catalog = parseModelCatalog(catalogAnswer.data);
    check(
      catalog.defaultModel === "gpt-5.5" && catalog.items.length >= 2,
      "GET /claudex/models",
      `${catalog.items.length} entries, default ${catalog.defaultModel}`,
    );
    const bootAgain = await desktop.session.authorized((value) =>
      desktop.accounts.client.bootstrap(
        value,
        backend.deviceId,
        backend.bootstrap.tag,
      ),
    );
    check(
      bootAgain.notModified,
      "GET /claudex/bootstrap with If-None-Match",
      `HTTP ${bootAgain.status}`,
    );
    // Design 3.6: bootstrap p95 under 150 ms on local Docker (full answers,
    // within the Heavy per-user limit).
    const token = await desktop.session.authorized(async (value) => value);
    const times: number[] = [];
    for (let index = 0; index < 20; index++) {
      const started = performance.now();
      const answer = await desktop.accounts.client.bootstrap(
        token,
        backend.deviceId,
      );
      if (answer.notModified) throw Error("unexpected 304");
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1];
    check(
      p95 < 150,
      "bootstrap p95 under 150 ms",
      `p50 ${times[9].toFixed(1)} ms, p95 ${p95.toFixed(1)} ms over ${times.length} reads`,
    );
  });
  if (boot?.voice) parseVoice(backend.bootstrap.rawSection("voice"));

  // -- Device limit.
  section("Device limit");
  await step("device limit", async () => {
    await admin.call(
      "PUT",
      `/api/v1/admin/claudex/users/${account.userId}/device-limit`,
      { max_devices: 1 },
    );
    await admin.call(
      "GET",
      `/api/v1/admin/claudex/users/${account.userId}/device-limit`,
    );
    const second = await signIn(
      "desktop-limit",
      account.email,
      account.password,
    );
    try {
      await second.backend.prepare(second.credentials);
      check(false, "second device over the limit is refused", "it registered");
    } catch (error) {
      check(
        error instanceof Error && error.message === deviceLimitMessage(1),
        "second device over the limit is refused",
        errorText(error),
      );
    } finally {
      await second.session.logout().catch(() => {});
      await admin.call(
        "DELETE",
        `/api/v1/admin/claudex/users/${account.userId}/device-limit`,
      );
    }
  });

  // -- A chat turn through the gateway, and usage.
  section("Policy and release");
  await step("policy and release", () =>
    policyAndRelease(admin, desktop, originals, account.groupId),
  );

  section("Chat turn and usage");
  await step("chat turn", async () => {
    const reply = await turn(desktop, "gpt-5.5", "Reply with OK.");
    check(
      reply.completed,
      "POST /responses through the provider service",
      `HTTP ${reply.status}`,
    );
    await sleep(1500);
    const reader = new ClaudexUsageReader(
      () =>
        desktop.session.authorized((value) =>
          fetchUsageStatus(baseUrl, value, {
            deviceId: backend.deviceId,
            fetchImpl: recordingFetch,
          }),
        ),
      () => backend.bootstrap.current()?.features.usageStatus,
    );
    const status = await reader.status(true);
    const sessionWindow = status?.windows.find(
      (item) => item.kind === "session",
    );
    check(
      !!sessionWindow && sessionWindow.usedUsd > 0 && sessionWindow.active,
      "usage-status counts the turn",
      status
        ? status.windows
            .map(
              (item) =>
                `${item.label} ${item.usedUsd.toFixed(6)}/${item.limitUsd} (${item.percent}%)`,
            )
            .join("; ")
        : "no usage-status",
    );
    if (status) {
      const page = planUsageFromStatus(status, {
        plan: backend.plan?.name,
        expiresAt: backend.plan?.expiresAt ?? null,
        warnPercent: 80,
        learnMoreUrl: null,
        readAt: Date.now(),
      });
      note(
        "Plan usage limits page",
        page.windows
          .map(
            (item) =>
              `${item.kind} "${item.label}" ${item.percent.toFixed(1)}%`,
          )
          .join(", "),
      );
    }
    const logs = await admin.call<
      Page<{ model?: string; total_cost?: number; actual_cost?: number }>
    >("GET", `/api/v1/admin/usage?user_id=${account.userId}&page_size=5`);
    check(
      (logs.items ?? []).some((item) => item.model === "gpt-5.5"),
      "usage log recorded",
      `${logs.items?.length ?? 0} recent record(s)`,
    );
  });

  // -- Dictation.
  section("Dictation (realtime WebSocket)");
  await step("dictation", () => dictation(admin, desktop, originals));

  // -- A usage rule refuses.
  section("Usage rule refusal");
  await step("usage rule refusal", async () => {
    const first = await turn(desktop, "mock-echo", "echo one");
    note("first mock-echo turn", `HTTP ${first.status}`);
    await sleep(1500);
    const second = await turn(desktop, "mock-echo", "echo two");
    const refusal = desktop.refusals.at(-1);
    check(
      second.status === 429 && refusal?.claudex?.reason === "RULE_LIMIT",
      "second mock-echo turn refused by the rule",
      `HTTP ${second.status}${refusal ? `, ${refusal.code} ${refusal.claudex?.reason ?? ""}: ${refusal.message}` : ""}`,
    );
    check(
      !!refusal?.resetsAt && refusal.models?.includes("mock-echo") === true,
      "refusal names the window and the models",
      refusal
        ? `resets ${refusal.resetsAt ? new Date(refusal.resetsAt).toISOString() : "?"}, models ${refusal.models?.join(",")}`
        : "none",
    );
    const raw = await gateway(lastDeviceKey(), "/v1/responses", {
      model: "mock-echo",
      input: "echo three",
    });
    gatewayExchanges.push({
      label: "POST /v1/responses (rule limit)",
      fixture: "refusal.rule-limit.json",
      status: raw.status,
      body: raw.body,
    });
    const parsed = parseRefusal(raw.status, raw.body);
    check(
      raw.status === 429 && parsed?.reason === "RULE_LIMIT",
      "gateway 429 body parses",
      `${raw.status} ${parsed?.reason ?? "no claudex object"}`,
    );
    const other = await turn(desktop, "gpt-5.5", "Still fine?");
    check(other.completed, "other models keep working", `HTTP ${other.status}`);
    const status = parseUsageStatus(
      await requestJson(
        recordingFetch,
        `${baseUrl}/api/v1/claudex/usage-status`,
        { token: await token(), deviceId: backend.deviceId },
      ),
    );
    const echo = status.windows.find((item) => item.label === `${prefix} echo`);
    check(
      !!echo?.exceeded,
      "usage-status marks the rule exceeded",
      echo
        ? `${echo.usedUsd}/${echo.limitUsd}, resets ${echo.resetsAt}`
        : "no row",
    );
    // Dictation is counted as its own model: another model's exceeded rule
    // must not refuse its handshake (dictation is off again here, so the
    // route answers 404 when the rules let it through; nothing goes upstream).
    const handshake = await upgradeStatus(
      lastDeviceKey(),
      "/v1/audio/realtime/transcriptions",
    );
    check(
      handshake !== 429,
      "dictation is not refused by another model's rule",
      `handshake HTTP ${handshake}`,
    );
  });

  // -- The subscription's weekly cap.
  section("Subscription weekly limit");
  await step("subscription weekly limit", async () => {
    const group = await admin.call<{ weekly_limit_usd?: number | null }>(
      "GET",
      `/api/v1/admin/groups/${account.groupId}`,
    );
    await admin.call("PUT", `/api/v1/admin/groups/${account.groupId}`, {
      weekly_limit_usd: 0.0001,
    });
    try {
      await sleep(1000);
      const refused = await turn(desktop, "gpt-5.5", "Reply with OK.");
      const refusal = desktop.refusals.at(-1);
      check(
        refused.status === 429 &&
          refusal?.claudex?.reason === "SUBSCRIPTION_WEEKLY_LIMIT",
        "weekly subscription cap refuses",
        `HTTP ${refused.status}${refusal ? `: ${refusal.claudex?.reason} ${refusal.message}` : ""}`,
      );
      const raw = await gateway(lastDeviceKey(), "/v1/responses", {
        model: "gpt-5.5",
        input: "Reply with OK.",
      });
      gatewayExchanges.push({
        label: "POST /v1/responses (weekly cap)",
        fixture: "refusal.subscription-weekly-limit.json",
        status: raw.status,
        body: raw.body,
      });
      const status = parseUsageStatus(
        await requestJson(
          recordingFetch,
          `${baseUrl}/api/v1/claudex/usage-status`,
          { token: await token(), deviceId: backend.deviceId },
        ),
      );
      const weekly = status.windows.find(
        (item) => item.source === "subscription",
      );
      check(
        !!weekly?.exceeded,
        "usage-status shows the weekly cap reached",
        weekly
          ? `${weekly.label} ${weekly.usedUsd}/${weekly.limitUsd}, blocked ${status.blocked.blocked}`
          : "no subscription row",
      );
    } finally {
      await admin.call("PUT", `/api/v1/admin/groups/${account.groupId}`, {
        weekly_limit_usd: group.weekly_limit_usd ?? null,
      });
    }
    await sleep(1000);
    const after = await turn(desktop, "gpt-5.5", "Reply with OK.");
    check(
      after.completed,
      "cap restored; turns work again",
      `HTTP ${after.status}`,
    );
  });

  // -- Payments.
  section("Payments (mock provider only)");
  await step("payments", () =>
    payments(admin, desktop, created, account.groupId),
  );

  // -- Diagnostics and feedback.
  section("Diagnostics and feedback");
  await step("diagnostics and feedback", () =>
    reports(admin, desktop, created),
  );

  // -- A user-created key, revoke-all and the legacy key.
  section("Revoke-all and user-created keys");
  let userKey = "";
  let quotaKey = "";
  await step("user-created key", async () => {
    await admin.call("PUT", "/api/v1/admin/claudex/provisioning", {
      user_api_keys_enabled: true,
    });
    try {
      const key = await desktop.session.authorized((value) =>
        desktop.accounts.client.createKey(
          value,
          `${prefix}-user-key`,
          account.groupId,
        ),
      );
      created.userKeys.push(key.id);
      userKey = key.key;
      // A user key with a tiny quota: the gateway's own key limit, explained.
      const limited = (await desktop.session.authorized((value) =>
        requestJson(recordingFetch, `${baseUrl}/api/v1/keys`, {
          method: "POST",
          token: value,
          body: {
            name: `${prefix}-quota-key`,
            group_id: account.groupId,
            quota: 0.00001,
          },
        }),
      )) as { id: number; key: string };
      created.userKeys.push(limited.id);
      quotaKey = limited.key;
    } finally {
      await admin.call("PUT", "/api/v1/admin/claudex/provisioning", {
        user_api_keys_enabled:
          originals.provisioning.user_api_keys_enabled === true,
      });
    }
    const models = await gateway(userKey, "/v1/models");
    check(
      models.status === 200,
      "user-created key works before revoke-all",
      `HTTP ${models.status}`,
    );
    const spend = await gateway(quotaKey, "/v1/responses", {
      model: "gpt-5.5",
      input: "Reply with OK.",
    });
    await sleep(1500);
    const over = await gateway(quotaKey, "/v1/responses", {
      model: "gpt-5.5",
      input: "Reply with OK.",
    });
    // Only device keys get a `claudex` explanation (design 2.7); a user key
    // gets the gateway's own error, with the same outer shape as the fixture.
    const overBody = over.body as {
      claudex?: unknown;
      error?: { code?: unknown };
    };
    gatewayExchanges.push({
      label:
        "POST /v1/responses (user key quota used up; claudex object only for device keys)",
      fixture: "refusal.key-quota-exhausted.json",
      status: over.status,
      body: { ...overBody, claudex: undefined },
    });
    check(
      spend.status === 200 &&
        over.status === 429 &&
        overBody.error?.code === "insufficient_quota" &&
        overBody.claudex === undefined,
      "user key over its quota: gateway error, no claudex object",
      `first ${spend.status}, then ${over.status} ${String(overBody.error?.code)}`,
    );
    // The client's key parser skips masked keys, so the list is read raw here.
    const listed = (await desktop.session.authorized((value) =>
      requestJson(
        recordingFetch,
        `${baseUrl}/api/v1/keys?page=1&page_size=100`,
        {
          token: value,
        },
      ),
    )) as Page<{ id: number; name: string; key: string; status: string }>;
    const deviceKey = lastDeviceKey();
    const device = listed.items?.find(
      (item) =>
        item.name.startsWith("claudex-device:") && item.status === "active",
    );
    check(
      !!device && device.key !== deviceKey && !deviceKey.includes(device.key),
      "device key is masked in /api/v1/keys (H13)",
      device
        ? `${device.name}: shown as ${device.key.length} masked chars`
        : "no device key listed",
    );
    if (device)
      try {
        await desktop.session.authorized((value) =>
          desktop.accounts.client.deleteKey(value, device.id),
        );
        check(
          false,
          "device key cannot be deleted through /api/v1/keys",
          "deleted",
        );
      } catch (error) {
        check(
          error instanceof Sub2ApiError &&
            error.code === "CLAUDEX_DEVICE_KEY_MANAGED",
          "device key cannot be deleted through /api/v1/keys",
          errorText(error),
        );
      }
  });
  await step("revoke-all", async () => {
    const deviceKey = lastDeviceKey();
    await desktop.session.authorized(async () => undefined);
    const oldToken = lastAccessToken;
    let signedOut: string | undefined;
    desktop.session.onSignedOut = (reason) => {
      signedOut = reason;
    };
    await desktop.session.revokeAll();
    check(true, "Log out of all devices", "POST /auth/revoke-all-sessions");
    const keys = await fetch(`${baseUrl}/api/v1/keys`, {
      headers: { Authorization: `Bearer ${oldToken}` },
    });
    const keysBody = await keys.json();
    exchanges.push({
      method: "GET",
      path: "/api/v1/keys",
      status: keys.status,
      body: keysBody,
    });
    check(
      keys.status === 401 &&
        (keysBody as { code?: unknown }).code ===
          claudexErrorCodes.sessionRevoked,
      "old access token refused (H9b)",
      `HTTP ${keys.status} ${(keysBody as { code?: unknown }).code}`,
    );
    const device = await gateway(deviceKey, "/v1/models");
    gatewayExchanges.push({
      label: "GET /v1/models (revoked device key)",
      fixture: "refusal.device-revoked.json",
      status: device.status,
      body: device.body,
    });
    check(
      device.status === 401 || device.status === 403,
      "device key refused after revoke-all",
      `HTTP ${device.status} ${parseRefusal(device.status, device.body)?.reason ?? ""}`,
    );
    const mine = await gateway(userKey, "/v1/models");
    const reply = await gateway(userKey, "/v1/responses", {
      model: "gpt-5.5",
      input: "Reply with OK.",
      stream: false,
    });
    check(
      mine.status === 200 && reply.status === 200,
      "user-created key untouched by revoke-all",
      `/v1/models ${mine.status}, /v1/responses ${reply.status}`,
    );
    const listed = await admin.call<
      Page<{ status?: string; revoked_at?: unknown; user_id?: number }>
    >(
      "GET",
      `/api/v1/admin/claudex/devices?user_id=${account.userId}&status=all`,
    );
    const active = (listed.items ?? []).filter(
      (item) => item.status === "active",
    );
    check(
      active.length === 0,
      "admin device list shows every device revoked",
      `${listed.items?.length ?? 0} device(s), ${active.length} active`,
    );
    const restored = await new RemoteAccounts(
      desktop.root,
      baseUrl,
      cipher,
      recordingFetch,
    ).restore();
    check(
      !restored,
      "this desktop is signed out",
      signedOut ? `signed out: ${signedOut}` : "session file cleared",
    );
  });

  // -- Legacy key: a claudex-desktop:<device> key from an older client.
  section("Legacy device key");
  await step("legacy key replacement", async () => {
    // Right after the revoke-all above: same-second sign-ins work (R13).
    const next = await signIn("desktop-2", account.email, account.password);
    created.desktops.push(next);
    const legacyName = deviceKeyName(deviceId(next.root));
    await admin.call("PUT", "/api/v1/admin/claudex/provisioning", {
      user_api_keys_enabled: true,
    });
    let legacy;
    try {
      legacy = await next.session.authorized((value) =>
        next.accounts.client.createKey(value, legacyName, account.groupId),
      );
    } finally {
      await admin.call("PUT", "/api/v1/admin/claudex/provisioning", {
        user_api_keys_enabled:
          originals.provisioning.user_api_keys_enabled === true,
      });
    }
    created.userKeys.push(legacy.id);
    next.provider = await next.backend.prepare(next.credentials);
    const keys = await next.session.authorized((value) =>
      next.accounts.client.listKeys(value, "", 1),
    );
    const old = keys.items.find((item) => item.id === legacy.id);
    const fresh = lastDeviceKey();
    check(
      old?.status === "disabled" && fresh !== legacy.key,
      "legacy key disabled, a new device key issued (decision 10)",
      `legacy ${old?.status}; new key ${fresh !== legacy.key ? "differs" : "SAME"}`,
    );
    const oldWorks = await gateway(legacy.key, "/v1/models");
    const newWorks = await gateway(fresh, "/v1/models");
    check(
      oldWorks.status !== 200 && newWorks.status === 200,
      "gateway: legacy key refused, new key works",
      `${oldWorks.status} / ${newWorks.status}`,
    );
    // Decision 4: resetting the password leaves device keys alone.
    const newPassword = randomBytes(12).toString("hex");
    await admin.call("PUT", `/api/v1/admin/users/${account.userId}`, {
      password: newPassword,
    });
    const afterReset = await gateway(fresh, "/v1/models");
    check(
      afterReset.status === 200,
      "password reset keeps the device key (decision 4)",
      `HTTP ${afterReset.status}`,
    );
    const stale = await next.session
      .authorized((value) => next.accounts.client.me(value))
      .then(() => "still signed in", errorText);
    note("after the password reset", `this desktop's session: ${stale}`);
    // Sign in again with the new password; then this device leaves the account.
    await sleep(1100);
    const again = new RemoteAccounts(
      next.root,
      baseUrl,
      cipher,
      recordingFetch,
    );
    const second = await again.login(account.email, newPassword);
    if (second.kind !== "signedIn")
      throw Error("The test account asks for 2FA.");
    const left = await second.session.authorized((value) =>
      again.client.revokeCurrentDevice(value, deviceId(next.root)),
    );
    const afterLeave = await gateway(fresh, "/v1/models");
    check(
      left.revoked && afterLeave.status !== 200,
      "DELETE /claudex/devices/current turns this device's key off",
      `revoked ${left.revoked}, key now HTTP ${afterLeave.status}`,
    );
    await second.session.logout().catch(() => {});
  });
}

// ---------------------------------------------------------------------------

async function payments(
  admin: AdminApi,
  desktop: Desktop,
  created: Created,
  groupId: number,
) {
  const opened: string[] = [];
  const host = {
    backend: desktop.backend,
    accounts: desktop.accounts,
    bootstrap: desktop.backend.bootstrap,
    refreshPlan: async () => {},
  };
  const billing = new BillingSession(host, {
    openExternal: async (url) => {
      opened.push(url);
    },
    push: () => {},
    active: () => true,
  });
  try {
    await desktop.backend.bootstrap.refresh();
    const off = await billing.paymentFeatures();
    const checkoutOff = await billing.checkout();
    check(
      !off.payment && checkoutOff === null,
      "payments off: no checkout",
      `payment ${off.payment}, redeem ${off.redeem}`,
    );
    const info = await billing.info();
    note(
      "Billing info",
      `plan ${info.plan ?? "none"}, ${info.subscriptions?.length ?? 0} subscription(s)`,
    );

    const provider = await admin.call<{ id: number }>(
      "POST",
      "/api/v1/admin/payment/providers",
      {
        provider_key: "easypay",
        name: `${prefix}-mock-easypay`,
        config: {
          pid: "1000",
          pkey: randomBytes(16).toString("hex"),
          // Never contacted: redirect mode only builds a URL on this host.
          apiBase: "https://pay.i1.invalid",
          notifyUrl: `${baseUrl}/api/v1/payment/webhook/easypay`,
          returnUrl: `${baseUrl}/payment/result`,
        },
        supported_types: ["alipay"],
        enabled: true,
        payment_mode: "popup",
        sort_order: 99,
        limits: "",
        refund_enabled: false,
        allow_user_refund: false,
      },
    );
    created.paymentProvider = provider.id;
    const planRow = await admin.call<{ id: number }>(
      "POST",
      "/api/v1/admin/payment/plans",
      {
        group_id: groupId,
        name: `${prefix}-plan`,
        description: "Synthetic plan for the I1 check",
        price: 1,
        currency: "CNY",
        validity_days: 30,
        validity_unit: "day",
        features: "",
        product_name: `${prefix}-plan`,
        for_sale: true,
        sort_order: 99,
      },
    );
    created.paymentPlan = planRow.id;
    await admin.call("PUT", "/api/v1/admin/payment/config", {
      enabled: true,
      enabled_payment_types: ["alipay"],
    });
    await sleep(500);
    const fresh = new BillingSession(host, {
      openExternal: async (url) => {
        opened.push(url);
      },
      push: () => {},
      active: () => true,
      payment: new ClaudexPayment(baseUrl, recordingFetch),
    });
    await desktop.backend.bootstrap.refresh();
    const checkout = await fresh.checkout();
    const listed = checkout?.plans.find(
      (item) => item.name === `${prefix}-plan`,
    );
    check(
      !!checkout &&
        !!listed &&
        checkout.methods.some((item) => item.id === "alipay"),
      "plans and methods listed",
      checkout
        ? `${checkout.plans.length} plan(s), methods ${checkout.methods.map((item) => item.id).join(", ")}`
        : "no checkout",
    );
    if (!listed) return;
    const started = await fresh.start({ planId: listed.id, method: "alipay" });
    const page = opened.at(-1) ?? "";
    check(
      started.kind === "browser" &&
        page.startsWith("https://pay.i1.invalid/submit.php?"),
      "order created against the mock provider",
      `${started.kind}, order ${started.order.id} ${started.order.status}, page on the mock host (never opened)`,
    );
    try {
      await desktop.session.authorized((value) =>
        fresh.payment.checkoutLink(value, {
          orderId: started.order.id,
          resumeToken: "i1-not-a-real-token",
          clientSecret: "i1_not_a_real_secret",
        }),
      );
      check(
        false,
        "desktop checkout link refused for an EasyPay order",
        "issued",
      );
    } catch (error) {
      check(
        error instanceof Sub2ApiError &&
          error.code === "CLAUDEX_CHECKOUT_UNAVAILABLE",
        "desktop checkout link refused for an EasyPay order",
        errorText(error),
      );
    }
    const cancelled = await fresh.cancel(started.order.id);
    check(
      cancelled.status === "CANCELLED",
      "order cancelled",
      cancelled.status,
    );
    const orders = await fresh.orders(1);
    note("orders", `${orders.total} order(s) on the account`);
    fresh.close();
  } finally {
    billing.close();
  }
}

async function reports(admin: AdminApi, desktop: Desktop, created: Created) {
  let consent = true;
  const posts = () =>
    exchanges.filter(
      (item) =>
        item.method === "POST" &&
        /\/api\/v1\/claudex\/(diagnostics|feedback)$/.test(item.path),
    ).length;
  const reporter = () =>
    new DiagnosticsReporter({
      file: path.join(desktop.root, "diagnostics-queue.json"),
      bootstrap: desktop.backend.bootstrap,
      consented: () => consent,
      client: reporterClient("0.0.1"),
      post: (route, body) =>
        desktop.session.authorized((value) =>
          requestJson(recordingFetch, `${baseUrl}/api/v1/claudex/${route}`, {
            method: "POST",
            token: value,
            body,
            deviceId: desktop.backend.deviceId,
          }),
        ),
    });
  const conversation = {
    id: randomUUID(),
    title: "i1 feedback",
    mode: "chat",
    model: "gpt-5.5",
    incognito: false,
    turns: [
      {
        id: "i1-turn",
        prompt: "I1 PROMPT TEXT THAT MUST NOT BE SENT",
        status: "done",
        createdAt: Date.now(),
        answer: "OK",
      },
    ],
  } as unknown as Conversation;

  // Server switch off (the default).
  await desktop.backend.bootstrap.refresh();
  const off = reporter();
  const kept = off.record({
    kind: "turn_error",
    code: "I1_TEST",
    message: "i1 synthetic error",
  });
  await off.flush();
  const before = posts();
  check(
    !kept && before === 0,
    "server off: nothing queued or sent",
    `queued ${kept}, requests ${before}`,
  );
  off.stop();
  try {
    await desktop.session.authorized((value) =>
      requestJson(recordingFetch, `${baseUrl}/api/v1/claudex/diagnostics`, {
        method: "POST",
        token: value,
        body: { reports: [] },
        deviceId: desktop.backend.deviceId,
      }),
    );
    check(false, "POST /claudex/diagnostics while off", "accepted");
  } catch (error) {
    check(
      error instanceof Sub2ApiError && error.status === 404,
      "POST /claudex/diagnostics while off is refused",
      errorText(error),
    );
  }

  // Server switch on, consent on.
  await admin.call("PUT", "/api/v1/admin/claudex/feedback-settings", {
    diagnostics: { enabled: true },
    feedback: { enabled: true, allow_conversation_excerpt: false },
  });
  await sleep(300);
  await desktop.backend.bootstrap.refresh();
  const on = reporter();
  const status = await on.reportingStatus(0);
  check(
    !!status?.diagnostics && !!status.feedback,
    "bootstrap reports collection on",
    JSON.stringify(status),
  );
  const queued = on.record({
    kind: "turn_error",
    code: "I1_TEST",
    message: "i1 synthetic error",
    model: "gpt-5.5",
    context: { surface: "chat" },
  });
  await on.flush();
  const result = await on.submitFeedback(conversation, {
    conversationId: conversation.id,
    turnId: "i1-turn",
    rating: "down",
    categories: ["other"],
    comment: "i1 synthetic feedback",
    includeConversation: true,
  });
  check(
    queued && on.pending.diagnostics === 0,
    "diagnostic sent with consent",
    `pending ${JSON.stringify(on.pending)}`,
  );
  check(result.sent, "feedback sent with consent", JSON.stringify(result));
  on.stop();
  const diagnostics = await admin.call<
    Page<{ id: string; code?: string; message?: string }>
  >("GET", "/api/v1/admin/claudex/diagnostics?page_size=20");
  const mine = (diagnostics.items ?? []).filter(
    (item) => item.code === "I1_TEST",
  );
  created.diagnostics.push(...mine.map((item) => String(item.id)));
  check(
    mine.length >= 1,
    "admin sees the diagnostic",
    `${mine.length} I1_TEST report(s)`,
  );
  const feedback = await admin.call<
    Page<{ id: string; comment?: string; conversation_excerpt?: unknown }>
  >("GET", "/api/v1/admin/claudex/feedback?page_size=20");
  const ours = (feedback.items ?? []).filter(
    (item) => item.comment === "i1 synthetic feedback",
  );
  created.feedback.push(...ours.map((item) => String(item.id)));
  const leaked = JSON.stringify(ours).includes("I1 PROMPT TEXT");
  check(
    ours.length >= 1 && !leaked,
    "admin sees the feedback, without the prompt",
    `${ours.length} item(s), prompt ${leaked ? "LEAKED" : "absent"}`,
  );

  // Consent off: nothing is sent.
  consent = false;
  const withdrawn = reporter();
  const countBefore = posts();
  const keptOff = withdrawn.record({
    kind: "turn_error",
    code: "I1_TEST",
    message: "i1 synthetic error",
  });
  const sentOff = await withdrawn.submitFeedback(conversation, {
    conversationId: conversation.id,
    turnId: "i1-turn",
    rating: "up",
  });
  await withdrawn.flush();
  check(
    !keptOff && !sentOff.sent && posts() === countBefore,
    "consent off: nothing sent",
    `queued ${keptOff}, feedback ${JSON.stringify(sentOff)}, requests ${posts() - countBefore}`,
  );
  withdrawn.stop();
}

async function dictation(
  admin: AdminApi,
  desktop: Desktop,
  originals: Originals,
) {
  const voiceEnv = option("--voice-env");
  await desktop.backend.bootstrap.refresh();
  const off = desktop.backend.bootstrap.current()?.voice;
  if (!voiceEnv) {
    check(
      !!off &&
        (originals.voice.transcription?.enabled === true ||
          !off.available.transcription),
      "dictation matches the voice setting",
      `available ${off?.available.transcription}; pass --voice-env to probe it live`,
    );
    return;
  }
  const key = parseEnvFile(fs.readFileSync(voiceEnv, "utf8")).HIWONDER_ASR_KEY;
  if (!key) throw Error("--voice-env has no HIWONDER_ASR_KEY.");
  await admin.call("PUT", "/api/v1/admin/claudex/voice", {
    transcription: { api_key: key, enabled: true, max_session_seconds: 60 },
  });
  await sleep(300);
  await desktop.backend.bootstrap.refresh();
  const voice = desktop.backend.bootstrap.current()?.voice;
  const raw = desktop.backend.bootstrap.rawSection("voice") as
    | { transcription?: { path?: unknown; max_session_seconds?: unknown } }
    | undefined;
  check(
    !!voice?.available.transcription &&
      voice.transcription.maxSeconds ===
        raw?.transcription?.max_session_seconds,
    "bootstrap offers dictation with the session limit",
    `path ${String(raw?.transcription?.path)}, client maxSeconds ${voice?.transcription.maxSeconds}, service max_session_seconds ${String(raw?.transcription?.max_session_seconds)}`,
  );
  const service = providerService(desktop);
  const audio = dictationAudio(option("--voice-audio"));
  const usageBefore = await dictationUsage(admin, desktop);
  let transcribed = false;
  try {
    const started = await service.startDictation(
      voice?.transcription.maxSeconds ?? 60,
    );
    let progress = "";
    for (let offset = 0; offset < audio.length; offset += 6400) {
      const part = await service.dictationAudio(
        audio.subarray(offset, offset + 6400),
      );
      progress = part.text || part.partial || progress;
      await sleep(100);
    }
    const text = await service.finishDictation();
    transcribed = true;
    check(
      started.streaming && typeof text === "string",
      "dictation through /v1/audio/realtime/transcriptions",
      `${(audio.length / 32000).toFixed(1)} s of audio → "${text.slice(0, 120)}"${progress && !text ? ` (partial "${progress.slice(0, 60)}")` : ""}`,
    );
  } catch (error) {
    // The relay passes the realtime service's own refusal through; the
    // server log then shows upstream_rejected with its code (for example
    // MODEL_NOT_FOUND while the key has no streaming model).
    check(
      false,
      "dictation through /v1/audio/realtime/transcriptions",
      `${errorText(error)} (see the server log: claudex_audio.session_ended)`,
    );
  } finally {
    await service.close();
    // One probe per run: dictation goes back to how it was (the key stays stored).
    await admin.call("PUT", "/api/v1/admin/claudex/voice", {
      transcription: {
        enabled: originals.voice.transcription?.enabled === true,
      },
    });
  }
  await sleep(1500);
  const usageAfter = await dictationUsage(admin, desktop);
  check(
    transcribed ? usageAfter > usageBefore : usageAfter === usageBefore,
    transcribed
      ? "dictation usage recorded as realtime-transcription"
      : "a refused session is not billed",
    `${usageAfter - usageBefore} new realtime-transcription usage record(s)`,
  );
  const sessions = await admin.call<
    Page<{
      audio_bytes?: number;
      billed?: boolean;
      end_reason?: string;
      estimated_seconds?: number;
    }>
  >("GET", "/api/v1/admin/claudex/voice/estimated-usage?page_size=5");
  const last = sessions.items?.[0];
  note(
    "estimated sessions (upstream sent no duration)",
    last
      ? `${last.audio_bytes} bytes, ${last.estimated_seconds} s, billed ${last.billed}, ${last.end_reason}`
      : "none",
  );
}

/** The account's usage records of dictation (the newest 100). */
async function dictationUsage(admin: AdminApi, desktop: Desktop) {
  const logs = await admin.call<Page<{ model?: string }>>(
    "GET",
    `/api/v1/admin/usage?user_id=${desktop.session.userId}&page_size=100`,
  );
  return (logs.items ?? []).filter(
    (item) => item.model === "realtime-transcription",
  ).length;
}

async function cleanup(
  admin: AdminApi,
  originals: Originals,
  created: Created,
  userId: number,
) {
  section("Cleanup");
  const attempt = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      note(`cleanup: ${label}`, errorText(error));
    }
  };
  for (const id of created.rules)
    await attempt(`usage rule ${id}`, () =>
      admin.call("DELETE", `/api/v1/admin/claudex/usage-rules/${id}`),
    );
  for (const id of created.catalog)
    await attempt(`catalog entry ${id}`, () =>
      admin.call("DELETE", `/api/v1/admin/claudex/models/${id}`),
    );
  for (const id of created.diagnostics)
    await attempt(`diagnostic ${id}`, () =>
      admin.call("DELETE", `/api/v1/admin/claudex/diagnostics/${id}`),
    );
  for (const id of created.feedback)
    await attempt(`feedback ${id}`, () =>
      admin.call("DELETE", `/api/v1/admin/claudex/feedback/${id}`),
    );
  await attempt("payment config", () =>
    admin.call("PUT", "/api/v1/admin/payment/config", {
      enabled: originals.payment.enabled === true,
      enabled_payment_types: Array.isArray(
        originals.payment.enabled_payment_types,
      )
        ? originals.payment.enabled_payment_types
        : [],
    }),
  );
  if (created.paymentPlan)
    await attempt("payment plan", () =>
      admin.call(
        "DELETE",
        `/api/v1/admin/payment/plans/${created.paymentPlan}`,
      ),
    );
  if (created.paymentProvider)
    await attempt("payment provider", () =>
      admin.call(
        "DELETE",
        `/api/v1/admin/payment/providers/${created.paymentProvider}`,
      ),
    );
  const feedback = originals.feedback as {
    diagnostics?: { enabled?: boolean };
    feedback?: { enabled?: boolean; allow_conversation_excerpt?: boolean };
  };
  await attempt("feedback settings", () =>
    admin.call("PUT", "/api/v1/admin/claudex/feedback-settings", {
      diagnostics: { enabled: feedback.diagnostics?.enabled === true },
      feedback: {
        enabled: feedback.feedback?.enabled === true,
        allow_conversation_excerpt:
          feedback.feedback?.allow_conversation_excerpt === true,
      },
    }),
  );
  // The stored upstream key stays (encrypted, write-only); dictation goes back to how it was.
  await attempt("voice", () =>
    admin.call("PUT", "/api/v1/admin/claudex/voice", {
      transcription: {
        enabled: originals.voice.transcription?.enabled === true,
      },
    }),
  );
  await attempt("provisioning", () =>
    admin.call("PUT", "/api/v1/admin/claudex/provisioning", {
      user_api_keys_enabled:
        originals.provisioning.user_api_keys_enabled === true,
    }),
  );
  // Device keys of this run: revoked. User-created keys: deleted by the user after sign-in.
  await attempt("devices", () =>
    admin.call(
      "POST",
      `/api/v1/admin/claudex/users/${userId}/devices/revoke-all`,
      {},
    ),
  );
  note(
    "kept",
    `${prefix}-standard and ${prefix}-pro groups, ${prefix}-mock-upstream account, ${prefix}-pricing channel, ${prefix}-user@claudex.local with its subscription (named ${prefix}-*, reused next run); revoked device keys and cancelled orders cannot be deleted`,
  );
  if (created.userKeys.length) {
    // The run reset the password; set one more to delete the user-created keys as the user.
    const password = randomBytes(12).toString("hex");
    await attempt("user keys", async () => {
      await admin.call("PUT", `/api/v1/admin/users/${userId}`, { password });
      const root = path.join(workRoot, "cleanup");
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const accounts = new RemoteAccounts(
        root,
        baseUrl,
        cipher,
        recordingFetch,
      );
      const result = await accounts.login(
        `${prefix}-user@claudex.local`,
        password,
      );
      if (result.kind !== "signedIn") return;
      for (const id of created.userKeys)
        await result.session
          .authorized((value) => accounts.client.deleteKey(value, id))
          .catch((error: unknown) =>
            note(`cleanup: key ${id}`, errorText(error)),
          );
      await result.session.logout();
    });
  }
  check(
    true,
    "cleanup",
    `${created.rules.length} rule(s), ${created.catalog.length} catalog entr(ies), ${created.diagnostics.length + created.feedback.length} report(s), ${created.userKeys.length} key(s), payment provider and plan removed; settings restored`,
  );
}

// ---------------------------------------------------------------------------

try {
  if (!/^https?:\/\//.test(baseUrl))
    throw Error("Set CLAUDEX_URL to the Claudex server.");
  providerScript = path.join(workRoot, "provider-service.cjs");
  await build({
    entryPoints: [
      path.join(import.meta.dirname, "../server/provider-service.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: providerScript,
    logLevel: "silent",
  });
  await publicChecks();
  if (full) await fullRun();
  const differences = contractReport();
  note(
    "summary",
    `${failed ? "some checks FAILED" : "all checks passed"}; ${differences} fixture(s) differ from the service`,
  );
} catch (error) {
  failed = true;
  say(`FAIL  ${errorText(error)}`);
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
