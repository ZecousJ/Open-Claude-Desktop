import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { registerBackgroundTerminalHandlers } from "../../electron/ipc/background-terminals";
import type { Engine } from "../../electron/engine/engine";
import { BackgroundHistory } from "../../electron/conversations/background-history";

test("background terminal list and termination are scoped to one conversation thread", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-bg-terminal-"));
  try {
    const store = new Store(root);
    store.conversations = [
      {
        id: "conversation",
        title: "Fixture",
        mode: "code",
        providerId: "default",
        model: "fixture",
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
        threadId: "thread",
        turns: [],
      },
    ];
    const calls: Array<{ method: string; params: any }> = [];
    const engine = {
      state: { state: "ready" },
      rpc: {
        call: async (method: string, params: any) => {
          calls.push({ method, params });
          if (method === "thread/loaded/list") return { data: ["thread"] };
          if (method === "thread/backgroundTerminals/list")
            return {
              data: [
                {
                  itemId: "cmd",
                  processId: "process",
                  command: "echo synthetic",
                  cwd: root,
                  osPid: 12,
                  rssKb: 100n,
                },
              ],
            };
          if (method === "thread/backgroundTerminals/terminate")
            return { terminated: true };
        },
      },
    } as unknown as Engine;
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerBackgroundTerminalHandlers((name, fn) => handlers.set(name, fn), {
      store,
      engine,
    });
    const list = (await handlers.get("listBackgroundTerminals")!(
      "conversation",
    )) as { items: Array<Record<string, unknown>> };
    assert.deepEqual(list.items, [
      {
        conversationId: "conversation",
        itemId: "cmd",
        processId: "process",
        command: "echo synthetic",
        cwd: root,
      },
    ]);
    await assert.rejects(
      handlers.get("stopBackgroundTerminal")!(
        "conversation",
        "other",
      ) as Promise<unknown>,
      /not in this conversation/,
    );
    assert.equal(
      await handlers.get("stopBackgroundTerminal")!("conversation", "process"),
      true,
    );
    assert.deepEqual(calls.at(-1), {
      method: "thread/backgroundTerminals/terminate",
      params: { threadId: "thread", processId: "process" },
    });
    const hiddenEngine = {
      ...engine,
      rpc: {
        call: async (method: string) =>
          method === "thread/loaded/list"
            ? { data: [] }
            : assert.fail("Unloaded thread should not be queried."),
      },
    } as unknown as Engine;
    const hidden = new Map<string, (...args: unknown[]) => unknown>();
    registerBackgroundTerminalHandlers((name, fn) => hidden.set(name, fn), {
      store,
      engine: hiddenEngine,
    });
    assert.deepEqual(
      (
        (await hidden.get("listBackgroundTerminals")!("conversation")) as {
          items: unknown[];
        }
      ).items,
      [],
    );
    await assert.rejects(
      handlers.get("listBackgroundTerminals")!("other") as Promise<unknown>,
      /Conversation not found/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a terminal stopped from the panel stays stopped when a listing sees it gone first", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-bg-stop-race-"));
  try {
    const store = new Store(root);
    store.conversations = [
      {
        id: "conversation",
        title: "Fixture",
        mode: "code",
        providerId: "default",
        model: "fixture",
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
        threadId: "thread",
        turns: [],
      },
    ];
    let running = true;
    let release: (value: { terminated: boolean }) => void = () => {};
    const engine = {
      state: { state: "ready" },
      rpc: {
        call: async (method: string) => {
          if (method === "thread/loaded/list") return { data: ["thread"] };
          if (method === "thread/backgroundTerminals/list")
            return {
              data: running
                ? [
                    {
                      itemId: "cmd",
                      processId: "process",
                      command: "sleep 600",
                      cwd: root,
                    },
                  ]
                : [],
            };
          if (method === "thread/backgroundTerminals/terminate")
            return new Promise((resolve) => (release = resolve));
        },
      },
    } as unknown as Engine;
    const backgroundHistory = new BackgroundHistory(root);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerBackgroundTerminalHandlers((name, fn) => handlers.set(name, fn), {
      store,
      engine,
      backgroundHistory,
    });
    const list = () => handlers.get("listBackgroundTerminals")!("conversation");
    await list();
    const stopped = handlers.get("stopBackgroundTerminal")!(
      "conversation",
      "process",
    ) as Promise<boolean>;
    await new Promise((resolve) => setImmediate(resolve));
    running = false;
    // Another poll finds the terminal gone while the stop is still pending.
    await list();
    assert.deepEqual(backgroundHistory.finished("conversation"), []);
    release({ terminated: true });
    assert.equal(await stopped, true);
    assert.deepEqual(
      backgroundHistory.finished("conversation").map((item) => item.status),
      ["stopped"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
