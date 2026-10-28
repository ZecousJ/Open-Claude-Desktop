import { useEffect, useRef, useState, type RefObject } from "react";
import { dragHasFiles } from "./attachment-input";
import { dropZoneAt } from "./drop-zones";

/**
 * Where a file drag is, as the composer's drop overlay shows it: nowhere, over
 * the window, or over the composer itself.
 */
export type FileDropState = "idle" | "off-target" | "on-target";

/**
 * "page": a drop anywhere in the window attaches (the composer that owns the
 * page); "card": only a drop on the composer does, and the rest of the
 * window refuses it (a composer sharing the window with a side panel).
 */
export type FileDropScope = "page" | "card";

/** A drag over an open dialog belongs to it, not to the composer. */
function overDialog(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest('[role="dialog"], [role="alertdialog"], [aria-modal]')
  );
}

/**
 * The state of a file drag for the element `target` points at. The window's
 * body listens, so the state also knows a drag that is over the window but
 * not over the composer. `onDrop` gets the drop when the scope accepts it.
 */
export function useFileDrop(
  target: RefObject<HTMLElement | null>,
  {
    scope,
    enabled,
    onDrop,
  }: {
    scope: FileDropScope;
    enabled: boolean;
    onDrop: (files: DataTransfer) => void;
  },
): FileDropState {
  const [state, setState] = useState<FileDropState>("idle");
  const latest = useRef(onDrop);
  latest.current = onDrop;
  if (!enabled && state !== "idle") setState("idle");
  useEffect(() => {
    const body = target.current?.ownerDocument.body;
    if (!enabled || !body) return;
    const inside = (node: EventTarget | null) =>
      node instanceof Node && !!target.current?.contains(node);
    const files = (event: DragEvent) =>
      !!event.dataTransfer && dragHasFiles(event.dataTransfer.types);
    // Another drop zone under the pointer (a project's knowledge) takes the
    // drag; the composer stands aside.
    const elsewhere = (node: EventTarget | null) => {
      const zone = dropZoneAt(node);
      return !!zone && !zone.contains(target.current);
    };
    const over = (event: DragEvent) => {
      if (!files(event)) return;
      if (overDialog(event.target)) {
        setState("idle");
        return;
      }
      // A card stays off-target (the drag is still in the window); the
      // page-wide overlay steps back so the other zone shows.
      if (elsewhere(event.target)) {
        setState(scope === "card" ? "off-target" : "idle");
        return;
      }
      event.preventDefault();
      const on = inside(event.target);
      if (event.dataTransfer)
        event.dataTransfer.dropEffect =
          on || scope === "page" ? "copy" : "none";
      setState(on ? "on-target" : "off-target");
    };
    // Leaving the window: a move inside the window enters the next element
    // before it leaves the last one, so a leave from the element entered last
    // means the drag left the window.
    let entered: EventTarget | null = null;
    const enter = (event: DragEvent) => {
      if (files(event)) entered = event.target;
    };
    const leave = (event: DragEvent) => {
      if (!files(event)) return;
      if (event.target === entered || event.target === body) setState("idle");
    };
    const reset = () => setState("idle");
    // A card refuses a drop beside it, so the window does not open the file.
    const dropCapture = (event: DragEvent) => {
      if (!files(event)) return;
      if (overDialog(event.target) || elsewhere(event.target))
        return setState("idle");
      if (scope === "card" && !inside(event.target)) {
        event.preventDefault();
        setState("idle");
      }
    };
    // Bubbling, after any nearer handler: one that took the drop wins.
    const drop = (event: DragEvent) => {
      if (!files(event) || !event.dataTransfer) return;
      setState("idle");
      if (event.defaultPrevented && !inside(event.target)) return;
      if (overDialog(event.target) || elsewhere(event.target)) return;
      if (scope === "card" && !inside(event.target)) return;
      event.preventDefault();
      latest.current(event.dataTransfer);
    };
    body.addEventListener("dragenter", enter, true);
    body.addEventListener("dragenter", over, true);
    body.addEventListener("dragover", enter, true);
    body.addEventListener("dragover", over, true);
    body.addEventListener("dragleave", leave, true);
    body.addEventListener("dragend", reset, true);
    body.addEventListener("drop", dropCapture, true);
    body.addEventListener("drop", drop);
    // A page-wide overlay never outlives a click or a pointer move (a drag
    // the system lost; live hides it until the next drag enters).
    if (scope === "page") {
      body.addEventListener("pointerdown", reset, true);
      body.addEventListener("pointermove", reset, true);
    }
    return () => {
      body.removeEventListener("dragenter", enter, true);
      body.removeEventListener("dragenter", over, true);
      body.removeEventListener("dragover", enter, true);
      body.removeEventListener("dragover", over, true);
      body.removeEventListener("dragleave", leave, true);
      body.removeEventListener("dragend", reset, true);
      body.removeEventListener("drop", dropCapture, true);
      body.removeEventListener("drop", drop);
      body.removeEventListener("pointerdown", reset, true);
      body.removeEventListener("pointermove", reset, true);
    };
  }, [enabled, scope, target]);
  return enabled ? state : "idle";
}
