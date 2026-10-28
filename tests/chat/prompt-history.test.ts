import test from "node:test";
import assert from "node:assert/strict";
import {
  act,
  createElement,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { parseHTML } from "linkedom";
import {
  findMatch,
  isHistorySearchKey,
  searchOrder,
  usePromptHistory,
} from "../../src/composer/prompt-history";

test("history search goes newest first, each prompt once", () => {
  assert.deepEqual(searchOrder(["a", "b", "a", "c"]), ["c", "a", "b"]);
});

test("prompt recall, reverse search, draft restoration, IME and session reset follow the Code composer", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  let current!: ReturnType<typeof usePromptHistory>;
  const hint = () => current.hint;
  let draft = "";
  let setDraft!: (text: string) => void;
  const prompts = ["  fix lint\n", "write tests", "fix build"];
  function Harness({
    session,
    entries = prompts,
  }: {
    session: string;
    entries?: string[];
  }) {
    const [text, update] = useState("");
    const field = useRef({
      value: text,
      selectionStart: 0,
      selectionEnd: 0,
    } as HTMLTextAreaElement);
    draft = text;
    setDraft = (value) => {
      field.current.value = value;
      field.current.selectionStart = field.current.selectionEnd = value.length;
      update(value);
    };
    current = usePromptHistory({
      prompts: entries,
      text,
      field,
      enabled: true,
      resetKey: session,
      setText: (value, caret) => {
        field.current.value = value;
        field.current.selectionStart = field.current.selectionEnd =
          caret === "start" ? 0 : value.length;
        update(value);
      },
    });
    return null;
  }
  async function press(key: string, extra = {}) {
    let handled = false;
    let prevented = false;
    let stopped = false;
    await act(async () => {
      handled = current.onKeyDown({
        key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
        ...extra,
      } as unknown as ReactKeyboardEvent<HTMLTextAreaElement>);
    });
    return { handled, prevented, stopped };
  }
  try {
    await act(async () =>
      root.render(createElement(Harness, { session: "one" })),
    );
    await press("ArrowUp");
    assert.equal(draft, "fix build");
    assert.deepEqual(current.hint, {
      kind: "nav",
      index: 3,
      total: 3,
      hasDraft: false,
    });
    await press("ArrowUp");
    assert.equal(draft, "write tests");
    await press("ArrowUp");
    assert.equal(draft, "  fix lint\n");
    await act(async () => setDraft(draft));
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    assert.equal(draft, "");
    assert.equal(current.hint, null);
    await act(async () => setDraft("unfinished draft"));
    assert.deepEqual(await press("r", { ctrlKey: true }), {
      handled: true,
      prevented: true,
      stopped: true,
    });
    await press("f");
    assert.equal(draft, "fix build");
    await press("r", { ctrlKey: true });
    assert.equal(draft, "  fix lint\n");
    await press("ArrowDown");
    assert.equal(draft, "fix build");
    await press("z");
    assert.equal(
      hint()?.kind === "search" && (hint() as { failed: boolean }).failed,
      true,
    );
    await press("Escape");
    assert.equal(draft, "unfinished draft");
    assert.equal(current.hint, null);
    await press("r", { ctrlKey: true });
    await press("w");
    await press("Enter");
    assert.equal(draft, "write tests");
    assert.equal(current.hint, null);
    await press("r", { ctrlKey: true });
    assert.equal((await press("Process")).handled, false);
    assert.equal(current.hint, null);
    await press("r", { ctrlKey: true });
    await act(async () =>
      root.render(createElement(Harness, { session: "two" })),
    );
    assert.equal(current.hint, null);
    assert.equal((await press("Escape")).handled, false);
    await act(async () =>
      root.render(createElement(Harness, { session: "empty", entries: [] })),
    );
    assert.equal((await press("r", { ctrlKey: true })).prevented, true);
    assert.equal(hint()?.kind, "search");
    await press("x");
    assert.equal(
      hint()?.kind === "search" && (hint() as { failed: boolean }).failed,
      true,
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("a search finds older and newer matches from where it is", () => {
  const order = ["fix the build", "write tests", "fix lint"];
  assert.equal(findMatch(order, "FIX", 0, 1), 0);
  assert.equal(findMatch(order, "fix", 1, 1), 2);
  assert.equal(findMatch(order, "fix", 1, -1), 0);
  assert.equal(findMatch(order, "deploy", 0, 1), -1);
});

test("Ctrl+R alone starts a history search", () => {
  const press = {
    key: "r",
    code: "KeyR",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
  };
  assert.equal(isHistorySearchKey(press), true);
  assert.equal(isHistorySearchKey({ ...press, shiftKey: true }), false);
  assert.equal(
    isHistorySearchKey({ ...press, ctrlKey: false, metaKey: true }),
    false,
  );
  assert.equal(isHistorySearchKey({ ...press, key: "к" }), true);
  assert.equal(isHistorySearchKey({ ...press, key: "Dead" }), true);
  assert.equal(isHistorySearchKey({ ...press, key: "Unidentified" }), true);
  assert.equal(isHistorySearchKey({ ...press, key: "p" }), false);
  assert.equal(isHistorySearchKey({ ...press, isComposing: true }), false);
});
