import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import type { Routine } from "../../shared/routines";

for (const sample of [
  { language: "Chinese", accepted: "中文任务", cancelled: "取消的草稿" },
  {
    language: "Japanese",
    accepted: "日本語タスク",
    cancelled: "取消する下書き",
  },
]) {
  test(`scheduled rename keeps ${sample.language} IME keys inside composition and accepts normal edit keys afterwards`, async () => {
    const { window, document } = parseHTML(
      "<html><body><main></main></body></html>",
    );
    (document as unknown as { oninput: null }).oninput = null;
    window.desktop = {
      routineRuns: async () => [],
      onEvent: () => () => {},
    } as never;
    const frames: FrameRequestCallback[] = [];
    const globals = {
      window,
      document,
      IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    };
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
    const inputPrototype = window.HTMLInputElement.prototype;
    const select = Object.getOwnPropertyDescriptor(inputPrototype, "select");
    const inputType = Object.getOwnPropertyDescriptor(inputPrototype, "type");
    // Browsers reflect an omitted input type as "text"; linkedom does not.
    Object.defineProperty(inputPrototype, "type", {
      configurable: true,
      get(this: HTMLInputElement) {
        return this.getAttribute("type") || "text";
      },
      set(this: HTMLInputElement, value: string) {
        this.setAttribute("type", value);
      },
    });
    const focus = Object.getOwnPropertyDescriptor(
      window.HTMLElement.prototype,
      "focus",
    );
    let focused: HTMLElement | undefined;
    window.HTMLElement.prototype.focus = function () {
      focused = this;
    };
    inputPrototype.select = () => {};
    const { createRoot } = await import("react-dom/client");
    const { WebRoutineDetail } =
      await import("../../src/collections/routines/WebRoutineDetail");
    const root = createRoot(document.querySelector("main")!);
    let routine: Routine = {
      id: "synthetic-ime-schedule",
      name: "Original schedule",
      prompt: "Synthetic instructions",
      mode: "cowork",
      providerId: "p",
      model: "Opus",
      frequency: "daily",
      repeat: { kind: "daily", time: "09:00" },
      nextRunAt: 1,
      enabled: false,
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: string[] = [];
    const render = () =>
      root.render(
        createElement(WebRoutineDetail, {
          routine,
          onClose() {},
          onEdit() {},
          async onRename(name) {
            calls.push(name);
            routine = { ...routine, name };
            render();
          },
          onDelete() {},
          onRun() {},
          onEnabled() {},
          onRemoveApproval() {},
          onOpenConversation() {},
          running: false,
          disabled: false,
        }),
      );
    const nameButton = () =>
      document.querySelector<HTMLButtonElement>(".scheduled-detail-name")!;
    const input = () =>
      document.querySelector<HTMLInputElement>(
        ".scheduled-detail-name-field input",
      )!;
    const change = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(inputPrototype, "value")!.set!.call(
          input(),
          value,
        );
        input().dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    const composition = async (
      type: "compositionstart" | "compositionupdate" | "compositionend",
      data: string,
    ) =>
      act(async () => {
        const event = new window.Event(type, { bubbles: true });
        Object.assign(event, { data });
        input().dispatchEvent(event);
      });
    const key = async (
      value: "Enter" | "Escape",
      composing = false,
      keyCode = value === "Enter" ? 13 : 27,
    ) => {
      const event = new window.Event("keydown", {
        bubbles: true,
        cancelable: true,
      });
      Object.assign(event, {
        key: value,
        isComposing: composing,
        keyCode,
        repeat: false,
      });
      await act(async () => {
        input().dispatchEvent(event);
      });
      return event;
    };
    const flushFrames = async () =>
      act(async () => {
        for (const callback of frames.splice(0)) callback(0);
      });
    try {
      await act(async () => {
        render();
      });
      await act(async () => {
        nameButton().click();
      });
      await composition("compositionstart", sample.accepted);
      await change(sample.accepted);
      await composition("compositionupdate", sample.accepted);
      for (const value of ["Enter", "Escape"] as const) {
        assert.equal((await key(value, true)).defaultPrevented, false);
        assert.ok(input(), "the IME key cannot close the edit");
        assert.equal(input().value, sample.accepted);
        assert.deepEqual(calls, []);
        // Safari's candidate key can clear isComposing before keydown.
        assert.equal((await key(value, false, 229)).defaultPrevented, false);
        assert.ok(input());
        assert.deepEqual(calls, []);
      }
      await composition("compositionend", sample.accepted);
      assert.equal((await key("Enter")).defaultPrevented, true);
      await flushFrames();
      assert.deepEqual(calls, [sample.accepted]);
      assert.equal(
        document.querySelector(".scheduled-detail-name-field input"),
        null,
      );
      assert.equal(nameButton().textContent, sample.accepted);
      assert.equal(focused, nameButton());

      await act(async () => {
        nameButton().click();
      });
      await composition("compositionstart", sample.cancelled);
      await change(sample.cancelled);
      assert.equal((await key("Escape", true)).defaultPrevented, false);
      assert.ok(input());
      await composition("compositionend", sample.cancelled);
      assert.equal((await key("Escape")).defaultPrevented, true);
      await flushFrames();
      assert.deepEqual(
        calls,
        [sample.accepted],
        "normal Escape cancels without another save",
      );
      assert.equal(
        document.querySelector(".scheduled-detail-name-field input"),
        null,
      );
      assert.equal(nameButton().textContent, sample.accepted);
      assert.equal(focused, nameButton());
    } finally {
      await act(async () => {
        root.unmount();
      });
      if (select) Object.defineProperty(inputPrototype, "select", select);
      else Reflect.deleteProperty(inputPrototype, "select");
      if (inputType) Object.defineProperty(inputPrototype, "type", inputType);
      else Reflect.deleteProperty(inputPrototype, "type");
      if (focus)
        Object.defineProperty(window.HTMLElement.prototype, "focus", focus);
      else Reflect.deleteProperty(window.HTMLElement.prototype, "focus");
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
