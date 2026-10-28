/**
 * Cowork's last prompt has Restart session from here and Edit: when they show,
 * and that they reach the transcript's retry and edit callbacks, which are the
 * engine's retryResponse and editPrompt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { CodeUserMessage } from "../../src/transcript/CodeUserMessage";
import { coworkPromptActions } from "../../src/transcript/cowork-prompt-actions";
import type { Conversation, Turn } from "../../shared/types";

// React reads the document once, when react-dom/client loads, to decide
// whether text fields report `input` events; linkedom has to look like a
// browser that does (an `oninput` handler slot) before it is imported.
{
  const { window, document } = parseHTML("<html><body></body></html>");
  (document as unknown as { oninput: null }).oninput = null;
  Object.assign(globalThis, { window, document });
}
const { createRoot } = await import("react-dom/client");

function turn(id: string, patch: Partial<Turn> = {}): Turn {
  return {
    id,
    prompt: `prompt ${id}`,
    attachments: [],
    items: [],
    status: "completed",
    createdAt: 1,
    ...patch,
  };
}
const conversation = (turns: Turn[]) =>
  ({ turns }) as Pick<Conversation, "turns">;

test("only a finished last Cowork prompt shows Edit and Restart", () => {
  const a = turn("a");
  const b = turn("b");
  const both = conversation([a, b]);
  const yes = { edit: true, restart: true };
  const no = { edit: false, restart: false };
  assert.deepEqual(coworkPromptActions(both, b, "cowork", false), yes);
  // An earlier prompt has neither.
  assert.deepEqual(coworkPromptActions(both, a, "cowork", false), no);
  // While Claude works, hidden (the original hides them while streaming).
  assert.deepEqual(coworkPromptActions(both, b, "cowork", true), no);
  assert.deepEqual(
    coworkPromptActions(
      conversation([a, turn("b", { status: "inProgress" })]),
      turn("b", { status: "inProgress" }),
      "cowork",
      false,
    ),
    no,
  );
  // A failed or stopped turn is still the last prompt: it can be edited.
  for (const status of ["failed", "interrupted"] as const) {
    const ended = turn("b", { status });
    assert.deepEqual(
      coworkPromptActions(conversation([a, ended]), ended, "cowork", false),
      yes,
    );
  }
  // Code (Rewind to here) and Chat (its own row) are not Cowork's.
  assert.deepEqual(coworkPromptActions(both, b, "code", false), no);
  assert.deepEqual(coworkPromptActions(both, b, "chat", false), no);
  // A turn that is not a message to send again.
  for (const patch of [
    { compaction: "manual" as const },
    { shell: true as const },
  ]) {
    const odd = turn("b", patch);
    assert.deepEqual(
      coworkPromptActions(conversation([a, odd]), odd, "cowork", false),
      no,
    );
  }
});

function environment() {
  const { window, document } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  // linkedom has no caret API; the editor puts the caret at the text's end.
  Object.getPrototypeOf(document.createElement("textarea")).setSelectionRange =
    () => {};
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    ResizeObserver: globalThis.ResizeObserver,
  };
  Object.assign(globalThis, {
    window,
    document,
    getComputedStyle: () => ({ getPropertyValue: () => "0" }),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (run: () => void) => setTimeout(run, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const click = async (selector: string) => {
    const control = document.querySelector(selector);
    assert.ok(control, selector);
    await act(async () => {
      control.dispatchEvent(
        new window.Event("click", { bubbles: true, cancelable: true }),
      );
    });
  };
  const type = async (selector: string, text: string) => {
    const field = document.querySelector(selector) as HTMLTextAreaElement;
    assert.ok(field, selector);
    await act(async () => {
      // React tracks the field's value; the prototype's setter goes round
      // that tracker so the input event reads as a change.
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(field),
        "value",
      )!.set!.call(field, text);
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  return {
    root,
    document,
    click,
    type,
    restore() {
      Object.assign(globalThis, previous);
    },
  };
}

const labels = (document: Document) =>
  [...document.querySelectorAll(".user-message-actions button")].map((b) =>
    b.getAttribute("aria-label"),
  );

test("the prompt row carries Restart and Edit only when they are offered", async () => {
  const env = environment();
  try {
    await act(async () =>
      env.root.render(createElement(CodeUserMessage, { turn: turn("b") })),
    );
    assert.ok(!labels(env.document).includes("Edit"));
    assert.ok(!labels(env.document).includes("Restart session from here"));
    await act(async () =>
      env.root.render(
        createElement(CodeUserMessage, {
          turn: turn("b"),
          onEdit: async () => true,
          onRestart() {},
        }),
      ),
    );
    const found = labels(env.document);
    // Restart, Edit, then Copy, as the original orders them.
    assert.ok(
      found.indexOf("Restart session from here") < found.indexOf("Edit"),
    );
  } finally {
    await act(async () => env.root.unmount());
    env.restore();
  }
});

test("Restart calls the retry callback; Edit opens the editor and Save sends the new text", async () => {
  const env = environment();
  const restarts: number[] = [];
  const edits: string[] = [];
  try {
    await act(async () =>
      env.root.render(
        createElement(CodeUserMessage, {
          turn: turn("b", { prompt: "first draft" }),
          onRestart: () => restarts.push(1),
          onEdit: async (text: string) => {
            edits.push(text);
            return true;
          },
        }),
      ),
    );
    await env.click('button[aria-label="Restart session from here"]');
    assert.deepEqual(restarts, [1]);
    await env.click('button[aria-label="Edit"]');
    assert.ok(env.document.querySelector(".user-message.is-editing"));
    const save = () =>
      env.document.querySelector(".save-message") as HTMLButtonElement;
    // Unchanged text cannot be saved.
    assert.equal(save().disabled, true);
    await env.type("textarea", "second draft");
    assert.equal(save().disabled, false);
    await env.click(".save-message");
    assert.deepEqual(edits, ["second draft"]);
    // Saved: the editor closes and the prompt row is back.
    assert.equal(env.document.querySelector(".user-message.is-editing"), null);
    assert.ok(labels(env.document).includes("Edit"));
  } finally {
    await act(async () => env.root.unmount());
    env.restore();
  }
});

test("a refused save keeps the editor open, and Cancel leaves the prompt as sent", async () => {
  const env = environment();
  let saves = 0;
  try {
    await act(async () =>
      env.root.render(
        createElement(CodeUserMessage, {
          turn: turn("b", { prompt: "as sent" }),
          onEdit: async () => {
            saves += 1;
            return false;
          },
        }),
      ),
    );
    await env.click('button[aria-label="Edit"]');
    await env.type("textarea", "changed");
    await env.click(".save-message");
    assert.equal(saves, 1);
    assert.ok(env.document.querySelector(".user-message.is-editing"));
    await env.click(".user-edit-actions button:not(.save-message)");
    assert.equal(env.document.querySelector(".user-message.is-editing"), null);
    assert.match(
      env.document.querySelector(".user-message")!.textContent!,
      /as sent/,
    );
    // Editing again starts from the sent text, not the abandoned draft.
    await env.click('button[aria-label="Edit"]');
    assert.equal(
      (env.document.querySelector("textarea") as HTMLTextAreaElement).value,
      "as sent",
    );
  } finally {
    await act(async () => env.root.unmount());
    env.restore();
  }
});

test("the editor closes when the prompt stops being editable", async () => {
  const env = environment();
  try {
    const props = { turn: turn("b"), onEdit: async () => true };
    await act(async () =>
      env.root.render(createElement(CodeUserMessage, props)),
    );
    await env.click('button[aria-label="Edit"]');
    assert.ok(env.document.querySelector("textarea"));
    await act(async () =>
      env.root.render(createElement(CodeUserMessage, { turn: turn("b") })),
    );
    assert.equal(env.document.querySelector("textarea"), null);
  } finally {
    await act(async () => env.root.unmount());
    env.restore();
  }
});

test("the Cowork transcript puts Edit and Restart on the last prompt and calls the engine's edit and retry", async () => {
  const { ConversationTranscript } =
    await import("../../src/transcript/ConversationTranscript");
  const env = environment();
  const retried: string[] = [];
  const edited: [string, string][] = [];
  const turns = [
    turn("first", { prompt: "one" }),
    turn("last", { prompt: "two" }),
  ];
  const render = (mode: "cowork" | "code", sending = false) =>
    act(async () =>
      env.root.render(
        createElement(ConversationTranscript, {
          conversation: {
            id: "w",
            title: "T",
            mode,
            providerId: "default",
            model: "m",
            pinned: false,
            archived: false,
            createdAt: 1,
            updatedAt: 1,
            turns,
          },
          mode,
          sending,
          running: false,
          approvals: [],
          replyFeedback: {},
          onReplyFeedback: async () => {},
          onArtifact() {},
          onOpenWorkflow() {},
          onEditPrompt: async (turnId: string, text: string) => {
            edited.push([turnId, text]);
            return true;
          },
          onRetryResponse: (turnId: string) => retried.push(turnId),
          onContinue() {},
          onSelectVersion() {},
          onError() {},
          scrollRef: { current: null },
          onScroll() {},
          onWheel() {},
          away: false,
          onJumpToLatest() {},
        }),
      ),
    );
  const edit = 'button[aria-label="Edit"]';
  const restart = 'button[aria-label="Restart session from here"]';
  try {
    await render("cowork");
    const rows = [...env.document.querySelectorAll(".turn")];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelector(edit), null);
    assert.equal(rows[0].querySelector(restart), null);
    await env.click(restart);
    assert.deepEqual(retried, ["last"]);
    await env.click(edit);
    await env.type("textarea", "two, reworded");
    await env.click(".save-message");
    assert.deepEqual(edited, [["last", "two, reworded"]]);
    // While Claude works on the reply neither is offered.
    await render("cowork", true);
    assert.equal(env.document.querySelector(edit), null);
    assert.equal(env.document.querySelector(restart), null);
    // Code has neither.
    await render("code");
    assert.equal(env.document.querySelector(edit), null);
    assert.equal(env.document.querySelector(restart), null);
  } finally {
    await act(async () => env.root.unmount());
    env.restore();
  }
});
