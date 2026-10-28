/**
 * Checks Claudex's remote-mode client against a running Claudex server (the
 * Sub2API fork in backend/) with one user account, through the user routes
 * only, in a throwaway data directory. Prints results without tokens or keys.
 *
 *   CLAUDEX_SUB2API_URL=http://127.0.0.1:18080 SUB2API_EMAIL=… SUB2API_PASSWORD=… \
 *     npx tsx scripts/sub2api-live-check.ts [--full]
 *
 * Steps: public settings, sign-in and refresh rotation, `GET
 * /claudex/bootstrap`, the device registration as the app does it at sign-in
 * and `POST /claudex/devices` once more (idempotent: same key, not created,
 * moved or rotated), the account's device list, usage-status, the gateway's
 * /v1/models and /v1/usage with the device key, one Responses request
 * through the provider service child (--full), and at the end this device
 * leaves the account (`DELETE /claudex/devices/current`) and signs out.
 * --full is for an account whose plan has models and usage windows: it
 * requires them and the Responses request must complete.
 *
 * A server without the Claudex module (an unmodified Sub2API: `GET
 * /claudex/release` or the bootstrap answers 404) is reported as "not a
 * Claudex server" with exit code 2. The older client's key flow under
 * /api/v1/keys is not tried: legacy `claudex-desktop:<device>` keys are not
 * adopted by the service (owner decision 10). For the admin side and every
 * other scenario, see scripts/claudex-live-check.ts.
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 not a Claudex server.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { parseDeviceList } from "../shared/claudex-contract";
import type { GatewayRefusal } from "../server/sub2api-errors";
import { normalizeSub2ApiUrl } from "../server/sub2api-config";
import { ProviderCredentials } from "../electron/engine/provider-credentials";
import { ProviderServiceClient } from "../electron/engine/provider-service-client";
import { placeholderProvider } from "../electron/account/remote-mode";
import { RemoteBackend } from "../electron/sub2api/backend";
import {
  ClaudexUsageReader,
  fetchUsageStatus,
} from "../electron/sub2api/claudex-usage";
import { requestJson, Sub2ApiError } from "../electron/sub2api/http";
import { RemoteAccounts } from "../electron/sub2api/identity";
import { registerDevice } from "../electron/sub2api/provision";

const baseUrl = normalizeSub2ApiUrl(process.env.CLAUDEX_SUB2API_URL ?? "");
const email = process.env.SUB2API_EMAIL ?? "";
const password = process.env.SUB2API_PASSWORD ?? "";
const full = process.argv.includes("--full");
if (!email || !password)
  throw Error("Set SUB2API_EMAIL and SUB2API_PASSWORD for the test account.");

/** Exit code for a server without the Claudex module. */
const notClaudexExit = 2;
const notClaudex = (why: string) => {
  note(
    "not a Claudex server",
    `${why}. This check needs the Claudex fork of Sub2API (backend/); older desktop keys under /api/v1/keys are not used.`,
  );
  return notClaudexExit;
};

// A reversible stand-in for Electron safeStorage; the directory is deleted afterwards.
const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) =>
    Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x5a)),
  decryptString: (value: Buffer) =>
    Buffer.from(value.map((byte) => byte ^ 0x5a)).toString(),
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-sub2api-live-"));
const note = (step: string, value: string) => console.log(`${step}: ${value}`);
let failed = false;
let exitCode: number | undefined;
/**
 * Set once signed in: the device leaves the account and the session ends,
 * also when a check throws half-way (a registered device would otherwise
 * keep one of the account's device slots).
 */
let leave: (() => Promise<void>) | undefined;
const expect = (ok: boolean, step: string, value: string) => {
  if (!ok) failed = true;
  note(`${ok ? "ok" : "FAIL"} ${step}`, value);
};

