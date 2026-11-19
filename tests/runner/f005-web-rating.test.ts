import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReplyFeedback } from "../../electron/conversations/reply-feedback";
import { useElectronShim } from "./runner-core-support.test";

useElectronShim();
const { registerCoreHandlers } = await import("../../runner/src/web-context-settings");

test("web ratings persist across reload without emitting reports for original feedback", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f005-web-rating-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events: unknown[] = [];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const context = {
    store: { conversation: (id: string) => {
      if (id !== "owned") throw Error("not found");
      return { turns: [{ id: "active", status: "completed" }, { id: "running", status: "inProgress" }], savedBranches: [{ turns: [{ id: "branch", status: "completed" }] }] };
    } },
    replyFeedback: new ReplyFeedback(root),
    ratingListeners: { emit: (event: unknown) => events.push(event) },
  };
  registerCoreHandlers.call(context as never, (name, fn) => handlers.set(name, fn));
  const set = handlers.get("setReplyFeedback")!;
  set("owned", "active", "up", { localOnly: true });
  set("owned", "branch", "down", { localOnly: true });
  assert.deepEqual(events, []);
  assert.deepEqual(new ReplyFeedback(root).all(), { '["owned","active"]': "up", '["owned","branch"]': "down" });
  assert.throws(() => set("owned", "running", "up", { localOnly: true }));
  assert.throws(() => set("foreign", "active", "up", { localOnly: true }));
  assert.throws(() => set("owned", "active", "up", { localOnly: true, extra: true }));
  set("owned", "active", null, { localOnly: true });
  assert.equal(new ReplyFeedback(root).all()['["owned","active"]'], undefined);
  set("owned", "active", "up");
  assert.equal(events.length, 1);
});
