/**
 * States for the agent-tools-2 audit: a Code reply that is streaming text with
 * its token counter, Code tool rows (several shells, three files read at once,
 * multi-line and long commands, a failed connector call) and a finished Cowork
 * command group with a reasoning note. preview/app.html?at2=1 adds them;
 * nothing here reaches a network.
 */
import type { Conversation, Item, Mode, Turn } from "../../../shared/types";
import type { FixtureDomain } from "./index";

const cwd = "/Users/fixture/claude-reference-edit-sandbox";

function conversation(
  id: string,
  title: string,
  mode: Mode,
  at: number,
  turns: Turn[],
): Conversation {
  return {
    id,
    threadId: `thread-${id}`,
    title,
    mode,
    cwd: mode === "chat" ? undefined : cwd,
    providerId: "fixture",
    model: "Opus 5.5",
    pinned: false,
    archived: false,
    createdAt: at,
    updatedAt: at,
    turns,
  };
}

function turn(
  id: string,
  at: number,
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
    createdAt: at,
    ...extra,
  };
}

function command(id: string, line: string, output: string, extra: Partial<Item> = {}): Item {
  return {
    id,
    type: "commandExecution",
    command: line,
    cwd,
    status: "completed",
    lifecycleStatus: "completed",
    exitCode: 0,
    aggregatedOutput: output,
    commandActions: [{ type: "unknown", command: line }],
    ...extra,
  };
}

const read = (id: string, name: string): Item =>
  command(id, `cat ${name}`, "", {
    commandActions: [
      { type: "read", command: `cat ${name}`, name, path: `${cwd}/${name}` },
    ],
  });

/** R-0816 / R-0837: "Used 2 tools (1 failed)": a listing that returns [], then a call rejected for a missing argument. */
function mcpTurn(at: number): Turn {
  return turn("at2-t3", at + 2000, "Use the preview tools.", [
        {
          id: "at2-m0",
          type: "mcpToolCall",
          server: "preview",
          tool: "preview_list",
          status: "completed",
          lifecycleStatus: "completed",
          arguments: {},
          result: { content: [{ type: "text", text: "[]" }] },
        },
        {
          id: "at2-m1",
          type: "mcpToolCall",
          server: "preview",
          tool: "preview_eval",
          status: "failed",
          lifecycleStatus: "failed",
          arguments: { expression: "location.href" },
          error: {
            message:
              'MCP error -32602: Input validation error: Invalid arguments for tool preview_eval: [\n  {\n    "expected": "string",\n    "code": "invalid_type",\n    "path": [\n      "serverId"\n    ],\n    "message": "Invalid input: expected string, received undefined"\n  }\n]',
          },
        },
        { id: "at2-msg3", type: "agentMessage", text: "The call failed." },
      ]);
}

export function agentToolsAuditConversations(origin: number): Conversation[] {
  const at = origin + 9_000_000;
  const now = Date.now();
  const list = Array.from(
    { length: 40 },
    (_, index) => `${index + 1}. Dune ${index + 1}`,
  ).join("\n");
  return [
    conversation("c-at2-stream", "AT2 Code: streaming", "code", at, [
      turn(
        "at2-s1",
        now - 34_000,
        "Write 800 fictional colour-theme names, plain text only.",
        [
          {
            id: "at2-s1-m",
            type: "agentMessage",
            text: list,
            status: "inProgress",
            lifecycleStatus: "inProgress",
            startedAt: now - 30_000,
          },
        ],
        { status: "inProgress", outputTokens: 794 },
      ),
    ]),
    conversation("c-at2-tools", "AT2 Code: tool rows", "code", at + 1, [
      turn("at2-t1", at, "Read the three files.", [
        read("at2-r1", "README.md"),
        read("at2-r2", "app.js"),
        read("at2-r3", "utils.js"),
        {
          id: "at2-msg1",
          type: "agentMessage",
          text: "All three files are short.",
        },
      ]),
      turn("at2-t2", at + 1000, "Run it in zsh, then a long one.", [
        command("at2-z", "echo zsh-check", "zsh-check\n", {
          shell: "/bin/zsh",
        }),
        command(
          "at2-l",
          "for f in *.js; do\n  echo \"checking $f\"\n  node --check \"$f\" && echo ok\ndone",
          "checking app.js\nok\nchecking utils.js\nok\n",
        ),
        command(
          "at2-long",
          "grep -rn --include='*.js' --exclude-dir=node_modules -e 'greet' -e 'farewell' -e 'double' /Users/fixture/claude-reference-edit-sandbox/src /Users/fixture/claude-reference-edit-sandbox/lib",
          "app.js:1:export function greet(name) {\n",
        ),
        { id: "at2-msg2", type: "agentMessage", text: "Both scripts passed." },
      ]),
      mcpTurn(at + 2000),
      turn("at2-t4", at + 3000, "Run the failing script.", [
        command("at2-f", "node broken.js", "Error: boom\n", {
          status: "failed",
          lifecycleStatus: "failed",
          exitCode: 7,
        }),
        { id: "at2-msg4", type: "agentMessage", text: "One failed." },
      ]),
    ]),
    conversation("c-at2-mcp", "AT2 Code: connector rows", "code", at + 3, [
      mcpTurn(at),
    ]),
    conversation("c-at2-cowork", "AT2 Cowork: notes", "cowork", at + 2, [
      turn("at2-c1", at, "Wait twenty seconds.", [
        {
          id: "at2-c1-r",
          type: "reasoning",
          summary: ["**Running a sleep**\n\nThe command waits for twenty seconds."],
          lifecycleStatus: "completed",
        },
        command("at2-c1-c", "sleep 20", "", {
          startedAt: at,
          completedAt: at + 20_000,
        }),
        {
          id: "at2-c1-m",
          type: "agentMessage",
          text: "It ran for twenty seconds and exited without output.",
        },
      ]),
    ]),
  ];
}

export const agentToolsAuditFixture: FixtureDomain = {
  params: {
    at2: "1 adds the agent-tools-2 audit conversations (Code streaming and tool rows, Cowork notes)",
    open: "all: after the conversation opens, expands every tool disclosure (for renders that cannot click); terminal: also opens the Terminal panel with two tabs",
  },
  bridge: ({ params, origin, state }) => {
    if (
      params.get("at2") === "1" &&
      !state.conversations.some((c) => c.id === "c-at2-stream")
    )
      state.conversations.unshift(...agentToolsAuditConversations(origin));
    const open = params.get("open");
    if (open) {
      // Once the conversation is on screen (the `returned` parameter opens it).
      const expand = () =>
        document
          .querySelectorAll<HTMLElement>(".turn details > summary")
          .forEach((summary) => summary.click());
      const click = (selector: string) =>
        document.querySelector<HTMLElement>(selector)?.click();
      // Polls for what it needs: the screenshot is taken ~1.5s after
      // `.sidebar` appears, so nothing waits on a fixed delay.
      const until = (selector: string, then: () => void, tries = 100) => {
        if (document.querySelector(selector)) then();
        else if (tries)
          setTimeout(() => until(selector, then, tries - 1), 50);
      };
      if (open === "terminal")
        until('[aria-label="Terminal"]', () => {
          click('[aria-label="Terminal"]');
          until('[aria-label="New terminal"]', () =>
            click('[aria-label="New terminal"]'),
          );
        });
      else until(".turn details > summary", expand);
    }
    return {};
  },
};
