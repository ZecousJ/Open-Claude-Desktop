/**
 * The Chat transcript the 2026-09-28 shell/chat audit compares with the W969
 * Headings H4–H6, a quote, mixed bold/italic/inline code, a wide table, a long
 * URL, code blocks with and without a language, a user prompt with raw Markdown
 * and a long URL, and a reply with three commands, an edited file and a web
 * search. preview/app.html?shellAudit=1 adds it at the top of Recents.
 */
import type { Conversation, Item, Turn } from "../../../shared/types";
import type { FixtureDomain } from "./index";

const longUrl =
  "https://example.com/reference/long-path-without-spaces?section=typography&mode=chat";

const table = [
  "| A | B | C | D |",
  "| --- | --- | --- | --- |",
  ...[1, 2, 3].map(
    (row) =>
      `| AlphaOverflowSampleStringRow${row}ColumnA | BravoOverflowSampleStringRow${row}ColumnB | CharlieOverflowSampleStringRow${row}ColumnC | DeltaOverflowSampleStringRow${row}ColumnD |`,
  ),
].join("\n");

const markdownReply = [
  "#### H4 标题：编号 1 至 12 的有序列表",
  "",
  "1. 第一项 First item",
  "2. 第二项 Second item",
  "",
  "这是一段简短的中英混排文字，用于检查 Chat 界面中的字体渲染与行高。其中包含 **粗体文本 Bold**、*斜体文本 Italic*、`inline` `code` 片段，以及一个安全的 Markdown 链接 [Example](https://example.com)。Mixed-language text helps verify spacing between 中文字符 and English words.",
  "",
  "##### H5 标题：表格示例",
  "",
  table,
  "",
  "###### H6 标题：引用、代码与长 URL",
  "",
  "> 这是一个引用块 blockquote，用于检查左侧边框、背景色和文字颜色。",
  "> Second line of the quote to verify multi-line rendering.",
  "",
  `无空格长 URL 测试：${longUrl}`,
  "",
  "```javascript",
  "// 注释：计算列表项的总数（comment）",
  'const title = "Chat 排版测试";',
  "let count = 12;",
  "",
  "function renderItems(items, limit = 10) {",
  "  if (items.length > limit) {",
  "    return `显示前 ${limit} 项，共 ${items.length} 项`;",
  "  }",
  "  return items.map((item, index) => `${index + 1}. ${item}`).join(\"\\n\");",
  "}",
  "",
  'console.log(title, renderItems(["alpha", "beta", "gamma", "delta", "epsilon"], count));',
  "```",
  "",
  "The SHA-256 of the sample (no language, one long line without a newline) is:",
  "",
  "```",
  "4feb73d4dd57c61119f530d27e3782ce812140eb40ccd88e1b6f7d2a3c4b5e6f7a8b9c0d6e6a0c6dcf",
  "```",
].join("\n");

const userMarkdown =
  "包含H1到H6各一个标题；中英混排段落，含**粗体**、*斜体*、`inline code` 和安全链接[Example](https://example.com/reference/test)；三层嵌套无序列表。";

function command(
  id: string,
  at: number,
  commandLine: string,
  output: string,
): Item {
  return {
    id,
    type: "commandExecution",
    command: commandLine,
    cwd: "/tmp/claudex-audit",
    status: "completed",
    exitCode: 0,
    aggregatedOutput: output,
    commandActions: [{ type: "unknown", command: commandLine }],
    lifecycleStatus: "completed",
    startedAt: at,
    completedAt: at + 300,
  };
}

function turn(id: string, at: number, prompt: string, items: Item[]): Turn {
  return {
    id,
    prompt,
    attachments: [],
    items,
    status: "completed",
    createdAt: at,
  };
}

export function shellAuditConversation(origin: number): Conversation {
  const at = origin + 3_600_000;
  const tools: Item[] = [
    command("audit-cmd-1", at + 1_000, "echo alpha", "alpha\n"),
    command(
      "audit-cmd-2",
      at + 2_000,
      "printf 'beta\\n' > /tmp/claudex-audit/beta.txt",
      "",
    ),
    command("audit-cmd-3", at + 3_000, "wc -l /tmp/claudex-audit/beta.txt", "1 /tmp/claudex-audit/beta.txt\n"),
    {
      id: "audit-edit",
      type: "fileChange",
      status: "completed",
      lifecycleStatus: "completed",
      startedAt: at + 4_000,
      completedAt: at + 4_200,
      changes: [
        {
          path: "/tmp/claudex-audit/notes.md",
          kind: { type: "update", move_path: null },
          diff: "@@ -1 +1,2 @@\n # Notes\n+Edited by the audit fixture.\n",
        },
      ],
    },
    {
      id: "audit-search",
      type: "webSearch",
      query: "claudex audit fixture",
      action: { type: "search", query: "claudex audit fixture" },
      lifecycleStatus: "completed",
      sources: [1, 2, 3, 4, 5].map((i) => ({
        url: `https://example.com/audit/${i}`,
        title: `Audit source ${i}`,
      })),
    },
    { id: "audit-msg-2", type: "agentMessage", text: "Done: three commands ran, one file was edited and the web was searched." },
  ];
  return {
    id: "c-shell-audit",
    threadId: "thread-c-shell-audit",
    title: "Markdown样例生成测试",
    mode: "chat",
    providerId: "fixture",
    model: "Opus 5.5",
    pinned: false,
    archived: false,
    createdAt: at,
    updatedAt: at + 10_000,
    turns: [
      turn("t-audit-1", at, userMarkdown, [
        { id: "audit-msg-1", type: "agentMessage", text: markdownReply },
      ]),
      turn("t-audit-2", at + 5_000, `${longUrl}。以下仅为无个人数据的长消息折叠测试填充。`, tools),
    ],
  };
}

export const shellChatAuditFixture: FixtureDomain = {
  params: { shellAudit: "1 adds the W969 Markdown and tool-row test chat" },
  bridge: ({ params, origin, state }) => {
    if (
      params.get("shellAudit") === "1" &&
      !state.conversations.some((c) => c.id === "c-shell-audit")
    )
      state.conversations.unshift(shellAuditConversation(origin));
    return {};
  },
};
