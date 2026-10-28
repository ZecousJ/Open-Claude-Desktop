import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BackgroundHistory,
  finishedTerminalId,
} from "../../electron/conversations/background-history";
import { registerBackgroundTerminalHandlers } from "../../electron/ipc/background-terminals";
import { Store } from "../../electron/store/store";
import type { Engine } from "../../electron/engine/engine";
import {
  BackgroundTasksPanel,
  elapsedLabel,
} from "../../src/conversation/BackgroundTasksPanel";
import { ConversationPanelButtons } from "../../src/conversation/ConversationPanelButtons";
import type { SidePanel } from "../../src/conversation/ToolSidePanel";
import { AgentTranscriptPanel } from "../../src/transcript/agents/AgentTranscriptPanel";
import {
  ProgressPanel,
  folderOf,
  planDoneCount,
} from "../../src/cowork/ProgressPanel";
import type { Conversation, Mode } from "../../shared/types";

function conversation(mode: Mode, extra: Partial<Conversation> = {}) {
  return {
    id: `c-${mode}`,
    threadId: `thread-${mode}`,
    title: "Synthetic",
    mode,
    providerId: "fixture",
    model: "fixture-model",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    ...extra,
  } satisfies Conversation;
}

test("running time counts like the original panel", () => {
  assert.equal(elapsedLabel(12_400), "12s");
  assert.equal(elapsedLabel(183_000), "3m 03s");
  assert.equal(elapsedLabel(3_720_000), "1h 02m");
  assert.equal(elapsedLabel(-5), "0s");
});

test("title bar offers Terminal and Changes in Code, Activity in Cowork and Chat", () => {
  const render = (mode: Mode, panel: SidePanel | null = null) =>
    renderToStaticMarkup(
      createElement(ConversationPanelButtons, {
        conversation: conversation(mode),
        mode,
        panel,
        onTogglePanel() {},
      }),
    );
  const code = render("code", "terminal");
  assert.match(code, /aria-label="Terminal"/);
  assert.match(code, /aria-label="Changes"/);
  assert.doesNotMatch(code, /Background tasks|Execution log|File changes/);
  assert.match(code, /icon-button active panel-toggle/);
  assert.match(render("cowork"), /aria-label="Activity panel"/);
  assert.doesNotMatch(render("cowork"), /Terminal|Changes/);
  assert.match(render("chat"), /aria-label="Activity panel"/);
});

test("an Agent's transcript panel leads Back to the task list", () => {
  const html = renderToStaticMarkup(
    createElement(AgentTranscriptPanel, {
      conversationId: "c-code",
      agentId: "a1",
      title: "Check greet",
      onBack() {},
      onClose() {},
      onRead: async () => ({
        model: "m",
        context: "",
        status: "running" as const,
        items: [],
        toolUses: 0,
      }),
      onError() {},
    }),
  );
  assert.match(html, /Agent transcript: Check greet/);
  assert.match(html, /Back to background tasks/);
  // No inline sizes: the card's width comes from the workspace (CSS).
  assert.doesNotMatch(html, /flex-basis|min-width/);
});

test("Progress shows the task's steps, produced files and folder", () => {
  const html = renderToStaticMarkup(
    createElement(ProgressPanel, {
      conversation: conversation("cowork", {
        cwd: "/Users/fixture/notes",
        turns: [
          {
            id: "t",
            prompt: "p",
            attachments: [],
            createdAt: 1,
            status: "completed",
            items: [
              {
                id: "plan",
                type: "taskPlan",
                plan: [
                  { step: "Collect", status: "completed" },
                  { step: "Write", status: "inProgress" },
                ],
              },
            ],
          },
        ],
      }),
      onArtifact() {},
    }),
  );
  assert.match(html, /Progress/);
  // Collapsed Progress says "m of m" only once every step is done.
  assert.doesNotMatch(html, /\d of \d/);
  assert.equal(
    planDoneCount([{ status: "completed" }, { status: "inProgress" }]),
    undefined,
  );
  assert.equal(
    planDoneCount([{ status: "completed" }, { status: "completed" }]),
    2,
  );
  assert.equal(planDoneCount([]), undefined);
  // A folder section starts closed, named for the folder.
  assert.match(
    html,
    /progress-section-title"><span data-no-translate="true">notes</,
  );
  // Context starts open, empty until a connector is used.
  assert.match(html, /Track tools and referenced files used in this task/);
});

