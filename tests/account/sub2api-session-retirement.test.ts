import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { registerRemoteAuthHandlers } from "../../electron/ipc/remote-auth";
import { RemoteAccounts } from "../../electron/sub2api/identity";
import { MockSub2Api, fakeCipher } from "../support/sub2api-mock";

const user = {
  id: 11,
  email: "refresh-race@example.invalid",
  password: "fixture-password",
};

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function pendingRotation(t: TestContext) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-refresh-"));
  const service = new MockSub2Api({ users: [user] });
  await service.start();

  const rotated = deferred();
  const deliver = deferred();
  t.after(async () => {
    deliver.resolve();
    await service.close();
    fs.rmSync(profile, { recursive: true, force: true });
  });
  const transport: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).endsWith("/auth/refresh")) {
      assert.equal(response.status, 200);
      rotated.resolve();
      await deliver.promise;
    }
    return response;
  };

  const accounts = new RemoteAccounts(
    profile,
    service.url,
    fakeCipher,
    transport,
  );
  const signIn = await accounts.login(user.email, user.password);
  assert.equal(signIn.kind, "signedIn");
  const session = signIn.session;
  assert.equal(session.persist(), true);
  const saved = accounts.file.load();
  assert.ok(saved);
  const pending = session.refresh();
  void pending.catch(rotated.reject);
  const refreshing = Promise.allSettled([pending]);
  await rotated.promise;
  assert.equal(service.refreshTokens.has(saved.refreshToken), false);
  assert.equal(service.refreshTokens.size, 1);
  return {
    accounts,
    deliver,
    refreshing,
    saved,
    service,
    session,
    account: signIn.account,
  };
}

test("logout revokes the latest issued refresh token and clears the saved session", async (t) => {
  const { accounts, deliver, refreshing, service, session } =
    await pendingRotation(t);
  const loggingOut = session.logout();
  deliver.resolve();
  await Promise.all([refreshing, loggingOut]);
  assert.equal(service.refreshTokens.size, 0);
  assert.equal(accounts.file.load() !== undefined, false);
});

test("overlapping logout actions still end the active session", async (t) => {
  const { account, accounts, deliver, refreshing, service, session } =
    await pendingRotation(t);
  let active = true;
  let logout: (() => Promise<unknown>) | undefined;
  registerRemoteAuthHandlers(
    (method, call) => {
      if (method === "logoutAccount") logout = call;
    },
    {
      accounts,
      get activeAccount() {
        return active ? account : undefined;
      },
      get session() {
        return active ? session : undefined;
      },
      activate: async () => account,
      deactivate: async () => {
        active = false;
      },
    },
  );
  assert.ok(logout);
  const logouts = Promise.allSettled([logout(), logout()]);
  deliver.resolve();
  const [results] = await Promise.all([logouts, refreshing]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  assert.equal(active, false);
  assert.equal(service.refreshTokens.size, 0);
});

test("force-ending an account leaves no saved session after its pending refresh completes", async (t) => {
  const { accounts, deliver, refreshing, session } = await pendingRotation(t);
  session.end();
  deliver.resolve();
  await refreshing;
  assert.equal(accounts.file.load() !== undefined, false);
});

test("an ended session cannot overwrite or clear a replacement account's saved session", async (t) => {
  const { accounts, deliver, refreshing, saved, session } =
    await pendingRotation(t);
  session.end();
  const replacement = {
    ...saved,
    accountId: "8ee65e7e-6402-4f00-858c-3abb2ac5572c",
    userId: 22,
    email: "replacement@example.invalid",
    refreshToken: "fixture-replacement",
  };
  accounts.file.save(replacement);
  deliver.resolve();
  await refreshing;
  assert.equal(accounts.file.load()?.accountId, replacement.accountId);
  session.end();
  assert.equal(accounts.file.load()?.accountId, replacement.accountId);
});

test("parking waits for rotation and retains a refresh token the service accepts", async (t) => {
  const { accounts, deliver, refreshing, saved, session } =
    await pendingRotation(t);
  const parking = accounts.park(session);
  deliver.resolve();
  await Promise.all([refreshing, parking]);
  assert.equal(accounts.file.load() !== undefined, false);
  const resumed = await accounts.resume(saved.accountId);
  assert.equal(resumed.account.id, saved.accountId);
});
