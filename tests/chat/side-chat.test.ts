import test from "node:test";
import assert from "node:assert/strict";
import {
  branchDraft,
  sideChatAvailability,
} from "../../src/side-chat/side-chat-model";
import {
  applySideChatText,
  askSideChat,
  askSideChatNow,
  clearSideChat,
  clearSideChatContext,
  closeSideChat,
  openSideChat,
  openSideChatWithContext,
  resetSideChats,
  setSideChatDraft,
  sideChatContextLimit,
  sideChatOf,
  sideChatStarted,
  stopSideChat,
  toggleSideChat,
} from "../../src/side-chat/side-chat-store";
import { menuStateFor } from "../../src/app/shell-menu";
import type { Turn } from "../../shared/types";

const turn = (id: string, status: Turn["status"] = "completed"): Turn => ({
  id,
  prompt: id,
  attachments: [],
  items: [],
  status,
  createdAt: 1,
});
const conversation = (turns: Turn[], threadId: string | null = "t") => ({
  mode: "chat" as const,
  threadId: threadId ?? undefined,
  turns,
});

type Calls = { ask: unknown[][]; end: unknown[][]; stop: unknown[][] };
function desktop(answer: (question: string) => Promise<string>) {
  const calls: Calls = { ask: [], end: [], stop: [] };
  (globalThis as any).window = {
    desktop: {
      askSideChat: (...args: unknown[]) => {
        calls.ask.push(args);
        return answer(String(args[2]));
      },
      interruptSideChat: async (...args: unknown[]) => {
        calls.stop.push(args);
      },
      endSideChat: async (...args: unknown[]) => {
        calls.end.push(args);
      },
    },
  };
  return calls;
}

test("a side chat starts once the conversation has a finished reply, in Chat and Code only", () => {
  assert.equal(sideChatAvailability(undefined, "code").available, false);
  assert.equal(
    sideChatAvailability(undefined, "code").reason,
    "Open a session to use side chat",
  );
  assert.equal(
    sideChatAvailability(undefined, "chat").reason,
    "Open a chat to use side chat",
  );
  assert.equal(
    sideChatAvailability(conversation([turn("a", "inProgress")]), "chat")
      .available,
    false,
  );
  assert.match(
    sideChatAvailability(conversation([turn("a", "inProgress")]), "chat")
      .reason ?? "",
    /once this conversation starts/,
  );
  assert.equal(
    sideChatAvailability(conversation([turn("a")], null), "chat").available,
    false,
  );
  assert.equal(
    sideChatAvailability(conversation([turn("a")]), "chat").available,
    true,
  );
  // A reply running after a finished one still allows it.
  assert.equal(
    sideChatAvailability(
      conversation([turn("a"), turn("b", "inProgress")]),
      "code",
    ).available,
    true,
  );
  assert.equal(
    sideChatAvailability(
      { ...conversation([turn("a")]), mode: "cowork" },
      "cowork",
    ).available,
    false,
  );
});

test("Branch to new chat carries the side question and its answer", () => {
  assert.equal(
    branchDraft("What is X?", "X is Y."),
    "Continuing from a side question.\n\nQ: What is X?\n\nA: “X is Y.”\n\n",
  );
  assert.equal(branchDraft(undefined, "Only an answer."), "Only an answer.");
});

test("the panel opens, closes and keeps its draft; questions and answers pile up until Clear", async () => {
  resetSideChats();
  const calls = desktop(async (question) => `Answer to ${question}`);
  openSideChat("c");
  assert.equal(sideChatOf("c")?.open, true);
  setSideChatDraft("c", "  What is this?  ");
  closeSideChat("c");
  assert.equal(sideChatOf("c")?.open, false);
  assert.equal(sideChatOf("c")?.draft, "  What is this?  ");
  toggleSideChat("c");
  assert.equal(sideChatOf("c")?.open, true);
  const id = sideChatOf("c")!.sideChatId;
  const sent = askSideChat("c", sideChatOf("c")!.draft);
  // The question shows at once and the field empties.
  assert.deepEqual(sideChatOf("c")?.messages, [
    { role: "user", text: "What is this?" },
  ]);
  assert.equal(sideChatOf("c")?.thinking, true);
  assert.equal(sideChatOf("c")?.draft, "");
  // One question at a time.
  await askSideChat("c", "Too soon");
  assert.equal(calls.ask.length, 1);
  await sent;
  assert.deepEqual(calls.ask[0], ["c", id, "What is this?"]);
  assert.deepEqual(sideChatOf("c")?.messages, [
    { role: "user", text: "What is this?" },
    {
      role: "assistant",
      text: "Answer to What is this?",
      question: "What is this?",
    },
  ]);
  assert.equal(sideChatOf("c")?.thinking, false);
  await askSideChat("c", "And then?");
  assert.equal(sideChatOf("c")?.messages.length, 4);
  // Clear empties the list, releases the fork and starts a new one.
  clearSideChat("c");
  assert.deepEqual(sideChatOf("c")?.messages, []);
  assert.equal(sideChatOf("c")?.open, true);
  assert.notEqual(sideChatOf("c")?.sideChatId, id);
  assert.deepEqual(calls.end, [["c", id]]);
});

