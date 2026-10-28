import {
  editSkillTokens,
  validSkillTokens,
  type SkillToken,
} from "./skill-tokens";

export interface ChatInputSnapshot {
  text: string;
  skillTokens: SkillToken[];
}
export interface ChatInputHandoff {
  entries: ChatInputSnapshot[];
  index: number;
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
  focused: boolean;
}
const same = (a: ChatInputSnapshot, b: ChatInputSnapshot) =>
  a.text === b.text &&
  JSON.stringify(a.skillTokens) === JSON.stringify(b.skillTokens);
/** The browser owns the loading textarea. This records only accepted draft
 * snapshots for the one-time transfer, never edits composition DOM itself. */
export function handoffDraft(initial: ChatInputSnapshot) {
  const state: ChatInputHandoff = {
    entries: [initial],
    index: 0,
    start: 0,
    end: 0,
    direction: "none",
    focused: false,
  };
  let group: number | undefined,
    depth = 0;
  return {
    state,
    beginGroup() {
      if (depth++ === 0) group = state.index;
    },
    endGroup() {
      if (depth && --depth === 0) group = undefined;
    },
    accept(next: ChatInputSnapshot, inputType = "") {
      const current = state.entries[state.index]!;
      next = {
        text: next.text,
        skillTokens: validSkillTokens(next.text, next.skillTokens),
      };
      if (same(current, next)) return;
      if (group !== undefined) {
        state.entries.splice(group + 1);
        state.index = group;
        if (!same(state.entries[group]!, next)) {
          state.entries.push(next);
          state.index++;
        }
        return;
      }
      if (inputType === "historyUndo" || inputType === "historyRedo") {
        const step = inputType === "historyUndo" ? -1 : 1;
        for (
          let index = state.index + step;
          index >= 0 && index < state.entries.length;
          index += step
        )
          if (state.entries[index]!.text === next.text) {
            state.index = index;
            return;
          }
      }
      state.entries.splice(state.index + 1);
      state.entries.push(next);
      state.index++;
      // Match ProseMirror history's default 100 undo events, rather than
      // keeping unbounded full-string snapshots during an offline load.
      if (state.entries.length > 101) {
        const removed = state.entries.length - 101;
        state.entries.splice(0, removed);
        state.index -= removed;
        if (group !== undefined) group = Math.max(0, group - removed);
      }
    },
    typed(text: string, inputType: string) {
      const before = state.entries[state.index]!;
      this.accept(
        {
          text,
          skillTokens: editSkillTokens(before.text, text, before.skillTokens),
        },
        inputType,
      );
    },
  };
}
