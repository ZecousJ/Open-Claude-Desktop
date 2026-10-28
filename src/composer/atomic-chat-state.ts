import {
  Plugin,
  EditorState,
  NodeSelection,
  type Command,
  type Transaction,
} from "prosemirror-state";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo, closeHistory } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import type { Node as ProseNode } from "prosemirror-model";
import {
  chatDoc,
  chatDraft,
  chatSchema,
  positionToRaw,
  rawSelection,
} from "./atomic-chat-model";
import type { SkillToken } from "./skill-tokens";

const selectAdjacent =
  (backward: boolean): Command =>
  (state, dispatch) => {
    if (!state.selection.empty) return false;
    const { $from } = state.selection;
    const node = backward ? $from.nodeBefore : $from.nodeAfter;
    if (node?.type.name !== "skill") return false;
    dispatch?.(
      state.tr.setSelection(
        NodeSelection.create(
          state.doc,
          backward ? $from.pos - node.nodeSize : $from.pos,
        ),
      ),
    );
    return true;
  };

/** A raw identifier must never remain visually marked as a shorter skill.
 * The appended transaction is part of the native edit's undo event. */
export function skillBoundaries() {
  let deferred = false,
    composition: unknown;
  const normalize = (state: EditorState) => {
    const valid = new Set(
      chatDraft(state.doc).skillTokens.map((token) => token.start),
    );
    const replace: { from: number; to: number; text: string }[] = [];
    state.doc.descendants((node, position) => {
      if (
        node.type.name === "skill" &&
        !valid.has(positionToRaw(state.doc, position, -1))
      )
        replace.push({
          from: position,
          to: position + node.nodeSize,
          text: `$${node.attrs.name}`,
        });
    });
    if (!replace.length) return;
    const transaction = state.tr;
    for (const entry of replace.reverse())
      transaction.insertText(entry.text, entry.from, entry.to);
    return transaction;
  };
  return new Plugin({
    appendTransaction(transactions, _old, state) {
      if (
        !transactions.some((transaction) => transaction.docChanged) ||
        transactions.some((transaction) =>
          transaction.getMeta("skill-normalize"),
        )
      )
        return;
      const composing = transactions.find(
        (transaction) => transaction.getMeta("composition") !== undefined,
      );
      if (composing) {
        deferred = true;
        composition = composing.getMeta("composition");
        return;
      }
      return normalize(state);
    },
    view(view) {
      let alive = true;
      const settle = () =>
        queueMicrotask(() => {
          if (!alive || view.composing || !deferred) return;
          deferred = false;
          const transaction = normalize(view.state);
          if (transaction)
            view.dispatch(
              transaction
                .setMeta("skill-normalize", true)
                .setMeta("composition", composition),
            );
        });
      // EditorView installs its native IME listeners before plugin views.
      // Its final DOM observer flush is therefore queued before this check.
      view.dom.addEventListener("compositionend", settle);
      return {
        update() {
          if (deferred && !view.composing) settle();
        },
        destroy() {
          alive = false;
          view.dom.removeEventListener("compositionend", settle);
        },
      };
    },
  });
}
export function createChatState(
  text: string,
  tokens: readonly SkillToken[],
  callable: () => ReadonlySet<string>,
) {
  const schema = chatSchema(callable);
  return EditorState.create({
    schema,
    doc: chatDoc(schema, text, tokens),
    plugins: [
      skillBoundaries(),
      history(),
      keymap({
        "Mod-z": undo,
        "Shift-Mod-z": redo,
        "Mod-y": redo,
        Backspace: selectAdjacent(true),
        Delete: selectAdjacent(false),
      }),
      keymap(baseKeymap),
    ],
  });
}
/** External draft changes are actual undoable editor transactions. A new
 * draft identity creates another EditorState instead of importing history. */
export function replaceChatDoc(
  state: EditorState,
  doc: ProseNode,
  record = true,
) {
  const start = positionToRaw(state.doc, state.selection.from, -1);
  const end = positionToRaw(state.doc, state.selection.to, 1);
  const transaction = closeHistory(state.tr)
    .replaceWith(0, state.doc.content.size, doc.content)
    .setMeta("chat-programmatic", true);
  transaction.setSelection(
    rawSelection(
      transaction.doc,
      start,
      end,
      state.selection.anchor > state.selection.head ? "backward" : "none",
    ),
  );
  if (!record) transaction.setMeta("addToHistory", false);
  return transaction;
}
/** Programmatic actions form a complete undo event; subsequent native typing
 * or paste must not merge back through a restored/inserted draft. */
export function applyChatTransaction(
  state: EditorState,
  transaction: Transaction,
) {
  const result = state.applyTransaction(transaction);
  if (transaction.getMeta("chat-programmatic"))
    result.state = result.state.apply(
      closeHistory(result.state.tr).setMeta("addToHistory", false),
    );
  return result;
}
