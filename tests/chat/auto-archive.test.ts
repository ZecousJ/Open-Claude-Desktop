import test from "node:test";
import assert from "node:assert/strict";
import { inactiveSessions } from "../../electron/conversations/auto-archive";

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