test("ended background terminals are kept per profile, first status winning", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-finished-"));
  try {
    const history = new BackgroundHistory(root);
    const item = {
      conversationId: "c",
      itemId: "cmd",
      processId: "p1",
      command: "sleep 90",
      cwd: "/tmp",
      finishedAt: 5,
    };
    history.recordFinished({ ...item, status: "stopped" });
    history.recordFinished({ ...item, status: "completed" });
    const reopened = new BackgroundHistory(root);
    assert.deepEqual(reopened.finished("c"), [
      { ...item, status: "stopped", id: finishedTerminalId("c", "p1") },
    ]);
    assert.deepEqual(reopened.finished("other"), []);
    // Clearing keeps the record (it only hides it from the panel).
    reopened.clear([finishedTerminalId("c", "p1")]);
    assert.equal(new BackgroundHistory(root).finished("c").length, 1);
    assert.deepEqual(new BackgroundHistory(root).list(), [
      finishedTerminalId("c", "p1"),
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a terminal gone from Codex's list is Completed, one stopped from the panel Stopped", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-bg-finish-"));
  try {
    const store = new Store(root);
    store.conversations = [conversation("code", { id: "conversation" })];
    store.conversations[0].threadId = "thread";
    let listed = [
      { itemId: "a", processId: "pa", command: "sleep 90", cwd: root },
      { itemId: "b", processId: "pb", command: "sleep 600", cwd: root },
    ];
    let loaded = true;
    const engine = {
      state: { state: "ready" },
      rpc: {
        call: async (method: string, params: any) => {
          if (method === "thread/loaded/list")
            return { data: loaded ? ["thread"] : [] };
          if (method === "thread/backgroundTerminals/list")
            return { data: listed };
          if (method === "thread/backgroundTerminals/terminate") {
            listed = listed.filter((i) => i.processId !== params.processId);
            return { terminated: true };
          }
        },
      },
    } as unknown as Engine;
    const backgroundHistory = new BackgroundHistory(root);
    const handlers = new Map<string, (...args: unknown[]) => any>();
    registerBackgroundTerminalHandlers((name, fn) => handlers.set(name, fn), {
      store,
      engine,
      backgroundHistory,
    });
    const list = () => handlers.get("listBackgroundTerminals")!("conversation");
    assert.equal((await list()).items.length, 2);
    assert.equal(
      await handlers.get("stopBackgroundTerminal")!("conversation", "pb"),
      true,
    );
    // "pa" exits on its own.
    listed = [];
    const after = await list();
    assert.deepEqual(after.items, []);
    assert.deepEqual(
      after.finished.map((i: { processId: string; status: string }) => [
        i.processId,
        i.status,
      ]),
      [
        ["pb", "stopped"],
        ["pa", "completed"],
      ],
    );
    // An unloaded thread is not a listing: nothing is recorded from it.
    listed = [{ itemId: "c", processId: "pc", command: "x", cwd: root }];
    await list();
    loaded = false;
    await list();
    loaded = true;
    listed = [];
    await list();
    assert.equal(
      backgroundHistory
        .finished("conversation")
        .some((i) => i.processId === "pc"),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("with nothing running or finished the panel says so", () => {
  const html = renderToStaticMarkup(
    createElement(BackgroundTasksPanel, {
      conversations: [conversation("code")],
      engineReady: false,
      onClose() {},
      onError() {},
    }),
  );
  assert.match(html, /Background tasks appear here/);
});

test("Progress without a folder has an Outputs section; outputs go to the deepest folder holding them", () => {
  const bare = renderToStaticMarkup(
    createElement(ProgressPanel, {
      conversation: conversation("cowork", {}),
      onArtifact() {},
    }),
  );
  assert.match(bare, /progress-section-title">Outputs</);
  assert.doesNotMatch(bare, /Working folders/);
  const folders = ["/w", "/w/sub", "/other/"];
  assert.equal(folderOf(folders, "/w/a.md"), 0);
  assert.equal(folderOf(folders, "/w/sub/a.md"), 1);
  assert.equal(folderOf(folders, "/other/x/a.md"), 2);
  assert.equal(folderOf(folders, "/elsewhere/a.md"), 0);
  assert.equal(folderOf(folders, undefined), 0);
});
