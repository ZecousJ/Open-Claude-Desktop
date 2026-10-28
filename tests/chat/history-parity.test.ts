import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import type { Conversation, Mode } from "../../shared/types";
import { useHistorySearch } from "../../src/collections/history/use-history-search";
import {
  historyNeedsAttention,
  historyRepositoryName,
  matchesHistoryTitle,
} from "../../src/collections/history/history-rows";

const row = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  title: id,
  mode: "cowork",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  turns: [],
  ...extra,
});

test("Code's title fallback does not search message bodies; attention excludes archived rows", () => {
  const conversation = row("title", {
    unread: true,
    turns: [
      {
        id: "turn",
        prompt: "body needle",
        attachments: [],
        items: [],
        status: "completed",
        createdAt: 1,
      },
    ],
  });
  assert.equal(matchesHistoryTitle(conversation, "TITLE"), true);
  assert.equal(matchesHistoryTitle(conversation, "needle"), false);
  assert.equal(historyNeedsAttention(conversation, false), true);
  assert.equal(
    historyNeedsAttention({ ...conversation, archived: true }, true),
    false,
  );
  assert.equal(historyNeedsAttention(row("waiting"), true), true);
  assert.equal(historyNeedsAttention(row("idle"), false), false);
  assert.equal(
    historyRepositoryName(row("local", { cwd: "/work/project/" })),
    "project",
  );
  assert.equal(
    historyRepositoryName(row("windows", { cwd: "C:\\work\\project" })),
    "project",
  );
  assert.equal(
    historyRepositoryName(row("local", { cwd: "/work/project" }), "owner/repo"),
    "owner/repo",
  );
});

test("history searches the host after 300ms, retries failures, and keeps bulk read/pin selection", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  (document as unknown as { oninput: null }).oninput = null;
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  let calls = 0;
  let fail = true;
  let mode: Mode = "cowork";
  const conversations = [
    row("title", {
      title: "",
      unread: true,
      updatedAt: 3,
      turns: [
        {
          id: "turn",
          prompt: "hi",
          attachments: [],
          items: [],
          status: "completed",
          createdAt: 1,
        },
      ],
    }),
    row("other"),
    row("archived", { mode: "chat", archived: true }),
    row("local-code", { mode: "code", cwd: "/work/local-project" }),
    row("code", {
      mode: "code",
      title: "needle session",
      repository: {
        fullName: "owner/repository",
        url: "https://github.com/owner/repository",
      },
    }),
  ];
  const updates: {
    ids: string[];
    patch: { pinned?: boolean; unread?: boolean };
  }[] = [];
  const archiveRequests: string[][] = [];
  Object.assign(window, {
    desktop: {
      hostedShares: async () => [{ status: "active", sourceKey: "archived" }],
      codeGitStatus: async (id: string) => {
        assert.equal(id, "local-code");
        return { state: "ready", repository: "local/repository" };
      },
      onEvent: () => () => {},
      listConversationGroups: async () => ({ groups: [], members: {} }),
      searchConversations: async (query: string) => {
        calls++;
        assert.equal(query, "needle");
        if (fail) throw new Error("offline");
        return {
          results: [{ conversationId: "other", snippet: "server needle" }],
        };
      },
    },
  });
  const { createRoot } = await import("react-dom/client");
  const { HistoryPage } =
    await import("../../src/collections/history/HistoryPage");
  const root = createRoot(document.querySelector("main")!);
  const render = () =>
    root.render(
      createElement(HistoryPage, {
        mode,
        conversations,
        projects: [],
        onNewChat() {},
        onOpenConversation() {},
        onRename() {},
        onArchive: async () => [],
        onDelete() {},
        onConfirmArchive: (ids) => {
          archiveRequests.push(ids);
        },
        onUpdateSelection: async (ids, patch) => {
          updates.push({ ids, patch });
          return [];
        },
      }),
    );
  const button = (label: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const textButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent === label,
    )!;
  const wait = () =>
    act(() => new Promise<void>((resolve) => setTimeout(resolve, 320)));
  try {
    await act(render);
    assert.match(document.body.innerHTML, /More options for Untitled/);
    assert.match(document.body.innerHTML, /Needs attention/);
    await act(() => textButton("Select").click());
    await act(() => textButton("Select all").click());
    assert.ok(
      document.querySelector(
        '[role="group"][aria-label="Actions for the selection"]',
      ),
    );
    await act(() => button("Pin").click());
    assert.deepEqual(updates[0], {
      ids: ["title", "other"],
      patch: { pinned: true },
    });
    await act(() => button("Mark as read").click());
    assert.deepEqual(updates[1], { ids: ["title"], patch: { unread: false } });
    assert.equal(
      document.querySelectorAll('[role="checkbox"][aria-checked="true"]')
        .length,
      2,
    );
    await act(() => button("Archive").click());
    assert.deepEqual(archiveRequests, [["title", "other"]]);
    await act(() => button("Exit selection").click());
    await act(() => textButton("Shared").click());
    assert.equal(
      document.querySelector(".history-tag")?.textContent,
      "Archived",
    );
    mode = "code";
    await act(render);
    assert.equal(
      document.querySelector(".history-repository")?.textContent,
      "owner/repository",
    );
    assert.ok(
      [...document.querySelectorAll(".history-repository")].some(
        (caption) => caption.textContent === "local/repository",
      ),
    );
    let search!: ReturnType<typeof useHistorySearch>;
    mode = "cowork";
    let input = "ignored";
    function SearchHarness() {
      search = useHistorySearch(input, mode, "all", conversations);
      return null;
    }
    const renderSearch = () => root.render(createElement(SearchHarness));
    await act(renderSearch);
    input = "needle";
    await act(renderSearch);
    assert.equal(calls, 0);
    await wait();
    assert.equal(calls, 1);
    assert.equal(search.error, true);
    assert.equal(search.pending, false);
    fail = false;
    await act(() => search.retry());
    assert.equal(calls, 2);
    assert.equal(search.error, false);
    assert.equal(search.results[0].conversationId, "other");
    assert.equal(search.results[0].snippet, "server needle");
    mode = "code";
    await act(renderSearch);
    assert.deepEqual(search.results, []);
    assert.equal(calls, 2);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