test("a question that gets no answer goes back to the field with the reason", async () => {
  resetSideChats();
  desktop(async () => {
    throw new Error("Couldn’t get an answer. Try again.");
  });
  openSideChat("c");
  await askSideChat("c", "Will it work?");
  const state = sideChatOf("c")!;
  assert.deepEqual(state.messages, []);
  assert.equal(state.thinking, false);
  assert.equal(state.error, "Couldn’t get an answer. Try again.");
  assert.equal(state.draft, "Will it work?");
});

test("clearing while a question is out ignores its answer", async () => {
  resetSideChats();
  let finish: (answer: string) => void = () => {};
  desktop(() => new Promise<string>((resolve) => (finish = resolve)));
  openSideChat("c");
  const pending = askSideChat("c", "Slow one");
  clearSideChat("c");
  finish("too late");
  await pending;
  assert.deepEqual(sideChatOf("c")?.messages, []);
  assert.equal(sideChatOf("c")?.thinking, false);
});

test("the menu reports the side chat of the open conversation", () => {
  const input = {
    mode: "chat" as const,
    sidebarOpen: true,
    sidebarEnabled: true,
    canGoBack: false,
    canGoForward: false,
    inCodeConversation: false,
    isOpen: () => false,
    terminalAvailable: false,
    browserAvailable: false,
    artifactOpen: false,
    anyPanelOpen: false,
    canReopenClosed: false,
  };
  assert.deepEqual(menuStateFor(input).sideChat, {
    enabled: false,
    open: false,
  });
  assert.deepEqual(
    menuStateFor({ ...input, sideChatAvailable: true, sideChatOpen: true })
      .sideChat,
    { enabled: true, open: true },
  );
  // Open without a conversation that can have one reads as closed.
  assert.deepEqual(menuStateFor({ ...input, sideChatOpen: true }).sideChat, {
    enabled: false,
    open: false,
  });
});

test("a passage selected in a reply is staged, cut to 1500 characters, and goes with the next question", async () => {
  resetSideChats();
  const calls = desktop(async () => "Because.");
  assert.equal(sideChatStarted("c"), false);
  openSideChatWithContext("c", `  ${"x".repeat(2000)}  `);
  assert.equal(sideChatOf("c")?.open, true);
  assert.equal(sideChatOf("c")?.context?.length, sideChatContextLimit);
  // A blank selection opens the card without staging anything.
  clearSideChatContext("c");
  openSideChatWithContext("c", "   ");
  assert.equal(sideChatOf("c")?.context, undefined);
  openSideChatWithContext("c", "line one\nline two");
  await askSideChat("c", "Why?");
  // The engine gets the passage as an attached quote; the list keeps them apart.
  assert.equal(
    calls.ask[0][2],
    "<!-- attach -->\n> line one\n> line two\n\nWhy?",
  );
  assert.deepEqual(sideChatOf("c")?.messages[0], {
    role: "user",
    text: "Why?",
    context: "line one\nline two",
  });
  assert.equal(sideChatOf("c")?.context, undefined);
  assert.equal(sideChatStarted("c"), true);
  openSideChatWithContext("c", "again");
  assert.equal(sideChatOf("c")?.context, "again");
  assert.equal(sideChatOf("c")?.messages.length, 2);
  // A question that gets no answer keeps its passage for the next try.
  desktop(async () => {
    throw new Error("No.");
  });
  await askSideChat("c", "And?");
  assert.equal(sideChatOf("c")?.context, "again");
  assert.equal(sideChatOf("c")?.draft, "And?");
});

test("/btw opens the card and asks at once; a busy card keeps the question in the field", async () => {
  resetSideChats();
  const calls = desktop(async (question) => `Answer to ${question}`);
  await askSideChatNow("c", "  quick one  ");
  assert.equal(sideChatOf("c")?.open, true);
  assert.deepEqual(calls.ask[0].slice(2), ["quick one"]);
  assert.equal(sideChatOf("c")?.messages.length, 2);
  // Bare /btw only opens it.
  closeSideChat("c");
  await askSideChatNow("c", "  ");
  assert.equal(sideChatOf("c")?.open, true);
  assert.equal(calls.ask.length, 1);
  // While an answer is out, the new question waits in the field.
  let finish: (answer: string) => void = () => {};
  desktop(() => new Promise<string>((resolve) => (finish = resolve)));
  const slow = askSideChat("c", "Slow");
  await askSideChatNow("c", "Next");
  assert.equal(sideChatOf("c")?.draft, "Next");
  finish("done");
  await slow;
});

