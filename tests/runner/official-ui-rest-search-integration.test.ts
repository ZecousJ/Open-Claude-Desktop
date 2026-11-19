/** Browser fetch shim → actual authenticated read dispatcher → real adapter, mocked account/store only. */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { officialUiRead } from "../../runner/src/official-ui-read";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { encodeWireValue, decodeWireValue } from "../../shared/web-wire";
import { organizationUuid } from "../../electron/official-ui/api/context";
import {
  isOfficialUiQuery,
  isOfficialUiAction,
} from "../../shared/official-ui-web";
import { searchLocalConversations } from "../../electron/conversations/history-search";
function fixture(t: any) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-rest-search-test-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows: any[] = [
    {
      id: "33333333-3333-4333-8333-333333333333",
      mode: "chat",
      title: "Saved chat",
      createdAt: 1000,
      updatedAt: 2000,
      turns: [{ id: "turn", createdAt: 1000, prompt: "needle", items: [] }],
    },
  ];
  let retireOnSearch = false;
  let identity = {},
    writes = 0,
    native = 0;
  const calls: string[] = [];
  const ctx: any = {
    userId: "owner",
    activeAccount: {
      id: "owner",
      name: "Fixture",
      email: "test@example.invalid",
    },
    officialSessionIdentity: () => identity,
    store: { root, settings: {} },
    setAccessToken: () => {},
    appVersion: "test",
    log: () => {},
    onEvent: () => () => {},
  };
  const dispatcher: any = {
    options: {
      officialUiRoot: path.resolve("build/official-ui"),
      officialUiActions: false,
    },
    guard: { modes: ["chat"] },
    contextFor: async () => ctx,
    context: () => ctx,
    now: () => 0,
    run: async (frame: any) => {
      calls.push(frame.method);
      const args = decodeWireValue(frame.args) as any[];
      if (frame.method === "snapshot")
        return { conversations: rows, projects: [] };
      if (frame.method === "searchConversations") {
        if (retireOnSearch) identity = {};
        return searchLocalConversations(rows, args[0], args[1]);
      }
      throw Error("Unexpected write or source call");
    },
  };
  const read = async (request: any) =>
    officialUiRead(dispatcher, {
      method: "officialUiRead",
      args: encodeWireValue([request]),
      user: { id: "owner", accessToken: "fixture-inert" },
    } as any) as Promise<any>;
  const fetch = createOfficialReadFetch(
    "https://fixture.invalid",
    read,
    async () => {
      native++;
      return new Response("unreachable");
    },
    undefined,
    async () => {
      writes++;
      throw Error("Must never use action transport");
    },
  );
  return {
    calls,
    read,
    retire: () => (identity = {}),
    retireDuringSearch: () => (retireOnSearch = true),
    resumeSearch: () => {
      retireOnSearch = false;
    },
    rows,
    get writes() {
      return writes;
    },
    get native() {
      return native;
    },
    fetch,
  };
}

const searchPath = `/api/organizations/${organizationUuid("owner")}/conversation/search/v2`;
const request = (query = "needle") => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query, n: 50, target_snippet_size: 200 }),
});
test("actual browser/read dispatcher/runner REST search is read-only and full text", async (t) => {
  const f = fixture(t);
  assert.equal(isOfficialUiQuery("POST", searchPath), true);
  assert.equal(isOfficialUiAction("POST", searchPath), false);
  const r = await f.fetch(searchPath, request());
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.data[0].conversation.name, "Saved chat");
  assert.equal(body.data[0].matched_snippet.text, "needle");
  assert.deepEqual(body.data[0].matched_snippet.matches, [
    { start: 0, end: 6 },
  ]);
  assert.deepEqual(f.calls, ["snapshot", "searchConversations"]);
  assert.equal(f.writes, 0);
  assert.equal(f.native, 0);
});
test("actual browser rejects foreign org/query/unknown route without dispatch or action", async (t) => {
  const f = fixture(t);
  assert.equal(
    (
      await f.fetch(
        searchPath.replace(
          organizationUuid("owner"),
          organizationUuid("other"),
        ),
        request(),
      )
    ).status,
    404,
  );
  assert.equal(
    (await f.fetch(searchPath + "?mode=code", request())).status,
    400,
  );
  assert.equal((await f.fetch(searchPath + "/unknown", request())).status, 501);
  assert.equal((await f.fetch(searchPath, { method: "GET" })).status, 501);
  assert.deepEqual(f.calls, []);
  assert.equal(f.writes, 0);
  assert.equal(f.native, 0);
});
test("actual runner retirement suppresses source result and later activation can search normally", async (t) => {
  const f = fixture(t);
  f.retireDuringSearch();
  const r = await f.fetch(searchPath, request());
  assert.ok(r.status >= 400);
  assert.doesNotMatch(await r.text(), /Saved chat|needle/);
  f.resumeSearch();
  const restored = await f.fetch(searchPath, request());
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).data[0].conversation.name, "Saved chat");
  assert.equal(f.writes, 0);
  assert.equal(f.native, 0);
});
test("actual browser accepts top-50 and preserves explicit larger-request bounds and honest empty", async (t) => {
  const f = fixture(t);
  const empty = await f.fetch(searchPath, request("absent"));
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).data, []);
  const first = f.rows[0];
  for (let i = 1; i < 50; i++) f.rows.push({ ...first, id: `local-${i}` });
  const full = await f.fetch(searchPath, request());
  assert.equal(full.status, 200);
  assert.equal((await full.json()).data.length, 50);
  const capped = await f.fetch(searchPath, {
    ...request(),
    body: JSON.stringify({ query: "needle", n: 200, target_snippet_size: 200 }),
  });
  assert.equal(capped.status, 413);
  assert.match(await capped.text(), /Refine/);
  assert.equal(f.writes, 0);
  assert.equal(f.native, 0);
});
