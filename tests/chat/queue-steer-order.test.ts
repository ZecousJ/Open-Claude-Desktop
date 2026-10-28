import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../../shared/types";
import {
  addQueued,
  clearQueued,
  nextQueued,
  queuedMessages,
  removeQueued,
  takeEditableQueued,
} from "../../src/composer/queue";
import { conversationChanged, sendQueuedNow } from "../../src/composer/queue";

const common = {
  text: "$review Queued instructions",
  attachments: [],
  state: "queued" as const,
  mode: "chat" as const,
  providerId: "p",
  model: "m",
  webSearch: false,
};
let serial = 0;
function record(
  id: string,
  running: boolean,
  clients: string[] = [],
): Conversation {
  return {
    id,
    title: "Synthetic queue",
    mode: "chat",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: running ? 1 : 2,
    turns: [
      {
        id: `${id}-turn`,
        prompt: "Previous",
        attachments: [],
        createdAt: 1,
        status: running ? "inProgress" : "completed",
        items: clients.map((clientId) => ({
          id: clientId,
          type: "userMessage",
          steered: true,
          clientId,
          text: common.text,
          attachments: [],
        })),
      },
    ],
  };
}
async function fixture(
  run: (state: {
    id: string;
    entryId: string;
    running: Conversation;
    idle(clients?: string[]): Conversation;
    requests: { resolve(value: unknown): void; reject(error: Error): void }[];
    upserts: Conversation[];
    ordinary: string[];
    send: (entry: { id: string }) => Promise<void>;
  }) => Promise<void>,
) {
  const id = `steer-order-${++serial}`;
  const requests: {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktop: {
        steerTurn: () =>
          new Promise((resolve, reject) => requests.push({ resolve, reject })),
      },
    },
  });
  const entry = addQueued(id, common);
  const ordinary: string[] = [];
  try {
    await run({
      id,
      entryId: entry.id,
      running: record(id, true),
      idle: (clients = []) => record(id, false, clients),
      requests,
      upserts: [],
      ordinary,
      send: async (entry) => {
        ordinary.push(entry.id);
      },
    });
  } finally {
    for (const entry of queuedMessages(id)) removeQueued(id, entry.id);
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("a completion carrying the eventual client ID cannot send again before or after steer resolves", async () => {
  await fixture(async (f) => {
    const request = sendQueuedNow(
      f.running,
      f.entryId,
      (c) => f.upserts.push(c),
      f.send,
    );
    assert.equal(
      await sendQueuedNow(f.running, f.entryId, () => {}, f.send),
      "gone",
    );
    assert.equal(f.requests.length, 1);
    await conversationChanged(f.idle(["accepted"]), f.send);
    await conversationChanged(f.idle(["accepted"]), f.send);
    assert.deepEqual(f.ordinary, []);
    assert.equal(nextQueued(queuedMessages(f.id), f.idle()), undefined);
    f.requests[0].resolve({ messageId: "accepted", conversation: f.running });
    assert.equal(await request, "steered");
    assert.deepEqual(f.ordinary, []);
    assert.equal(queuedMessages(f.id).length, 0);
    assert.equal(f.upserts.length, 1);
    assert.equal(
      await sendQueuedNow(f.running, f.entryId, () => {}, f.send),
      "gone",
    );
    await conversationChanged(f.idle(["accepted"]), f.send);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.ordinary, []);
  });
});

test("the RPC snapshot's delivered client ID also prevents resend if an earlier event lacked it", async () => {
  await fixture(async (f) => {
    const request = sendQueuedNow(f.running, f.entryId, () => {}, f.send);
    await conversationChanged(f.idle(), f.send);
    assert.deepEqual(f.ordinary, []);
    f.requests[0].resolve({
      messageId: "accepted",
      conversation: f.idle(["accepted"]),
    });
    assert.equal(await request, "steered");
    assert.deepEqual(f.ordinary, []);
    assert.equal(queuedMessages(f.id).length, 0);
  });
});

for (const result of ["unread", "held", "rejected"] as const) {
  test(`a completion during ${result} steer wakes exactly one ordinary send after settlement`, async () => {
    await fixture(async (f) => {
      const request = sendQueuedNow(f.running, f.entryId, () => {}, f.send);
      await conversationChanged(f.idle(), f.send);
      await conversationChanged(f.idle(), f.send);
      assert.deepEqual(f.ordinary, []);
      if (result === "rejected")
        f.requests[0].reject(new Error("Steer failed"));
      else
        f.requests[0].resolve(
          result === "held"
            ? null
            : { messageId: "unread", conversation: f.idle() },
        );
      assert.equal(await request, "sent");
      assert.deepEqual(f.ordinary, [f.entryId]);
      assert.equal(queuedMessages(f.id).length, 0);
      assert.equal(
        await sendQueuedNow(f.idle(), f.entryId, () => {}, f.send),
        "gone",
      );
      await conversationChanged(f.idle(), f.send);
      assert.deepEqual(f.ordinary, [f.entryId]);
    });
  });
}