const text = (id: string, value: string) => ({
  type: "side-chat-text" as const,
  conversationId: id,
  sideChatId: sideChatOf(id)!.sideChatId,
  text: value,
});

test("the answer shows as it is written and is replaced by the final one", async () => {
  resetSideChats();
  let finish: (answer: string) => void = () => {};
  desktop(() => new Promise<string>((resolve) => (finish = resolve)));
  openSideChat("c");
  const pending = askSideChat("c", "Tell me");
  assert.equal(sideChatOf("c")?.partial, undefined);
  applySideChatText(text("c", "Well"));
  assert.equal(sideChatOf("c")?.partial, "Well");
  applySideChatText(text("c", "Well, here it is"));
  assert.equal(sideChatOf("c")?.partial, "Well, here it is");
  // Another side chat's text, or another conversation's, is not ours.
  applySideChatText({ ...text("c", "stray"), sideChatId: "other" });
  applySideChatText({ ...text("c", "stray"), conversationId: "nobody" });
  assert.equal(sideChatOf("c")?.partial, "Well, here it is");
  // The messages only change when the answer is whole.
  assert.equal(sideChatOf("c")?.messages.length, 1);
  finish("Well, here it is.");
  await pending;
  const state = sideChatOf("c")!;
  assert.equal(state.partial, undefined);
  assert.deepEqual(state.messages.at(-1), {
    role: "assistant",
    text: "Well, here it is.",
    question: "Tell me",
  });
  // A late copy after the answer is ignored.
  applySideChatText(text("c", "late"));
  assert.equal(sideChatOf("c")?.partial, undefined);
});

test("a failed answer drops the text written so far", async () => {
  resetSideChats();
  let fail: (error: Error) => void = () => {};
  desktop(() => new Promise<string>((_, reject) => (fail = reject)));
  openSideChat("c");
  const pending = askSideChat("c", "Will it?");
  applySideChatText(text("c", "Half"));
  fail(new Error("Couldn’t get an answer. Try again."));
  await pending;
  const state = sideChatOf("c")!;
  assert.equal(state.partial, undefined);
  assert.deepEqual(state.messages, []);
  assert.equal(state.draft, "Will it?");
  assert.equal(state.error, "Couldn’t get an answer. Try again.");
});

test("Stop asks the engine to end the answer; what was written stays", async () => {
  resetSideChats();
  let finish: (answer: string) => void = () => {};
  const calls = desktop(
    () => new Promise<string>((resolve) => (finish = resolve)),
  );
  // Nothing to stop yet.
  openSideChat("c");
  await stopSideChat("c");
  assert.deepEqual(calls.stop, []);
  const pending = askSideChat("c", "Go on");
  applySideChatText(text("c", "One two"));
  const id = sideChatOf("c")!.sideChatId;
  await stopSideChat("c");
  assert.deepEqual(calls.stop, [["c", id]]);
  assert.equal(sideChatOf("c")?.stopping, true);
  // Stop twice is one request.
  await stopSideChat("c");
  assert.equal(calls.stop.length, 1);
  finish("One two");
  await pending;
  const state = sideChatOf("c")!;
  assert.equal(state.thinking, false);
  assert.equal(state.stopping, false);
  assert.equal(state.error, undefined);
  assert.equal(state.messages.at(-1)?.text, "One two");
});

test("a question stopped before any text goes back to the field without an error", async () => {
  resetSideChats();
  let fail: (error: Error) => void = () => {};
  desktop(() => new Promise<string>((_, reject) => (fail = reject)));
  openSideChat("c");
  const pending = askSideChat("c", "Quick?");
  await stopSideChat("c");
  fail(new Error("The side chat was stopped."));
  await pending;
  const state = sideChatOf("c")!;
  assert.deepEqual(state.messages, []);
  assert.equal(state.thinking, false);
  assert.equal(state.stopping, false);
  assert.equal(state.error, undefined);
  assert.equal(state.draft, "Quick?");
});

test("Stop that cannot reach the engine can be pressed again", async () => {
  resetSideChats();
  const calls = desktop(() => new Promise<string>(() => {}));
  (globalThis as any).window.desktop.interruptSideChat = async (
    ...args: unknown[]
  ) => {
    calls.stop.push(args);
    throw new Error("away");
  };
  openSideChat("c");
  void askSideChat("c", "Hello?");
  await stopSideChat("c");
  assert.equal(sideChatOf("c")?.stopping, false);
  await stopSideChat("c");
  assert.equal(calls.stop.length, 2);
});
