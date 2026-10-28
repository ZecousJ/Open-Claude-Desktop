import type { ComposerField } from "./composer-field";
import { useEffect, type RefObject } from "react";

/*
 * Type-to-focus. A character typed while nothing editable has the focus, and no
 * menu, list or dialog is open, goes into the composer at its caret and focuses
 * it; a paste in the same state pastes into the composer, files included. A
 * space on a button stays the button's, and whitespace alone never starts an
 * empty draft.
 */

/** Open layers that keep their own keys (menus, lists, dialogs). */
const layers =
  '[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"],dialog[open]';

const buttonRoles = new Set([
  "button",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
]);

/** A text field, an editor or a terminal: typing there is its own. */
export function isEditable(element: Element | null) {
  if (!element) return false;
  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA")
    return true;
  if ((element as HTMLElement).isContentEditable === true) return true;
  const editable = element.getAttribute("contenteditable");
  if (editable === "" || editable === "true") return true;
  return element.getAttribute("role") === "textbox";
}

/** Space on these presses them. */
function isButtonLike(element: Element | null) {
  if (!element) return false;
  const tag = element.tagName;
  if (tag === "BUTTON" || tag === "SUMMARY" || tag === "SELECT") return true;
  if (tag === "INPUT")
    return ["button", "submit", "reset", "checkbox", "radio"].includes(
      (element as HTMLInputElement).type,
    );
  return buttonRoles.has(element.getAttribute("role") ?? "");
}

/** A menu, list or dialog on screen (inert ones, under a dialog, do not count). */
export function openLayer(doc: Document) {
  for (const layer of doc.querySelectorAll(layers)) {
    if (layer.closest("[inert]")) continue;
    const element = layer as HTMLElement;
    if (
      typeof element.checkVisibility === "function" &&
      !element.checkVisibility()
    )
      continue;
    return true;
  }
  return false;
}

/** The parts of a key press type-to-focus reads. */
export interface TypedKey {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  isComposing?: boolean;
}

/** Whether a key press types into the composer instead of where it landed. */
export function typesIntoComposer(
  event: TypedKey,
  active: Element | null,
  layerOpen: boolean,
) {
  return (
    !event.defaultPrevented &&
    !event.isComposing &&
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !isEditable(active) &&
    !layerOpen &&
    !(event.key === " " && isButtonLike(active))
  );
}

/** The composer can take text: on screen, enabled and not under a dialog. */
function ready(field: ComposerField | null): field is ComposerField {
  if (!field || !field.isConnected || field.disabled || field.readOnly)
    return false;
  if (field.closest("[inert]")) return false;
  return typeof field.checkVisibility === "function"
    ? field.checkVisibility()
    : field.offsetParent !== null;
}

/** Inserts at the caret as typing would (undo and React's onChange follow). */
function insert(field: ComposerField, text: string) {
  field.focus({ preventScroll: true });
  if (field.insertText) {
    field.insertText(text);
    return;
  }
  let done = false;
  try {
    done = document.execCommand("insertText", false, text);
  } catch {
    done = false;
  }
  if (done) return;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(text, start, end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Sends typing and pasting that land nowhere editable to the composer while
 * `enabled`. Heard on the window, after the document's own key handlers
 * (the artifact panel's C, the approval card's digits) had their turn.
 */
export function useTypeToFocus(
  composer: RefObject<ComposerField | null>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const field = composer.current;
      if (
        !typesIntoComposer(
          event,
          document.activeElement,
          openLayer(document),
        ) ||
        !ready(field)
      )
        return;
      // Whitespace alone does not start an empty draft.
      if (!event.key.trim() && !field.value.trim()) return;
      event.preventDefault();
      insert(field, event.key);
    };
    const onPaste = (event: ClipboardEvent) => {
      const field = composer.current;
      if (
        event.defaultPrevented ||
        !event.clipboardData ||
        isEditable(document.activeElement) ||
        openLayer(document) ||
        !ready(field)
      )
        return;
      const data = event.clipboardData;
      const text = data.getData("text/plain");
      if (!data.files.length && !text.trim() && !field.value.trim()) return;
      event.preventDefault();
      field.focus({ preventScroll: true });
      // The composer's own paste handling decides (files, a pasted card).
      let handled = false;
      try {
        handled = !field.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          }),
        );
      } catch {
        handled = false;
      }
      if (!handled && text) insert(field, text);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  }, [composer, enabled]);
}
