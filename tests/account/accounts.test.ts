import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Accounts, importLegacyProfile } from "../../electron/account/accounts";
import { RemoteAccounts } from "../../electron/sub2api/identity";
import { fakeCipher } from "../support/sub2api-mock";

test("deleted remote accounts are forgotten and their cached profile is erased", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-delete-remote-"));
  const id = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  try {
    const profile = path.join(root, "profiles", id);
    const kept = path.join(root, "profiles", other);
    fs.mkdirSync(profile, { recursive: true });
    fs.mkdirSync(kept, { recursive: true });
    fs.writeFileSync(path.join(profile, "settings.json"), "private");
    const accounts = new RemoteAccounts(
      root,
      "https://service.example",
      fakeCipher,
    );
    await accounts.removeDeleted(id);
    assert.equal(fs.existsSync(profile), false);
    assert.equal(fs.existsSync(kept), true);
    await assert.rejects(accounts.removeDeleted("../"), /Unknown account/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session-authorized deletion revokes sessions and removes only that account's profile", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-delete-account-"),
  );
  try {
    const accounts = new Accounts(root);
    const alice = await accounts.register(
      "alice@example.com",
      "correct horse battery",
      "Alice",
    );
    const bob = await accounts.register(
      "bob@example.com",
      "another long password",
      "Bob",
    );
    const profile = accounts.profileRoot(alice.account.id);
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "private.txt"), "private");
    accounts.removeSignedIn(alice.account.id);
    assert.equal(accounts.session(alice.token), undefined);
    assert.equal(accounts.session(bob.token)?.id, bob.account.id);
    assert.equal(fs.existsSync(profile), false);
    assert.throws(
      () => accounts.removeSignedIn(alice.account.id),
      /Unknown account/,
    );
    assert.equal(new Accounts(root).session(alice.token), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("accounts persist password hashes, isolate profile roots and revoke sessions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-accounts-"));
  let now = 1000;
  try {
    const accounts = new Accounts(root, () => now);
    assert.equal(accounts.hasAccounts, false);
    const alice = await accounts.register(
      "  Alice@Example.com  ",
      "correct horse battery",
      "Alice",
    );
    const bob = await accounts.register(
      "bob@example.com",
      "another long password",
      "Bob",
    );
    assert.equal(accounts.hasAccounts, true);
    assert.equal(alice.account.email, "alice@example.com");
    assert.notEqual(
      accounts.profileRoot(alice.account.id),
      accounts.profileRoot(bob.account.id),
    );
    const data = fs.readFileSync(path.join(root, "accounts.json"), "utf8");
    assert.doesNotMatch(
      data,
      /correct horse battery|another long password|"token"/,
    );
    assert.equal(accounts.session(alice.token)?.id, alice.account.id);
    assert.equal(accounts.session(bob.token)?.id, bob.account.id);
    const reopened = new Accounts(root, () => now);
    const second = await reopened.login(
      "ALICE@example.com",
      "correct horse battery",
    );
    assert.notEqual(second.token, alice.token);
    assert.equal(second.account.id, alice.account.id);
    reopened.logout(alice.token);
    assert.equal(reopened.session(alice.token), undefined);
    assert.equal(reopened.session(second.token)?.id, alice.account.id);
    now += 31 * 24 * 60 * 60 * 1000;
    assert.equal(reopened.session(second.token), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid credentials are rate limited and corrupt account records are preserved", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-accounts-"));
  let now = 1000;
  try {
    const accounts = new Accounts(root, () => now);
    await accounts.register(
      "fixture@example.com",
      "safe test password",
      "Fixture",
    );
    await assert.rejects(
      () =>
        accounts.register("FIXTURE@example.com", "safe test password", "Other"),
      /already exists/,
    );
    for (let i = 0; i < 5; i++)
      await assert.rejects(
        () => accounts.login("fixture@example.com", "wrong password"),
        /incorrect/,
      );
    await assert.rejects(
      () => accounts.login("fixture@example.com", "safe test password"),
      /Too many/,
    );
    now += 16 * 60 * 1000;
    assert.equal(
      (await accounts.login("fixture@example.com", "safe test password"))
        .account.name,
      "Fixture",
    );
    const filename = path.join(root, "accounts.json");
    fs.writeFileSync(filename, "{broken");
    assert.throws(() => new Accounts(root), /cannot be read/);
    assert.equal(fs.readFileSync(filename, "utf8"), "{broken");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy migration copies known files only once and leaves original data untouched", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-accounts-"));
  try {
    fs.writeFileSync(
      path.join(root, "conversations.json"),
      '["old synthetic"]',
    );
    fs.writeFileSync(path.join(root, "settings.json"), '{"name":"Legacy"}');
    const profile = path.join(root, "profiles", "fixture");
    assert.equal(importLegacyProfile(root, profile), true);
    assert.equal(
      fs.readFileSync(path.join(profile, "conversations.json"), "utf8"),
      '["old synthetic"]',
    );
    fs.writeFileSync(
      path.join(profile, "settings.json"),
      '{"name":"Newer account setting"}',
    );
    fs.rmSync(path.join(profile, "conversations.json"));
    importLegacyProfile(root, profile);
    assert.equal(
      fs.readFileSync(path.join(profile, "settings.json"), "utf8"),
      '{"name":"Newer account setting"}',
    );
    assert.equal(
      fs.existsSync(path.join(profile, "conversations.json")),
      false,
    );
    assert.equal(
      fs.readFileSync(path.join(root, "settings.json"), "utf8"),
      '{"name":"Legacy"}',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
