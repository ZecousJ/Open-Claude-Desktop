import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, createRef, useState } from "react";
import { createChatInput } from "../../src/composer/ChatInput";
import { useSkillDraft } from "../../src/composer/useSkillDraft";
import type { ComposerField } from "../../src/composer/composer-field";
import { handoffDraft } from "../../src/composer/chat-input-handoff";
import { atomicChatDom } from "../support/atomic-chat-dom";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test("the loading handoff tracks actual native undo/redo snapshots without editing DOM or dropping token metadata", () => {
  const handoff = handoffDraft({
    text: "$review ",
    skillTokens: [{ name: "review", start: 0, end: 7 }],
  });
  handoff.typed("$review one", "insertText");
  handoff.typed("$review one two", "insertText");
  handoff.typed("$review one", "historyUndo");
  assert.equal(handoff.state.index, 1);
  handoff.typed("$review one two", "historyRedo");
  assert.equal(handoff.state.index, 2);
  assert.deepEqual(handoff.state.entries[2]?.skillTokens, [
    { name: "review", start: 0, end: 7 },
  ]);
  handoff.typed("$review other", "insertText");
  assert.equal(handoff.state.entries.length, 4);
});

test("a blocked editor chunk accepts native typing, preserves selection/focus and transfers accepted draft history", async () => {
  const env = await atomicChatDom();
  const module =
    deferred<typeof import("../../src/composer/AtomicChatInput")>();
  const Input = createChatInput(() => module.promise),
    field = createRef<ComposerField>();
  const scope = {};
  function Harness() {
    const draft = useSkillDraft("Before");
    return h(Input, {
      identity: "cold",
      scope,
      field,
      text: draft.text,
      tokens: draft.skillTokens,
      nativeProps: { "aria-label": "Prompt" },
      onDraft(text, tokens) {
        draft.setText(text);
        draft.setSkillTokens(tokens);
      },
      onSelection() {},
      onError(error) {
        throw error;
      },
      fallback: h("textarea", {
        "aria-label": "Prompt",
        value: draft.text,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
          draft.setText(event.currentTarget.value),
      }),
    });
  }
  try {
    await env.render(h(Harness));
    const native = env.document.querySelector("textarea")!;
    assert.equal(native.readOnly, false);
    await act(async () => {
      native.focus();
      Object.getOwnPropertyDescriptor(
        env.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(native, "Before accepted");
      native.dispatchEvent(
        new env.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: " accepted",
        }),
      );
      native.setSelectionRange(7, 10, "backward");
    });
    assert.equal(native.value, "Before accepted");
    await act(async () =>
      module.resolve(await import("../../src/composer/AtomicChatInput")),
    );
    await env.settle();
    assert.equal(env.document.querySelector("textarea"), null);
    assert.equal(field.current!.value, "Before accepted");
    assert.equal(field.current!.selectionStart, 7);
    assert.equal(field.current!.selectionEnd, 10);
    assert.equal(env.document.activeElement, field.current);
    await env.key(field.current!, "z", { ctrlKey: true, keyCode: 90 });
    assert.equal(field.current!.value, "Before");
    await env.key(field.current!, "z", {
      ctrlKey: true,
      shiftKey: true,
      keyCode: 90,
    });
    assert.equal(field.current!.value, "Before accepted");
  } finally {
    await env.clean();
  }
});

