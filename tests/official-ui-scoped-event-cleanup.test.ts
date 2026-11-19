/** Inert event hosts and completion batches only; no engine, account, or network IO. */
import test from "node:test";
import assert from "node:assert/strict";
import { guardAdapterContext } from "../electron/official-ui/api/scoped-context";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
import { openOfficialCompletion } from "../shared/official-completion-stream";
const terminal = {
  type: "signed-out",
  reason: "session-expired",
  message: "The account session changed. Reopen the conversation.",
};
function fixture(install?: (f: any) => void, stopThrows = false) {
  let owner = "a",
    identity = {},
    current = true,
    listener: (e: any) => void = () => {},
    offCount = 0;
  const order: string[] = [];
  const scope = newAdapterScope(owner, undefined, identity);
  const f = {
    order,
    scope,
    emit: (e: any) => listener(e),
    retire: () => {
      current = false;
    },
    switch: () => {
      owner = "b";
    },
    reactivate: () => {
      identity = {};
    },
    offCount: () => offCount,
    ctx: null as any,
  };
  f.ctx = guardAdapterContext({
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    isCurrent: () => current,
    onEvent: (fn: any) => {
      listener = fn;
      install?.(f);
      return () => {
        offCount++;
        order.push("off");
        listener({ type: "reentrant-private" });
        if (stopThrows) throw Error("stop failed");
      };
    },
  } as never);
  return f;
}
for (const kind of ["retire", "switch", "reactivate"] as const)
  test(`${kind}: detach before one sanitized terminal, no revival or reentrant delivery`, () => {
    const f = fixture(),
      events: any[] = [];
    const off = inAdapterScope(f.scope, () =>
      f.ctx.onEvent((e: any) => {
        f.order.push("event");
        events.push(e);
        f.emit({ type: "reentrant-private" });
      }),
    );
    f[kind]();
    f.emit({ type: "conversation", private: "must not escape" });
    f.emit({ type: "signed-out", message: "private" });
    off();
    off();
    assert.deepEqual(events, [terminal]);
    assert.deepEqual(f.order, ["off", "event"]);
    assert.equal(f.offCount(), 1);
  });
