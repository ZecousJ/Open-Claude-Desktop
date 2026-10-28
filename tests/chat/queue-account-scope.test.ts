import test from "node:test";
import assert from "node:assert/strict";
import { StrictMode, createElement, useEffect, useLayoutEffect } from "react";
import type { AppEvent, Conversation, DesktopAPI } from "../../shared/types";
import { workspaceTrustMessage } from "../../shared/workspace-trust-api";
import {
  activateQueuedAccount,
  addQueued,
  queuedMessages,
  removeQueued,
} from "../../src/composer/queue";
import {
  conversationChanged,
  sendQueued,
  sendQueuedNow,
  watchQueuedMessages,
} from "../../src/composer/queue";
import {
  currentTrustQuestion,
  mountTrustHost,
} from "../../src/workspace-trust/trust-request";
import { routineDom } from "../support/routine-dom";
import { flush, json, signedInBridge } from "../app/web-bridge-fakes.test.ts";
import { readSource } from "../support/read-source";

const common = {
  text: "A-owned queued text",
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
    title: "Synthetic queue account",
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function installWindow(bridge: DesktopAPI) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { desktop: bridge },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  };
}
function clear(id: string) {
  for (const entry of queuedMessages(id)) removeQueued(id, entry.id);
}
function fakeBridge(extra: Partial<DesktopAPI> = {}) {
  const live = new Set<(event: AppEvent) => void>();
  const retained: ((event: AppEvent) => void)[] = [];
  const sends: unknown[] = [];
  let stopped = 0;
  const api = {
    onEvent(callback: (event: AppEvent) => void) {
      live.add(callback);
      retained.push(callback);
      return () => {
        if (live.delete(callback)) stopped++;
      };
    },
    send: async (input: unknown) => {
      sends.push(input);
      return null;
    },
    ...extra,
  } as unknown as DesktopAPI;
  return {
    api,
    live,
    retained,
    sends,
    get stopped() {
      return stopped;
    },
    emit(conversation: Conversation) {
      for (const callback of live)
        callback({ type: "conversation", conversation });
    },
  };
}

for (const returnToA of [false, true]) {
  for (const outcome of ["held", "rejected", "unread", "consumed"] as const) {
    test(`real WebAuth ${returnToA ? "A→B→A" : "A→B"} on one bridge isolates an old ${outcome} steer`, async () => {
      const pending = deferred<unknown>();
      const id = `same-bridge-account-${++serial}`;
      const setup = await signedInBridge((method) =>
        method === "snapshot"
          ? { conversations: [], platform: "linux" }
          : method === "steerTurn"
            ? pending.promise
            : null,
      );
      const { bridge, tab, service, calls } = setup;
      const restore = installWindow(bridge.api);
      let release = activateQueuedAccount("42");
      const oldRelease = release;
      const upserts: Conversation[] = [];
      try {
        watchQueuedMessages();
        const socket = tab.sockets.at(-1)!;
        socket.open();
        socket.receive({ t: "ready", v: 1, seq: 0, resumed: false });
        const entry = addQueued(id, common);
        const request = sendQueuedNow(record(id, true), entry.id, (c) =>
          upserts.push(c),
        );
        await flush();
        socket.receive({
          t: "event",
          seq: 1,
          event: { type: "conversation", conversation: record(id, false) },
        });
        release(); // AuthGate's keyed App unmounts before the chooser switches.
        tab.routes.unshift((request) =>
          request.url.endsWith("/auth/refresh") &&
          (request.body as { account?: string })?.account === "2"
            ? json({
                code: 0,
                data: {
                  access_token: "at-account-B",
                  expires_in: 3600,
                  user: { id: 2, email: "b@example.test", username: "B" },
                },
              })
            : undefined,
        );
        service.valid.add("at-account-B");
        await bridge.api.switchAccount("2");
        release = activateQueuedAccount("2");
        watchQueuedMessages();
        assert.equal(window.desktop, bridge.api);
        assert.equal(queuedMessages(id).length, 0);
        const ownB = addQueued(id, { ...common, text: "B-owned queued text" });
        if (returnToA) {
          release();
          await bridge.api.switchAccount("42");
          release = activateQueuedAccount("42");
          watchQueuedMessages();
          oldRelease(); // A prior cleanup cannot unsubscribe this new A lease.
        }
        if (outcome === "rejected")
          pending.reject(new Error("Old A steer refused"));
        else
          pending.resolve(
            outcome === "held"
              ? null
              : {
                  messageId: "accepted-A",
                  conversation: record(
                    id,
                    outcome === "unread",
                    outcome === "consumed" ? ["accepted-A"] : [],
                  ),
                },
          );
        assert.equal(await request, "gone");
        assert.deepEqual(upserts, []);
        assert.deepEqual(
          calls.filter((c) => c.method === "send"),
          [],
        );
        if (returnToA) {
          if (outcome === "consumed")
            assert.equal(queuedMessages(id).length, 0);
          else {
            assert.equal(queuedMessages(id)[0].id, entry.id);
            assert.equal(queuedMessages(id)[0].steering, undefined);
            assert.equal(queuedMessages(id)[0].error, undefined);
            if (outcome === "unread") {
              await conversationChanged(record(id, false), sendQueued);
              assert.equal(queuedMessages(id).length, 0);
            } else
              assert.equal(
                await sendQueuedNow(record(id, false), entry.id, () => {}),
                "sent",
              );
          }
          release();
          await bridge.api.switchAccount("2");
          release = activateQueuedAccount("2");
          watchQueuedMessages();
        }
        assert.equal(queuedMessages(id)[0].id, ownB.id);
        assert.equal(
          await sendQueuedNow(record(id, false), ownB.id, () => {}),
          "sent",
        );
        const retriedA = returnToA && outcome !== "consumed";
        const sourceWhitelist = new Map<string, string>([
          ["Bearer at-account-B", "B-owned queued text"],
        ]);
        if (retriedA) sourceWhitelist.set("Bearer at-2", "A-owned queued text");
        const sends = calls.filter((c) => c.method === "send");
        assert.equal(sends.length, retriedA ? 2 : 1);
        for (const call of sends) {
          const input = call.args[0] as {
            text: string;
            conversationId: string;
          };
          assert.equal(input.conversationId, id);
          assert.equal(
            sourceWhitelist.get(call.request.headers.get("authorization")!),
            input.text,
            "only the current account's explicitly authorized queue may enter that transport",
          );
        }
      } finally {
        clear(id);
        release();
        const clearA = activateQueuedAccount("42");
        clear(id);
        clearA();
        const clearB = activateQueuedAccount("2");
        clear(id);
        clearB();
        bridge.dispose();
        restore();
      }
    });
  }
}