test("a rejected steer followed by failed draining unlocks the retained entry and an explicit retry sends once", async () => {
  await fixture(async (f) => {
    let attempts = 0;
    const send = async () => {
      attempts++;
      throw new Error("Ordinary send failed");
    };
    const request = sendQueuedNow(f.running, f.entryId, () => {}, send);
    await conversationChanged(f.idle(), send);
    f.requests[0].reject(new Error("Steer failed"));
    await assert.rejects(request, /Steer failed/);
    assert.equal(attempts, 1);
    const entry = queuedMessages(f.id)[0];
    assert.match(entry.error!, /Ordinary send failed/);
    assert.equal(entry.steering, undefined);
    assert.equal(
      await sendQueuedNow(f.idle(), f.entryId, () => {}, f.send),
      "sent",
    );
    assert.deepEqual(f.ordinary, [f.entryId]);
    assert.equal(queuedMessages(f.id).length, 0);
  });
});

test("a failed steer without a completion still rejects and a later completion can drain", async () => {
  await fixture(async (f) => {
    const request = sendQueuedNow(f.running, f.entryId, () => {}, f.send);
    f.requests[0].reject(new Error("Steer failed"));
    await assert.rejects(request, /Steer failed/);
    assert.deepEqual(f.ordinary, []);
    assert.equal(queuedMessages(f.id)[0].steering, undefined);
    await conversationChanged(f.idle(), f.send);
    assert.deepEqual(f.ordinary, [f.entryId]);
  });
});

test("the latest running event supersedes an earlier completion and does not drain into a live turn", async () => {
  await fixture(async (f) => {
    const request = sendQueuedNow(f.running, f.entryId, () => {}, f.send);
    await conversationChanged(f.idle(), f.send);
    const newer = {
      ...f.running,
      updatedAt: 3,
      turns: [{ ...f.running.turns[0], id: "new-live-turn" }],
    };
    await conversationChanged(newer, f.send);
    f.requests[0].resolve(null);
    assert.equal(await request, "held");
    assert.deepEqual(f.ordinary, []);
    assert.equal(queuedMessages(f.id).length, 1);
    await conversationChanged(
      { ...newer, turns: [{ ...newer.turns[0], status: "completed" }] },
      f.send,
    );
    assert.deepEqual(f.ordinary, [f.entryId]);
  });
});

for (const sameTimestamp of [false, true]) {
  for (const accepted of [false, true]) {
    test(`a new running turn rejects an older completion (${sameTimestamp ? "equal" : "older"} timestamp, ${accepted ? "accepted" : "held"} RPC)`, async () => {
      await fixture(async (f) => {
        const request = sendQueuedNow(
          f.running,
          f.entryId,
          (c) => f.upserts.push(c),
          f.send,
        );
        const older = f.idle();
        const newer: Conversation = {
          ...older,
          updatedAt: sameTimestamp ? older.updatedAt : older.updatedAt + 1,
          turns: [
            ...older.turns,
            {
              ...f.running.turns[0],
              id: "newer-turn-opaque-a",
              createdAt: 3,
            },
          ],
        };
        await conversationChanged(newer, f.send);
        await conversationChanged(older, f.send);
        f.requests[0].resolve(
          accepted ? { messageId: "unread", conversation: older } : null,
        );
        assert.equal(await request, accepted ? "steered" : "held");
        assert.deepEqual(f.ordinary, []);
        assert.equal(queuedMessages(f.id).length, 1);
        if (accepted) assert.equal(f.upserts.at(-1), newer);
        await conversationChanged(
          {
            ...newer,
            turns: newer.turns.map((turn) => ({
              ...turn,
              status: "completed",
            })),
          },
          f.send,
        );
        assert.deepEqual(f.ordinary, [f.entryId]);
      });
    });
  }
}

test("same-turn completion at the same timestamp is retained over a late running snapshot and wakes once", async () => {
  await fixture(async (f) => {
    const request = sendQueuedNow(f.running, f.entryId, () => {}, f.send);
    const completed = { ...f.idle(), updatedAt: f.running.updatedAt };
    await conversationChanged(completed, f.send);
    await conversationChanged(f.running, f.send);
    f.requests[0].resolve(null);
    assert.equal(await request, "sent");
    assert.deepEqual(f.ordinary, [f.entryId]);
  });
});

