import test from "node:test";
import assert from "node:assert/strict";
import {
  act,
  createElement as h,
  createRef,
  StrictMode,
  useState,
} from "react";
import { readFileSync } from "node:fs";
import type { ComposerField } from "../../src/composer/composer-field";
import { useSkillDraft } from "../../src/composer/useSkillDraft";
import { atomicChatDom } from "../support/atomic-chat-dom";
import type { SkillToken } from "../../src/composer/skill-tokens";

const token = (name: string, start = 0) => ({
  name,
  start,
  end: start + name.length + 1,
});
async function editorHarness(
  initial = { text: "$review tail", skillTokens: [token("review")] },
  bridge: Partial<Window["desktop"]> = {},
) {
  const env = await atomicChatDom(bridge);
  const { AtomicChatInput } =
    await import("../../src/composer/AtomicChatInput");
  const field = createRef<ComposerField>();
  const writes: { text: string; skillTokens: SkillToken[] }[] = [];
  let external!: (draft: typeof initial) => void;
  const presses: string[] = [];
  const scope = {};
  function Harness({
    identity,
    readOnly = false,
  }: {
    identity: string;
    readOnly?: boolean;
  }) {
    const [draft, setDraft] = useState(initial);
    external = setDraft;
    return h(AtomicChatInput, {
      identity,
      scope,
      field,
      text: draft.text,
      tokens: draft.skillTokens,
      nativeProps: {
        "aria-label": "Prompt",
        placeholder: "Write",
        readOnly,
        onKeyDown(event) {
          presses.push(event.key);
        },
      },
      onDraft(text, skillTokens) {
        writes.push({ text, skillTokens });
        setDraft({ text, skillTokens });
      },
      onSelection() {},
      onError(error) {
        throw error;
      },
    });
  }
  const draw = (identity = "draft-a", readOnly = false) =>
    env.render(h(Harness, { identity, readOnly }));
  await draw();
  await env.settle();
  return {
    ...env,
    field,
    writes,
    presses,
    draw,
    change: (draft: typeof initial) => act(async () => external(draft)),
    draft: () => ({
      text: field.current!.value,
      skillTokens: writes.at(-1)?.skillTokens ?? initial.skillTokens,
    }),
  };
}
async function clipboard(
  env: Awaited<ReturnType<typeof editorHarness>>,
  type: "copy" | "paste",
  initial: Record<string, string> = {},
) {
  const data = { ...initial };
  const event = new env.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      types: Object.keys(data),
      getData: (kind: string) => data[kind] ?? "",
      setData: (kind: string, value: string) => (data[kind] = value),
      clearData() {},
    },
  });
  await act(async () => {
    env.field.current!.dispatchEvent(event);
  });
  await env.settle();
  return data;
}

test("real ProseMirror focus remains the native DOM method through StrictMode and same-node scope rebuilding", async () => {
  const env = await atomicChatDom();
  const { AtomicChatInput } =
    await import("../../src/composer/AtomicChatInput");
  const field = createRef<ComposerField>();
  const scopes = [{}, {}];
  const initialBridge = env.window.desktop;
  const errors: unknown[] = [];
  function Probe({ scope }: { scope: object }) {
    const draft = useSkillDraft("Hello");
    return h(AtomicChatInput, {
      identity: "same-draft",
      scope,
      field,
      text: draft.text,
      tokens: draft.skillTokens,
      nativeProps: { "aria-label": "Prompt", placeholder: "Write" },
      onDraft(text, tokens) {
        draft.setText(text);
        draft.setSkillTokens(tokens);
      },
      onSelection() {},
      onError: (error) => errors.push(error),
    });
  }
  try {
    await env.render(h(StrictMode, null, h(Probe, { scope: scopes[0]! })));
    await env.settle();
    const dom = field.current!;
    assert.equal(Object.hasOwn(dom, "focus"), false);
    assert.equal(dom.focus, env.window.HTMLElement.prototype.focus);
    await act(async () => {
      dom.focus();
      dom.setSelectionRange(5, 5);
      dom.insertText!(" one");
    });
    assert.equal(dom.value, "Hello one");
    await env.render(h(StrictMode, null, h(Probe, { scope: scopes[1]! })));
    assert.equal(
      field.current,
      dom,
      "the same mounted field exercises the old focus recursion path",
    );
    await act(async () => {
      dom.focus();
      dom.setSelectionRange(dom.value.length, dom.value.length);
      dom.insertText!(" two");
    });
    await env.settle();
    assert.equal(dom.value, "Hello one two");
    assert.equal(env.document.activeElement, dom);
    assert.equal(Object.hasOwn(dom, "focus"), false);
    const retiredInsert = dom.insertText!;
    env.window.desktop = { ...initialBridge };
    await env.render(h(StrictMode, null, h(Probe, { scope: scopes[1]! })));
    assert.equal(field.current, dom);
    await act(async () => {
      retiredInsert(" obsolete");
      dom.focus();
      dom.setSelectionRange(dom.value.length, dom.value.length);
      dom.insertText!(" current");
    });
    assert.equal(dom.value, "Hello one two current");
    assert.equal(Object.hasOwn(dom, "focus"), false);
    assert.deepEqual(errors, []);
    await env.render(h("p", null, "closed"));
    assert.equal(
      Object.hasOwn(dom, "value"),
      false,
      "the explicit adapter properties are restored on unmount",
    );
  } finally {
    env.window.desktop = initialBridge;
    await env.clean();
  }
});