test("an old account's pending normal send cannot finish or unlock the next account's colliding queue", async () => {
  const first = deferred<Conversation>(),
    second = deferred<Conversation>();
  let user = "A";
  const sourceWhitelist = new Map([
    ["A", "A-owned queued text"],
    ["B", "B-owned queued text"],
  ]);
  const calls: { user: string; text: string }[] = [];
  const bridge = fakeBridge({
    send: async (input) => {
      calls.push({ user, text: input.text });
      return user === "A" ? first.promise : second.promise;
    },
  });
  const restore = installWindow(bridge.api);
  const id = `normal-account-${++serial}`,
    a = `normal-A-${serial}`,
    b = `normal-B-${serial}`;
  let release = activateQueuedAccount(a);
  try {
    const entryA = addQueued(id, common);
    const requestA = sendQueuedNow(record(id, false), entryA.id, () => {});
    release();
    user = "B";
    release = activateQueuedAccount(b);
    const entryB = addQueued(id, { ...common, text: "B-owned queued text" });
    const requestB = sendQueuedNow(record(id, false), entryB.id, () => {});
    first.resolve(record(id, false));
    assert.equal(await requestA, "gone");
    assert.equal(queuedMessages(id)[0].id, entryB.id);
    assert.equal(queuedMessages(id)[0].steering, true);
    second.resolve(record(id, false));
    assert.equal(await requestB, "sent");
    assert.equal(queuedMessages(id).length, 0);
    assert.equal(calls.length, 2);
    for (const call of calls)
      assert.equal(call.text, sourceWhitelist.get(call.user));
    release();
    release = activateQueuedAccount(a);
    assert.equal(
      queuedMessages(id).length,
      0,
      "the original successful send settles only A's entry",
    );
  } finally {
    clear(id);
    release();
    const clearB = activateQueuedAccount(b);
    clear(id);
    clearB();
    restore();
  }
});

