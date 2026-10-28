/**
 * Chat transcript states for the chat-transcript audit: the captured
 * H3/bold/inline-code reply with a second turn for spacing and toolbar checks,
 * running and stopped turns, errors and a reply with many kinds of tool rows.
 * preview/app.html?chatAudit=1 adds them at the top of Recents; nothing here
 * reaches a network.
 */
import type { Conversation, Item, Turn } from "../../../shared/types";
import type { FixtureDomain } from "./index";

const md = [
  "# H1 标题：Chat 界面排版参考",
  "",
  "这是一段简短的中英混排文字，用于检查 Chat 界面中的字体渲染与行高。其中包含 **粗体文本 Bold**、*斜体文本 Italic*、`inline code` 片段，以及一个安全的 Markdown 链接 [Example](https://example.com)。Mixed-language text helps verify spacing between 中文字符 and English words.",
  "",
  "## H2 标题：列表示例",
  "",
  "### H3 标题：三层嵌套无序列表",
  "",
  "- 第一层项目 A：Top-level item",
  "  - 第二层项目 A1：Second-level item",
  "    - 第三层项目 A1a：Third-level item",
  "- 第一层项目 B",
].join("\n");

const cwd = "/tmp/claudex-audit";

function message(id: string, text: string, extra: Partial<Item> = {}): Item {
  return { id, type: "agentMessage", text, ...extra };
}
function command(
  id: string,
  at: number,
  line: string,
  output: string,
  extra: Partial<Item> = {},
): Item {
  return {
    id,
    type: "commandExecution",
    command: line,
    cwd,
    status: "completed",
    exitCode: 0,
    aggregatedOutput: output,
    commandActions: [{ type: "unknown", command: line }],
    lifecycleStatus: "completed",
    startedAt: at,
    completedAt: at + 300,
    ...extra,
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
function chat(id: string, title: string, at: number, turns: Turn[]): Conversation {
  return {
    id,
    threadId: `thread-${id}`,
    title,
    mode: "chat",
    providerId: "fixture",
    model: "Opus 5.5",
    pinned: false,
    archived: false,
    createdAt: at,
    updatedAt: at + 10_000,
    turns,
  };
}

export function chatAuditConversations(origin: number): Conversation[] {
  const at = origin + 7_200_000;
  const now = Date.now();
  const mcp = (
    id: string,
    status: "inProgress" | "completed" | "failed",
    extra: Partial<Item> = {},
  ): Item => ({
    id,
    type: "mcpToolCall",
    server: "preview",
    tool: "list_pages",
    status,
    lifecycleStatus: status,
    arguments: { limit: 5 },
    startedAt: now - 4000,
    ...extra,
  });
  const changeItem = (id: string, path: string, extra: Partial<Item> = {}): Item => ({
    id,
    type: "fileChange",
    status: "completed",
    lifecycleStatus: "completed",
    startedAt: at,
    completedAt: at + 200,
    changes: [
      {
        path,
        kind: { type: "update", move_path: null },
        diff: "@@ -1 +1,2 @@\n # Notes\n+Edited by the audit fixture.\n",
      },
    ],
    ...extra,
  });
  return [
    chat("c-ca-md", "Chat audit: markdown and spacing", at, [
      turn("ca-1", at, "Show me a markdown sample.", [message("ca-1-m", md)]),
      turn("ca-2", at + 60_000, "Thanks, and a short one?", [
        message("ca-2-m", "Sure — here is a short answer with `code`."),
      ]),
    ]),
    chat("c-ca-think", "Chat audit: thinking", at + 1, [
      turn(
        "ct-1",
        now - 9000,
        "Explain how streaming output works.",
        [
          {
            id: "ct-r",
            type: "reasoning",
            summary: ["**Explaining how streaming output works**\n\nThe model emits tokens."],
            lifecycleStatus: "inProgress",
            startedAt: now - 8000,
          },
        ],
        { status: "inProgress" },
      ),
    ]),
    chat("c-ca-stream", "Chat audit: streaming", at + 2, [
      turn(
        "cs-1",
        now - 9000,
        "Write a paragraph.",
        [
          message(
            "cs-m",
            "Streaming output arrives in small pieces, and the",
            { lifecycleStatus: "inProgress" },
          ),
        ],
        { status: "inProgress" },
      ),
    ]),
    chat("c-ca-cmd", "Chat audit: running command", at + 3, [
      turn(
        "cc-1",
        now - 15_000,
        "Run the slow script.",
        [
          command("cc-c", now - 14_000, "node slow.js", "step 1\nstep 2\n", {
            status: "inProgress",
            lifecycleStatus: "inProgress",
            completedAt: undefined,
            exitCode: undefined,
          }),
        ],
        { status: "inProgress" },
      ),
    ]),
    chat("c-ca-mcp", "Chat audit: running tool", at + 4, [
      turn(
        "cm-1",
        now - 9000,
        "List the preview pages.",
        [mcp("cm-t", "inProgress", { progress: "Connecting to the preview server…" })],
        { status: "inProgress" },
      ),
    ]),
    chat("c-ca-stop", "Chat audit: stopped", at + 5, [
      turn(
        "cx-1",
        at,
        "Run the slow script.",
        [
          command("cx-c", at + 1000, "node slow.js", "step 1\n", {
            status: "interrupted",
            lifecycleStatus: "interrupted",
            exitCode: undefined,
          }),
        ],
        { status: "interrupted" },
      ),
      turn(
        "cx-2",
        at + 30_000,
        "Write a paragraph.",
        [message("cx-m", "Streaming output arrives in small pieces, and the")],
        { status: "interrupted" },
      ),
    ]),
    chat("c-ca-error", "Chat audit: errors", at + 6, [
      turn("ce-1", at, "Answer me.", [], {
        status: "failed",
        error: "The model service returned HTTP 502: the upstream request timed out.",
      }),
      turn("ce-2", at + 30_000, "Answer me again.", [], {
        status: "failed",
        error:
          "The model is overloaded right now (rate limit reached). Try again in a moment.",
      }),
    ]),
    chat("c-ca-tools", "Chat audit: tool rows", at + 7, [
      turn("cu-1", at, "Edit the notes and the readme.", [
        changeItem("cu-f1", `${cwd}/notes.md`),
        changeItem("cu-f2", `${cwd}/README.md`),
        message("cu-m1", "Both files were edited."),
      ]),
      turn("cu-2", at + 10_000, "Try to edit a protected file.", [
        changeItem("cu-f3", "/etc/hosts", {
          status: "failed",
          lifecycleStatus: "failed",
        }),
        message("cu-m2", "That edit was refused."),
      ]),
      turn("cu-3", at + 20_000, "Fetch the docs page.", [
        {
          id: "cu-w1",
          type: "webSearch",
          query: "https://example.com/docs",
          action: { type: "openPage", url: "https://example.com/docs" },
          lifecycleStatus: "completed",
        },
        {
          id: "cu-w2",
          type: "webSearch",
          query: "install",
          action: {
            type: "findInPage",
            url: "https://example.com/docs",
            pattern: "install",
          },
          lifecycleStatus: "completed",
        },
        message("cu-m3", "The page says to run the installer."),
      ]),
      turn("cu-4", at + 30_000, "Look at the image and wait.", [
        {
          id: "cu-i",
          type: "imageView",
          path: `${cwd}/screenshot.png`,
          lifecycleStatus: "completed",
        },
        { id: "cu-s", type: "sleep", durationMs: 5000, lifecycleStatus: "completed" },
        { id: "cu-cc", type: "contextCompaction", lifecycleStatus: "completed" },
        message("cu-m4", "Done looking."),
      ]),
      turn("cu-5", at + 40_000, "Run the failing script and the empty one.", [
        command("cu-c1", at + 41_000, "node broken.js", "Error: boom\n", {
          status: "failed",
          lifecycleStatus: "failed",
          exitCode: 7,
        }),
        command("cu-c2", at + 42_000, "true", ""),
        message("cu-m5", "One failed."),
      ]),
      turn("cu-6", at + 50_000, "Use the preview tools.", [
        mcp("cu-t1", "completed", {
          result: { content: [{ type: "text", text: "index.html\nabout.html" }] },
          completedAt: at + 51_000,
        }),
        mcp("cu-t2", "failed", {
          tool: "open_page",
          error: { message: "The preview server is not running." },
          completedAt: at + 52_000,
        }),
        message("cu-m6", "The second call failed."),
      ]),
      turn("cu-7", at + 60_000, "Show a long output.", [
        command(
          "cu-c3",
          at + 61_000,
          "seq 1 60",
          Array.from({ length: 60 }, (_, i) => String(i + 1)).join("\n") + "\n",
        ),
        message("cu-m7", "There were sixty lines."),
      ]),
    ]),
    chat("c-ca-tools2", "Chat audit: more rows", at + 8, [
      turn("cw-1", at, "Delegate and clean up.", [
        {
          id: "cw-a",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          lifecycleStatus: "completed",
          prompt: "Check the notes",
          receiverThreadIds: ["agent-x"],
          agentsStates: { "agent-x": { status: "completed" } },
        },
        {
          id: "cw-d",
          type: "fileChange",
          status: "completed",
          lifecycleStatus: "completed",
          changes: [
            { path: `${cwd}/old.txt`, kind: { type: "delete" }, diff: "" },
          ],
        },
        {
          id: "cw-t",
          type: "commandExecution",
          command: "sleep 600",
          cwd,
          status: "failed",
          lifecycleStatus: "failed",
          aggregatedOutput: "",
          error: { message: "The command timed out after 120 seconds." },
          commandActions: [{ type: "unknown", command: "sleep 600" }],
        },
        mcp("cw-m", "completed", {
          tool: "screenshot",
          result: {
            content: [
              {
                type: "image",
                mimeType: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC",
              },
            ],
          },
        }),
        message("cw-x", "Everything was cleaned up."),
      ]),
      turn("cw-2", at + 30_000, "Think about it.", [
        {
          id: "cw-r",
          type: "reasoning",
          summary: [
            "**Weighing the options**\n\nThe first option is faster but riskier.",
            "**Checking constraints**\n\nNothing blocks the second option.",
          ],
          lifecycleStatus: "completed",
          startedAt: at + 30_000,
          completedAt: at + 41_000,
        },
        message("cw-y", "The second option is the better one."),
      ]),
    ]),
    chat("c-ca-compact", "Chat audit: compacting", at + 9, [
      turn(
        "cz-1",
        now - 9000,
        "Keep going.",
        [
          {
            id: "cz-c",
            type: "contextCompaction",
            lifecycleStatus: "inProgress",
            status: "inProgress",
            startedAt: now - 8000,
          },
        ],
        { status: "inProgress" },
      ),
    ]),
    chat("c-ca-sleep", "Chat audit: waiting", at + 10, [
      turn(
        "cy-1",
        now - 9000,
        "Wait a bit.",
        [
          {
            id: "cy-s",
            type: "sleep",
            lifecycleStatus: "inProgress",
            status: "inProgress",
            startedAt: now - 8000,
          },
        ],
        { status: "inProgress" },
      ),
    ]),
    chat("c-ca-web", "Chat audit: searching", at + 11, [
      turn(
        "cv-1",
        now - 9000,
        "Find the docs.",
        [
          {
            id: "cv-w",
            type: "webSearch",
            query: "claudex docs",
            action: { type: "search", query: "claudex docs" },
            lifecycleStatus: "inProgress",
            status: "inProgress",
            startedAt: now - 8000,
          },
        ],
        { status: "inProgress" },
      ),
    ]),
    chat("c-ca-websearch", "Chat audit: searched", at + 13, [
      turn("cw-1", at + 13_000, "胃穿孔该怎么处理？", [
        message("cw-m1", "我先核实胃穿孔的急救处理要求。", {
          phase: "commentary",
        } as Partial<Item>),
        {
          id: "cw-s",
          type: "webSearch",
          query: "acute perforation gastrointestinal tract treatment",
          action: {
            type: "search",
            query: "acute perforation gastrointestinal tract treatment",
          },
          lifecycleStatus: "completed",
          sources: [
            {
              url: "https://www.gastrojournal.org/article/aga-update",
              title: "AGA Clinical Practice Update on management",
            },
          ],
        } as Item,
        message(
          "cw-m2",
          "**你就在医院附近，现在停止吃喝，去医院急诊。** 已确诊、尚未治愈的胃穿孔需要紧急处理，并通常要求禁食禁水。 [[1]](https://www.gastrojournal.org/article/aga-update)",
        ),
      ]),
    ]),
    chat("c-ca-edit", "Chat audit: editing", at + 12, [
      turn(
        "cf-1",
        now - 9000,
        "Edit the notes.",
        [
          changeItem("cf-f", `${cwd}/notes.md`, {
            status: "inProgress",
            lifecycleStatus: "inProgress",
            completedAt: undefined,
          }),
        ],
        { status: "inProgress" },
      ),
    ]),
  ];
}

export const chatTranscriptAuditFixture: FixtureDomain = {
  params: {
    chatAudit: "1 adds the chat-transcript audit conversations (Chat mode)",
  },
  bridge: ({ params, origin, state }) => {
    if (
      params.get("chatAudit") === "1" &&
      !state.conversations.some((c) => c.id === "c-ca-md")
    )
      state.conversations.unshift(...chatAuditConversations(origin));
    return {};
  },
};
