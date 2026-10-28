/**
 * Chat's prompt editor is the shared PromptEdit (also Cowork's): Edit opens
 * it, Save sends the changed text and closes it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import type { Conversation, Turn } from "../../shared/types";

// See cowork-prompt-actions.test.tsx: react-dom must load against a document
// that reports `input` events.
{
  const { window, document } = parseHTML("<html><body></body></html>");
  (document as unknown as { oninput: null }).oninput = null;
  Object.assign(globalThis, { window, document });
}
const { createRoot } = await import("react-dom/client");
const { UserMessage } = await import("../../src/transcript/UserMessage");

test("Chat's Edit opens the shared editor and Save passes the new text", async () => {
  const { window, document } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  Object.getPrototypeOf(document.createElement("textarea")).setSelectionRange =
    () => {};
  Object.assign(globalThis, {
    window,
    document,
    getComputedStyle: () => ({ getPropertyValue: () => "0" }),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
    innerWidth: 1440,
    innerHeight: 900,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  const turn: Turn = {
    id: "t",
    prompt: "hello",
    attachments: [],
    items: [],
    status: "completed",
    createdAt: 1,
  };
  const conversation = { id: "c", mode: "chat", turns: [turn] } as Conversation;
  const saved: string[] = [];
  const root = createRoot(document.getElementById("root")!);
  const fire = (selector: string, event: string) =>
    act(async () => {
      document
        .querySelector(selector)!
        .dispatchEvent(new window.Event(event, { bubbles: true }));
    });
  try {
    await act(async () =>
      root.render(
        createElement(UserMessage, {
          conversation,
          turn,
          busy: false,
          onEdit: async (text: string) => {
            saved.push(text);
            return true;
          },
          onRetry() {},
          onSelect() {},
        }),
      ),
    );
    // Edit sits in the message's More options menu.
    await fire('button[aria-label="More options"]', "click");
    const edit = [...document.querySelectorAll('[role^="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Edit",
    );
    assert.ok(edit, "Edit in More options");
    await act(async () => {
      edit!.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    assert.ok(document.querySelector(".user-message.is-editing"));
    const save = () =>
      document.querySelector(".save-message") as HTMLButtonElement;
    assert.equal(save().disabled, true);
    const field = document.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(field),
        "value",
      )!.set!.call(field, "hello there");
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await fire(".save-message", "click");
    assert.deepEqual(saved, ["hello there"]);
    assert.equal(document.querySelector(".user-message.is-editing"), null);
  } finally {
    await act(async () => root.unmount());
  }
});
