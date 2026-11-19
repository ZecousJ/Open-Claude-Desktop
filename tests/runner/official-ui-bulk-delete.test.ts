import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { organizationUuid } from "../../electron/official-ui/api/context";

const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

test("leased batch action preserves partial results and stops when the activation retires", async () => {
  let current = true;
  let retireOnDelete = false;
  const deleted: string[] = [];
  const host = {
    account: () => ({ id: "owner" }), settings: () => ({}), sessionIdentity: () => "session",
    stateDirectory: () => "/tmp", onEvent: () => () => {}, appVersion: "test", log() {},
  };
  const run = createRunnerOfficialAdapter(host as never, async (method, args) => {
    if (method === "snapshot") return { conversations: ids.map((id) => ({ id, mode: "chat" })), projects: [] };
    if (method === "conversationTurns") return { turns: [], savedBranches: [] };
    if (method === "deleteConversation") {
      if (args[0] === ids[1]) throw Error("running");
      deleted.push(String(args[0]));
      if (retireOnDelete) current = false;
      return;
    }
    throw Error(`Unexpected ${method}`);
  }, "build/official-ui", { modes: ["chat"] }, {
    allowTextActions: true, isChatBulkDeleteCurrent: (lease) => lease === "lease" && current,
  });
  const request = {
    method: "POST" as const,
    path: `/api/organizations/${organizationUuid("owner")}/chat_conversations/delete_many`,
    contentType: "application/json", body: Buffer.from(JSON.stringify({ conversation_uuids: ids })),
    capabilityLease: "lease",
  };
  assert.equal((await run({ ...request, capabilityLease: "stale" })).status, 501);
  assert.deepEqual(deleted, []);
  const response = await run(request);
  assert.equal(response.status, 200);
  const result = JSON.parse(Buffer.from(response.body).toString());
  assert.deepEqual(result.deleted, [ids[0]]);
  assert.deepEqual(result.failed.map((item: { uuid: string }) => item.uuid), [ids[1]]);
  assert.deepEqual(deleted, [ids[0]]);
  deleted.length = 0;
  retireOnDelete = true;
  assert.equal((await run(request)).status, 409);
  assert.deepEqual(deleted, [ids[0]]);
});
