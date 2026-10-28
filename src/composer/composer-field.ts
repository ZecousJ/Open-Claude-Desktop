/** Common DOM contract used by the native textarea and the ProseMirror Chat
 * field. Rich-field writes are editor transactions; no hidden textarea owns
 * the draft, selection or undo history. */
export interface ComposerField extends HTMLElement {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: "forward" | "backward" | "none";
  disabled: boolean;
  readOnly: boolean;
  setSelectionRange(
    start: number,
    end: number,
    direction?: "forward" | "backward" | "none",
  ): void;
  setRangeText(
    replacement: string,
    start?: number,
    end?: number,
    selectionMode?: "select" | "start" | "end" | "preserve",
  ): void;
  /** Available only on the rich field; global type-to-focus uses its real
   * transaction rather than execCommand followed by a synthetic input. */
  insertText?: (text: string) => void;
  /** Contenteditable has intrinsic line layout; keep the home anchor in sync
   * without pinning it to the loading textarea's measured height. */
  resizeToContent?: () => void;
}