test("a real completion containing the new turn still wakes after a stale old completion was ignored", async () => {
  await fixture(async (f) => {
    const request = sendQueuedNow(f.running, f.entryId, () => {}, f.send);
    const newer: Conversation = {
      ...f.idle(),
      turns: [
        ...f.idle().turns,
        { ...f.running.turns[0], id: "second-turn", createdAt: 3 },
      ],
    };
    await conversationChanged(newer, f.send);
    await conversationChanged(f.idle(), f.send);
    await conversationChanged(
      {
        ...newer,
        turns: newer.turns.map((turn) => ({ ...turn, status: "completed" })),
      },
      f.send,
    );
    f.requests[0].resolve(null);
    assert.equal(await request, "sent");
    assert.deepEqual(f.ordinary, [f.entryId]);
  });
});

test("an older RPC can prove delivery without replacing the observed new running turn", async () => {
  await fixture(async (f) => {
    const request = sendQueuedNow(
      f.running,
      f.entryId,
      (c) => f.upserts.push(c),
      f.send,
    );
    const newer: Conversation = {
      ...f.idle(),
      updatedAt: 3,
      turns: [
        ...f.idle().turns,
        { ...f.running.turns[0], id: "second-turn", createdAt: 3 },
      ],
    };
    await conversationChanged(newer, f.send);
    f.requests[0].resolve({
      messageId: "read-before-answer",
      conversation: f.idle(["read-before-answer"]),
    });
    assert.equal(await request, "steered");
    assert.deepEqual(f.ordinary, []);
    assert.equal(queuedMessages(f.id).length, 0);
    assert.equal(f.upserts.at(-1), newer);
  });
});

test("a completed RPC snapshot can wake the queue even without a separate completion event", async () => {
  await fixture(async (f) => {
    const request = sendQueuedNow(f.running, f.entryId, () => {}, f.send);
    f.requests[0].resolve({ messageId: "unread", conversation: f.idle() });
    assert.equal(await request, "sent");
    assert.deepEqual(f.ordinary, [f.entryId]);
    assert.equal(queuedMessages(f.id).length, 0);
  });
});

