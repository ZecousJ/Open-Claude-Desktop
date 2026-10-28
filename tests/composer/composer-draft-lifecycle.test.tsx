/**
 * The composer keeps an unsent draft per conversation and per home, brings
 * it back when that place shows again, and a split pane with an unsent
 * draft asks before it closes ("Discard draft?").
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, createElement, useState } from "react";
import type { Attachment } from "../../shared/types";

{
  const { window, document } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  (document as unknown as { oninput: null }).oninput = null;
  Object.assign(globalThis, {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
}
class MemoryStorage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}
const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  configurable: true,
});
const { createRoot } = await import("react-dom/client");
const { draftPlace, readDraft, resetDraftMemory, usePlacedDraft, writeDraft } =
  await import("../../src/composer/draft-store");
const { closePaneAsking, draftPreview, useDiscardDraftQuestion } =
  await import("../../src/split-view/discard-draft");
const { openDraft, openInSplit } =
  await import("../../src/split-view/split-actions");
const { loadSplitFor, resetSplitState, setSplitState, splitState } =
  await import("../../src/split-view/split-state");
const { onComposerSubmitRequest } =
  await import("../../src/composer/submit-request");

beforeEach(() => {
  storage.clear();
  resetDraftMemory();
});

interface Controls {
  setText: (text: string) => void;
  setAttachments: (files: Attachment[]) => void;
  show: (id: string | undefined, carry?: string) => void;
  text: () => string;
}

function mount() {
  const controls = {} as Controls;
  function Harness() {
    const [text, setText] = useState("");
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [id, setId] = useState<string | undefined>();
    usePlacedDraft({
      owner: "me",
      place: draftPlace({ conversationId: id, mode: "chat" }),
      text,
      attachments,
      setText,
      setAttachments,
    });
    controls.setText = setText;
    controls.setAttachments = setAttachments;
    // As App.openConversation does: the composer is emptied, unless the
    // change brings its own text (a fork's message).
    controls.show = (next, carry) => {
      setId(next);
      setText(carry ?? "");
    };
    controls.text = () => text;
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  act(() => root.render(createElement(Harness)));
  return { controls, root };
}

test("a draft stays with its conversation while another one is open", () => {
  const { controls, root } = mount();
  act(() => controls.show("c1"));
  act(() => controls.setText("for c1"));
  act(() => controls.show("c2"));
  assert.equal(controls.text(), "");
  act(() => controls.setText("for c2"));
  act(() => controls.show("c1"));
  assert.equal(controls.text(), "for c1");
  act(() => controls.show(undefined));
  assert.equal(controls.text(), "");
  act(() => controls.show("c2"));
  assert.equal(controls.text(), "for c2");
  act(() => root.unmount());
});

test("a draft written earlier comes back after a reload", () => {
  writeDraft("me", draftPlace({ mode: "chat" }), {
    text: "from last time",
    attachments: [],
  });
  resetDraftMemory();
  const { controls, root } = mount();
  assert.equal(controls.text(), "from last time");
  act(() => root.unmount());
});

test("text a switch brings stays in the new place", () => {
  const { controls, root } = mount();
  act(() => controls.show("c1"));
  act(() => controls.setText("unsent"));
  act(() => controls.show("fork", "the forked message"));
  assert.equal(controls.text(), "the forked message");
  act(() => controls.show("c1"));
  assert.equal(controls.text(), "unsent");
  act(() => root.unmount());
});

test("sending empties the draft, so it does not come back", () => {
  const { controls, root } = mount();
  act(() => controls.show("c1"));
  act(() => controls.setText("sent soon"));
  act(() => controls.setText(""));
  act(() => controls.show("c2"));
  act(() => controls.show("c1"));
  assert.equal(controls.text(), "");
  assert.equal(
    readDraft("me", draftPlace({ conversationId: "c1", mode: "chat" })),
    undefined,
  );
  act(() => root.unmount());
});

test("the question shows the draft's start on one line", () => {
  assert.equal(draftPreview("  fix\n the   build "), "fix the build");
  assert.equal(draftPreview("x".repeat(70)), `${"x".repeat(60)}…`);
});

test("closing a pane with an unsent draft asks first", async () => {
  resetSplitState();
  loadSplitFor("me");
  setSplitState({ maxColumns: 3 });
  openInSplit("s1", "primary");
  openDraft("right");
  const [session, draft] = splitState().panes;
  // A session's pane, and an empty draft's, close at once.
  assert.equal(await closePaneAsking(session.key, "me"), true);
  const place = draftPlace({ mode: "code", pane: draft.key });
  writeDraft("me", place, { text: "start this", attachments: [] });

  /** The question on screen, read as the dialog reads it. */
  const current = () => {
    let value: ReturnType<typeof useDiscardDraftQuestion> | undefined;
    function Probe() {
      value = useDiscardDraftQuestion();
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Probe)));
    act(() => root.unmount());
    return value;
  };
  // Keep editing: nothing happens.
  let asked = closePaneAsking(draft.key, "me");
  assert.equal(current()?.preview, "start this");
  current()!.answer("cancel");
  assert.equal(await asked, false);
  assert.equal(splitState().panes.length, 1);

  // Start session: the pane's composer is asked to send; the pane stays.
  const requested: string[] = [];
  const stop = onComposerSubmitRequest(`${draft.key}:code`, () =>
    requested.push("sent"),
  );
  asked = closePaneAsking(draft.key, "me");
  current()!.answer("start");
  assert.equal(await asked, false);
  assert.deepEqual(requested, ["sent"]);
  stop();

  // Discard: the draft goes and the pane closes.
  asked = closePaneAsking(draft.key, "me");
  current()!.answer("discard");
  assert.equal(await asked, true);
  assert.equal(splitState().panes.length, 0);
  assert.equal(readDraft("me", place), undefined);
});