async function check(): Promise<number | undefined> {
  const accounts = new RemoteAccounts(root, baseUrl, cipher);
  const policy = await accounts.policy();
  note(
    "public settings",
    policy.unavailable ??
      `registration ${policy.registrationEnabled ? "open" : "closed"}, captcha ${policy.captchaRequired ? "on" : "off"}`,
  );
  if ((await accounts.serviceKind()) !== "claudex")
    return notClaudex("GET /api/v1/claudex/release answered 404");
  note("service", "Claudex server (bootstrap and device registration)");

  const signIn = await accounts.login(email, password);
  if (signIn.kind !== "signedIn")
    throw Error("This account needs 2FA; use one without it for this check.");
  expect(true, "login", `user account ${signIn.account.id}`);
  signIn.session.persist();
  const restored = await new RemoteAccounts(root, baseUrl, cipher).restore();
  expect(
    restored?.account.id === signIn.account.id,
    "refresh rotation",
    "saved session restored with a rotated refresh token",
  );
  const session = restored!.session;
  const backend = new RemoteBackend(accounts, session, root);
  leave = async () => {
    leave = undefined;
    await session
      .authorized((token) =>
        accounts.client.revokeCurrentDevice(token, backend.deviceId),
      )
      .catch(() => {});
    await session.logout().catch(() => {});
  };

  // The bootstrap first: a server whose Claudex module is missing stops here.
  try {
    await session.authorized((token) =>
      requestJson(fetch, `${baseUrl}/api/v1/claudex/bootstrap`, {
        token,
        deviceId: backend.deviceId,
      }),
    );
  } catch (error) {
    if (error instanceof Sub2ApiError && error.status === 404)
      return notClaudex("GET /api/v1/claudex/bootstrap answered 404");
    throw error;
  }

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
  const credentials = new ProviderCredentials(root, script, cipher);
  await credentials.initialize([placeholderProvider(accounts)]);
  // Sign-in as the app does it: bootstrap, then POST /claudex/devices.
  const provider = await backend.prepare(credentials);
  note(
    "plan",
    `${backend.plan?.name} (group ${backend.plan?.groupId}, ${backend.plan?.platform}, ${backend.plan?.subscribed ? "subscription" : "balance"}) → ${provider.protocol}`,
  );
  // A second load of the same sign-in registers nothing more.
  await backend.prepare(credentials);
  const boot = backend.bootstrap.current();
  expect(
    !!boot?.device?.registered && boot.features.deviceKeys,
    "GET /claudex/bootstrap",
    boot
      ? `schema ${boot.schemaVersion}, release ${boot.release?.state ?? "?"}, voice ${boot.voice?.available.transcription ? "on" : "off"}, section errors ${boot.errors.length}`
      : "none",
  );

  // POST /claudex/devices again: the service answers with the same key.
  const again = await registerDevice(
    accounts.client,
    session,
    backend.deviceId,
  );
  expect(
    !again.created &&
      !again.moved &&
      !again.rotated &&
      again.device.id === boot?.device?.id,
    "POST /claudex/devices (again)",
    `same device and key: created ${again.created}, moved ${again.moved}, rotated ${again.rotated}, device ${again.device.id === boot?.device?.id ? "unchanged" : "changed"}`,
  );
  const vaultKey = await credentials.remote(provider, "models");
  const returnedKey = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${again.apiKey?.key}` },
  });
  expect(
    vaultKey.status === returnedKey.status,
    "one device key",
    `the stored key and the key returned again both answer HTTP ${returnedKey.status} on /v1/models`,
  );

  const devices = parseDeviceList(
    await session.authorized((token) =>
      requestJson(fetch, `${baseUrl}/api/v1/claudex/devices`, {
        token,
        deviceId: backend.deviceId,
      }),
    ),
  );
  const active = devices.items.filter((item) => !item.revoked);
  expect(
    active.filter((item) => item.current).length === 1,
    "GET /claudex/devices",
    `this device listed once; ${active.length} active device(s) of ${devices.limit}`,
  );
  const reader = new ClaudexUsageReader(
    () =>
      session.authorized((token) =>
        fetchUsageStatus(baseUrl, token, { deviceId: backend.deviceId }),
      ),
    () => backend.bootstrap.current()?.features.usageStatus,
  );
  const status = await reader.status(true);
  const windows = status?.windows ?? [];
  const summary =
    windows
      .map(
        (item) =>
          `${item.label} ${item.percent}%${item.exceeded ? " (reached)" : ""}`,
      )
      .join(", ") || "no windows";
  if (full) expect(!!windows.length, "GET /claudex/usage-status", summary);
  else note("GET /claudex/usage-status", summary);

  if (full)
    expect(
      provider.models.length > 0,
      "GET /v1/models",
      `${provider.models.length} model(s): ${provider.models.slice(0, 5).join(", ")}`,
    );
  else
    note(
      "GET /v1/models",
      backend.problem
        ? `refused (${backend.problem.code}): ${backend.problem.message}`
        : `${provider.models.length} model(s)`,
    );
  const usage = await credentials.remote(provider, "usage");
  note("GET /v1/usage", `HTTP ${usage.status}`);
  if (full && provider.model) {
    const refusals: GatewayRefusal[] = [];
    const service = new ProviderServiceClient(
      script,
      root,
      provider,
      "",
      credentials.vaultKey,
      root,
      undefined,
      undefined,
      (refusal) => refusals.push(refusal),
    );
    try {
      await service.start();
      const response = await fetch(`${service.url}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${service.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: provider.model,
          input: "Reply with OK.",
          stream: true,
        }),
      });
      const text = await response.text();
      expect(
        response.ok && /response\.completed/.test(text),
        "gateway request",
        `HTTP ${response.status}${refusals[0] ? `, ${refusals[0].message}` : ""}`,
      );
    } finally {
      await service.close();
    }
  } else if (full)
    expect(false, "gateway request", "the plan names no model to send to");

  // This check's device is temporary: it leaves the account again.
  leave = undefined;
  const left = await session.authorized((token) =>
    accounts.client.revokeCurrentDevice(token, backend.deviceId),
  );
  expect(
    left.revoked,
    "DELETE /claudex/devices/current",
    "this device left the account; its key is off",
  );
  await session.logout().catch(() => {});
  note("logout", "refresh token revoked");
  return undefined;
}

try {
  exitCode = await check();
} catch (error) {
  failed = true;
  note("FAIL", error instanceof Error ? error.message : String(error));
} finally {
  await leave?.();
  fs.rmSync(root, { recursive: true, force: true });
}
process.exitCode = exitCode ?? (failed ? 1 : 0);
