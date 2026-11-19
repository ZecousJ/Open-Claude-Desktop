import test from "node:test";
import assert from "node:assert/strict";
import { releaseOfficialCodeNewTask } from "../../electron/ipc/official-code-new-task";
import type { AppEvent, Conversation } from "../../shared/types";
function fixture() {
  const c: Conversation = {
    id: "code",
    mode: "code",
    title: "Code",
    pinned: false,
    archived: false,
    providerId: "p",
    model: "m",
    turns: [],
    createdAt: 1,
    updatedAt: 1,
    codeNewTask: {
      id: "offer",
      text: "saved input",
      attachments: [],
      providerId: "p",
      model: "m",
    },
  };
  let fail = false,
    writes = 0;
  const events: AppEvent[] = [];
  const ctx = {
    store: {
      conversation(id: string) {
        assert.equal(id, c.id);
        return c;
      },
      flush() {
        writes++;
        if (fail) throw Error("disk failure");
      },
    },
    push(event: AppEvent) {
      events.push(event);
    },
  };
  return {
    c,
    events,
    get writes() {
      return writes;
    },
    fail() {
      fail = true;
    },
    release: (offer: unknown = "offer", text: unknown = "saved input") =>
      releaseOfficialCodeNewTask(ctx, c.id, offer, text),
  };
}

test("private release uses exact offer ID and text and is idempotent", () => {
  const f = fixture();
  assert.equal(f.release("changed"), false);
  assert.equal(f.release("offer", "edited"), false);
  assert.equal(f.writes, 0);
  assert.equal(f.events.length, 0);
  assert.ok(f.c.codeNewTask);
  assert.equal(f.release(), true);
  assert.equal(f.c.codeNewTask, undefined);
  assert.equal(f.writes, 1);
  assert.equal(f.events.length, 1);
  assert.equal(f.release(), false);
  assert.equal(f.writes, 1);
});

test("private release rolls back failed persistence and rejects attached or nonlocal tasks", () => {
  const f = fixture(),
    original = f.c.codeNewTask;
  f.fail();
  assert.throws(() => f.release(), /disk failure/);
  assert.equal(f.c.codeNewTask, original);
  assert.equal(f.events.length, 0);
  const g = fixture();
  g.c.codeNewTask!.attachments = [
    {
      id: "attachment",
      name: "file.txt",
      path: "/not-read",
      size: 1,
      kind: "text",
    },
  ];
  assert.throws(() => g.release(), /attached/);
  assert.equal(g.writes, 0);
  g.c.cloudHosted = true;
  assert.throws(() => g.release(), /local Code/);
  const h = fixture();
  assert.throws(() => h.release("offer", null));
  assert.equal(h.writes, 0);
});
