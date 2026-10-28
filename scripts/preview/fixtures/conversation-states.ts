/**
 * Synthetic conversations for transcript states: a long prompt, math, a remote
 * image and a link, a stopped reply, an error with Retry, the output limit
 * with Continue, a reconnect in progress and a Code turn interrupted by the
 * user or by the app closing.
 * Loaded with preview/app.html?states=1; nothing here reaches a network.
 */
import type { Conversation, Item, Project, Turn } from "../../../shared/types";

export const statesProject: Project = {
  id: "p-research",
  name: "Research notes",
  description: "Synthetic project for header breadcrumb checks.",
  instructions: "",
  createdAt: Date.UTC(2026, 8, 20, 9),
};

const longPrompt = Array.from(
  { length: 18 },
  (_, i) =>
    `Line ${i + 1}: this synthetic prompt is long enough to be collapsed behind a fade so the transcript stays readable.`,
).join("\n");

const reply = [
  "The energy relation is \\(E = mc^2\\), and the Gaussian integral is",
  "",
  "$$",
  "\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi} \\qquad \\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6} \\qquad \\prod_{k=1}^{n} \\left(1 + \\frac{1}{k}\\right) = n + 1 \\qquad \\lim_{n \\to \\infty} \\left(1 + \\frac{1}{n}\\right)^n = e",
  "$$",
  "",
  "See the [Codex repository](https://github.com/openai/codex) for the engine.",
  "",
  "![Architecture diagram](https://images.example.com/claudex/diagram.png)",
].join("\n");

function message(id: string, text: string): Item {
  return { id, type: "agentMessage", text };
}
function turn(
  id: string,
  createdAt: number,
  prompt: string,
  items: Item[],
  extra: Partial<Turn> = {},
): Turn {
  return {
    id,
    prompt,
    attachments: [],
    items,
    status: "completed",
    createdAt,
    ...extra,
  };
}
function base(
  id: string,
  title: string,
  mode: Conversation["mode"],
  updatedAt: number,
  turns: Turn[],
): Conversation {
  return {
    id,
    threadId: `thread-${id}`,
    title,
    mode,
    cwd: mode === "code" ? "/Users/fixture/claudex" : undefined,
    providerId: "fixture",
    model: "Opus 5.5",
    pinned: false,
    archived: false,
    createdAt: updatedAt - 3_600_000,
    updatedAt,
    turns,
  };
}

/** Newest first, so they lead the Recents list. */
export function stateConversations(now: number): Conversation[] {
  const t = (minutes: number) => now - minutes * 60_000;
  return [
    {
      ...base("c-states", "Conversation states", "chat", t(1), [
        turn("s-1", t(40), longPrompt, [message("s-1-m", reply)]),
        turn(
          "s-2",
          t(30),
          "Draft a summary of the notes.",
          [message("s-2-m", "Here is a first pass at the summary")],
          { status: "interrupted" },
        ),
        turn("s-3", t(20), "Try again with the other model.", [], {
          status: "failed",
          error:
            "The model service returned HTTP 502: the upstream request timed out.",
        }),
        turn(
          "s-4",
          t(10),
          "Write the full report.",
          [message("s-4-m", "## Report\n\nThe first section covers")],
          {
            status: "failed",
            stopReason: "length",
            error: "The response reached the model's maximum output length.",
          },
        ),
      ]),
      projectId: statesProject.id,
    },
    // The latest reply failed with the engine's own text: the notice above
    // the composer says it in plain words and offers Retry.
    base("c-failed", "Failed reply", "chat", t(1.5), [
      turn("f-1", t(6), "Explain the retry policy.", [
        message("f-1-m", "Retries back off exponentially."),
      ]),
      turn("f-2", t(5), "Now compare it with a circuit breaker.", [], {
        status: "failed",
        error:
          'unexpected status 502 Bad Gateway: The model service returned HTTP 502: {"error":{"message":"Upstream service temporarily unavailable","type":"upstream_error"}}, url: http://127.0.0.1:34217/v1/responses',
      }),
    ]),
    base("c-reconnect", "Reconnect test", "chat", t(2), [
      turn(
        "r-1",
        t(3),
        "Explain the retry policy.",
        [message("r-1-m", "Retries back off exponentially")],
        {
          status: "inProgress",
          reconnecting: "2/5",
          // The live status line counts from the real clock, not the fixture's.
          createdAt: Date.now() - 12_000,
        },
      ),
    ]),
    ...runStateConversations(t),
    base("c-interrupted", "Interrupted task", "code", t(3), [
      turn(
        "i-1",
        t(8),
        "Refactor the settings loader.",
        [message("i-1-m", "I'll start by reading the loader.")],
        { status: "interrupted" },
      ),
      turn(
        "i-2",
        t(5),
        "Continue with the tests.",
        [message("i-2-m", "Running the test suite now.")],
        { status: "interrupted", stopReason: "restart" },
      ),
    ]),
  ];
}

/**
 * Run states: a finished Code turn whose reads, command and edit fold into
 * one row, a background agent line and the still end star; a finished Cowork
 * reply with its icon toolbar; a Chat reply with a message sent mid-turn and a
 * /compact turn.
 */