test("the real editor puts an indivisible skill node in normal text flow instead of a textarea mirror", async () => {
  const name = "skill-creator";
  const env = await editorHarness(
    {
      text: `WWWWWWWWWWWWWWWWWW $${name} tail`,
      skillTokens: [token(name, 19)],
    },
    {
      customizeSkills: async () => [
        {
          name,
          path: "/fixture/skill/SKILL.md",
          description: "Skill fixture",
          enabled: true,
          scope: "user",
          own: true,
        },
      ],
    },
  );
  try {
    const atom = env.document.querySelector<HTMLElement>(
      ".composer-atomic-skill",
    )!;
    assert.equal(
      env.document.querySelector("textarea, .composer-skill-mirror"),
      null,
    );
    assert.equal(atom.getAttribute("contenteditable"), "false");
    assert.equal(atom.textContent, "/skill-creator");
    assert.equal(atom.parentElement?.tagName, "P");
    assert.equal(atom.previousSibling?.textContent, "WWWWWWWWWWWWWWWWWW ");
    assert.equal(atom.nextSibling?.textContent, " tail");
    const css = readFileSync("src/composer/atomic-chat-input.css", "utf8");
    assert.match(
      css,
      /\.composer-atomic-skill\s*\{[^}]*display:\s*inline-flex/,
    );
    assert.match(css, /\.composer-atomic-skill\s*\{[^}]*white-space:\s*nowrap/);
    assert.doesNotMatch(
      css,
      /composer-atomic-skill\s*\{[^}]*position:\s*absolute/,
    );
    assert.equal(
      env.field.current!.value,
      "WWWWWWWWWWWWWWWWWW $skill-creator tail",
    );
  } finally {
    await env.clean();
  }
});

test("real native selection/copy/paste preserves the dollar protocol and rehydrates only current unambiguous enabled skills", async () => {
  const env = await editorHarness();
  try {
    await act(async () => {
      env.field.current!.focus();
      env.field.current!.setSelectionRange(0, 7);
    });
    const copied = await clipboard(env, "copy");
    assert.equal(copied["text/plain"], "$review");
    assert.match(copied["text/html"]!, /data-claudex-skill="review"/);
    assert.doesNotMatch(
      copied["text/html"]!,
      /SKILL\.md|fixture|Actual fixture/,
    );
    await act(async () => env.field.current!.setSelectionRange(12, 12));
    await clipboard(env, "paste", copied);
    assert.equal(
      env.document.querySelectorAll(
        '.composer-atomic-skill[data-callable="true"]',
      ).length,
      1,
    );
    assert.equal(env.field.current!.value, "$review tail$review");
    // No whitespace boundary means a copied atom cannot claim a different
    // runtime command. The normalizer converts that pasted adjacency to raw.
    assert.deepEqual(env.writes.at(-1)?.skillTokens, [token("review")]);
    await env.change({ text: "", skillTokens: [] });
    await act(async () => env.field.current!.setSelectionRange(0, 0));
    await clipboard(env, "paste", {
      "text/plain": "$unknown",
      "text/html": '<p><span data-claudex-skill="unknown">$unknown</span></p>',
    });
    assert.equal(env.field.current!.value, "$unknown");
    assert.equal(env.document.querySelector(".composer-atomic-skill"), null);
  } finally {
    await env.clean();
  }
});