test("the old batch's final drain cannot clear a new pending batch created while its send awaits", async () => {
  await fixture(async (f) => {
    const second = addQueued(f.id, { ...common, text: "Second turn message" });
    let releaseFirst!: () => void;
    let startedFirst!: () => void;
    const started = new Promise<void>((resolve) => {
      startedFirst = resolve;
    });
    const send = async (entry: { id: string }) => {
      f.ordinary.push(entry.id);
      if (entry.id === f.entryId) {
        startedFirst();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    };
    const firstRequest = sendQueuedNow(f.running, f.entryId, () => {}, send);
    await conversationChanged(f.idle(), send);
    f.requests[0].resolve(null);
    await started;
    const secondRunning: Conversation = {
      ...f.idle(),
      updatedAt: 3,
      turns: [
        ...f.idle().turns,
        { ...f.running.turns[0], id: "new-live-turn", createdAt: 3 },
      ],
    };
    const secondRequest = sendQueuedNow(
      secondRunning,
      second.id,
      () => {},
      send,
    );
    const secondCompleted: Conversation = {
      ...secondRunning,
      updatedAt: 4,
      turns: secondRunning.turns.map((turn) => ({
        ...turn,
        status: "completed",
      })),
    };
    await conversationChanged(secondCompleted, send);
    releaseFirst();
    assert.equal(await firstRequest, "sent");
    await conversationChanged(secondCompleted, send);
    assert.deepEqual(f.ordinary, [f.entryId]);
    assert.equal(queuedMessages(f.id)[0].steering, true);
    f.requests[1].resolve({
      messageId: "second-read",
      conversation: {
        ...secondCompleted,
        turns: [
          secondCompleted.turns[0],
          {
            ...secondCompleted.turns[1],
            items: record(f.id, false, ["second-read"]).turns[0].items,
          },
        ],
      },
    });
    assert.equal(await secondRequest, "steered");
    assert.deepEqual(f.ordinary, [f.entryId]);
    assert.equal(queuedMessages(f.id).length, 0);
  });
});

test("concurrent steers settle behind one temporary barrier and consumed messages never resend", async () => {
  await fixture(async (f) => {
    const second = addQueued(f.id, { ...common, text: "Second" });
    const firstRequest = sendQueuedNow(f.running, f.entryId, () => {}, f.send);
    const secondRequest = sendQueuedNow(f.running, second.id, () => {}, f.send);
    await conversationChanged(f.idle(["first", "second"]), f.send);
    f.requests[0].resolve({ messageId: "first", conversation: f.running });
    await firstRequest;
    assert.deepEqual(f.ordinary, []);
    f.requests[1].resolve({ messageId: "second", conversation: f.running });
    await secondRequest;
    assert.deepEqual(f.ordinary, []);
    assert.equal(queuedMessages(f.id).length, 0);
    const later = addQueued(f.id, {
      ...common,
      text: "Fresh queue after settlement",
    });
    await conversationChanged(f.idle(), f.send);
    assert.deepEqual(
      f.ordinary,
      [later.id],
      "no settled barrier survives to block a fresh queue",
    );
  });
});

test("one rejected concurrent steer does not drain until the other settles, then preserves FIFO", async () => {
  await fixture(async (f) => {
    const second = addQueued(f.id, { ...common, text: "Second" });
    const firstRequest = sendQueuedNow(f.running, f.entryId, () => {}, f.send);
    const secondRequest = sendQueuedNow(f.running, second.id, () => {}, f.send);
    await conversationChanged(f.idle(), f.send);
    f.requests[0].reject(new Error("First steer failed"));
    await assert.rejects(firstRequest, /First steer failed/);
    assert.deepEqual(f.ordinary, []);
    f.requests[1].resolve(null);
    assert.equal(await secondRequest, "held");
    assert.deepEqual(f.ordinary, [f.entryId]);
    assert.deepEqual(
      queuedMessages(f.id).map((entry) => entry.id),
      [second.id],
    );
    const later = f.idle();
    later.turns.push({ ...later.turns[0], id: "ordinary-send-finished" });
    await conversationChanged(later, f.send);
    assert.deepEqual(f.ordinary, [f.entryId, second.id]);
  });
});

test("Clear all keeps the in-flight intent and cancels its waiting sibling before the deferred drain", async () => {
  await fixture(async (f) => {
    const sibling = addQueued(f.id, { ...common, text: "Cancelled sibling" });
    const request = sendQueuedNow(f.running, f.entryId, () => {}, f.send);
    await conversationChanged(f.idle(), f.send);
    clearQueued(f.id);
    assert.deepEqual(
      queuedMessages(f.id).map((entry) => entry.id),
      [f.entryId],
    );
    assert.equal(takeEditableQueued(f.id, f.entryId), undefined);
    f.requests[0].resolve(null);
    await request;
    assert.deepEqual(f.ordinary, [f.entryId]);
    assert.equal(queuedMessages(f.id).length, 0);
    assert.equal(
      await sendQueuedNow(f.idle(), sibling.id, () => {}, f.send),
      "gone",
    );
    assert.deepEqual(f.ordinary, [f.entryId]);
  });
});

test("a forcibly removed old generation cannot resurrect itself or consume a freshly added queue", async () => {
  await fixture(async (f) => {
    const request = sendQueuedNow(f.running, f.entryId, () => {}, f.send);
    await conversationChanged(f.idle(), f.send);
    removeQueued(f.id, f.entryId);
    const fresh = addQueued(f.id, { ...common, text: "New generation" });
    f.requests[0].reject(new Error("Old failure"));
    assert.equal(await request, "gone");
    assert.deepEqual(f.ordinary, []);
    assert.deepEqual(
      queuedMessages(f.id).map((entry) => entry.id),
      [fresh.id],
    );
    await conversationChanged(f.idle(), f.send);
    assert.deepEqual(f.ordinary, [fresh.id]);
  });
});

test("settling A after switching to B drains only A and cannot clear B's own pending send", async () => {
  await fixture(async (f) => {
    const b = `${f.id}-B`;
    const bEntry = addQueued(b, { ...common, text: "B-owned message" });
    let releaseB!: () => void;
    const bCalls: string[] = [];
    try {
      const a = sendQueuedNow(f.running, f.entryId, () => {}, f.send);
      await conversationChanged(f.idle(["accepted"]), f.send);
      const bSend = conversationChanged(record(b, false), async (entry) => {
        bCalls.push(entry.id);
        await new Promise<void>((resolve) => {
          releaseB = resolve;
        });
      });
      f.requests[0].resolve({ messageId: "accepted", conversation: f.running });
      await a;
      assert.deepEqual(f.ordinary, []);
      assert.equal(queuedMessages(f.id).length, 0);
      assert.equal(queuedMessages(b)[0].steering, true);
      assert.equal(takeEditableQueued(b, bEntry.id), undefined);
      assert.deepEqual(bCalls, [bEntry.id]);
      releaseB();
      await bSend;
      assert.equal(queuedMessages(b).length, 0);
    } finally {
      for (const entry of queuedMessages(b)) removeQueued(b, entry.id);
    }
  });
});
