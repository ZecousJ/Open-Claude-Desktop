/**
 * Research mode (R4, design R45 §4) for the preview. `research=1` adds three
 * Chat conversations in Research mode:
 * - "Sidebar density and tooltip accessibility": gathering, 185 sources,
 *   2m 58s (the transcript card, design R45 §4.3, and the running panel).
 * - "Composer chip placement": done, with a synthetic report the panel
 *   reads (design R45 §4.4).
 * - "Stopped research": failed while gathering ("Research stopped").
 * Every other call answers as the main process would: Research turns on
 * with web search, the report can't be saved (no save dialog here) and
 * site icons stay placeholders.
 */
import type { Conversation, Item, Turn } from "../../../shared/types";
import type { ResearchState } from "../../../shared/research";
import type { FixtureDomain } from "./index";

const hosts = [
  "www.w3.org",
  "developer.mozilla.org",
  "www.nngroup.com",
  "m3.material.io",
  "developer.apple.com",
  "web.dev",
  "a11yproject.com",
  "www.smashingmagazine.com",
];

/** `count` synthetic pages over a few searches. */
function searches(prefix: string, count: number): Item[] {
  const items: Item[] = [];
  const perSearch = 20;
  for (let s = 0; s * perSearch < count; s++) {
    const sources = [];
    for (let i = s * perSearch; i < Math.min(count, (s + 1) * perSearch); i++) {
      const host = hosts[i % hosts.length];
      sources.push({
        url: `https://${host}/fixture/${prefix}-${i}`,
        title: `Sidebar density note ${i + 1}`,
      });
    }
    items.push({
      id: `${prefix}-ws-${s}`,
      type: "webSearch",
      query: `sidebar density ${s + 1}`,
      action: { type: "search", query: `sidebar density ${s + 1}` },
      lifecycleStatus: "completed",
      sources,
    });
  }
  return items;
}

