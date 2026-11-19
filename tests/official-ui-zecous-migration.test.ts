import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AdapterContext } from "../electron/official-ui/api/context";
import { zecousMigrationRoute } from "../electron/official-ui/api/zecous-migration";
import { officialZecousMigrationPath as path } from "../shared/official-zecous-migration";
import type { OfficialZecousMigration } from "../shared/zecous-migration-api";
import { createOfficialReadFetch } from "../src-web/official/read-fetch";

const pending = { state: "pending", amountUsd: 42.75, balanceUsd: 12.5, subscriptionUsd: 30.25 } as const;
const done = { ...pending, state: "done" } as const;
const unused = async () => { throw Error("Unexpected provider request"); };

test("the Web frame verifies a lost transfer response with a read and never relays the POST", async () => {
  let commits = 0;
  let verified = false;
  let active = true;
  const zecousMigration: OfficialZecousMigration = {
    status: async (options) => {
      if (options?.refreshOnDone) verified = true;
      return commits ? done : pending;
    },
    confirm: async () => { commits++; throw Error("The response was lost"); },
  };
  const request = createOfficialReadFetch("http://localhost", unused, unused,
    undefined, undefined, undefined, undefined, undefined, undefined,
    { zecousMigration, current: () => active });
  assert.equal((await request(path + "/confirm")).status, 405);
  assert.equal((await request(path + "?user_id=2")).status, 400);
  assert.deepEqual(await (await request(path)).json(), pending);
  assert.equal((await request(path + "/confirm", { method: "POST" })).status, 503);
  const readback = await request(path + "?refresh=1");
  assert.equal(readback.headers.get("cache-control"), "no-store");
  assert.deepEqual(await readback.json(), done);
  assert.equal(verified, true);
  assert.equal(commits, 1);
  active = false;
  assert.equal((await request(path + "/confirm", { method: "POST" })).status, 409);
  assert.equal(commits, 1);
});

test("native billing never presents a transfer completed by a retired account", async () => {
  let activation = 1;
  const ctx = {
    account: () => ({ id: "account-a" }), isCurrent: () => true, sessionIdentity: () => activation,
    zecousMigration: { status: async () => pending, confirm: async () => { activation++; return done; } },
  } as unknown as AdapterContext;
  const server = http.createServer((req, res) => {
    void zecousMigrationRoute(req, res, new URL(req.url ?? "/", "http://localhost"), ctx);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const read = await fetch(origin + path);
    assert.deepEqual(await read.json(), pending);
    const confirmation = await fetch(origin + path + "/confirm", { method: "POST" });
    assert.equal(confirmation.status, 409);
    assert.doesNotMatch(await confirmation.text(), /42\.75/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
