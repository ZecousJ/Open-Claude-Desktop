import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inAdapterScope, newAdapterScope } from "../../electron/official-ui/api/scope";
import { assistantMessageId, forgetTemporaryTurnIds, rememberTurnIds } from "../../electron/official-ui/api/conversations";
import { flushState } from "../../electron/official-ui/api/state";
import type { Turn } from "../../shared/types";

test("temporary message identities stay in memory even when saved chats write their identities", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "temporary-message-ids-"));
  try {
    inAdapterScope(newAdapterScope("fixture", root, 1), () => {
      const temporary = { id: "private-turn", prompt: "private prompt" } as Turn;
      const saved = { id: "saved-turn", prompt: "saved prompt" } as Turn;
      rememberTurnIds(temporary, { user: "private-user", assistant: "private-assistant" }, true);
      rememberTurnIds(saved, { user: "saved-user", assistant: "saved-assistant" });
      flushState("message-ids");
      assert.equal(assistantMessageId(temporary), "private-assistant");
      const files = fs.readdirSync(root, { recursive: true }).map(String);
      const stored = files.filter(file => file.endsWith("message-ids.json")).map(file => fs.readFileSync(path.join(root, file), "utf8")).join("");
      assert.match(stored, /saved-assistant/);
      assert.doesNotMatch(stored, /private/);
      forgetTemporaryTurnIds([temporary]);
      assert.equal(assistantMessageId(temporary), "private-turn:assistant");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
