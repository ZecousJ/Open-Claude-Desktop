/**
 * Chat transcript states for the chat-transcript-2 audit: the W1164 reference
 * reply in full (H1–H3, nested and ordered lists, the wrapped six-column table,
 * the 12-column table, quote, code blocks, links, task lists, raw HTML), reply
 * and prompt versions (1/2 and 2/2), a prompt with three images and a text
 * file. preview/app.html?chatAudit2=1 adds them at the top of Recents; nothing
 * here reaches a network.
 */
import type { Attachment, Conversation, Item, Turn } from "../../../shared/types";
import type { FixtureDomain } from "./index";

const longPrompt = [
  "仅用于 Chat UI 测试；不要调用工具、联网、读取或修改文件。请输出包含以下元素的一条回复：H1 到 H6 各一个标题；中英混排段落，含粗体、斜体、行内代码和安全链接；三层嵌套无序列表；编号 1 至 12 的有序列表；至少 6 列且含长单元格的 Markdown 表格；引用块；带 javascript 标签、关键字/字符串/数字/注释的代码块；无空格长 URL。",
  "https://example.com/reference/long-path-without-spaces?section=typography&mode=chat。以下仅为无个人数据的长消息折叠测试填充：测试段01，用于观察 Chat 消息的换行、折叠和滚动。",
  "测试段02，用于观察 Chat 消息的换行、折叠和滚动。测试段03，用于观察 Chat 消息的换行、折叠和滚动。测试段04，用于观察 Chat 消息的换行、折叠和滚动。",
].join("\n");

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
  "  - 第二层项目 A.1：Second-level item",
  "    - 第三层项目 A.1.a：Third-level item",
  "    - 第三层项目 A.1.b：Another deep item",
  "  - 第二层项目 A.2：Sibling item",
  "- 第一层项目 B：Another top-level item",
  "  - 第二层项目 B.1：Nested content",
  "    - 第三层项目 B.1.a：Deepest level",
  "",
  "#### H4 标题：编号 1 至 12 的有序列表",
  "",
  ...[
    "第一项 First item",
    "第二项 Second item",
    "第三项 Third item",
    "第四项 Fourth item",
    "第五项 Fifth item",
    "第六项 Sixth item",
    "第七项 Seventh item",
    "第八项 Eighth item",
    "第九项 Ninth item",
    "第十项 Tenth item",
    "第十一项 Eleventh item",
    "第十二项 Twelfth item",
  ].map((text, i) => `${i + 1}. ${text}`),
  "",
  "##### H5 标题：嵌套有序、混合与任务列表",
  "",
  "1. 有序第一项",
  "   - 无序嵌套 a",
  "   - 无序嵌套 b",
  "2. 有序第二项",
  "   1. 有序嵌套 1",
  "   2. 有序嵌套 2",
  "",
  "- 无序项 A",
  "  1. 有序嵌套 A1",
  "  2. 有序嵌套 A2",
  "",
  "1. 第一项带第二段与代码块。",
  "",
  "   这是第一项的第二段文字，用于检查列表项内的多段落间距。",
  "",
  "   ```bash",
  "   echo list-item-code",
  "   ```",
  "",
  "- [ ] 任务：未勾选 Unchecked",
  "- [x] 任务：已勾选 Checked",
  "- [x] 任务：另一个已勾选 Done",
  "",
  "###### H6 标题：表格、引用与转义",
  "",
  "| ID | 标题 | 类型 | 状态 | 数值 | 说明 |",
  "| --- | --- | --- | --- | --- | --- |",
  "| 001 | 标题样式 | Heading | 已完成 Done | 42 | 检查 H1-H6 的字号层级 |",
  "| 002 | 列表样式 | List | 进行中 In progress | 128 | 这是一段很长的中英混排单元格内容，用于测试表格在窄屏或宽度受限时是否会触发横向滚动 horizontal scrolling behavior，同时观察中文字符与 English words 混合时的自动换行 line wrapping、单元格内边距 padding 以及整体可读性 readability，确保表格不会撑破消息气泡的宽度限制。 |",
  "| 003 | 代码块 | Code | 待定 | 3.14 | 语法高亮 syntax |",
  "",
  "| 左对齐 | 居中 | 右对齐 |",
  "| :-- | :-: | --: |",
  "| a | b | c |",
  "| 长一点的左 | 中间 | 12.5 |",
  "",
  "> 外层引用 outer quote",
  "> > 内层引用 inner quote",
  "> - 引用中的列表项",
  "",
  "特殊字符原样显示：\\<b>bold\\</b> &amp; &lt;div&gt; \\<script>alert(1)\\</script>，以及 <b>真实标签</b> 与 &copy; 实体。",
  "",
  "```javascript",
  "// 注释：计算列表项的总数 (comment)",
  'const title = "Chat 排版测试";',
  "let count = 12;",
  "",
  "function renderItems(items, limit = 10) {",
  "  if (items.length > limit) {",
  "    return `显示前 ${limit} 项，共 ${items.length} 项`;",
  "  }",
  '  return items.map((item, index) => `${index + 1}. ${item}`).join("\\n");',
  "}",
  "",
  'console.log(title, renderItems(["alpha", "beta", "gamma"], count));',
  "```",
  "",
  "```",
  "4feb73d4dd57c61119f530d27e3782ce812140eb40ccd880bbf186e6a0c6dcf",
  "```",
  "",
  "无空格长 URL 测试：https://example.com/reference/long-path-without-spaces?section=typography&mode=chat",
].join("\n");

