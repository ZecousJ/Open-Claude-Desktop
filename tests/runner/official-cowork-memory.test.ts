import assert from "node:assert/strict";
import test from "node:test";
import { officialCoworkMemory } from "../../shared/official-cowork-memory";
import { officialCoworkMemoryResponse, coworkMemoryService } from "../../runner/src/official-cowork-memory";

const origin = "https://claudex.example";
const org = "00000000-0000-4000-8000-000000000001";
const path = `/v1/environment_providers/private/organizations/${org}/users/me/memory?repo=cowork`;

test("original Cowork delete includes the index CAS and bounded account epoch", async () => {
  const calls: object[] = [];
  const service = coworkMemoryService(origin, async (target, init) => {
    assert.equal(String(target), origin + "/api/v1/claudex/memory/cowork");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer account-token");
    calls.push({ method: init?.method, body: init?.body && JSON.parse(String(init.body)) });
    if (calls.length === 2) return Response.json({}, { status: 412 });
    return Response.json({ code: 0, data: {
      revision: "15", epoch: "4", updated_at: "2026-11-14T00:00:00Z",
      entries: { "MEMORY.md": "Index", "fixture.md": "Remember this" },
    } });
  });
  const run = (method: string, input: Record<string, unknown>) =>
    officialCoworkMemoryResponse(officialCoworkMemory(method, path)!, input, service, "account-token", () => true);
  const read = await run("GET", {});
  assert.equal(read.status, 200);
  const data = JSON.parse(Buffer.from(read.body).toString());
  assert.equal(data.repo, "cowork");
  assert.equal(data.claudex_epoch, "4");
  assert.equal(data.content.entries["fixture.md"], "Remember this");
  const patch = {
    contentType: "application/json", coworkMemoryEpoch: "4", coworkMemoryIfMatch: '"15"',
    body: Buffer.from(JSON.stringify({ entries: { "MEMORY.md": "Updated" }, soft_delete_keys: ["fixture.md"] })),
  };
  assert.equal((await run("PUT", { ...patch, coworkMemoryEpoch: undefined })).status, 409);
  assert.equal((await run("PUT", { ...patch, coworkMemoryIfMatch: "*" })).status, 400);
  assert.equal((await run("PUT", patch)).status, 412);
  assert.deepEqual(calls[1], { method: "PUT", body: {
    expected_epoch: "4", expected_revision: "15", entries: { "MEMORY.md": "Updated" }, delete_keys: ["fixture.md"],
  } });
  assert.equal((await run("DELETE", { coworkMemoryEpoch: "4" })).status, 200);
  assert.deepEqual(calls[2], { method: "DELETE", body: { expected_epoch: "4" } });
});