test("a replaced bridge retires its watcher and old pending fallback while keeping the account's intent", async () => {
  const pending = deferred<null>();
  const a = fakeBridge({ steerTurn: () => pending.promise });
  const b = fakeBridge();
  const restore = installWindow(a.api);
  const release = activateQueuedAccount(`bridge-owner-${++serial}`);
  const id = `bridge-replacement-${serial}`;
  try {
    watchQueuedMessages();
    const entry = addQueued(id, common);
    const upserts: Conversation[] = [];
    const request = sendQueuedNow(record(id, true), entry.id, (c) =>
      upserts.push(c),
    );
    a.emit(record(id, false));
    window.desktop = b.api;
    watchQueuedMessages();
    assert.equal(a.live.size, 0);
    assert.equal(a.stopped, 1);
    assert.equal(b.live.size, 1);
    for (const old of a.retained)
      old({ type: "conversation", conversation: record(id, false) });
    pending.resolve(null);
    assert.equal(await request, "gone");
    assert.deepEqual(upserts, []);
    assert.deepEqual(a.sends, []);
    assert.deepEqual(b.sends, []);
    assert.equal(queuedMessages(id)[0].steering, undefined);
    b.emit(record(id, false));
    await flush();
    assert.equal(b.sends.length, 1);
    assert.equal((b.sends[0] as { text: string }).text, common.text);
    assert.equal(queuedMessages(id).length, 0);
  } finally {
    clear(id);
    release();
    restore();
  }
});

test("an old lease cannot clear a new same-account pending batch or publish its old snapshot", async () => {
  const first = deferred<unknown>(),
    second = deferred<unknown>();
  let count = 0;
  const bridge = fakeBridge({
    steerTurn: () => (++count === 1 ? first.promise : second.promise),
  } as Partial<DesktopAPI>);
  const restore = installWindow(bridge.api);
  const owner = `lease-owner-${++serial}`,
    id = `lease-request-${serial}`;
  let release = activateQueuedAccount(owner);
  const oldRelease = release;
  try {
    watchQueuedMessages();
    const original = addQueued(id, common);
    const oldUpserts: Conversation[] = [],
      newUpserts: Conversation[] = [];
    const oldRequest = sendQueuedNow(record(id, true), original.id, (c) =>
      oldUpserts.push(c),
    );
    release();
    release = activateQueuedAccount(owner);
    watchQueuedMessages();
    const newer = addQueued(id, { ...common, text: "New lease message" });
    const newRequest = sendQueuedNow(record(id, true), newer.id, (c) =>
      newUpserts.push(c),
    );
    oldRelease();
    assert.equal(bridge.live.size, 1);
    bridge.emit(record(id, false, ["old-read", "new-read"]));
    first.resolve({
      messageId: "old-read",
      conversation: record(id, false, ["old-read"]),
    });
    assert.equal(await oldRequest, "gone");
    assert.deepEqual(oldUpserts, []);
    assert.equal(queuedMessages(id)[0].id, newer.id);
    assert.equal(queuedMessages(id)[0].steering, true);
    bridge.emit(record(id, false, ["new-read"]));
    assert.deepEqual(bridge.sends, []);
    second.resolve({
      messageId: "new-read",
      conversation: record(id, false, ["new-read"]),
    });
    assert.equal(await newRequest, "steered");
    assert.equal(newUpserts.length, 1);
    assert.deepEqual(bridge.sends, []);
    assert.equal(queuedMessages(id).length, 0);
  } finally {
    clear(id);
    release();
    restore();
  }
});

for (const wait of ["answer", "save"] as const) {
  test(`a trust ${wait} awaited across account change cannot save or retry using the next account`, async () => {
    let user = "A";
    const sent: string[] = [],
      saved: string[] = [];
    const pendingSave = deferred<{
      folder: string;
      root: string;
      sources: string[];
      trusted: boolean;
    }>();
    const trust = {
      folder: "/synthetic",
      root: "/synthetic",
      sources: [],
      trusted: false,
    };
    const bridge = fakeBridge({
      send: async () => {
        sent.push(user);
        throw new Error(workspaceTrustMessage);
      },
      checkWorkspaceTrust: async () => trust,
      saveWorkspaceTrust: async () => {
        saved.push(user);
        return wait === "save"
          ? pendingSave.promise
          : { ...trust, trusted: true };
      },
    });
    const restore = installWindow(bridge.api);
    const a = `trust-A-${++serial}`,
      b = `trust-B-${serial}`,
      id = `trust-${serial}`;
    let release = activateQueuedAccount(a);
    const unmount = mountTrustHost();
    try {
      watchQueuedMessages();
      const entry = addQueued(id, { ...common, mode: "code" });
      const request = sendQueuedNow(
        { ...record(id, false), mode: "code", cwd: trust.folder },
        entry.id,
        () => {},
      );
      await flush();
      const question = currentTrustQuestion()!;
      assert.ok(question);
      if (wait === "save") {
        question.answer(true);
        await flush();
        assert.deepEqual(saved, ["A"]);
      }
      release();
      user = "B";
      release = activateQueuedAccount(b);
      watchQueuedMessages();
      const ownB = addQueued(id, { ...common, text: "B remains queued" });
      if (wait === "answer") question.answer(true);
      else pendingSave.resolve({ ...trust, trusted: true });
      assert.equal(await request, "gone");
      assert.deepEqual(sent, ["A"]);
      assert.deepEqual(saved, wait === "save" ? ["A"] : []);
      assert.equal(queuedMessages(id)[0].id, ownB.id);
      assert.equal(queuedMessages(id)[0].steering, undefined);
      release();
      release = activateQueuedAccount(a);
      assert.equal(queuedMessages(id)[0].id, entry.id);
      assert.equal(queuedMessages(id)[0].steering, undefined);
      assert.equal(queuedMessages(id)[0].error, undefined);
    } finally {
      unmount();
      clear(id);
      release();
      const clearB = activateQueuedAccount(b);
      clear(id);
      clearB();
      restore();
    }
  });
}

