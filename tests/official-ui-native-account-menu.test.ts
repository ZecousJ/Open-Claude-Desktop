import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createNativeAccountApi } from "../electron/official-ui/api/native-account-api";
import type { AdapterContext } from "../electron/official-ui/api/context";
import { createOfficialActivationLease } from "../electron/official-ui/activation-lease";
import { authorizeRetiredTerminalResponse } from "../electron/official-ui/response-lease";
import { startOfficialUiServer } from "../electron/official-ui/server";
import { createRunnerOfficialAdapter } from "../runner/src/official-ui-adapter";
import { defaultGuardOptions } from "../runner/src/method-guard";
import type { BrowserAccounts } from "../shared/sign-in-api";

const alpha = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "a@fixture.local",
  name: "Alpha",
};
const beta = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "b@fixture.local",
  name: "Beta",
};
const ended = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "c@fixture.local",
  name: "Ended",
};
const remembered = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "d@fixture.local",
  name: "Remembered",
};

test("native account routes project the browser accounts and bind a switch to its retired response", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-native-account-menu-"),
  );
  fs.mkdirSync(path.join(root, "ui"));
  fs.writeFileSync(path.join(root, "ui", "index.html"), "test");
  const identity = { owner: alpha.id, store: {}, generation: 1, active: true };
  const lease = createOfficialActivationLease(identity, () => identity);
  const calls: [string, unknown][] = [];
  let capability = true;
  const source: BrowserAccounts = {
    current: alpha.id,
    maxAccounts: 5,
    accounts: [
      { ...alpha, signedIn: true },
      { ...beta, signedIn: true },
      { ...ended, signedIn: false, signInAgain: true },
      { ...remembered, signedIn: false },
    ],
  };
  const ctx = {
    root,
    account: () => alpha,
    sessionIdentity: () => identity,
    isCurrent: () => lease.current(),
    browserAccountsAvailable: () => capability,
    stateDirectory: () => root,
    log() {},
    async call(method, target) {
      calls.push([method, target]);
      if (method === "browserAccounts") return source;
      assert.equal(method, "switchAccount");
      assert.equal(target, beta.id);
      const complete = authorizeRetiredTerminalResponse(lease, method, target);
      lease.retire();
      complete?.(true, beta);
      return beta;
    },
  } satisfies Pick<
    AdapterContext,
    | "root"
    | "account"
    | "sessionIdentity"
    | "isCurrent"
    | "browserAccountsAvailable"
    | "stateDirectory"
    | "log"
    | "call"
  >;
  const server = await startOfficialUiServer({
    root,
    isCurrent: () => lease.current(),
    responseLease: lease,
    api: createNativeAccountApi(ctx as AdapterContext),
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (route: string, method = "GET", body?: string) =>
    fetch(server.origin.replace("localhost", "127.0.0.1") + route, {
      method,
      body,
      headers: {
        Cookie: `claudex_official_ui=${server.token}`,
        Connection: "close",
      },
    });
  const list = await request("/api/auth/accounts");
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), {
    max_accounts: 5,
    accounts: [
      {
        handle: alpha.id,
        account_uuid: alpha.id,
        email_address: alpha.email,
        full_name: alpha.name,
        avatar_url: null,
        active: true,
        state: "signed_in",
      },
      {
        handle: beta.id,
        account_uuid: beta.id,
        email_address: beta.email,
        full_name: beta.name,
        avatar_url: null,
        active: false,
        state: "signed_in",
      },
      {
        handle: ended.id,
        account_uuid: ended.id,
        email_address: ended.email,
        full_name: ended.name,
        avatar_url: null,
        active: false,
        state: "sign_in_again",
      },
    ],
  });
  const activate = (id: string, body = JSON.stringify({ handle: id })) =>
    request(`/api/auth/accounts/${id}/activate`, "POST", body);
  assert.equal((await activate(remembered.id)).status, 404);
  assert.equal((await activate(ended.id)).status, 401);
  assert.equal(
    (await activate(beta.id, JSON.stringify({ handle: alpha.id }))).status,
    400,
  );
  source.maxAccounts = 3;
  assert.equal(
    (await request("/api/auth/accounts/add-intent", "POST")).status,
    409,
  );
  capability = false;
  assert.equal((await request("/api/auth/accounts")).status, 501);
  capability = true;
  assert.equal(
    calls.some(
      ([method]) => method === "switchAccount" || method === "addAccount",
    ),
    false,
  );

  const response = await activate(beta.id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { account: { uuid: beta.id } });
  assert.equal((await request("/api/auth/accounts")).status, 410);
  assert.equal(
    calls.filter(([method]) => method === "switchAccount").length,
    1,
  );
});

test("guarded Web runner refuses native account inventory and mutations before dispatch", async () => {
  const root = os.tmpdir();
  let calls = 0;
  const runner = createRunnerOfficialAdapter(
    {
      account: () => alpha,
      settings() {
        throw Error("Settings were not requested.");
      },
      sessionIdentity: () => alpha.id,
      stateDirectory: () => root,
      onEvent: () => () => {},
      appVersion: "fixture",
      log() {},
    },
    async () => {
      calls++;
      throw Error("Native account operation reached Runner dispatch.");
    },
    root,
    defaultGuardOptions,
    { allowTextActions: true },
  );
  for (const [method, path] of [
    ["GET", "/api/auth/accounts"],
    ["POST", "/api/auth/accounts/add-intent"],
    ["POST", `/api/auth/accounts/${beta.id}/activate`],
  ] as const)
    assert.equal((await runner({ method, path })).status, 501);
  assert.equal(calls, 0);
});
