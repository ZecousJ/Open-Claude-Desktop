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
  officialUiRecentsPath,
  isOfficialUiQuery,
  isOfficialUiAction,
} from "../../shared/official-ui-web";
import { searchLocalConversations } from "../../electron/conversations/history-search";
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-recents-test-"));
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
    snapshot: () => ({ conversations: rows, projects: [], approvals: [] }),
    chatDeviceController: { pendingApprovals: () => [] },
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
      if (frame.method === "searchConversations")
        return searchLocalConversations(rows, args[0], args[1]);
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
    get writes() {
      return writes;
    },
    get native() {
      return native;
    },
    fetch,
  };
}
test("actual browser and runner route Recents POST through readonly transport with full-text source", async (t) => {
  const f = fixture(t);
  assert.equal(isOfficialUiQuery("POST", officialUiRecentsPath), true);
  assert.equal(isOfficialUiAction("POST", officialUiRecentsPath), false);
  const r = await f.fetch(officialUiRecentsPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationUuid: organizationUuid("owner"),
      first: { query: "needle", surfaces: [1, 2] },
    }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.data[0].chat.name, "Saved chat");
  assert.equal(f.writes, 0);
  assert.equal(f.native, 0);
  assert.ok(f.calls.includes("searchConversations"));
  assert.ok(
    f.calls.every((m) => ["snapshot", "searchConversations"].includes(m)),
  );
});
test("browser unknown methods/RPC and runner foreign org never broaden read authority", async (t) => {
  const f = fixture(t);
  for (const [p, m] of [
    [officialUiRecentsPath, "DELETE"],
    [officialUiRecentsPath, "GET"],
    [officialUiRecentsPath + "Other", "POST"],
  ])
    assert.equal((await f.fetch(p, { method: m })).status, 501);
  assert.equal(f.calls.length, 0);
  const r = await f.fetch(officialUiRecentsPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationUuid: organizationUuid("other"),
      first: { query: "needle", surfaces: [1] },
    }),
  });
  assert.equal(r.status, 404);
  assert.ok(!f.calls.includes("searchConversations"));
  assert.equal(f.writes, 0);
});