test("a resolved chunk never replaces the native field during IME composition and hands over the final accepted string once", async () => {
  const env = await atomicChatDom();
  const module =
    deferred<typeof import("../../src/composer/AtomicChatInput")>();
  const Input = createChatInput(() => module.promise),
    field = createRef<ComposerField>();
  function Harness() {
    const draft = useSkillDraft("Before ");
    return h(Input, {
      identity: "cold-ime",
      field,
      text: draft.text,
      tokens: draft.skillTokens,
      nativeProps: { "aria-label": "Prompt" },
      onDraft(text, tokens) {
        draft.setText(text);
        draft.setSkillTokens(tokens);
      },
      onSelection() {},
      onError(error) {
        throw error;
      },
      fallback: h("textarea", {
        value: draft.text,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
          draft.setText(event.currentTarget.value),
      }),
    });
  }
  try {
    await env.render(h(Harness));
    const native = env.document.querySelector("textarea")!;
    await act(async () => {
      native.focus();
      native.dispatchEvent(
        new env.window.CompositionEvent("compositionstart", { bubbles: true }),
      );
      Object.getOwnPropertyDescriptor(
        env.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(native, "Before 中");
      native.dispatchEvent(
        new env.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          isComposing: true,
          data: "中",
        }),
      );
    });
    await act(async () =>
      module.resolve(await import("../../src/composer/AtomicChatInput")),
    );
    assert.equal(env.document.querySelector("textarea"), native);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        env.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(native, "Before 中文");
      native.dispatchEvent(
        new env.window.CompositionEvent("compositionend", {
          bubbles: true,
          data: "中文",
        }),
      );
      native.dispatchEvent(
        new env.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: "中文",
        }),
      );
      native.setSelectionRange(9, 9);
    });
    await env.settle();
    assert.equal(env.document.querySelector("textarea"), null);
    assert.equal(field.current!.value, "Before 中文");
    assert.equal(field.current!.selectionStart, 9);
    assert.equal(field.current!.textContent, "Before 中文");
    await env.key(field.current!, "z", { ctrlKey: true, keyCode: 90 });
    assert.equal(
      field.current!.value,
      "Before ",
      "the loading IME session transfers as one complete undo event",
    );
    await env.key(field.current!, "z", {
      ctrlKey: true,
      shiftKey: true,
      keyCode: 90,
    });
    assert.equal(field.current!.value, "Before 中文");
  } finally {
    await env.clean();
  }
});

test("a cold chunk waits for live dictation and transfers the completed transcript as one undo event", async () => {
  const env = await atomicChatDom();
  const module =
    deferred<typeof import("../../src/composer/AtomicChatInput")>();
  const Input = createChatInput(() => module.promise),
    field = createRef<ComposerField>();
  let spoken!: (text: string, live: boolean) => void;
  function Harness() {
    const draft = useSkillDraft("Before");
    const [readOnly, setReadOnly] = useState(false);
    spoken = (text, live) => {
      draft.setText(text);
      setReadOnly(live);
    };
    return h(Input, {
      identity: "cold-dictation",
      field,
      text: draft.text,
      tokens: draft.skillTokens,
      nativeProps: { "aria-label": "Prompt", readOnly },
      onDraft(text, tokens) {
        draft.setText(text);
        draft.setSkillTokens(tokens);
      },
      onSelection() {},
      onError(error) {
        throw error;
      },
      fallback: h("textarea", {
        value: draft.text,
        readOnly,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
          draft.setText(event.currentTarget.value),
      }),
    });
  }
  try {
    await env.render(h(Harness));
    const native = env.document.querySelector("textarea")!;
    await act(async () => spoken("Before partial", true));
    await act(async () =>
      module.resolve(await import("../../src/composer/AtomicChatInput")),
    );
    assert.equal(env.document.querySelector("textarea"), native);
    assert.equal(native.readOnly, true);
    await act(async () => spoken("Before final transcript", false));
    await env.settle();
    assert.equal(env.document.querySelector("textarea"), null);
    assert.equal(field.current!.value, "Before final transcript");
    await act(async () => field.current!.focus());
    await env.key(field.current!, "z", { ctrlKey: true, keyCode: 90 });
    assert.equal(field.current!.value, "Before");
    await env.key(field.current!, "z", {
      ctrlKey: true,
      shiftKey: true,
      keyCode: 90,
    });
    assert.equal(field.current!.value, "Before final transcript");
  } finally {
    await env.clean();
  }
});
