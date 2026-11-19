import assert from "node:assert/strict";
import test from "node:test";
import { compactBootstrap, expandBootstrap, type BootstrapCatalog } from "../../shared/official-bootstrap-catalog";
import { bootstrapRead } from "../../src-web/official/bootstrap-read";
import type { OfficialUiReadRequest } from "../../shared/official-ui-web";

const catalog: BootstrapCatalog = { revision: "a".repeat(64), messages: { greeting: "Hello", changed: "Old" } };
const complete = {
  account: { uuid: "owner-a" }, locale: "zh-Hans",
  gated_messages: { messages: { greeting: "Hello", changed: "New", reply: "回复" }, gates: ["quotes"] },
  growthbook: { features: { allowed: false } }, org_growthbook: { features: { allowed: false } },
};
const answer = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: new TextEncoder().encode(JSON.stringify(value)) });

test("catalog round trip preserves overrides, account, locale and feature restrictions", () => {
  const wire = JSON.parse(JSON.stringify(compactBootstrap(complete, catalog)));
  assert.deepEqual(wire.gated_messages.messages, { changed: "New", reply: "回复" });
  assert.deepEqual(expandBootstrap(wire, catalog), complete);
  assert.throws(() => expandBootstrap(wire, { ...catalog, revision: "b".repeat(64) }), /catalog changed/);
  const distinct = { ...complete, growthbook: { features: { different: true } } };
  assert.deepEqual(expandBootstrap(JSON.parse(JSON.stringify(compactBootstrap(distinct, catalog))), catalog), distinct);
  const removed = { ...complete, gated_messages: { messages: { reply: "回复" } } };
  assert.deepEqual(compactBootstrap(removed, catalog), removed);
});

test("new clients preserve old Runner responses and fall back only for rejected negotiation", async () => {
  for (const legacy of ["unknown-field", "bad-request", "full-response", "missing-catalog"]) {
    const calls: OfficialUiReadRequest[] = [];
    const read = bootstrapRead(async request => {
      calls.push(request);
      if (request.bootstrapCatalogRevision && legacy === "unknown-field") throw Error("Invalid official Web request.");
      if (request.bootstrapCatalogRevision && legacy === "bad-request") return answer({}, 400);
      return answer(complete);
    }, Promise.resolve(legacy === "missing-catalog" ? undefined : catalog));
    const result = await read({ method: "GET", path: "/edge-api/bootstrap" });
    assert.deepEqual(JSON.parse(new TextDecoder().decode(result.body)), complete);
    assert.equal(calls.length, ["unknown-field", "bad-request"].includes(legacy) ? 2 : 1);
    await read({ method: "GET", path: "/api/account" });
    assert.equal(calls.at(-1)?.bootstrapCatalogRevision, undefined);
  }
});

test("catalog optimization does not hide authentication failures", async () => {
  let calls = 0;
  const read = bootstrapRead(async () => { calls++; throw Error("Account activation changed"); }, Promise.resolve(catalog));
  await assert.rejects(read({ method: "GET", path: "/edge-api/bootstrap" }), /Account activation changed/);
  assert.equal(calls, 1);
});