function runStateConversations(t: (minutes: number) => number): Conversation[] {
  const cwd = "/Users/fixture/claudex";
  const read = (id: string, name: string): Item => ({
    id,
    type: "commandExecution",
    command: `cat ${name}`,
    cwd,
    status: "completed",
    lifecycleStatus: "completed",
    exitCode: 0,
    aggregatedOutput: "",
    commandActions: [
      { type: "read", command: `cat ${name}`, name, path: `${cwd}/${name}` },
    ],
  });
  const agent = "agent-state-1";
  return [
    base("c-run-code", "Run states (Code)", "code", t(4), [
      turn("rc-1", t(6), "Make the greeting include the name.", [
        read("rc-r1", "README.md"),
        read("rc-r2", "app.js"),
        {
          id: "rc-c1",
          type: "commandExecution",
          command: "node app.js",
          cwd,
          status: "failed",
          lifecycleStatus: "failed",
          exitCode: 1,
          aggregatedOutput: "TypeError: name is undefined\n",
        },
        {
          id: "rc-f1",
          type: "fileChange",
          status: "completed",
          lifecycleStatus: "completed",
          changes: [
            {
              path: `${cwd}/app.js`,
              kind: { type: "update", move_path: null },
              diff: "@@ -1 +1 @@\n-return `Hello`;\n+return `Hello, ${name}`;\n",
            },
          ],
        },
        {
          id: "rc-spawn",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          prompt: "Check greet against README",
          receiverThreadIds: [agent],
          agentsStates: { [agent]: { status: "completed" } },
          model: "Opus 5.5",
        },
        {
          id: "rc-child",
          type: "subAgentActivity",
          kind: "completed",
          agentThreadId: agent,
          agentPath: "/root/check-greet",
          agentModel: "Opus 5.5",
          agentStartedAt: { [agent]: t(6) + 3000 },
          agentDurationMs: { [agent]: 51000 },
          agentsStates: { [agent]: { status: "completed" } },
        },
        message(
          "rc-m",
          "Updated `app.js`; the greeting now includes the name.\n\nNothing else changed.",
        ),
      ]),
    ]),
    base("c-run-cowork", "Run states (Cowork)", "cowork", t(4.5), [
      turn("rw-1", t(7), "Count the lines in notes.txt.", [
        {
          id: "rw-c1",
          type: "commandExecution",
          command: "wc -l notes.txt",
          status: "completed",
          lifecycleStatus: "completed",
          exitCode: 0,
          aggregatedOutput: "12 notes.txt\n",
        },
        message("rw-m", "The notes file has twelve lines."),
      ]),
    ]),
    // The Activity panel with a finished plan, a written file in the task's
    // folder and a web search.
    {
      ...base("c-activity", "Activity panel (Cowork)", "cowork", t(4.4), [
        turn("ac-1", t(6.5), "Write the synthetic summary file.", [
          {
            id: "ac-plan",
            type: "taskPlan",
            plan: [
              { step: "List the fictional titles", status: "completed" },
              { step: "Pick one title", status: "completed" },
              { step: "Write the blurb", status: "completed" },
              { step: "Write the summary", status: "completed" },
            ],
          },
          {
            id: "ac-search",
            type: "webSearch",
            query: "synthetic reading club",
            status: "completed",
          },
          {
            id: "ac-change",
            type: "fileChange",
            status: "completed",
            changes: [
              {
                path: "/private/tmp/claude-reference-code-test-20260927/R-0928-synthetic-output.txt",
                kind: { type: "add" },
                diff: "",
              },
            ],
            generatedFiles: [
              {
                id: "ac-file",
                name: "R-0928-synthetic-output.txt",
                path: "/private/tmp/claude-reference-code-test-20260927/R-0928-synthetic-output.txt",
                language: "text",
                operation: "create",
                state: "ready",
                content: "Title: Cloud library\nTheme: reading club\nStatus: done\n",
                digest: "a".repeat(64),
              },
            ],
          },
          message("ac-m", "The file is ready with the three lines you asked for."),
        ]),
      ]),
      cwd: "/private/tmp/claude-reference-code-test-20260927",
    },
    base("c-run-chat", "Run states (Chat)", "chat", t(5), [
      turn("rh-1", t(9), "Summarize the notes.", [
        message("rh-m1", "Reading the notes first."),
        {
          id: "rh-s",
          type: "userMessage",
          steered: true,
          clientId: "rh-client",
          text: "Keep it under five bullets.",
          attachments: [],
        },
        message("rh-m2", "Four bullets:\n\n- One\n- Two\n- Three\n- Four"),
      ]),
      turn(
        "rh-2",
        t(8),
        "",
        [
          {
            id: "rh-cc",
            type: "contextCompaction",
            status: "completed",
            lifecycleStatus: "completed",
          },
        ],
        { compaction: "manual" },
      ),
    ]),
  ];
}

/** A stand-in for a fetched remote image: a small local SVG, no network. */
export const fixtureRemoteImage =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200"><rect width="480" height="200" rx="12" fill="#2b2a27"/><text x="240" y="108" fill="#c2c0b6" font-family="sans-serif" font-size="18" text-anchor="middle">Architecture diagram</text></svg>',
  );
