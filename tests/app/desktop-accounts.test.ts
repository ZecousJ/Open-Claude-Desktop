import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RemoteAccounts } from "../../electron/sub2api/identity";
import { remoteAccountId } from "../../electron/sub2api/identity-support";
import { ParkedSessions, SessionFile } from "../../electron/sub2api/session";
import type { RemoteSession } from "../../electron/sub2api/session";
import { registerRemoteAuthHandlers } from "../../electron/ipc/remote-auth";
import { needsSignInAgain, signInAgainCode } from "../../shared/sign-in-api";
import type { PublicAccount } from "../../shared/types";
import { MockSub2Api, fakeCipher } from "../support/sub2api-mock";

const alice = {
  id: 7,
  email: "alice@example.test",
  password: "alice-password",
  username: "Alice",
};
const bob = {
  id: 8,
  email: "bob@example.test",
  password: "bob-password",
  username: "Bob",
};

async function withMock(
  run: (mock: MockSub2Api, root: string) => Promise<void>,
) {
  const mock = new MockSub2Api({ users: [alice, bob] });
  await mock.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-accounts-"));
  try {
    await run(mock, root);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function signIn(accounts: RemoteAccounts, who: typeof alice) {
  const result = await accounts.login(who.email, who.password);
  if (result.kind !== "signedIn") throw Error("expected a sign-in");
  assert.ok(result.session.persist());
  return result;
}

/**
 * The remote sign-in handlers over a fake window: activate opens the
 * account, deactivate closes it (what electron/remote/host.ts does).
 */
function handlers(accounts: RemoteAccounts) {
  const state: {
    account?: PublicAccount;
    session?: RemoteSession;
    reloads: number;
  } = { reloads: 0 };
  const found = new Map<string, (...args: any[]) => any>();
  registerRemoteAuthHandlers((name, fn) => found.set(name, fn), {
    accounts,
    get activeAccount() {
      return state.account;
    },
    get session() {
      return state.session;
    },
    activate: async (session, account) => {
      state.session = session;
      state.account = account;
      return account;
    },
    deactivate: async () => {
      state.account = undefined;
      state.session = undefined;
    },
    reloadCaller: () => {
      state.reloads++;
    },
  });
  const call = (name: string, ...args: unknown[]) => found.get(name)!(...args);
  return { state, call };
}

test("Add account parks the open account; the new one opens beside it", async () => {
  await withMock(async (mock, root) => {
    const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
    const { state, call } = handlers(accounts);
    await call("loginAccount", alice.email, alice.password);
    const aliceId = remoteAccountId(mock.url, alice.id);
    assert.equal(state.account?.id, aliceId);
    const menu = await call("browserAccounts");
    assert.equal(menu.maxAccounts, 5);
    assert.equal(menu.current, aliceId);

    await call("addAccount");
    assert.equal(state.account, undefined);
    // The window that asked loads again, onto the sign-in page.
    assert.equal(state.reloads, 1);
    const status = await call("authStatus");
    assert.deepEqual(status.browserAccounts.adding, {});
    assert.equal(status.browserAccounts.current, aliceId);
    assert.equal(status.browserAccounts.accounts[0].signedIn, true);
    // Alice's session left the open file for her own.
    assert.equal(new SessionFile(root, fakeCipher).load(), undefined);
    assert.equal(
      new ParkedSessions(root, fakeCipher).load(aliceId)?.email,
      alice.email,
    );

    await call("loginAccount", bob.email, bob.password);
    const bobId = remoteAccountId(mock.url, bob.id);
    // (Read afresh: the handlers changed it.)
    assert.equal((state as { account?: PublicAccount }).account?.id, bobId);
    const both = await call("browserAccounts");
    assert.equal(both.adding, undefined);
    assert.deepEqual(
      both.accounts.map((account: { id: string; signedIn: boolean }) => [
        account.id,
        account.signedIn,
      ]),
      [
        [bobId, true],
        [aliceId, true],
      ],
    );
    // Each account holds its own refresh token on the service.
    assert.equal(mock.refreshTokens.size, 2);
  });
});

test("Switch account swaps the sessions without signing either out", async () => {
  await withMock(async (mock, root) => {
    const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
    const { state, call } = handlers(accounts);
    await call("loginAccount", alice.email, alice.password);
    await call("addAccount");
    await call("loginAccount", bob.email, bob.password);
    const aliceId = remoteAccountId(mock.url, alice.id);
    const bobId = remoteAccountId(mock.url, bob.id);

    const opened = await call("switchAccount", aliceId);
    assert.equal(opened.id, aliceId);
    assert.equal(state.account?.id, aliceId);
    assert.equal(new SessionFile(root, fakeCipher).load()?.accountId, aliceId);
    assert.equal(new ParkedSessions(root, fakeCipher).load(bobId)?.userId, 8);
    // A parked session no longer renews: its token belongs to the file.
    const open = state.session!;
    const record = await open.detach();
    assert.equal(record.accountId, aliceId);
    await assert.rejects(open.refresh(), /no longer open/);

    // A restart opens the account the window had.
    const restored = await new RemoteAccounts(
      root,
      mock.url,
      fakeCipher,
    ).restore();
    assert.equal(restored?.account.id, aliceId);
  });
});

test("an account whose session ended asks to sign in again", async () => {
  await withMock(async (mock, root) => {
    const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
    const { state, call } = handlers(accounts);
    await call("loginAccount", alice.email, alice.password);
    await call("addAccount");
    await call("loginAccount", bob.email, bob.password);
    const aliceId = remoteAccountId(mock.url, alice.id);
    // Alice logged out of all devices elsewhere.
    for (const [token, owner] of mock.refreshTokens)
      if (owner === alice.id) mock.refreshTokens.delete(token);

    const refusal = await call("switchAccount", aliceId).catch(
      (error: unknown) => error,
    );
    assert.ok(needsSignInAgain(refusal));
    assert.equal((refusal as Error).message, signInAgainCode);
    // Bob's window came back.
    assert.equal(state.account?.id, remoteAccountId(mock.url, bob.id));
    const list = await call("browserAccounts");
    const entry = list.accounts.find(
      (account: { id: string }) => account.id === aliceId,
    );
    assert.equal(entry.signedIn, false);
    assert.equal(entry.signInAgain, true);

    // Signing in to her again (Add account with her email) clears it.
    await call("addAccount", alice.email);
    assert.deepEqual((await call("authStatus")).browserAccounts.adding, {
      email: alice.email,
    });
    await call("loginAccount", alice.email, alice.password);
    const after = await call("browserAccounts");
    assert.equal(after.current, aliceId);
    assert.equal(
      after.accounts.every(
        (account: { signedIn: boolean }) => account.signedIn,
      ),
      true,
    );
  });
});

test("going back from Add account reopens the account; a restart does too", async () => {
  await withMock(async (mock, root) => {
    const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
    const { state, call } = handlers(accounts);
    await call("loginAccount", alice.email, alice.password);
    const aliceId = remoteAccountId(mock.url, alice.id);
    await call("addAccount");
    await call("cancelAddAccount");
    assert.equal(state.account?.id, aliceId);
    assert.equal((await call("browserAccounts")).adding, undefined);

    await call("addAccount");
    const restored = await new RemoteAccounts(
      root,
      mock.url,
      fakeCipher,
    ).restore();
    assert.equal(restored?.account.id, aliceId);
  });
});

test("Remove from this device signs a parked account out and forgets it", async () => {
  await withMock(async (mock, root) => {
    const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
    const { call } = handlers(accounts);
    await call("loginAccount", alice.email, alice.password);
    await call("addAccount");
    await call("loginAccount", bob.email, bob.password);
    const aliceId = remoteAccountId(mock.url, alice.id);
    await assert.rejects(
      call("forgetBrowserAccount", remoteAccountId(mock.url, bob.id)),
      /Log out/,
    );
    await call("forgetBrowserAccount", aliceId);
    assert.equal(new ParkedSessions(root, fakeCipher).load(aliceId), undefined);
    assert.equal(
      [...mock.refreshTokens.values()].includes(alice.id),
      false,
      "her refresh token was revoked",
    );
    const list = await call("browserAccounts");
    assert.deepEqual(
      list.accounts.map((account: { id: string }) => account.id),
      [remoteAccountId(mock.url, bob.id)],
    );
  });
});

test("Add account stops at five accounts, as the web does", async () => {
  await withMock(async (mock, root) => {
    const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
    const { call } = handlers(accounts);
    await call("loginAccount", alice.email, alice.password);
    const parked = new ParkedSessions(root, fakeCipher);
    for (let n = 0; n < 4; n++) {
      const id = `00000000-0000-5000-8000-00000000000${n}`;
      parked.save({
        version: 1,
        baseUrl: mock.url,
        accountId: id,
        userId: 100 + n,
        email: `u${n}@example.test`,
        refreshToken: `rt_${n}`,
      });
    }
    await assert.rejects(call("addAccount"), /up to 5 accounts/);
  });
});
