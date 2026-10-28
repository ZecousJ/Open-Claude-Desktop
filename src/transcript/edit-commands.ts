import type { DesktopAPI } from "../../shared/types";

export function historyEditor(document: Document) {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement)
    active = active.shadowRoot.activeElement;
  return active?.matches(
    '.ProseMirror[contenteditable="true"], .cm-content[contenteditable="true"]',
  )
    ? active
    : null;
}

// Dispatch beforeinput so ProseMirror/CodeMirror can consume their own history
// .
export function installEditCommands(document: Document, api: DesktopAPI) {
  if (!api.claimEditCommands) return () => {};
  void api.claimEditCommands();
  const report = () =>
    void api.reportContextMenuEditor(historyEditor(document) !== null);
  document.addEventListener("contextmenu", report, true);
  const unsubscribe = api.onEvent((event) => {
    if (event.type !== "edit-command") return;
    const editor = historyEditor(document);
    const claimed =
      editor &&
      !editor.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: event.command === "undo" ? "historyUndo" : "historyRedo",
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    if (!claimed) void api.editCommandUnclaimed(event.command);
  });
  return () => {
    unsubscribe();
    document.removeEventListener("contextmenu", report, true);
    void api.releaseEditCommands();
  };
}
