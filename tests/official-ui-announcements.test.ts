import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AdapterContext } from "../electron/official-ui/api/context";
import { announcementsRoute } from "../electron/official-ui/api/announcements";
import type { OfficialAnnouncements } from "../shared/announcements-api";
import { createOfficialReadFetch } from "../src-web/official/read-fetch";

const root = "/api/claudex/service-announcements";
const unused = async () => { throw Error("Unexpected provider request"); };
const ordinary = { id: "5", title: "Release note", content: "text", popup: false, read: false, readAt: null, createdAt: 1 };
const dialog = { id: 5, title: "Maintenance", badge: "", bodyHtml: "text", bodyFormat: "text" as const, imageUrl: "", primaryLabel: "", primaryUrl: "", dismissLabel: "" };

test("official Web keeps overlapping notice IDs in their own read streams", async () => {
  let active = true;
  let fail = true;
  const recorded: unknown[] = [];
  const announcements: OfficialAnnouncements = {
    notices: async () => [ordinary], pending: async () => [dialog],
    markRead: async (id) => { recorded.push(id); },
    close: async (id, action) => {
      if (fail) { fail = false; throw Error("Service offline"); }
      recorded.push([id, action]);
    },
  };
  const fetch = createOfficialReadFetch("http://localhost", unused, unused,
    undefined, undefined, undefined, undefined, undefined, undefined,
    { announcements, current: () => active });
  assert.deepEqual(await (await fetch(root)).json(), [ordinary]);
  assert.deepEqual(await (await fetch(`${root}/pending`)).json(), [dialog]);
  assert.equal((await fetch(`${root}/5/read`)).status, 405);
  assert.equal((await fetch(`${root}?account=other`)).status, 400);
  const close = (value: string) => fetch(`${root}/pending/5/read`, { method: "POST", body: value });
  assert.equal((await close('{"action":"unknown"}')).status, 400);
  assert.equal((await close("{".repeat(1025))).status, 413);
  assert.equal((await close('{"action":"close"}')).status, 503);
  assert.equal((await close('{"action":"close"}')).status, 200);
  assert.equal((await fetch(`${root}/5/read`, { method: "POST" })).status, 200);
  assert.deepEqual(recorded, [[5, "close"], "5"]);
  announcements.notices = async () => { active = false; return [ordinary]; };
  assert.equal((await fetch(root)).status, 409);
});

test("official desktop rejects a read result from a retired account activation", async () => {
  let activation = 1;
  let closeCalls = 0;
  const ctx = {
    account: () => ({ id: "owner" }), isCurrent: () => true, sessionIdentity: () => activation,
    announcements: {
      notices: async () => { activation++; return [ordinary]; }, pending: async () => [dialog],
      markRead: unused, close: async () => { closeCalls++; },
    },
  } as unknown as AdapterContext;
  const server = http.createServer((req, res) => {
    void announcementsRoute(req, res, new URL(req.url ?? "/", "http://localhost"), ctx);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(origin + root);
    assert.equal(response.status, 409);
    assert.doesNotMatch(await response.text(), /Release note/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(origin + `${root}/pending/5/read`, { method: "POST", body: '{"action":"dismiss"}' })).status, 200);
    assert.equal(closeCalls, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
