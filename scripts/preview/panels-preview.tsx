/**
 * preview/panels.html: the app fixture (app-preview.tsx) plus the states the
 * right-side tool panels need: a Cowork task with a plan, a produced file and a
 * folder (Progress), a Code task with a finished child Agent (its transcript),
 * and ended background terminals under Finished. Everything is synthetic;
 * nothing runs.
 */
import type {
  Conversation,
  DesktopAPI,
  Item,
  Snapshot,
} from "../../shared/types";
import type { FinishedBackgroundTerminal } from "../../shared/panels-api";
import { createFixtureDesktop, type FixtureOptions } from "./app-fixture";

const params = new URLSearchParams(location.search);
const desktop = createFixtureDesktop(
  {
    history: "full",
    states: params.get("states") === "1",
    approval: (params.get("approval") ??
      undefined) as FixtureOptions["approval"],
  },
  params,
);
// The base fixture's own calls, before the overrides below replace them.
const base = {
  snapshot: desktop.snapshot,
  updateConversation: desktop.updateConversation,
  listBackgroundTerminals: desktop.listBackgroundTerminals,
  stopBackgroundTerminal: desktop.stopBackgroundTerminal,
};
/** Same origin as app-fixture.ts. */
const origin = Date.UTC(2026, 8, 24, 9);
const minute = 60_000;

function coworkConversation(): Conversation {
  const createdAt = origin - 5 * minute;
  return {
    id: "c-cowork-progress",
    threadId: "thread-cowork-progress",
    title: "Sidebar and popover recommendations",
    mode: "cowork",
    cwd: "/Users/fixture/research-notes",
    providerId: "fixture",
    model: "Opus 5.5",
    pinned: false,
    archived: false,
    createdAt,
    updatedAt: origin + 2 * minute,
    turns: [
      {
        id: "t-cowork-progress",
        prompt: "Compare compact and comfortable sidebars and write it up.",
        attachments: [],
        status: "completed",
        createdAt,
        items: [
          {
            id: "plan-cowork",
            type: "taskPlan",
            plan: [
              { step: "Collect the sidebar notes", status: "completed" },
              { step: "Compare hover and click popovers", status: "completed" },
              { step: "Write the recommendations", status: "inProgress" },
            ],
          },
          {
            id: "file-cowork",
            type: "fileChange",
            status: "completed",
            changes: [
              {
                path: "/Users/fixture/research-notes/recommendations.md",
                kind: { type: "add" },
                diff: "# Sidebar recommendations\n\nUse compact mode for long lists.\n",
              },
            ],
            generatedFiles: [
              {
                id: "gen-recommendations",
                name: "recommendations.md",
                path: "/Users/fixture/research-notes/recommendations.md",
                language: "markdown",
                operation: "create",
                state: "ready",
                content:
                  "# Sidebar recommendations\n\nUse compact mode for long lists.",
                digest: "fixture-recommendations",
                capturedAt: createdAt + minute,
              },
            ],
          },
          {
            id: "msg-cowork",
            type: "agentMessage",
            text: "The recommendations are in **recommendations.md**.",
          },
        ],
      },
    ],
  };
}

function agentConversation(): Conversation {
  const createdAt = origin - 8 * minute;
  return {
    id: "c-subagent",
    threadId: "thread-subagent",
    title: "Check greet against README",
    mode: "code",
    cwd: "/Users/fixture/claude-reference-diff-sandbox",
    providerId: "fixture",
    model: "Opus 5.5",
    pinned: false,
    archived: false,
    createdAt,
    updatedAt: origin + minute,
    turns: [
      {
        id: "t-subagent",
        prompt: "Check greet against README with a sub-agent.",
        attachments: [],
        status: "completed",
        createdAt,
        items: [
          {
            id: "child-greet",
            type: "subAgentActivity",
            kind: "completed",
            agentThreadId: "agent-greet",
            agentPath: "/root/check-greet-against-readme",
            agentStartedAt: { "agent-greet": createdAt + 2000 },
            agentCompletedAt: { "agent-greet": createdAt + 53_000 },
            agentTokenUsage: { "agent-greet": 58_700 },
            agentToolUses: { "agent-greet": 6 },
            agentsStates: { "agent-greet": { status: "completed" } },
          },
          {
            id: "msg-subagent",
            type: "agentMessage",
            text: "greet matches the README.",
          },
        ],
      },
    ],
  };
}

/** A second, finished sleep in the background conversation. */
const sleep90: Item = {
  id: "cmd-sleep-90",
  type: "commandExecution",
  command: "sleep 90",
  cwd: "/Users/fixture/claude-reference-edit-sandbox",
  processId: "bq90sleep",
  status: "completed",
  exitCode: 0,
  aggregatedOutput: "",
  lifecycleStatus: "completed",
  startedAt: origin - 40 * minute + 1000,
};
const added = [coworkConversation(), agentConversation()];
const ended: FinishedBackgroundTerminal[] = [
  {
    id: "terminal:c-background:bq90sleep",
    conversationId: "c-background",
    itemId: "cmd-sleep-90",
    processId: "bq90sleep",
    command: "sleep 90",
    cwd: "/Users/fixture/claude-reference-edit-sandbox",
    status: "completed",
    finishedAt: origin - 38 * minute,
  },
];

const overrides: Partial<DesktopAPI> = {
  snapshot: async () => {
    const snapshot: Snapshot = await base.snapshot();
    const background = snapshot.conversations.find(
      (c) => c.id === "c-background",
    );
    background?.turns[0].items.unshift(sleep90);
    snapshot.conversations.splice(1, 0, ...structuredClone(added));
    return snapshot;
  },
  updateConversation: async (id, patch) => {
    const mine = added.find((c) => c.id === id);
    if (!mine) return base.updateConversation(id, patch);
    Object.assign(mine, patch);
    return structuredClone(mine);
  },
  listBackgroundTerminals: async (conversationId) => ({
    ...(await base.listBackgroundTerminals(conversationId)),
    finished: ended.filter((item) => item.conversationId === conversationId),
  }),
  stopBackgroundTerminal: async (conversationId, processId) => {
    const stopped = await base.stopBackgroundTerminal(
      conversationId,
      processId,
    );
    if (stopped && conversationId === "c-background")
      ended.push({
        id: `terminal:${conversationId}:${processId}`,
        conversationId,
        itemId: "cmd-sleep",
        processId,
        command: "sleep 600",
        cwd: "/Users/fixture/claude-reference-edit-sandbox",
        status: "stopped",
        finishedAt: Date.now(),
      });
    return stopped;
  },
  readWorkflowAgent: async (_conversationId, agentId) => ({
    model: "Opus 5.5",
    context:
      "You are working in the repository at /Users/fixture/claude-reference-diff-sandbox.\n\nTask: Determine whether the `greet` function's behavior matches what README.md documents.",
    status: "completed",
    items: [
      {
        id: `${agentId}-reply`,
        type: "agentMessage",
        text: "greet trims the name and falls back to “friend”, as README.md says.",
      },
    ],
    toolUses: 6,
  }),
};
Object.assign(desktop, overrides);
window.desktop = desktop;
await import("../../src/main");
