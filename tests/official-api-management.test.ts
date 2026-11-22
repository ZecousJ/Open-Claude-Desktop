import assert from "node:assert/strict";
import test from "node:test";
import { maskedKey, type ApiKey } from "../shared/api-keys-api";
import type { ApiManagement } from "../shared/official-api-management";
import { createOfficialReadFetch } from "../src-web/official/read-fetch";

const prefix = "/api/claudex/api-management/";
const origin = "http://localhost";
const firstKey: ApiKey = {
  id: 1, name: "Deployment", key: "sk-api-management-test-secret", groupId: 4,
  groupName: "OpenAI", status: "active", createdAt: null, lastUsedAt: null,
};

function fixture() {
  let current = true;
  let key: ApiKey | undefined = firstKey;
  let deletions = 0;
  const unused = async () => { throw Error("Unexpected request outside the API management surface."); };
  const api: ApiManagement = {
    balance: async () => 0,
    apiKeys: async () => key ? [key] : [],
    createApiKey: async () => {
      throw Object.assign(Error("Verify your email to continue."), {
        status: 403,
        code: "action_verification_required",
        details: { action_label: "Create an API key" },
      });
    },
    deleteApiKey: async () => { deletions++; key = undefined; },
    groupRates: async () => ({ 4: 0 }),
    apiGroups: unused,
    setApiGroup: unused,
    sendActionVerification: unused,
    confirmActionVerification: unused,
  };
  const request = createOfficialReadFetch(origin, unused, unused,
    undefined, undefined, undefined, undefined, undefined, undefined,
    { api, current: () => current });
  return { api, request, retire: () => { current = false; }, deletions: () => deletions };
}

test("API keys are masked in the list and copied only on explicit request", async () => {
  const { request } = fixture();
  const list = await request(prefix + "keys");
  assert.equal(list.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await list.json(), [{ ...firstKey, key: maskedKey(firstKey.key) }]);
  assert.equal((await request(prefix + "keys/1/copy")).status, 404);
  assert.deepEqual(await (await request(prefix + "keys/1/copy", { method: "POST" })).json(), { key: firstKey.key });
  assert.deepEqual(await (await request(prefix + "rates")).json(), { 4: 0 });
  const balance = await request(prefix + "balance");
  assert.equal(balance.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await balance.json(), { balance: 0 });
  assert.equal((await request(prefix + "keys/1", { method: "DELETE" })).status, 204);
  assert.equal((await request(prefix + "keys/1/copy", { method: "POST" })).status, 404);
});

test("API management preserves the service verification refusal and rejects invalid input", async () => {
  const { request } = fixture();
  const create = (body: string) => request(prefix + "keys", { method: "POST", body });
  assert.equal((await create('{"name":"Test","groupId":"4"}')).status, 400);
  assert.equal((await create('{"name":"claudex-device:stub","groupId":4}')).status, 400);
  assert.equal((await create("x".repeat(4097))).status, 413);
  const refusal = await create('{"name":"Test","groupId":4}');
  assert.equal(refusal.status, 403);
  assert.deepEqual((await refusal.json()).error, {
    message: "Verify your email to continue.", code: "action_verification_required",
    actionLabel: "Create an API key", seconds: 0,
  });
});

test("a retired frame cannot disclose a key or revoke through the new activation", async () => {
  const { api, request, retire, deletions } = fixture();
  api.apiKeys = async () => { retire(); return [firstKey]; };
  await assert.rejects(request(prefix + "keys/1/copy", { method: "POST" }), { name: "AbortError" });
  await assert.rejects(request(prefix + "keys/1", { method: "DELETE" }), { name: "AbortError" });
  assert.equal(deletions(), 0);
});

test("an in-flight balance from a retired account is refused", async () => {
  const { api, request, retire } = fixture();
  api.balance = async () => { retire(); return 10; };
  await assert.rejects(request(prefix + "balance"), { name: "AbortError" });
});
