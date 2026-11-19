import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { Engine } from "../../electron/engine/engine";
import { switchCodeRewindMark } from "../../electron/engine/engine-history";
import { retireCodeRewind } from "../../shared/code-rewind";
import type { Conversation } from "../../shared/types";

test("rewind markers survive sending and Store reopen with their model and original thread", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f106-marks-"));
  let store = new Store(root);
  const stores = [store];
  t.after(() => {
    for (const item of stores) item.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const turns = ["one", "two"].map((id) => ({
    id,
    prompt: id,
    items: [],
    attachments: [],
    status: "completed" as const,
    createdAt: 1,
  }));
  const c: Conversation = {
    id: "session",
    title: "History",
    createdAt: 1,
    updatedAt: 1,
    mode: "code",
    model: "rewound-model",
    providerId: "default",
    cwd: root,
    pinned: false,
    archived: false,
    threadId: "rewound-thread",
    turns: [turns[0]],
    rewind: {
      variant: "pending",
      index: 1,
      threadId: "original-thread",
      model: "original-model",
      turns: [turns[1]],
      at: 2,
    },
  };
  store.conversations.push(c);
  retireCodeRewind(c);
  c.turns.push({ ...turns[1], id: "new", prompt: "new" });
  const mark = c.savedBranches![0].id;
  store.flush();
  store = new Store(root);
  stores.push(store);
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  const restored = await switchCodeRewindMark(engine, c.id, mark, () => true);
  assert.equal(restored.threadId, "original-thread");
  assert.equal(restored.model, "original-model");
  assert.deepEqual(
    restored.turns.map((turn) => turn.id),
    ["one", "two"],
  );
  const back = restored.savedBranches!.find((branch) => branch.rewindMark)!;
  const redo = await switchCodeRewindMark(engine, c.id, back.id, () => true);
  assert.equal(redo.threadId, "rewound-thread");
  assert.equal(redo.model, "rewound-model");
  assert.deepEqual(
    redo.turns.map((turn) => turn.id),
    ["one", "new"],
  );
  const reopened = new Store(root);
  stores.push(reopened);
  assert.deepEqual(
    reopened.conversation(c.id).turns.map((turn) => turn.id),
    ["one", "new"],
  );
});