test("account isolation keeps queues across normal conversation navigation and never drains a colliding foreign ID", async () => {
  const bridge = fakeBridge();
  const restore = installWindow(bridge.api);
  const owner = `navigation-A-${++serial}`,
    other = `navigation-B-${serial}`;
  const id = `navigation-${serial}`,
    second = `${id}-other`;
  let release = activateQueuedAccount(owner);
  try {
    watchQueuedMessages();
    const first = addQueued(id, common);
    const next = addQueued(second, {
      ...common,
      text: "Second conversation intent",
    });
    assert.equal(queuedMessages(second)[0].id, next.id);
    assert.equal(queuedMessages(id)[0].id, first.id);
    bridge.emit(record(second, false));
    await flush();
    assert.equal(queuedMessages(id)[0].id, first.id);
    release();
    release = activateQueuedAccount(other);
    watchQueuedMessages();
    bridge.emit(record(id, false));
    await flush();
    assert.equal(queuedMessages(id).length, 0);
    assert.equal(bridge.sends.length, 1);
    release();
    release = activateQueuedAccount(owner);
    watchQueuedMessages();
    assert.equal(queuedMessages(id)[0].id, first.id);
    bridge.emit(record(id, false));
    await flush();
    assert.equal(bridge.sends.length, 2);
    assert.equal(queuedMessages(id).length, 0);
  } finally {
    clear(id);
    clear(second);
    release();
    restore();
  }
});

test("real StrictMode setup/cleanup keeps one current watcher and stale cleanup cannot unsubscribe its successor", async () => {
  const bridge = fakeBridge();
  const dom = await routineDom(bridge.api);
  const owners = [`strict-A-${++serial}`, `strict-B-${serial}`];
  const id = `strict-${serial}`;
  const cleanups: (() => void)[] = [];
  function Scope({ owner }: { owner: string }) {
    useLayoutEffect(() => {
      const release = activateQueuedAccount(owner);
      cleanups.push(release);
      return release;
    }, [owner]);
    useEffect(() => {
      watchQueuedMessages();
    }, []);
    return createElement("span", null, owner);
  }
  try {
    await dom.render(
      createElement(
        StrictMode,
        null,
        createElement(Scope, { owner: owners[0], key: owners[0] }),
      ),
    );
    assert.equal(bridge.live.size, 1);
    assert.ok(
      bridge.stopped >= 1,
      "StrictMode's first lease was actually cleaned up",
    );
    const first = addQueued(id, common);
    await dom.render(
      createElement(
        StrictMode,
        null,
        createElement(Scope, { owner: owners[1], key: owners[1] }),
      ),
    );
    assert.equal(bridge.live.size, 1);
    const ownB = addQueued(id, { ...common, text: "Strict B message" });
    cleanups[0]();
    for (const old of bridge.retained.slice(0, -1))
      old({ type: "conversation", conversation: record(id, false) });
    assert.equal(bridge.live.size, 1);
    assert.equal(queuedMessages(id)[0].id, ownB.id);
    bridge.emit(record(id, false));
    await flush();
    assert.equal(bridge.sends.length, 1);
    assert.equal(
      (bridge.sends[0] as { text: string }).text,
      "Strict B message",
    );
    await dom.render(createElement("div"));
    assert.equal(bridge.live.size, 0);
    const clearA = activateQueuedAccount(owners[0]);
    assert.equal(queuedMessages(id)[0].id, first.id);
    clear(id);
    clearA();
  } finally {
    await dom.clean();
  }
});

test("the real App activates queues at the same account layout boundary as settings and routine reads", () => {
  const source = readSource("src/app/App.tsx");
  assert.match(
    source,
    /import \{ activateQueuedAccount \} from "\.\.\/composer\/queue"/,
  );
  assert.match(
    source,
    /useLayoutEffect\(\(\) => activateQueuedAccount\(accountId\), \[accountId\]\)/,
  );
});