test("a well-separated copied atom pastes with its identity, and native undo/redo restores whole nodes", async () => {
  const env = await editorHarness();
  try {
    await act(async () => env.field.current!.setSelectionRange(0, 7));
    const copied = await clipboard(env, "copy");
    await env.change({ text: "Next ", skillTokens: [] });
    await act(async () => {
      env.field.current!.focus();
      env.field.current!.setSelectionRange(5, 5);
    });
    await clipboard(env, "paste", copied);
    assert.equal(env.field.current!.value, "Next $review");
    assert.deepEqual(env.writes.at(-1)?.skillTokens, [token("review", 5)]);
    await env.key(env.field.current!, "z", { ctrlKey: true, keyCode: 90 });
    assert.equal(env.field.current!.value, "Next ");
    await env.key(env.field.current!, "z", {
      ctrlKey: true,
      shiftKey: true,
      keyCode: 90,
    });
    assert.equal(env.field.current!.value, "Next $review");
    assert.equal(
      env.document.querySelectorAll(".composer-atomic-skill").length,
      1,
    );
  } finally {
    await env.clean();
  }
});

test("ordinary rich HTML paste keeps the real plain clipboard's spaces and blank lines and cannot introduce a different skill command", async () => {
  const env = await editorHarness({ text: "Before ", skillTokens: [] });
  try {
    await act(async () => {
      env.field.current!.focus();
      env.field.current!.setSelectionRange(7, 7);
    });
    await clipboard(env, "paste", {
      "text/plain": "one  two\r\n\r\n  indented",
      "text/html": "<p><b>one two</b></p><p>indented</p>",
    });
    assert.equal(env.field.current!.value, "Before one  two\n\n  indented");
    assert.deepEqual(env.writes.at(-1)?.skillTokens, []);
    await env.change({ text: "", skillTokens: [] });
    await act(async () => env.field.current!.setSelectionRange(0, 0));
    await clipboard(env, "paste", {
      "text/plain": "Actual plain words",
      "text/html":
        '<p><span data-claudex-skill="review">$review</span> unexpected</p>',
    });
    assert.equal(env.field.current!.value, "Actual plain words");
    assert.equal(env.document.querySelector(".composer-atomic-skill"), null);
  } finally {
    await env.clean();
  }
});

test("programmatic restore and dictation use the same raw draft while dictation completes as one undoable change", async () => {
  const env = await editorHarness();
  try {
    await env.change({
      text: "$review restored draft",
      skillTokens: [token("review")],
    });
    assert.equal(env.field.current!.value, "$review restored draft");
    await env.draw("draft-a", true);
    await env.change({
      text: "$review restored draft partial",
      skillTokens: [token("review")],
    });
    await env.change({
      text: "$review restored draft partial spoken",
      skillTokens: [token("review")],
    });
    await env.draw("draft-a", false);
    await act(async () => env.field.current!.focus());
    await env.key(env.field.current!, "z", { ctrlKey: true, keyCode: 90 });
    assert.equal(env.field.current!.value, "$review restored draft");
    await env.key(env.field.current!, "z", {
      ctrlKey: true,
      shiftKey: true,
      keyCode: 90,
    });
    assert.equal(
      env.field.current!.value,
      "$review restored draft partial spoken",
    );
  } finally {
    await env.clean();
  }
});

test("synthetic DOM IME composition beside a real atom is left to ProseMirror and cannot submit its Enter", async () => {
  const env = await editorHarness({
    text: "$review ",
    skillTokens: [token("review")],
  });
  try {
    const field = env.field.current!;
    await act(async () => {
      field.focus();
      field.setSelectionRange(8, 8);
    });
    await act(async () =>
      field.dispatchEvent(
        new env.window.CompositionEvent("compositionstart", {
          bubbles: true,
          data: "",
        }),
      ),
    );
    const text = field.querySelector("p")!.lastChild!;
    assert.equal(text.nodeType, 3);
    await act(async () => {
      text.textContent = " 中文";
      env.window.getSelection()!.collapse(text, 3);
      field.dispatchEvent(
        new env.window.InputEvent("input", {
          bubbles: true,
          data: "中文",
          inputType: "insertCompositionText",
          isComposing: true,
        }),
      );
    });
    await env.key(field, "Enter", { keyCode: 229, isComposing: true });
    assert.deepEqual(env.presses, []);
    await act(async () =>
      field.dispatchEvent(
        new env.window.CompositionEvent("compositionend", {
          bubbles: true,
          data: "中文",
        }),
      ),
    );
    await env.settle();
    assert.equal(field.value, "$review 中文");
    assert.deepEqual(env.writes.at(-1)?.skillTokens, [token("review")]);
    assert.equal(field.querySelectorAll(".composer-atomic-skill").length, 1);
    assert.equal(field.querySelector("p")!.textContent, "/review 中文");
  } finally {
    await env.clean();
  }
});

