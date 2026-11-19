import assert from "node:assert/strict";
import test from "node:test";
import type { OfficialDispatch } from "../shared/dispatch-api";
import { serveOfficialDispatch } from "../shared/official-dispatch";
import { createOfficialReadFetch } from "../src-web/official/read-fetch";

const origin = "http://localhost";
const url = (action: string) => new URL("/api/claudex/dispatch/" + action, origin);
const input = { deviceId: "f167-device", cwd: "/tmp/f167-allowed", mode: "code", text: "Prepare the report" } as const;

test("the official Web routes deliveries through the authorized device bridge", async () => {
  let delivered: unknown;
  const dispatch = {
    deliver: async (body) => {
      delivered = body;
      return { id: "test-delivery", title: body.text, deviceId: body.deviceId, state: "pending" };
    },
  } satisfies Pick<OfficialDispatch, "deliver">;
  const unused = async () => { throw Error("The signed relay route was bypassed."); };
  const fetch = createOfficialReadFetch(origin, unused, unused, undefined, undefined, undefined, undefined, undefined, undefined, {
    dispatch: dispatch as OfficialDispatch,
    current: () => true,
  });
  const request = (body: unknown) => fetch(url("deliver").href, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const bad = await request({ ...input, cwd: "/" });
  assert.equal(bad.status, 400);
  assert.equal(delivered, undefined);
  const good = await request(input);
  assert.equal(good.status, 200);
  assert.deepEqual(delivered, input);
  assert.deepEqual(await good.json(), { id: "test-delivery", title: input.text, deviceId: input.deviceId, state: "pending" });
  assert.equal((await request({ ...input, text: "a".repeat(600 * 1024) })).status, 413);
  assert.equal((await fetch(url("receiving").href)).status, 404);
});

test("a retired Dispatch request cannot mutate another account or read its records", async () => {
  let current = true;
  let writes = 0;
  const api = {
    deliver: async () => { writes++; },
  } as unknown as OfficialDispatch;
  const result = await serveOfficialDispatch({
    url: url("deliver"),
    method: "POST",
    body: async () => {
      current = false;
      return input;
    },
  }, api, () => current);
  assert.equal(result.status, 401);
  assert.equal(writes, 0);
  current = true;
  const read = await serveOfficialDispatch({
    url: url("status"),
    method: "GET",
    body: async () => { throw Error("GET must not consume an entity."); },
  }, {
    status: async () => {
      current = false;
      return { devices: ["private directory"] };
    },
  } as unknown as OfficialDispatch, () => current);
  assert.equal(read.status, 401);
  assert.doesNotMatch(JSON.stringify(read.body), /private directory/);
});