const wideTable = [
  "8. 第八项 Eighth item",
  "9. 第九项 Ninth item",
  "10. 第十项 Tenth item",
  "11. 第十一项 Eleventh item",
  "12. 第十二项 Twelfth item",
  "",
  `| ${"ABCDEFGHIJKL".split("").join(" | ")} |`,
  `| ${"ABCDEFGHIJKL".split("").map(() => "---").join(" | ")} |`,
  ...[1, 2, 3].map(
    (row) =>
      `| ${"ABCDEFGHIJKL"
        .split("")
        .map((column) => `${["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"]["ABCDEFGHIJKL".indexOf(column)]}OverflowSampleStringRow${row}Column${column}`)
        .join(" | ")} |`,
  ),
].join("\n");

function message(id: string, text: string, extra: Partial<Item> = {}): Item {
  return { id, type: "agentMessage", text, ...extra };
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
function chat(
  id: string,
  title: string,
  at: number,
  turns: Turn[],
  extra: Partial<Conversation> = {},
): Conversation {
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
    ...extra,
  };
}

/** Ids g1-img-* resolve to these synthetic pictures (attachmentPreview below). */
const imageIds = ["g1-img-1", "g1-img-2", "g1-img-3"];
const swatch = (a: string, b: string, w = 4, h = 3) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w * 100} ${h * 100}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`,
  )}`;
const previews: Record<string, string> = {
  "g1-img-1": swatch("#b7c4dd", "#6f8fbf"),
  "g1-img-2": swatch("#4a72ad", "#88a9d6", 7, 5),
  "g1-img-3": swatch("#5f86bb", "#3b6aa6", 7, 5),
};

