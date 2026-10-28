import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { windowRole } from "../../src/conversation-window/window-role";
import {
  draftHandoff,
  handoffAttachmentLimit,
  handoffTextLimit,
} from "../../src/conversation-window/handoff";
import { watchVisibility } from "../../src/conversation-window/useWindowVisibility";
import { shareButtonStatus } from "../../src/conversation-window/share-status";
import type { SharingStatus } from "../../shared/sharing-api";

describe("windowRole", () => {
  it("reads project pop-outs and rejects invalid project identifiers", () => {
    assert.deepEqual(windowRole("?window=project&id=p-1"), {
      kind: "project",
      projectId: "p-1",
    });
    assert.deepEqual(windowRole("?window=project&id=../p"), { kind: "main" });
  });
  it("is the main window without parameters", () => {
    assert.deepEqual(windowRole(""), { kind: "main" });
    assert.deepEqual(windowRole("?fonts=system"), { kind: "main" });
  });
  it("reads a separate conversation window", () => {
    assert.deepEqual(windowRole("?window=conversation&id=c-3"), {
      kind: "conversation",
      conversationId: "c-3",
    });
    assert.deepEqual(
      windowRole(
        "?id=0b5f6c1e-8a2d-4e8e-9f0a-1c2d3e4f5a6b&window=conversation",
      ),
      {
        kind: "conversation",
        conversationId: "0b5f6c1e-8a2d-4e8e-9f0a-1c2d3e4f5a6b",
      },
    );
  });
  it("accepts known tool-pane windows but ignores unrecognized pane names", () => {
    assert.deepEqual(windowRole("?window=conversation&id=c-3&pane=files"), {
      kind: "conversation",
      conversationId: "c-3",
      pane: "files",
    });
    assert.deepEqual(windowRole("?window=conversation&id=c-3&pane=invalid"), {
      kind: "conversation",
      conversationId: "c-3",
    });
  });
  it("falls back to the main window for anything unexpected", () => {
    for (const search of [
      "?window=conversation",
      "?window=conversation&id=",
      "?window=conversation&id=../x",
      "?window=conversation&id=a%20b",
      "?window=conversation&id=a/b",
      `?window=conversation&id=${"a".repeat(129)}`,
      "?window=artifact&id=c-3",
      "?id=c-3",
    ])
      assert.deepEqual(windowRole(search), { kind: "main" }, search);
    assert.equal(
      windowRole(`?window=conversation&id=${"a".repeat(128)}`).kind,
      "conversation",
    );
  });
});

describe("draftHandoff", () => {
  it("is nothing for an empty draft", () => {
    assert.equal(
      draftHandoff({ text: "", attachments: [], providerId: "p", model: "m" }),
      undefined,
    );
  });
  it("carries the text, attachment ids and non-empty selections", () => {
    assert.deepEqual(
      draftHandoff({
        text: "hello",
        attachments: [{ id: "a1" }, { id: "a2" }],
        providerId: "",
        model: "gpt-5",
      }),
      { text: "hello", attachmentIds: ["a1", "a2"], model: "gpt-5" },
    );
    assert.deepEqual(draftHandoff({ text: "", attachments: [{ id: "a" }] }), {
      text: "",
      attachmentIds: ["a"],
    });
  });
  it("refuses a draft the main process would reject", () => {
    assert.throws(
      () =>
        draftHandoff({
          text: "x".repeat(handoffTextLimit + 1),
          attachments: [],
        }),
      /too long/,
    );
    assert.throws(
      () =>
        draftHandoff({
          text: "x",
          attachments: Array.from(
            { length: handoffAttachmentLimit + 1 },
            (_, i) => ({ id: `a${i}` }),
          ),
        }),
      /attachments/,
    );
  });
});

describe("watchVisibility", () => {
  function fakePage(state: "visible" | "hidden") {
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: (type: string, listener: unknown) =>
        void listeners.set(type, listener as () => void),
      removeEventListener: (type: string) => void listeners.delete(type),
    };
    const page = {
      document: {
        ...target,
        visibilityState: state as DocumentVisibilityState,
      },
      window: target,
      fire: (type: string) => listeners.get(type)?.(),
      listeners,
    };
    return page;
  }

  it("reports the current state, each change once, and hidden when stopped", async () => {
    const sent: boolean[] = [];
    const page = fakePage("visible");
    const stop = watchVisibility(async (visible) => {
      sent.push(visible);
    }, page);
    page.fire("focus");
    page.document.visibilityState = "hidden";
    page.fire("visibilitychange");
    page.fire("visibilitychange");
    page.document.visibilityState = "visible";
    page.fire("visibilitychange");
    stop();
    assert.deepEqual(sent, [true, false, true, false]);
    assert.equal(page.listeners.size, 0);
  });

  it("sends a state again after a failed report", async () => {
    const sent: boolean[] = [];
    let fail = true;
    const page = fakePage("visible");
    const stop = watchVisibility(async (visible) => {
      sent.push(visible);
      if (fail) throw new Error("offline");
    }, page);
    await new Promise((resolve) => setImmediate(resolve));
    fail = false;
    page.fire("focus");
    stop();
    assert.deepEqual(sent, [true, true, false]);
  });
});

describe("shareButtonStatus", () => {
  const on = { conversations: true, artifacts: true } as SharingStatus;
  const off = { conversations: false, artifacts: false } as SharingStatus;
  it("shows Share when the service offers conversation sharing", () => {
    assert.equal(shareButtonStatus(on, false), on);
  });
  it("keeps Share for an existing link after sharing is turned off", () => {
    assert.equal(shareButtonStatus(off, true), off);
    assert.equal(shareButtonStatus(off, false), null);
  });
  it("shows nothing without hosted sharing", () => {
    assert.equal(shareButtonStatus(null, true), null);
    assert.equal(shareButtonStatus(undefined, false), null);
  });
});
