import test from "node:test";
import assert from "node:assert/strict";
import { createPasskeyMethods } from "../../src-web/bridge/account-passkeys";

test("the web's passkey row reads the service's switch and list, and sets one up after the password", async () => {
  const calls: [string, string, unknown][] = [];
  let enabled = true;
  const transport = {
    json: async (path: string, init: RequestInit = {}) => {
      calls.push([
        path,
        init.method ?? "GET",
        init.body ? JSON.parse(String(init.body)) : undefined,
      ]);
      if (path === "/api/v1/settings/public")
        return { code: 0, data: { passkey_enabled: enabled } };
      if (path === "/api/v1/user/passkeys")
        return { code: 0, data: [{ id: 1 }, { id: 2 }] };
      if (path.endsWith("/register/begin"))
        return { code: 0, data: { session_token: "s1", options: { o: 1 } } };
      return { code: 0, data: {} };
    },
  };
  const made: unknown[] = [];
  const methods = createPasskeyMethods(transport, {
    passkeyCreate: async (options) => {
      made.push(options);
      return { id: "cred" };
    },
  });
  assert.deepEqual(await methods.accountPasskeys(), { count: 2 });
  enabled = false;
  assert.equal(await methods.accountPasskeys(), null);
  calls.length = 0;
  await methods.setUpPasskey("secret");
  assert.deepEqual(made, [{ o: 1 }]);
  assert.deepEqual(calls, [
    ["/api/v1/user/passkeys/register/begin", "POST", { password: "secret" }],
    [
      "/api/v1/user/passkeys/register/finish",
      "POST",
      { session_token: "s1", credential: { id: "cred" } },
    ],
  ]);
  // A browser without passkeys has no row.
  assert.equal(
    await createPasskeyMethods(transport, {}).accountPasskeys(),
    null,
  );
});