export function chatAudit2Conversations(origin: number): Conversation[] {
  const at = origin + 9_000_000;
  const images: Attachment[] = imageIds.map((id, i) => ({
    id,
    name: `synthetic-image-${i + 1}.png`,
    path: `/tmp/claudex-audit/synthetic-image-${i + 1}.png`,
    kind: "image",
    size: 48_000,
  }));
  const one: Attachment[] = [images[0]];
  const file: Attachment = {
    id: "g1-file-1",
    name: "synthetic-notes.txt",
    path: "/tmp/claudex-audit/synthetic-notes.txt",
    kind: "text",
    size: 2_048,
  };

  // Reply versions 1/2 and 2/2: two turns of one response group.
  const replyV1 = turn(
    "g1-rv-1",
    Date.now() - 16 * 60_000,
    "Give me a one-line summary of what streaming means.",
    [message("g1-rv-1-m", "Streaming sends the reply in small pieces while it is written.")],
    { responseGroupId: "g1-rv" },
  );
  const replyV2 = turn(
    "g1-rv-2",
    Date.now() - 15 * 60_000,
    "Give me a one-line summary of what streaming means.",
    [
      message(
        "g1-rv-2-m",
        "Streaming means the reply appears piece by piece as it is generated, instead of all at once.",
      ),
    ],
    { responseGroupId: "g1-rv" },
  );

  // Prompt versions 1/2 and 2/2: an edited prompt with its own reply.
  const promptV1 = turn(
    "g1-pv-1",
    Date.now() - 8 * 60_000,
    "List three colours.",
    [message("g1-pv-1-m", "Red, green and blue.")],
    { promptGroupId: "g1-pv", promptVersionId: "g1-pv-1", responseGroupId: "g1-pv-1" },
  );
  const promptV2 = turn(
    "g1-pv-2",
    Date.now() - 30_000,
    "List three warm colours.",
    [message("g1-pv-2-m", "Red, orange and yellow.")],
    { promptGroupId: "g1-pv", promptVersionId: "g1-pv-2", responseGroupId: "g1-pv-2" },
  );
  const branch = (id: string, turns: Turn[], visited: number) => ({
    id,
    turns,
    providerId: "fixture",
    model: "Opus 5.5",
    visited,
  });

  return [
    chat("c-g1-md", "G1 audit: markdown reference", at, [
      turn("g1-md-1", at, longPrompt, [message("g1-md-1-m", md)]),
    ]),
    chat("c-g1-wide", "G1 audit: list and wide table", at + 1, [
      turn(
        "g1-wide-1",
        at,
        "仅用于 Chat UI 测试；不要调用工具、联网、读取或修改文件。请只输出两项：1) 有序列表第 8 到第 12 项，每项单独一行并使用数字 8-12；2) 一个 12 列（A-L）、3 行的 Markdown 表格，各单元格使用较长的无空格英文串，便于观察横向溢出。不要输出真实个人数据。",
        [message("g1-wide-1-m", wideTable)],
      ),
    ]),
    chat(
      "c-g1-reply-versions",
      "G1 audit: reply versions",
      at + 2,
      [replyV2],
      {
        activeBranchId: "g1-rv-b2",
        branchVisit: 2,
        savedBranches: [branch("g1-rv-b1", [replyV1], 1)],
      },
    ),
    chat(
      "c-g1-prompt-versions",
      "G1 audit: prompt versions",
      at + 3,
      [promptV2],
      {
        activeBranchId: "g1-pv-b2",
        branchVisit: 2,
        savedBranches: [branch("g1-pv-b1", [promptV1], 1)],
      },
    ),
    chat("c-g1-images", "G1 audit: attachments", at + 4, [
      turn(
        "g1-att-1",
        at,
        "Describe these pictures.",
        [message("g1-att-1-m", "Three blue gradient pictures.")],
        { attachments: images },
      ),
      turn(
        "g1-att-2",
        at + 60_000,
        "And this one, with the notes?",
        [message("g1-att-2-m", "One picture and a text file.")],
        { attachments: [...one.map((a) => ({ ...a, id: "g1-img-1" })), file] },
      ),
    ]),
    chat("c-g1-short", "G1 audit: short chat", at + 5, [
      turn("g1-short-1", at, "Hello?\n\nSecond paragraph after an empty line.\nThird line.", [
        message("g1-short-1-m", "Hi. This is a short reply."),
      ]),
    ]),
  ];
}

export const chatTranscriptAudit2Fixture: FixtureDomain = {
  params: {
    chatAudit2:
      "1 adds the chat-transcript-2 audit conversations (markdown reference, versions, attachments)",
  },
  bridge: ({ params, origin, state }) => {
    if (params.get("chatAudit2") !== "1") return {};
    if (!state.conversations.some((c) => c.id === "c-g1-md"))
      state.conversations.unshift(...chatAudit2Conversations(origin));
    return {
      attachmentPreview: async (id: string) => previews[id] ?? null,
    };
  },
};
