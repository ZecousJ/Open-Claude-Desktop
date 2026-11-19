import test from "node:test";
import assert from "node:assert/strict";
import { createOfficialReadFetch } from "../src-web/official/read-fetch";
import type { OfficialFrameAccount } from "../src-web/official/account-fetch";

const unexpected = async (): Promise<never> => { throw Error("Unexpected remote dispatch"); };
const account = (signOut: OfficialFrameAccount["signOut"]): OfficialFrameAccount => ({
  activeSessions: unexpected, endActiveSession: unexpected, browserAccounts: unexpected,
  switchAccount: unexpected, addAccount: unexpected, signOut,
});

test("original logout uses the browser session without dispatching an engine action", async () => {
  const scopes: string[] = [];
  const fetch = createOfficialReadFetch("https://fixture.invalid", unexpected, unexpected, undefined, unexpected,
    account(async scope => { scopes.push(scope); }));
  assert.equal((await fetch("/api/auth/logout", { method: "POST" })).status, 204);
  assert.equal((await fetch("/api/auth/logout/all-sessions", { method: "POST" })).status, 204);
  assert.deepEqual(scopes, ["current", "all"]);
});

test("logout failures remain visible to the original caller and aborted requests do not sign out", async () => {
  let calls = 0;
  const fetch = createOfficialReadFetch("https://fixture.invalid", unexpected, unexpected, undefined, undefined,
    account(async () => { calls++; throw Error("internal detail"); }));
  const failed = await fetch("/api/auth/logout", { method: "POST" });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(JSON.stringify(await failed.json()), /internal detail/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetch("/api/auth/logout", { method: "POST", signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
  const unavailable = createOfficialReadFetch("https://fixture.invalid", unexpected, unexpected);
  assert.equal((await unavailable("/api/auth/logout", { method: "POST" })).status, 501);
});
