/** Actual runner adapter with inert mocked session inventory; no account operation. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import type { ActiveSession } from "../../shared/settings-api";

test("official Web active sessions preserve real structured device fields and strict pagination", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "official-sessions-read-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let owner = "owner",
    identity = {},
    mode = "normal";
  const calls: string[] = [];
  const base: ActiveSession = {
    id: "device:1",
    kind: "desktop",
    deviceName: "Desk",
    platform: "linux",
    userAgent: "",
    current: true,
    createdAt: 0,
    updatedAt: 1,
  };
  const source: ActiveSession[] = [
    base,
    { ...base, id: "device:2", platform: "unrecognized", current: false },
    {
      ...base,
      id: "web:3",
      kind: "web",
      deviceName: "",
      platform: "",
      userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/123.0",
      current: false,
    },
  ];
  const run = createRunnerOfficialAdapter(
    {
      account: () => ({
        id: owner,
        email: "owner@example.invalid",
        name: owner,
      }),
      sessionIdentity: () => identity,
      settings: () => ({}),
      stateDirectory: () => root,
      onEvent: () => () => {},
      appVersion: "test",
      log() {},
    } as never,
    async (method, args) => {
      calls.push(method);
      assert.equal(method, "activeSessions");
      assert.deepEqual(args, []);
      if (mode === "failure") throw Error("SECRET_BACKEND_DETAIL");
      if (mode === "switch") owner = "different";
      if (mode === "retire") identity = {};
      if (mode === "null") return null;
      if (mode === "malformed") return [{ ...base, userAgent: { fake: true } }];
      return source;
    },
    root,
    { modes: ["chat"] },
  );
  const get = (query = "") =>
    run({ method: "GET", path: "/api/auth/sessions/list-active" + query });
  const json = (r: any) => JSON.parse(Buffer.from(r.body).toString());
  const first = await get("?page=1&per_page=2&application_slug=claude-ai");
  assert.equal(first.status, 200);
  assert.equal(json(first).pagination.total, 3);
  assert.equal(json(first).pagination.has_more, true);
  assert.equal(json(first).data.length, 2);
  assert.ok(
    json(first).pagination.total > 0,
    "real UI excludes all rows unless pagination.total is present",
  );
  assert.deepEqual(json(first).data[0].user_agent, {
    browser_family: "Claudex Desktop",
    os_family: "Linux",
  });
  assert.equal(json(first).data[0].created_at, "1970-01-01T00:00:00.000Z");
  assert.equal(json(first).data[1].user_agent.os_family, null);
  const next = await get("?page=2&per_page=2&application_slug=claude-ai");
  assert.equal(next.status, 200);
  assert.equal(json(next).pagination.has_more, false);
  assert.deepEqual(json(next).data[0].user_agent, {
    browser_family: "Chrome",
    os_family: "Windows",
  });
  for (const query of [
    "?page=0",
    "?page=01",
    "?per_page=101",
    "?page=1&page=2",
    "?org=other",
    "?account_uuid=other",
    "?application_slug=other",
    "?unknown=1",
  ]) {
    const before = calls.length;
    const result = await get(query);
    assert.ok(result.status >= 400);
    assert.equal(calls.length, before);
  }
  const before = calls.length;
  assert.equal(
    (await run({ method: "POST", path: "/api/auth/sessions/list-active" }))
      .status,
    501,
  );
  assert.equal(calls.length, before);
  for (const failure of ["null", "malformed", "failure", "switch", "retire"]) {
    mode = failure;
    owner = "owner";
    identity = {};
    const result = await get();
    assert.ok(result.status >= 400, failure);
    const text = Buffer.from(result.body).toString();
    assert.ok(!text.includes("SECRET_BACKEND_DETAIL"));
    assert.ok(!text.includes("device:1"));
  }
});