test("new draft identity drops old history and retained old editor operations cannot write into it", async () => {
  const env = await editorHarness();
  try {
    const old = env.field.current!;
    const staleInsert = old.insertText!;
    await env.change({ text: "New owned draft", skillTokens: [] });
    await env.draw("draft-b");
    const count = env.writes.length;
    await act(async () => staleInsert(" late A"));
    assert.equal(env.writes.length, count);
    assert.equal(env.field.current!.value, "New owned draft");
    await env.key(env.field.current!, "z", { ctrlKey: true, keyCode: 90 });
    assert.equal(env.field.current!.value, "New owned draft");
  } finally {
    await env.clean();
  }
});

test("IME immediately adjoining an atom keeps the composing DOM alive, then normalizes its raw boundary in the same undo event", async () => {
  const env = await editorHarness({
    text: "$review",
    skillTokens: [token("review")],
  });
  try {
    const field = env.field.current!;
    await act(async () => {
      field.focus();
      field.setSelectionRange(7, 7);
    });
    await act(async () =>
      field.dispatchEvent(
        new env.window.CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
    const paragraph = field.querySelector("p")!,
      text = env.document.createTextNode("中文");
    await act(async () => {
      paragraph.append(text);
      env.window.getSelection()!.collapse(text, 2);
      field.dispatchEvent(
        new env.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          isComposing: true,
          data: "中文",
        }),
      );
    });
    await env.settle();
    assert.ok(
      field.querySelector(".composer-atomic-skill"),
      "do not replace the IME's adjacent atom while composition is active",
    );
    await act(async () =>
      field.dispatchEvent(
        new env.window.CompositionEvent("compositionend", {
          bubbles: true,
          data: "中文",
        }),
      ),
    );
    await env.settle();
    assert.equal(field.value, "$review中文");
    assert.equal(field.querySelector(".composer-atomic-skill"), null);
    assert.deepEqual(env.writes.at(-1)?.skillTokens, []);
    const undoPress = await env.key(field, "z", { ctrlKey: true, keyCode: 90 });
    assert.equal(
      undoPress.defaultPrevented,
      true,
      "the actual PM undo keymap must handle the action",
    );
    assert.equal(field.value, "$review");
    assert.equal(field.querySelectorAll(".composer-atomic-skill").length, 1);
    await env.key(field, "z", { ctrlKey: true, shiftKey: true, keyCode: 90 });
    assert.equal(field.value, "$review中文");
    assert.equal(field.querySelector(".composer-atomic-skill"), null);
  } finally {
    await env.clean();
  }
});

test("a 64-character live skill is still one uneditable inline node with a separate untouched suffix", async () => {
  const name = "a".repeat(64),
    raw = `$${name}`;
  const env = await editorHarness(
    { text: `${raw} tail`, skillTokens: [token(name)] },
    {
      customizeSkills: async () => [
        {
          name,
          path: "/fixture/long/SKILL.md",
          enabled: true,
          own: true,
          scope: "user",
          description: "Long skill",
        },
      ],
    },
  );
  try {
    const atom = env.document.querySelector(".composer-atomic-skill")!;
    assert.equal(atom.getAttribute("contenteditable"), "false");
    assert.equal(atom.textContent, `/${name}`);
    assert.equal(atom.nextSibling?.textContent, " tail");
    await act(async () => env.field.current!.setSelectionRange(0, 65));
    const data = await clipboard(env, "copy");
    assert.equal(data["text/plain"], raw);
    assert.equal(env.field.current!.value, `${raw} tail`);
  } finally {
    await env.clean();
  }
});

test("disabled or ambiguous runtime identities never expose an enabled skill face or card", async () => {
  for (const skills of [
    [{ name: "review", enabled: false, path: "/fixture/off/SKILL.md" }],
    [
      { name: "review", enabled: true, path: "/fixture/one/SKILL.md" },
      { name: "review", enabled: true, path: "/fixture/two/SKILL.md" },
    ],
  ]) {
    const env = await editorHarness(undefined, {
      customizeSkills: async () =>
        skills.map((skill) => ({
          ...skill,
          scope: "user",
          own: true,
          description: "Fixture metadata",
        })),
    });
    try {
      const atom = env.document.querySelector(".composer-atomic-skill")!;
      assert.equal(atom.getAttribute("data-callable"), "false");
      assert.equal(atom.getAttribute("role"), null);
      assert.equal(
        atom.querySelector(".composer-skill-name")?.textContent,
        "$review",
      );
      assert.equal(
        (atom.querySelector(".composer-skill-prefix") as HTMLElement).style
          .display,
        "none",
      );
      await act(async () =>
        atom.dispatchEvent(
          new env.window.MouseEvent("click", { bubbles: true }),
        ),
      );
      assert.equal(env.document.querySelector('[role="dialog"]'), null);
      assert.equal(env.field.current!.value, "$review tail");
    } finally {
      await env.clean();
    }
  }
});
