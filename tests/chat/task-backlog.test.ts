import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskBacklog } from "../../electron/conversations/task-backlog";
import { registerTaskBacklogHandlers } from "../../electron/ipc/task-backlog";
import type { AppContext } from "../../electron/app/app-context";
import type { EngineExtension } from "../../electron/engine/engine-extensions";
import type { Conversation } from "../../shared/types";
import { webMethodKind } from "../../shared/web-bridge-methods";
import { appendTaskPrompt } from "../../shared/task-backlog";

test("taking a backlog task preserves an existing composer draft", () => {
  assert.equal(appendTaskPrompt("", "Fix tests"), "Fix tests");
  assert.equal(
    appendTaskPrompt("My draft", "Fix tests"),
    "My draft\n\nFix tests",
  );
  assert.equal(appendTaskPrompt("My draft", "  "), "My draft");
});

test("task backlog deduplicates, expires, and caps by folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-backlog-"));
  try {
    let now = 1_000_000;
    const backlog = new TaskBacklog(root, () => now);
    const suggestion = (id: string, cwd = "/work") => ({
      id,
      title: id,
      prompt: `fix ${id}`,
      cwd,
      createdAt: now,
    });
    backlog.file("session", suggestion("a"), "dismissed");
    backlog.file("session", suggestion("a"), "dismissed");
    assert.equal(backlog.list("/work").length, 1);
    for (let index = 0; index < 25; index++) {
      now++;
      backlog.file("session", suggestion(`task-${index}`), "evicted");
    }
    assert.equal(backlog.list("/work").length, 20);
    const first = backlog.list("/work")[0];
    assert.equal(backlog.dismiss(first.id), true);
    assert.equal(backlog.dismiss(first.id), false);
    assert.equal(backlog.list("/work").length, 19);
    for (let folder = 0; folder < 6; folder++)
      for (let index = 0; index < 20; index++) {
        now++;
        backlog.file(
          "session",
          suggestion(`folder-${folder}-${index}`, `/folder-${folder}`),
          "evicted",
        );
      }
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "task-backlog.json"), "utf8"))
        .length,
      100,
    );
    now += 31 * 86400000;
    assert.deepEqual(backlog.list("/work"), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("suggestions are consumed once, filed on dismissal, and launched through the runner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-suggestions-"));
  try {
    const value = {
      id: "session",
      mode: "code",
      cwd: root,
      turns: [],
    } as unknown as Conversation;
    const handlers = new Map<string, (...args: any[]) => any>();
    let extension: EngineExtension | undefined;
    const events: unknown[] = [];
    const sends: unknown[] = [];
    const engine = {
      peerExtensions: [],
      extensions: {
        add: (entry: EngineExtension) => {
          extension = entry;
          return () => {};
        },
      },
      send: async (input: unknown) => {
        sends.push(input);
        return { id: "child" };
      },
    };
    const context = {
      store: {
        root,
        conversations: [value],
        conversation: () => value,
        flush() {},
      },
      engine,
      services: {},
      allowedFolder: (cwd: string) => assert.equal(cwd, root),
      push: (event: unknown) => events.push(event),
      onAccountActivated: (activate: () => void) => activate(),
      onAccountDeactivating() {},
    } as unknown as AppContext;
    registerTaskBacklogHandlers(
      (name, handler) => handlers.set(name, handler),
      context,
    );
    const spawn = async () => {
      const result = await extension!.handleDynamicTool!({
        conversation: value,
        namespace: null,
        tool: "spawn_task",
        arguments: { title: "Fix tests", prompt: "Fix the failing tests" },
        changed() {},
      } as Parameters<NonNullable<EngineExtension["handleDynamicTool"]>>[0]);
      assert.equal(result?.success, true);
      return value.backgroundTaskSuggestions!.at(-1)!;
    };
    const taken = await spawn();
    assert.equal(
      handlers.get("popBackgroundTaskSuggestionById")!(
        value.id,
        taken.id,
        true,
      ),
      true,
    );
    assert.equal(
      handlers.get("popBackgroundTaskSuggestionById")!(
        value.id,
        taken.id,
        true,
      ),
      false,
    );
    assert.deepEqual(new TaskBacklog(root).list(root), []);
    assert.equal(sends.length, 0);
    const dismissed = await spawn();
    assert.equal(
      handlers.get("popBackgroundTaskSuggestionById")!(
        value.id,
        dismissed.id,
        false,
      ),
      true,
    );
    assert.equal(new TaskBacklog(root).list(root)[0].prompt, dismissed.prompt);
    const launched = await spawn();
    assert.equal(
      await handlers.get("launchBackgroundTaskSuggestion")!(
        value.id,
        launched.id,
      ),
      "child",
    );
    assert.equal(
      await handlers.get("launchBackgroundTaskSuggestion")!(
        value.id,
        launched.id,
      ),
      null,
    );
    assert.equal(sends.length, 1);
    assert.ok(events.length);
    assert.equal(
      webMethodKind("launchBackgroundTaskSuggestion"),
      "remote-runner",
    );
    value.incognito = true;
    assert.throws(() => handlers.get("backgroundTaskSuggestions")!(value.id));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a remote session's suggestions are checked in its own environment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-remote-tasks-"));
  try {
    const environment = { kind: "ssh", hostId: "host-1" } as const;
    const value = {
      id: "session",
      mode: "code",
      cwd: "/home/dev/app",
      environment,
      turns: [],
    } as unknown as Conversation;
    let extension: EngineExtension | undefined;
    const checked: unknown[] = [];
    const trusted: unknown[] = [];
    const context = {
      store: {
        root,
        conversations: [value],
        conversation: () => value,
        flush() {},
      },
      engine: {
        peerExtensions: [],
        extensions: {
          add: (entry: EngineExtension) => {
            extension = entry;
            return () => {};
          },
        },
      },
      services: {
        workspaceTrust: { assert: (input: unknown) => trusted.push(input) },
      },
      allowedFolder: (cwd: string, place: unknown) =>
        checked.push([cwd, place]),
      push() {},
      onAccountActivated: (activate: () => void) => activate(),
      onAccountDeactivating() {},
    } as unknown as AppContext;
    registerTaskBacklogHandlers(() => {}, context);
    // The remote path is not on this disk: it is not checked there.
    const result = await extension!.handleDynamicTool!({
      conversation: value,
      namespace: null,
      tool: "spawn_task",
      arguments: { prompt: "Fix the failing tests" },
      changed() {},
    } as Parameters<NonNullable<EngineExtension["handleDynamicTool"]>>[0]);
    assert.equal(result?.success, true);
    assert.equal(value.backgroundTaskSuggestions?.[0].cwd, "/home/dev/app");
    assert.deepEqual(checked, [
      ["/home/dev/app", environment],
      ["/home/dev/app", environment],
    ]);
    assert.deepEqual(
      trusted.map((input: any) => input.conversation.environment),
      [environment, environment],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
