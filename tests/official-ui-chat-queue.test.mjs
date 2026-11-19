import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { deriveOfficialChatQueue, chatQueueModule } from "../scripts/official-ui-chat-queue.mjs";

test("the shared native composer queues Chat while the engine is busy", () => {
  const path = "assets/v1/" + chatQueueModule;
  const candidate = fs.readFileSync("build/official-ui/ui/" + path, "utf8");
  const manifest = JSON.parse(fs.readFileSync("build/official-ui/manifest.json", "utf8"));
  assert.equal(manifest.hostChatQueue, true);
  assert.ok(candidate.includes("    transportTakesMidTurnSends: false,"));
  assert.ok(!candidate.includes("    transportTakesMidTurnSends: B.current?.outcomeAcks ?? Ie,"));
  const composer = fs.readFileSync("build/official-ui/ui/assets/v1/shared-28-CcQ2xpO-.js", "utf8");
  const start = composer.indexOf("function JC(e) {");
  const end = composer.indexOf("\nfunction ", start + 1);
  assert.ok(start > 0 && end > start);
  const queues = vm.runInNewContext("(" + composer.slice(start, end) + ")");
  const state = { frontendQueueEnabled: true, isSessionConversation: false,
    isAgentMode: false, isExternalConversation: true };
  assert.equal(queues({ ...state, transportTakesMidTurnSends: true }), false);
  assert.equal(queues({ ...state, transportTakesMidTurnSends: false }), true);
  assert.equal(queues({ ...state, isSessionConversation: true, transportTakesMidTurnSends: false }), false);
  assert.throws(() => deriveOfficialChatQueue(path, candidate), /transport changed/);
});
