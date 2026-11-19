import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { organizationUuid } from "../../electron/official-ui/api/context";

test("Web project details and knowledge use the scoped account and never advertise writes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-project-read-"));
  const id = "33333333-3333-4333-8333-333333333333";
  const base = `/api/organizations/${organizationUuid("owner")}/projects/${id}`;
  const calls: string[] = [];
  let fail = false,
    failRead = false,
    switchOnRead = false,
    account = "owner";
  const run = createRunnerOfficialAdapter(
    {
      account: () => ({
        id: account,
        email: "owner@example.invalid",
        name: "Owner",
      }),
      settings: () => ({}),
      sessionIdentity: () => 1,
      stateDirectory: () => root,
      onEvent: () => () => {},
      appVersion: "test",
      log() {},
    } as never,
    async (method, args) => {
      calls.push(method);
      if (method === "snapshot")
        return {
          projects: [
            { id, kind: "chat", name: "Project", createdAt: 1 },
            ...Array.from({ length: 30 }, (_, index) => ({
              id: `other-${index}`,
              kind: "chat",
              name: `Other ${index}`,
              createdAt: index + 2,
            })),
          ],
          conversations: [],
        };
      assert.equal(args[0], id);
      if (method === "listProjectKnowledge") {
        if (fail) throw Error("storage offline");
        return {
          files: [{ name: "note.txt", bytes: 5, addedAt: 1 }],
          bytes: 5,
          limit: 100,
        };
      }
      if (method === "readProjectKnowledge") {
        assert.equal(args[1], "note.txt");
        if (failRead) throw Error("read offline");
        if (switchOnRead) account = "other";
        return { kind: "text", text: "owned text", name: "note.txt", bytes: 10 };
      }
      throw Error(`Unexpected ${method}`);
    },
    root,
    { modes: ["chat"] },
  );
  try {
    const result = await run({ method: "GET", path: base });
    assert.equal(result.status, 200);
    const project = JSON.parse(Buffer.from(result.body).toString());
    assert.equal(project.name, "Project");
    assert.equal(project.docs_count, 1);
    assert.deepEqual(project.permissions, [
      "chat_project:chat:view",
      "chat_project:knowledge:view",
    ]);
    const list = `/api/organizations/${organizationUuid("owner")}/projects_v2?limit=30&permission_filter=chat_create`;
    const firstPage = await run({ method: "GET", path: list });
    assert.equal(firstPage.status, 200);
    assert.equal(JSON.parse(Buffer.from(firstPage.body).toString()).data.length, 30);
    assert.ok(!JSON.parse(Buffer.from(firstPage.body).toString()).data.some((row: { uuid: string }) => row.uuid === id));
    const search = await run({ method: "GET", path: list + "&searchQuery=PROJECT" });
    assert.equal(search.status, 200);
    assert.deepEqual(JSON.parse(Buffer.from(search.body).toString()).data.map((row: { uuid: string }) => row.uuid), [id]);
    const docs = await run({ method: "GET", path: base + "/docs" });
    assert.equal(docs.status, 200);
    assert.equal(
      JSON.parse(Buffer.from(docs.body).toString())[0].content,
      "owned text",
    );
    const stats = await run({ method: "GET", path: base + "/kb/stats" });
    assert.equal(
      JSON.parse(Buffer.from(stats.body).toString()).knowledge_size,
      5,
    );
    const before = calls.length;
    assert.equal(
      (
        await run({
          method: "GET",
          path: base.replace(
            organizationUuid("owner"),
            organizationUuid("other"),
          ),
        })
      ).status,
      404,
    );
    assert.equal(calls.length, before);
    assert.equal(
      (
        await run({
          method: "POST",
          path: base + "/docs",
          contentType: "application/json",
          body: new TextEncoder().encode("{}"),
        })
      ).status,
      501,
    );
    assert.equal(calls.length, before);
    failRead = true;
    assert.equal(
      (await run({ method: "GET", path: base + "/docs" })).status,
      503,
    );
    failRead = false;
    switchOnRead = true;
    const switched = await run({ method: "GET", path: base + "/docs" });
    assert.equal(switched.status, 409);
    assert.equal(
      Buffer.from(switched.body).toString().includes("note.txt"),
      false,
    );
    account = "owner";
    switchOnRead = false;
    fail = true;
    const failedDetail = await run({ method: "GET", path: base });
    assert.equal(
      failedDetail.status,
      503,
      "knowledge failure must not look like an empty successful project",
    );
    assert.match(Buffer.from(failedDetail.body).toString(), /temporarily unavailable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