function conversation(
  id: string,
  title: string,
  at: number,
  turn: Turn,
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
    updatedAt: at,
    webSearch: true,
    research: true,
    turns: [turn],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

const questions = [
  "How dense are the sidebars of current desktop chat apps?",
  "Which row heights and paddings keep 44px touch targets?",
  "How should tooltips on icon-only buttons be announced?",
  "What contrast do secondary sidebar labels need?",
];

const reportMarkdown = `# Composer chip placement

Chips that change how a message is sent sit next to the attachment button,
before the text, so they are read before the message itself.

## Findings

- A chip that stays on for the whole draft needs a pressed state
  (\`aria-pressed\`), not only a colour change.
- Tooltips on icon-only chips should name the mode ("Research"), and the
  chip should be reachable with Tab in the order it appears.
- Turning a mode off from the chip and from the menu should be the same
  action, so the two never disagree.

## Recommendation

Keep the chip 31 px square with an 8 px radius, and show it only while the
mode is on.
`;

export function researchConversations(origin: number): Conversation[] {
  const gatheringAt = origin - 178_000;
  const gatheringState: ResearchState = {
    title: "Sidebar density and tooltip accessibility",
    questions,
    state: "gathering",
    startedAt: gatheringAt,
    sourceCount: 185,
    searchCount: 10,
  };
  const gathering = conversation(
    "c-research-gathering",
    "Sidebar density and tooltip accessibility",
    gatheringAt,
    {
      id: "t-research-gathering",
      prompt: "Research sidebar density and tooltip accessibility in chat apps.",
      attachments: [],
      status: "inProgress",
      createdAt: gatheringAt,
      research: gatheringState,
      items: [
        {
          id: "msg-research-gathering",
          type: "agentMessage",
          text: "I'll look at how current apps size their sidebars and label their icon buttons.",
        },
        ...searches("g", 185),
      ],
    },
  );
  const doneAt = origin - 40 * 60_000;
  const done = conversation(
    "c-research-done",
    "Composer chip placement",
    doneAt,
    {
      id: "t-research-done",
      prompt: "Research where mode chips should sit in a chat composer.",
      attachments: [],
      status: "completed",
      createdAt: doneAt,
      research: {
        title: "Composer chip placement",
        questions: questions.slice(0, 2),
        state: "done",
        startedAt: doneAt,
        completedAt: doneAt + 4 * 60_000 + 12_000,
        sourceCount: 42,
        searchCount: 3,
        report: {
          title: "Composer chip placement",
          path: "research/c-research-done/composer-chip-placement.md",
          bytes: reportMarkdown.length,
        },
        reportSource: "tool",
      },
      items: [
        ...searches("d", 42),
        {
          id: "msg-research-done",
          type: "agentMessage",
          text: "The report is ready: keep the chip beside the attachment button with a pressed state.",
        },
      ],
    },
  );
  const failedAt = origin - 2 * 60 * 60_000;
  const failed = conversation("c-research-failed", "Stopped research", failedAt, {
    id: "t-research-failed",
    prompt: "Research tooltip delays.",
    attachments: [],
    status: "failed",
    error: "The model service stopped responding.",
    createdAt: failedAt,
    research: {
      state: "failed",
      startedAt: failedAt,
      completedAt: failedAt + 51_000,
      sourceCount: 7,
      searchCount: 1,
    },
    items: searches("f", 7),
  });
  return [gathering, done, failed];
}

/**
 * "Web search rows": a finished search with nine results, whose titles and
 * hosts are shaped like R-0740's list (a title cut with an ellipsis, the
 * host on the right), a second search that failed, and a reply with
 * citations. Synthetic pages only.
 */
function webSearchConversation(origin: number): Conversation {
  const at = origin - 120_000;
  const rows: [string, string][] = [
    ["Vintage field watch automatic movement service guide", "www.watchnotes.example"],
    ["Vintage field watch 120 ref 166 restoration notes", "www.watchnotes.example"],
    ["Field watch issued to a survey team ref 84", "www.watchnotes.example"],
    ["Vintage field watch 120 automatic dial variants", "www.watchnotes.example"],
    ["Quartz dive watch 1977 date model 196 0073 overview", "dialarchive.example"],
    ["FIELD Vintage WATCH 120 Restored", "www.watchnotes.example"],
    ["Quartz dive watch 1977 date model 196 0073", "dialarchive.example"],
    ["Quartz dive watch 1977 date model 196 0073", "dialarchive.example"],
    ["1973 Automatic Chronograph field watch", "collectors.example"],
  ];
  const sources = rows.map(([title, host], i) => ({
    url: `https://${host}/item-${i}`,
    title,
  }));
  const reply =
    "The 1977 quartz model is documented in a dial archive ([dialarchive.example](https://dialarchive.example/item-4)). " +
    "Restoration notes for the automatic 120 are on a second site ([watchnotes.example](https://www.watchnotes.example/item-1)).";
  const span = (fragment: string) => {
    const start = reply.indexOf(fragment);
    return { start, end: start + fragment.length };
  };
  const first = "([dialarchive.example](https://dialarchive.example/item-4))";
  const second = "([watchnotes.example](https://www.watchnotes.example/item-1))";
  return conversation("c-web-search-rows", "Web search rows", at, {
    id: "t-web-search-rows",
    prompt: "Find the field watch notes.",
    attachments: [],
    status: "completed",
    createdAt: at,
    items: [
      {
        id: "ws-rows-1",
        type: "webSearch",
        query: "ref-search-test-20260925-omega73",
        action: { type: "search", query: "ref-search-test-20260925-omega73" },
        status: "completed",
        lifecycleStatus: "completed",
        searchTool: "web_search",
        sources,
      },
      {
        id: "ws-rows-2",
        type: "webSearch",
        query: "second search",
        action: { type: "search", query: "second search" },
        status: "failed",
        lifecycleStatus: "failed",
      },
      {
        id: "msg-rows",
        type: "agentMessage",
        text: reply,
        status: "completed",
        lifecycleStatus: "completed",
        citations: [
          { url: sources[4].url, title: sources[4].title, ...span(first) },
          { url: sources[1].url, title: sources[1].title, ...span(second) },
        ],
      },
    ],
  });
}

export const researchFixture: FixtureDomain = {
  params: {
    research: "1 adds gathering, done and stopped Research chats",
    webSearchRows: "1 adds the Chat 'Web search rows' (results list, failure, citations)",
  },
  bridge: ({ params, origin, state }) => {
    if (
      params.get("research") === "1" &&
      !state.conversations.some((c) => c.id === "c-research-gathering")
    )
      state.conversations.unshift(...researchConversations(origin));
    if (
      params.get("webSearchRows") === "1" &&
      !state.conversations.some((c) => c.id === "c-web-search-rows")
    )
      state.conversations.unshift(webSearchConversation(origin));
    return {
      setConversationResearch: async (conversationId, enabled) => {
        const index = state.conversations.findIndex(
          (c) => c.id === conversationId,
        );
        if (index < 0) throw new Error("Conversation not found.");
        const next = {
          ...state.conversations[index],
          research: enabled,
          ...(enabled ? { webSearch: true } : {}),
        };
        state.conversations[index] = next;
        return next;
      },
      readResearchReport: async (conversationId, turnId) => {
        if (
          conversationId === "c-research-done" &&
          turnId === "t-research-done"
        )
          return { title: "Composer chip placement", markdown: reportMarkdown };
        throw new Error("This research report isn't available.");
      },
      // No save dialog in the preview: as if it were cancelled.
      saveResearchReport: async () => false,
      getFavicons: async (list) =>
        Object.fromEntries(list.map((host) => [host, null])),
    };
  },
};
