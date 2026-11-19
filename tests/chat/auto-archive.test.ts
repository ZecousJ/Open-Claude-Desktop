import test from "node:test";
import assert from "node:assert/strict";
import { inactiveSessions, startAutoArchive } from "../../electron/conversations/auto-archive";

const DAY = 86_400_000;
const now = 100 * DAY;
const session = (id: string, extra: object = {}) =>
  ({
    id,
    mode: "code",
    updatedAt: now - 10 * DAY,
    turns: [],
    ...extra,
  }) as never;

test("only idle local Code sessions past the chosen days are archived", () => {
  const list = [
    session("old"),
    session("recent", { updatedAt: now - 2 * DAY }),
    session("chat", { mode: "chat" }),
    session("ssh", { environment: { kind: "ssh", hostId: "h" } }),
    session("running", { turns: [{ status: "inProgress", items: [] }] }),
    session("archived", { archived: true }),
    session("pinned", { pinned: true }),
  ];
  assert.deepEqual(
    inactiveSessions(list, { autoArchiveDays: 7 } as never, now),
    ["old"],
  );
  // Never: nothing.
  assert.deepEqual(inactiveSessions(list, {} as never, now), []);
});

test("automatic archives honor activity, restore, and the latest PR choice", async () => {
  const held = new Set(["visible"]);
  const choices = [
    session("idle"), session("visible"), session("restored", { codeAutoArchiveExempt: true }),
    session("focused", { codeLastFocusedAt: now - DAY }),
    session("merged", { updatedAt: now - DAY }),
    session("closed", { updatedAt: now - DAY, prAutoArchive: true }),
    session("off", { updatedAt: now - DAY, prAutoArchive: false }),
    session("reopened", { updatedAt: now - DAY }),
    session("failed", { updatedAt: now, turns: [{ status: "failed", items: [] }] }),
  ];
  const archived = new Map();
  const service = startAutoArchive({
    settings: () => ({ autoArchiveDays: 7, prAutoArchive: true }) as never,
    conversations: () => choices,
    held: id => held.has(id),
    now: () => now,
    pull: async c => {
      if (c.id === "reopened") {
        held.add(c.id);
        return "closed";
      }
      if (c.id === "merged" || c.id === "failed") return "merged";
      if (c.id === "closed") return "closed";
    },
    archive: async (id, reason, eligible) => {
      assert.equal(eligible(), true);
      archived.set(id, reason);
    },
  });
  try {
    await service.check();
    assert.deepEqual([...archived], [["idle", "inactive"], ["merged", "merged"], ["closed", "closed"]]);
  } finally {
    service.stop();
  }
});
