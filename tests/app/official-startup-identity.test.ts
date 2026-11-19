import assert from "node:assert/strict";
import test from "node:test";
import {
  isChatStartupPath,
  readStartupIdentity,
  rememberStartupIdentity,
} from "../../src-web/official/startup-identity";

test("chat startup includes saved conversation links and excludes other surfaces", () => {
  for (const pathname of [
    "/",
    "/new",
    "/new/",
    "/chat/7ac58659-733b-4800-b246-23d4fe59b304",
    "/chat/local_thread/",
  ])
    assert.equal(isChatStartupPath(pathname), true, pathname);
  for (const pathname of [
    "/chat/",
    "/share/token",
    "/code",
    "/login",
    "/cowork/projects",
    "/chat/id/settings",
  ])
    assert.equal(isChatStartupPath(pathname), false, pathname);
});

test("frame identity is reused only after the same server-confirmed login session", () => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  const account = {
    uuid: "alice",
    settings: { locale: "zh-Hans", private_setting: "do-not-cache" },
    memberships: [
      {
        organization: {
          uuid: "12345678-1234-4234-8234-123456789012",
          capabilities: ["chat"],
        },
      },
    ],
    claudex_composer_layout_seed: "marlin",
    payment_details: "do-not-cache",
    feature_flags: { enabled: true },
  };
  const response = {
    status: 200,
    contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify(account)),
  };
  assert.equal(readStartupIdentity(storage, "alice-session-1"), undefined);
  rememberStartupIdentity(storage, "alice-session-1", response);
  assert.equal(readStartupIdentity(storage, "alice-session-1")?.uuid, "alice");
  assert.equal(readStartupIdentity(storage, "alice-session-2"), undefined);
  assert.equal(readStartupIdentity(storage, "bob-session-1"), undefined);
  assert.equal(readStartupIdentity(storage, undefined), undefined);
  assert.ok(![...values.values()].join().includes("do-not-cache"));
  assert.ok(![...values.values()].join().includes("feature_flags"));
  rememberStartupIdentity(storage, "bob-session-1", {
    ...response,
    status: 401,
  });
  assert.equal(readStartupIdentity(storage, "bob-session-1"), undefined);
  rememberStartupIdentity(storage, "bob-session-1", {
    ...response,
    body: new TextEncoder().encode("{}"),
  });
  assert.equal(readStartupIdentity(storage, "bob-session-1"), undefined);
});
