/**
 * Tool rows with the model's own descriptions (R7) for the preview. `r7=1` adds
 * three conversations whose command items carry a `description`, as the gateway
 * records it:
 * - "Exit code test (described)": Code, one failed command, "Failed to run a
 *   shell that exits with code 7".
 * - "Tool list with descriptions": Code, a finished group of six calls, "Ran 3
 *   commands (1 failed), read 3 files" over Listed / Read / Showed / Failed
 *   rows.
 * - "Running description": Chat, a command still running, "Change button label
 *   to Add" with the timer.
 */
import type { Conversation, Item, Turn } from "../../../shared/types";
import type { FixtureDomain } from "./index";

const cwd = "/Users/fixture/claude-reference-diff-sandbox";

function command(id: string, at: number, extra: Partial<Item>): Item {
  return {
    id,
    type: "commandExecution",
    cwd,
    status: "completed",
    lifecycleStatus: "completed",
    exitCode: 0,
    aggregatedOutput: "",
    startedAt: at,
    completedAt: at + 400,
    ...extra,
  };
}

function conversation(
  id: string,
  title: string,
  mode: Conversation["mode"],
  at: number,
  turn: Turn,
): Conversation {
  return {
    id,
    threadId: `thread-${id}`,
    title,
    mode,
    cwd: mode === "code" ? cwd : undefined,
    providerId: "fixture",
    model: "Opus 5.5",
    pinned: false,
    archived: false,
    createdAt: at,
    updatedAt: at,
    turns: [turn],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

const read = (path: string) => [
  { type: "read", command: `cat ${path}`, name: path, path },
];

export function toolDescriptionConversations(origin: number): Conversation[] {
  const failedAt = origin - 5 * 60_000;
  const failed = conversation(
    "c-r7-exit",
    "Exit code test (described)",
    "code",
    failedAt,
    {
      id: "t-r7-exit",
      prompt: "Run sh -c 'exit 7' once and tell me the exit code.",
      attachments: [],
      status: "completed",
      createdAt: failedAt,
      items: [
        command("cmd-r7-exit", failedAt + 1000, {
          command: "sh -c 'exit 7'",
          description: "Run a shell that exits with code 7",
          status: "failed",
          lifecycleStatus: "failed",
          exitCode: 7,
        }),
        {
          id: "msg-r7-exit",
          type: "agentMessage",
          text: "I ran `sh -c 'exit 7'` once. The exit code was **7**, as expected.",
        },
      ],
    },
  );
  const listAt = origin - 6 * 60_000;
  const list = conversation(
    "c-r7-list",
    "Tool list with descriptions",
    "code",
    listAt,
    {
      id: "t-r7-list",
      prompt: "Check greet against README.",
      attachments: [],
      status: "completed",
      createdAt: listAt,
      items: [
        command("cmd-r7-ls", listAt + 1000, {
          command: "git ls-files",
          description: "List repository files",
          commandActions: [{ type: "listFiles", command: "git ls-files" }],
          aggregatedOutput: "README.md\napp.js\nutils.js",
        }),
        command("cmd-r7-readme", listAt + 2000, {
          command: "cat README.md",
          description: "Read README.md",
          commandActions: read("README.md"),
        }),
        command("cmd-r7-app", listAt + 3000, {
          command: "cat app.js",
          description: "Read app.js",
          commandActions: read("app.js"),
        }),
        command("cmd-r7-utils", listAt + 4000, {
          command: "cat utils.js",
          description: "Read utils.js",
          commandActions: read("utils.js"),
        }),
        command("cmd-r7-diff", listAt + 5000, {
          command: "git diff -- app.js utils.js",
          description: "Show uncommitted changes to app.js and utils.js",
        }),
        command("cmd-r7-sleep", listAt + 6000, {
          command: "sleep 60",
          description: "Wait 60 seconds so the running state is visible",
          status: "failed",
          lifecycleStatus: "failed",
          exitCode: 1,
          aggregatedOutput: "sleep: operation not permitted",
        }),
        {
          id: "msg-r7-list",
          type: "agentMessage",
          text: "There's nothing to match: README.md doesn't describe `greet` at all.",
        },
      ],
    },
  );
  const runningAt = origin - 60_000;
  const running = conversation(
    "c-r7-running",
    "Running description",
    "chat",
    runningAt,
    {
      id: "t-r7-running",
      prompt: "Change the button label to Add.",
      attachments: [],
      status: "inProgress",
      createdAt: runningAt,
      items: [
        command("cmd-r7-running", runningAt + 1000, {
          command: "sed -i '' 's/Save/Add/' app.js",
          description: "Change button label to Add",
          status: "inProgress",
          lifecycleStatus: "inProgress",
          exitCode: null,
          completedAt: undefined,
        }),
      ],
    },
  );
  return [running, failed, list];
}

export const toolDescriptionsFixture: FixtureDomain = {
  params: { r7: "1 adds conversations whose command rows carry descriptions" },
  bridge: ({ params, origin, state }) => {
    if (params.get("r7") === "1" && !state.conversations.some((c) => c.id === "c-r7-exit"))
      state.conversations.unshift(...toolDescriptionConversations(origin));
    return {};
  },
};
