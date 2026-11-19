import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { officialReplyFeedbackTarget, legacyReplyFeedbackTypes } from "../../shared/official-reply-feedback";
import { isOfficialUiAction } from "../../shared/official-ui-web";

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f005-rest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const conversation = {
    id: "11111111-1111-4111-8111-111111111111", mode: "chat", createdAt: 1, updatedAt: 1,
    turns: [{ id: "22222222-2222-4222-8222-222222222222", status: "completed", createdAt: 1,
      prompt: "Question", attachments: [], items: [{ id: "answer", type: "agentMessage", text: "Answer" }] }],
  };
  let identity = {}, outcome: unknown = { sent: true }, retire = false;
  const calls: [string, unknown[]][] = [];
  const run = createRunnerOfficialAdapter({ account: () => ({ id: "owner" }), settings: () => ({}),
    sessionIdentity: () => identity, stateDirectory: () => root,
    onEvent: () => () => {}, appVersion: "test", log() {},
  } as never, async (method, args) => {
    calls.push([method, args]);
    if (method === "snapshot") return { conversations: [conversation] };
    if (method === "conversationTurns") {
      if (retire) identity = {};
      return { turns: conversation.turns };
    }
    if (method === "setReplyFeedback") return {};
    if (method === "submitReplyFeedback") return outcome;
    throw Error(`Unexpected ${method}`);
  }, path.resolve("build/official-ui"), { modes: ["chat"] }, { allowTextActions: true });
  const base = `/api/organizations/${organizationUuid("owner")}/chat_conversations/${conversation.id}`;
  const history = await run({ method: "GET", path: base });
  assert.equal(history.status, 200, Buffer.from(history.body).toString());
  const target = `${base}/chat_messages/${conversation.turns[0].id}:assistant/chat_feedback`;
  return { calls, target, run, root,
    submit: (body: unknown, method: "POST" | "PUT" = "POST", url = target) => run({
      method, path: url, contentType: "application/json", body: Buffer.from(JSON.stringify(body)),
    }),
    outcome(value: unknown) { outcome = value; }, retire() { retire = true; },
  };
}

test("legacy REST feedback preserves type/reason through the guarded Runner and shares protobuf consent outcomes", async t => {
  const f = await fixture(t);
  assert.equal(isOfficialUiAction("POST", f.target), true);
  assert.equal((await f.submit({ type: "upvote" })).status, 200);
  assert.equal(f.calls.filter(([name]) => name === "submitReplyFeedback").length, 0);
  f.outcome({ sent: false });
  assert.equal((await f.submit({ type: "flag/bug", reason: "Report" })).status, 503);
  f.outcome({ sent: false, queued: true });
  assert.equal((await f.submit({ type: "flag/bug", reason: "Report" }, "PUT")).status, 200);
  assert.equal((await f.submit({ type: "flag/bug", reason: "Report", artifacts: [{ uuid: "artifact", content: "not forwarded" }] })).status, 200);
  const reports = f.calls.filter(([name]) => name === "submitReplyFeedback");
  assert.equal(reports.length, 3);
  assert.deepEqual(reports[1][1], [{ conversationId: "11111111-1111-4111-8111-111111111111",
    turnId: "22222222-2222-4222-8222-222222222222", rating: "down", categories: ["3"], comment: "Report" }]);
  assert.deepEqual(reports[2][1], reports[1][1]);
  assert.equal(fs.existsSync(path.join(f.root, "official-action-receipts")), false);
  assert.equal((await f.submit({ type: "upvote" }, "POST", f.target.replace(":assistant", "%3Aassistant"))).status, 200);
});

test("legacy REST feedback rejects invalid bodies, foreign organization, unknown message, and retired activation before mutation", async t => {
  const f = await fixture(t);
  for (const body of [{ type: "unknown" }, { type: "flag", reason: 1 }, { type: "flag", reason: "x".repeat(4001) },
    { type: "upvote", includeConversation: true }, { reason: "missing type" }])
    assert.equal((await f.submit(body)).status, 400);
  assert.equal((await f.submit({ type: "flag" }, "POST", f.target.replace(organizationUuid("owner"), organizationUuid("other")))).status, 404);
  assert.equal((await f.submit({ type: "flag" }, "POST", f.target.replace(":assistant", ":user"))).status, 404);
  f.retire();
  assert.equal((await f.submit({ type: "flag", reason: "Report" })).status, 409);
  assert.equal(f.calls.filter(([name]) => name === "setReplyFeedback" || name === "submitReplyFeedback").length, 0);
});

test("legacy feedback path is exact and original recognized categories map without accepting arbitrary categories", () => {
  const target = "/api/organizations/11111111-1111-4111-8111-111111111111/chat_conversations/22222222-2222-4222-8222-222222222222/chat_messages/turn:assistant/chat_feedback";
  assert.equal(officialReplyFeedbackTarget("PUT", target)?.messageId, "turn:assistant");
  for (const suffix of ["?x=1", "/extra", "%2Fextra"])
    assert.equal(officialReplyFeedbackTarget("POST", target + suffix), undefined);
  assert.equal(officialReplyFeedbackTarget("POST", target.replace("turn:assistant", "a%2Fb")), undefined);
  assert.equal(officialReplyFeedbackTarget("DELETE", target), undefined);
  assert.equal(legacyReplyFeedbackTypes.get("flag/context"), 10);
  assert.equal(legacyReplyFeedbackTypes.has("not-original"), false);
});