test("normal events remain unchanged and explicit disposal is idempotent", () => {
  const f = fixture(),
    events: any[] = [];
  const off = inAdapterScope(f.scope, () =>
    f.ctx.onEvent((e: any) => events.push(e)),
  );
  const e = { type: "resync" };
  f.emit(e);
  assert.equal(events[0], e);
  off();
  off();
  f.emit(e);
  assert.equal(events.length, 1);
  assert.equal(f.offCount(), 1);
});
test("synchronous stale subscribe obtains disposer before terminal delivery", () => {
  const f = fixture((f) => {
      f.retire();
      f.emit({ type: "private" });
      f.emit({ type: "private" });
    }),
    events: any[] = [];
  const off = inAdapterScope(f.scope, () =>
    f.ctx.onEvent((e: any) => {
      f.order.push("event");
      events.push(e);
    }),
  );
  assert.deepEqual(f.order, ["off", "event"]);
  assert.deepEqual(events, [terminal]);
  off();
  assert.equal(f.offCount(), 1);
});
test("silent retirement during installation also closes after disposer is obtained", () => {
  const f = fixture((f) => f.retire()),
    events: any[] = [];
  inAdapterScope(f.scope, () => f.ctx.onEvent((e: any) => events.push(e)));
  assert.deepEqual(events, [terminal]);
  assert.equal(f.offCount(), 1);
});
test("throwing detach still delivers terminal once; throwing listener cannot retain subscription", () => {
  const f = fixture(undefined, true);
  let count = 0;
  inAdapterScope(f.scope, () =>
    f.ctx.onEvent(() => {
      count++;
      throw Error("listener failed");
    }),
  );
  f.retire();
  assert.throws(() => f.emit({ type: "private" }), /listener failed/);
  f.emit({ type: "private" });
  assert.equal(count, 1);
  assert.equal(f.offCount(), 1);
});
test("synchronous current listener throw is deferred until returned disposer has been called", () => {
  const f = fixture((f) => f.emit({ type: "resync" }));
  let count = 0;
  assert.throws(
    () =>
      inAdapterScope(f.scope, () =>
        f.ctx.onEvent(() => {
          count++;
          throw Error("sync failed");
        }),
      ),
    /sync failed/,
  );
  f.emit({ type: "resync" });
  assert.equal(count, 1);
  assert.equal(f.offCount(), 1);
});
test("asynchronous current listener throw also disposes", () => {
  const f = fixture();
  inAdapterScope(f.scope, () =>
    f.ctx.onEvent(() => {
      throw Error("failed");
    }),
  );
  assert.throws(() => f.emit({ type: "resync" }), /failed/);
  assert.equal(f.offCount(), 1);
  f.emit({ type: "resync" });
});
const id = "11111111-1111-4111-8111-111111111111";
const request = {
  method: "POST" as const,
  path: `/api/organizations/${id}/chat_conversations/${id}/completion`,
};
const answer = {
  status: 200,
  contentType: "application/json",
  body: new TextEncoder().encode(
    JSON.stringify({
      operation_id: id,
      cursor: 1,
      done: false,
      events: [{ event: "message_start", data: { type: "message_start" } }],
    }),
  ),
};
test("real completion under unread backpressure aborts and unsubscribes on stale event without read or replay", async () => {
  const f = fixture();
  let reads = 0,
    actions = 0;
  const response = await inAdapterScope(f.scope, () =>
    openOfficialCompletion(
      request,
      new AbortController().signal,
      async () => {
        reads++;
        return answer;
      },
      async () => {
        actions++;
        return answer;
      },
      (fn) => f.ctx.onEvent(fn),
      { pollMs: 5, deadlineMs: 1000 },
    ),
  );
  // Initial event fills the queue; deliberately do not acquire a reader yet.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reads, 0);
  assert.equal(f.offCount(), 0);
  f.retire();
  f.emit({ type: "conversation", private: "old-account" });
  assert.equal(f.offCount(), 1);
  await assert.rejects(response.body!.getReader().read(), {
    name: "AbortError",
  });
  assert.equal(actions, 1);
  assert.equal(reads, 0);
});
test("retirement during pending opening aborts immediately and late action cannot revive subscription", async () => {
  const f = fixture();
  let resolve!: (v: any) => void,
    actions = 0;
  const pending = new Promise<any>((r) => (resolve = r));
  const opened = inAdapterScope(f.scope, () =>
    openOfficialCompletion(
      request,
      new AbortController().signal,
      async () => {
        throw Error("unexpected read");
      },
      () => {
        actions++;
        return pending;
      },
      (fn) => f.ctx.onEvent(fn),
      { deadlineMs: 1000 },
    ),
  );
  f.retire();
  f.emit({ type: "private" });
  await assert.rejects(opened, { name: "AbortError" });
  resolve(answer);
  await Promise.resolve();
  assert.equal(f.offCount(), 1);
  assert.equal(actions, 1);
});
test("synchronous retirement listener throw occurs only after physical detach", () => {
  const f = fixture((f) => {
    f.retire();
    f.emit({ type: "private" });
  });
  assert.throws(
    () =>
      inAdapterScope(f.scope, () =>
        f.ctx.onEvent(() => {
          assert.equal(f.offCount(), 1);
          throw Error("terminal failed");
        }),
      ),
    /terminal failed/,
  );
  f.emit({ type: "private" });
  assert.equal(f.offCount(), 1);
});
test("retirement without any subsequent host event still relies on existing deadline", async () => {
  const f = fixture();
  const response = await inAdapterScope(f.scope, () =>
    openOfficialCompletion(
      request,
      new AbortController().signal,
      async () => {
        throw Error("unexpected read");
      },
      async () => answer,
      (fn) => f.ctx.onEvent(fn),
      { pollMs: 5, deadlineMs: 30 },
    ),
  );
  f.retire();
  assert.equal(f.offCount(), 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.offCount(), 1);
  const text = await response.text();
  assert.match(text, /timed out/);
  assert.doesNotMatch(text, /message_stop/);
});
