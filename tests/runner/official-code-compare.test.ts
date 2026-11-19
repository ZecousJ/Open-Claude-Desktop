import assert from "node:assert/strict";
import test from "node:test";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { officialUiRead } from "../../runner/src/official-ui-read";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { encodeWireValue } from "../../shared/web-wire";

 test("owned Code repository comparisons use the authenticated GitHub read", async () => {
  const calls: unknown[] = [];
  const account = { id: "owner" };
  let identity = {};
  let switchAccount = false;
  const ctx = {
    userId: 1, activeAccount: account, signedOut: false, closedFlag: false,
    setAccessToken() {},
    officialSessionIdentity: () => identity,
    store: { conversations: [{ id: "code", mode: "code", archived: false,
      environment: { kind: "space", spaceId: "space" },
      repository: { url: "https://github.com/fixture/primary", fullName: "fixture/primary" },
      sessionRepositories: [{ url: "https://github.com/fixture/primary" }, { url: "https://github.com/fixture/secondary" }],
    }] },
    runtime: { transport: { request: async (...args: unknown[]) => {
      calls.push(args);
      if (switchAccount) identity = {};
      return { ahead_by: 1, behind_by: 0, total_commits: 1,
        merge_base_commit: { sha: "base-sha" },
        files: [{ filename: "file.txt", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-old\n+new" }],
        commits: [{ sha: "1234567890", commit: { message: "Subject\nBody", author: { name: "A", email: "a@example.test", date: "2026-01-01T00:00:00Z" } } }],
      };
    } } },
  };
  const dispatcher = { options: { officialUiRoot: "/fixture" }, guard: { modes: ["code"] },
    contextFor: async () => ctx, context: () => ctx, now: Date.now };
  const read = (request: unknown) => officialUiRead(dispatcher as never, {
    method: "officialUiRead", user: { id: 1, accessToken: "fixture" }, args: encodeWireValue([request]),
  } as never) as Promise<any>;
  const fetch = createOfficialReadFetch("https://fixture.test", read, async () => assert.fail("unexpected network"));
  const send = (repo: string, org = organizationUuid(account.id), extra = {}) => fetch("/v1/code/github/compare-refs", {
    method: "POST", headers: { "Content-Type": "application/json", "x-organization-uuid": org },
    body: JSON.stringify({ repo, base: "main", head: "feature", ...extra }),
  });
  const response = await send("fixture/secondary");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.merge_base, "base-sha");
  assert.equal(body.files[0].filename, "file.txt");
  assert.equal(body.commits[0].subject, "Subject");
  assert.deepEqual(calls[0], ["github.api", 1, { url: "https://github.com/fixture/secondary", action: "repository.compare", base: "main", head: "feature" }]);
  assert.equal((await send("fixture/foreign")).status, 404);
  assert.equal((await send("fixture/secondary", organizationUuid("other"))).status, 403);
  assert.equal((await send("fixture/secondary", organizationUuid(account.id), { ghe_configuration_id: 8 })).status, 400);
  assert.equal(calls.length, 1);
  switchAccount = true;
  assert.equal((await send("fixture/secondary")).status, 409);
});
