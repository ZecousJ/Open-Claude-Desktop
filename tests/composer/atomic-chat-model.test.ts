import test from "node:test";
import assert from "node:assert/strict";
import { NodeSelection } from "prosemirror-state";
import { undo, redo } from "prosemirror-history";
import {
  chatDoc,
  chatDraft,
  chatSchema,
  positionToRaw,
  rawSelection,
  rawToPosition,
} from "../../src/composer/atomic-chat-model";
import {
  createChatState,
  replaceChatDoc,
} from "../../src/composer/atomic-chat-state";

const callable = () => new Set(["review", "skill-creator", "a".repeat(64)]);
const token = (name: string, start = 0) => ({
  name,
  start,
  end: start + name.length + 1,
});
test("the source-backed skill schema is a selectable inline atom and serializes the actual dollar protocol", () => {
  const schema = chatSchema(callable),
    reference = schema.nodes.skill;
  assert.equal(reference.spec.atom, true);
  assert.equal(reference.spec.inline, true);
  assert.equal(reference.spec.selectable, true);
  const doc = chatDoc(schema, "before $review after\nnext", [
    token("review", 7),
  ]);
  assert.deepEqual(chatDraft(doc), {
    text: "before $review after\nnext",
    skillTokens: [token("review", 7)],
  });
  const node = doc.firstChild!.child(1);
  assert.equal(node.nodeSize, 1);
  assert.equal(node.childCount, 0);
  assert.deepEqual(reference.spec.toDOM?.(node), [
    "span",
    { "data-claudex-skill": "review" },
    "$review",
  ]);
});
test("raw byte offsets round trip through paragraphs and atoms without allowing a caret inside the command", () => {
  const text = "a\n$review\n\nb $skill-creator tail";
  const entries = [token("review", 2), token("skill-creator", 13)];
  const doc = chatDoc(chatSchema(callable), text, entries);
  const draft = chatDraft(doc);
  assert.deepEqual(draft, { text, skillTokens: entries });
  for (let offset = 0; offset <= text.length; offset++) {
    const inside = entries.find(
      (entry) => offset > entry.start && offset < entry.end,
    );
    for (const bias of [-1, 1] as const)
      assert.equal(
        positionToRaw(doc, rawToPosition(doc, offset, bias), bias),
        inside ? (bias < 0 ? inside.start : inside.end) : offset,
        `${offset}:${bias}`,
      );
  }
  const selected = rawSelection(doc, 2, 9);
  assert.ok(selected instanceof NodeSelection);
  assert.equal(selected.node.attrs.name, "review");
});
test("64-character references remain one document node and do not consume or rewrite following text", () => {
  const name = "a".repeat(64),
    text = `WWWWWWWWWWWWWWWWWW $${name} tail`;
  const doc = chatDoc(chatSchema(callable), text, [token(name, 19)]);
  assert.equal(doc.firstChild!.childCount, 3);
  assert.equal(doc.firstChild!.child(1).nodeSize, 1);
  assert.deepEqual(chatDraft(doc), { text, skillTokens: [token(name, 19)] });
});
test("two Backspaces select then delete the atom using the actual ProseMirror keymaps and undo restores it", () => {
  let state = createChatState("$review", [token("review")], callable);
  state = state.apply(state.tr.setSelection(rawSelection(state.doc, 7)));
  const press = () => {
    for (const plugin of state.plugins) {
      const handler = plugin.props.handleKeyDown;
      if (
        handler?.call(
          plugin,
          {
            get state() {
              return state;
            },
            dispatch(transaction: typeof state.tr) {
              state = state.applyTransaction(transaction).state;
            },
          } as never,
          {
            key: "Backspace",
            keyCode: 8,
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            shiftKey: false,
          } as KeyboardEvent,
        )
      )
        return;
    }
    assert.fail("the production keymap did not handle Backspace");
  };
  press();
  assert.ok(state.selection instanceof NodeSelection);
  assert.equal(chatDraft(state.doc).text, "$review");
  press();
  assert.equal(chatDraft(state.doc).text, "");
  assert.equal(
    undo(state, (transaction) => {
      state = state.applyTransaction(transaction).state;
    }),
    true,
  );
  assert.deepEqual(chatDraft(state.doc).skillTokens, [token("review")]);
});
test("editing immediately beside an atom cannot falsely keep a shorter dollar identifier, and native undo restores its identity", () => {
  let state = createChatState("$review ", [token("review")], callable);
  const at = rawToPosition(state.doc, 7);
  state = state.applyTransaction(state.tr.insertText("er", at)).state;
  assert.deepEqual(chatDraft(state.doc), {
    text: "$reviewer ",
    skillTokens: [],
  });
  assert.equal(state.doc.firstChild!.firstChild!.isText, true);
  undo(state, (transaction) => {
    state = state.applyTransaction(transaction).state;
  });
  assert.deepEqual(chatDraft(state.doc), {
    text: "$review ",
    skillTokens: [token("review")],
  });
  redo(state, (transaction) => {
    state = state.applyTransaction(transaction).state;
  });
  assert.deepEqual(chatDraft(state.doc), {
    text: "$reviewer ",
    skillTokens: [],
  });
});
test("programmatic draft replacement is undoable while a new identity starts with isolated history", () => {
  let state = createChatState("Before", [], callable);
  state = state.apply(
    replaceChatDoc(
      state,
      chatDoc(state.schema, "$review Before", [token("review")]),
    ),
  );
  undo(state, (transaction) => {
    state = state.applyTransaction(transaction).state;
  });
  assert.equal(chatDraft(state.doc).text, "Before");
  redo(state, (transaction) => {
    state = state.applyTransaction(transaction).state;
  });
  assert.equal(chatDraft(state.doc).skillTokens.length, 1);
  const other = createChatState("Other draft", [], callable);
  assert.equal(undo(other), false);
});
