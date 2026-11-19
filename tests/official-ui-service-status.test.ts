import assert from "node:assert/strict";
import type http from "node:http";
import test from "node:test";
import type { AdapterContext } from "../electron/official-ui/api/context";
import { serviceStatusRoute } from "../electron/official-ui/api/service-status";
import { officialServiceStatusPath, serviceStatusFrom } from "../shared/service-status-api";
import { createOfficialReadFetch } from "../src-web/official/read-fetch";

const origin = "http://localhost";
const status = serviceStatusFrom({ timezone: "Asia/Shanghai", generated_at: "2026-11-14T23:40:00+08:00" });
const statusQuery = officialServiceStatusPath + "?hours=24&step=10";
const unused = async () => { throw Error("Unexpected provider request"); };

async function native(ctx: AdapterContext, path = statusQuery, method = "GET") {
  let answer: { status: number; body?: unknown; headers?: unknown } | undefined;
  const res = {
    writeHead(status: number, headers: unknown) { answer = { status, headers }; },
    end(body: string) { answer!.body = JSON.parse(body); },
  } as unknown as http.ServerResponse;
  await serviceStatusRoute({ method } as http.IncomingMessage, res, new URL(path, origin), ctx);
  return answer!;
}

test("official desktop status returns only the current account's GET result", async () => {
  let replies = 0;
  let activation = 1;
  const ctx = {
    account: () => ({ id: "actor" }),
    isCurrent: () => true,
    sessionIdentity: () => activation,
    serviceStatus: async () => { replies++; return status; },
  } as unknown as AdapterContext;
  assert.equal((await native(ctx, statusQuery, "POST")).status, 405);
  assert.equal((await native(ctx, statusQuery + "&hours=12")).status, 400);
  assert.equal(replies, 0);
  const answer = await native(ctx);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, status);
  assert.equal((answer.headers as Record<string, unknown>)["Cache-Control"], "no-store");
  ctx.serviceStatus = async () => { activation++; return status; };
  assert.equal((await native(ctx)).status, 409);
});

test("official Web status uses the tab account and never relays the status read", async () => {
  let active = true;
  let requests = 0;
  const readStatus = createOfficialReadFetch(origin, unused, unused,
    undefined, undefined, undefined, undefined, undefined, undefined,
    { current: () => active, serviceStatus: async (query) => {
      assert.deepEqual(query, { hours: 24, step: 10 });
      if (++requests === 3) active = false;
      if (requests === 1) throw Error("Synthetic service offline");
      return status;
    } });
  assert.equal((await readStatus(officialServiceStatusPath + "?user=foreign")).status, 400);
  assert.equal((await readStatus(statusQuery, { method: "POST" })).status, 405);
  assert.equal((await readStatus(statusQuery)).status, 503);
  assert.deepEqual(await (await readStatus(statusQuery)).json(), status);
  await assert.rejects(readStatus(statusQuery), { name: "AbortError" });
});
