import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RemoteAccounts } from "../../electron/sub2api/identity";
import { remoteAccountId } from "../../electron/sub2api/identity-support";
import { SessionFile } from "../../electron/sub2api/session";
import { desktopCredentialStorage } from "../../electron/account/desktop-credential-storage";
import { MockSub2Api, fakeCipher } from "../support/sub2api-mock";

const alice = {
  id: 7,
  email: "alice@example.test",
  password: "alice-password",
  username: "Alice",
};

async function withMock(
  options: ConstructorParameters<typeof MockSub2Api>[0],
  run: (mock: MockSub2Api, root: string) => Promise<void>,
) {
  const mock = new MockSub2Api(options);
  await mock.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-sub2api-"));
  try {
    await run(mock, root);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("sign-in keeps only an encrypted, rotating refresh token", async () => {
  await withMock({ users: [alice] }, async (mock, root) => {
    const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
    const result = await accounts.login(alice.email, alice.password);
    assert.equal(result.kind, "signedIn");
    if (result.kind !== "signedIn") return;
    assert.equal(result.account.id, remoteAccountId(mock.url, 7));
    assert.equal(result.account.name, "Alice");
    assert.equal(result.account.remote, true);
    assert.ok(result.session.persist());
    const file = path.join(root, "remote-session.enc");
    const first = new SessionFile(root, fakeCipher).load()!.refreshToken;
    assert.ok(first.startsWith("rt_"));
    // Encrypted at rest: no token or email in the file bytes.
    assert.doesNotMatch(fs.readFileSync(file, "latin1"), /rt_|alice@/);

    // A restart restores the session, rotating the refresh token on disk.
    const restored = await new RemoteAccounts(
      root,
      mock.url,
      fakeCipher,
    ).restore();
    assert.equal(restored?.account.id, result.account.id);
    const second = new SessionFile(root, fakeCipher).load()!.refreshToken;
    assert.notEqual(second, first);
    assert.equal(mock.refreshTokens.has(first), false);

    // The access token expired: the next call refreshes once and succeeds.
    mock.expireAccessTokens();
    const me = await restored!.session.authorized((token) =>
      accounts.client.me(token),
    );
    assert.equal(me.id, 7);
    const third = new SessionFile(root, fakeCipher).load()!.refreshToken;
    assert.notEqual(third, second);

    await restored!.session.logout();
    assert.equal(fs.existsSync(file), false);
    assert.equal(mock.refreshTokens.has(third), false);
  });
});

test("account ids are stable per service and user, and distinct across hosts", () => {
  const a = remoteAccountId("https://one.example", 1);
  assert.equal(a, remoteAccountId("https://one.example", 1));
  assert.notEqual(a, remoteAccountId("https://two.example", 1));
  assert.notEqual(a, remoteAccountId("https://one.example", 2));
  assert.match(
    a,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("macOS signs in and restores from a private local directory without calling OS storage", async () => {
  await withMock({ users: [alice] }, async (mock, root) => {
    const oldAccounts = new RemoteAccounts(root, mock.url, fakeCipher);
    const oldLogin = await oldAccounts.login(alice.email, alice.password);
    assert.equal(oldLogin.kind, "signedIn");
    assert.ok(oldLogin.session.persist());
    const oldFile = oldAccounts.file.filename;
    const oldBytes = fs.readFileSync(oldFile);
    const unavailable = () => assert.fail("Unexpected Keychain access");
    const osCipher = {
      isEncryptionAvailable: unavailable,
      encryptString: unavailable,
      decryptString: unavailable,
    };
    const accounts = () => {
      const storage = desktopCredentialStorage(root, "darwin", osCipher);
      return new RemoteAccounts(
        root,
        mock.url,
        storage.cipher,
        undefined,
        undefined,
        storage.root,
      );
    };
    const local = accounts();
    assert.equal(await local.restore(), undefined);
    const signedIn = await local.login(alice.email, alice.password);
    assert.equal(signedIn.kind, "signedIn");
    assert.ok(signedIn.session.persist());
    assert.equal(signedIn.account.id, oldLogin.account.id);
    const firstToken = local.file.load()!.refreshToken;
    const directory = path.dirname(local.file.filename);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, "storage.key")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(local.file.filename).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(local.file.filename).includes(firstToken), false);
    assert.equal(await accounts().restore().then(result => result?.account.id), signedIn.account.id);
    assert.notEqual(local.file.load()!.refreshToken, firstToken);
    assert.deepEqual(fs.readFileSync(oldFile), oldBytes);
  });
});

test("a refused saved session is removed, a wrong password is explained", async () => {
  await withMock({ users: [alice] }, async (mock, root) => {
    const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
    await assert.rejects(accounts.login(alice.email, "nope"), {
      message: "Email or password is incorrect.",
    });
    const result = await accounts.login(alice.email, alice.password);
    if (result.kind !== "signedIn") throw Error("expected sign-in");
    result.session.persist();
    mock.refreshTokens.clear();
    await assert.rejects(accounts.restore(undefined, "startup"));
    assert.equal(new SessionFile(root, fakeCipher).load(), undefined);
    assert.equal(accounts.signedOutReason, "session-expired");
    const again = await accounts.login(alice.email, alice.password);
    assert.equal(again.kind, "signedIn");
    assert.equal(accounts.signedOutReason, undefined);
  });
});

test("a temporary refresh failure keeps the saved account available for retry", async () => {
  await withMock({ users: [alice] }, async (mock, root) => {
    let offline = false;
    const accounts = new RemoteAccounts(root, mock.url, fakeCipher, (input, init) =>
      offline && String(input).endsWith("/auth/refresh")
        ? Promise.reject(Error("Fixture offline"))
        : fetch(input, init),
    );
    const signIn = await accounts.login(alice.email, alice.password);
    assert.equal(signIn.kind, "signedIn");
    assert.ok(signIn.session.persist());
    offline = true;
    await assert.rejects(accounts.restore());
    assert.equal(accounts.restorePending, true);
    assert.equal(accounts.file.load()?.accountId, signIn.account.id);
    assert.equal(accounts.signedOutReason, undefined);
    const cached = await accounts.restore(undefined, "startup");
    assert.equal(cached?.offline, true);
    assert.deepEqual(cached?.account, signIn.account);
    offline = false;
    assert.equal((await accounts.restore())?.account.id, signIn.account.id);
    assert.equal(accounts.restorePending, false);
  });
});

test("2FA: the challenge stays in the main process until the code is right", async () => {
  await withMock(
    { users: [{ ...alice, totp: "123456" }], settings: { totp_enabled: true } },
    async (mock, root) => {
      const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
      const first = await accounts.login(alice.email, alice.password);
      assert.deepEqual(first, {
        kind: "twoFactor",
        maskedEmail: "u***@example.test",
      });
      assert.equal(accounts.pendingTwoFactor, true);
      await assert.rejects(accounts.completeTwoFactor("12"), {
        message: "Enter the 6-digit code from your authenticator app.",
      });
      await assert.rejects(accounts.completeTwoFactor("000000"), {
        message: "That code didn\u2019t match. Check it and try again.",
      });
      const done = await accounts.completeTwoFactor("123456");
      assert.equal(done.kind, "signedIn");
      assert.equal(accounts.pendingTwoFactor, false);
    },
  );
});

test("2FA: a step the service forgot says to start again and is dropped", async () => {
  await withMock(
    { users: [{ ...alice, totp: "123456" }], settings: { totp_enabled: true } },
    async (mock, root) => {
      const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
      await accounts.login(alice.email, alice.password);
      (
        mock as unknown as { pending2fa: Map<string, number> }
      ).pending2fa.clear();
      await assert.rejects(accounts.completeTwoFactor("123456"), {
        message: "This sign-in expired. Start again to get a new code.",
      });
      assert.equal(accounts.pendingTwoFactor, false);
      await assert.rejects(accounts.completeTwoFactor("123456"), {
        message: "This sign-in expired. Start again to get a new code.",
      });
    },
  );
});

test("registration follows the public settings", async () => {
  await withMock({ users: [] }, async (mock, root) => {
    const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
    assert.equal((await accounts.policy()).registrationEnabled, false);
    await assert.rejects(accounts.register("new@example.test", "secret1"), {
      message: "Registration is closed on this Claudex service.",
    });
    assert.equal(mock.calls.includes("POST /api/v1/auth/register"), false);

    mock.options.settings = {
      registration_enabled: true,
      invitation_code_enabled: true,
      promo_code_enabled: false,
      registration_email_suffix_whitelist: ["example.test"],
    };
    const policy = await accounts.policy();
    assert.deepEqual(
      [policy.registrationEnabled, policy.invitationCode, policy.promoCode],
      [true, true, false],
    );
    assert.deepEqual(policy.emailDomains, ["example.test"]);
    await assert.rejects(accounts.register("new@example.test", "secret1"), {
      message: "Enter your invitation code.",
    });
    await assert.rejects(
      accounts.register("new@example.test", "secret1", {
        invitationCode: "WRONG",
      }),
      { message: "That invitation code is invalid or already used." },
    );
    const created = await accounts.register("new@example.test", "secret1", {
      invitationCode: "INVITE-1",
    });
    assert.equal(created.kind, "signedIn");
    assert.equal(accounts.hasAccounts, true);
  });
});

test("an unreachable service is reported, not treated as closed registration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-sub2api-"));
  try {
    const accounts = new RemoteAccounts(root, "http://127.0.0.1:9", fakeCipher);
    const policy = await accounts.policy();
    assert.equal(
      policy.unavailable,
      "The Claudex service is unreachable. Check your connection.",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
