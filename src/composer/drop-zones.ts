import { useEffect, useRef, useState, type RefObject } from "react";
import { dragHasFiles } from "./attachment-input";

/**
 * File drop zones besides the composer's. A zone here is an element, such as a
 * project's knowledge rail; the composer's `useFileDrop` leaves drags and drops
 * over one alone.
 */
const zones = new Set<() => HTMLElement | null>();

/** The innermost registered zone containing `target`, if any. */
export function dropZoneAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Node)) return null;
  let found: HTMLElement | null = null;
  for (const zone of zones) {
    const element = zone();
    if (!element?.contains(target)) continue;
    if (!found || found.contains(element)) found = element;
  }
  return found;
}

/** Adds a zone; the returned function removes it. */
export function registerDropZone(zone: () => HTMLElement | null) {
  zones.add(zone);
  return () => {
    zones.delete(zone);
  };
}

/**
 * Where a file drag is for a zone (the live drop zone's states): nowhere,
 * elsewhere in the window, over the zone, or over it with files it won't
 * take.
 */
export type ZoneDropState = "idle" | "off-target" | "on-target" | "rejected";

/**
 * A file drop zone on `target`. While files are dragged anywhere in the
 * window it is "off-target"; over it, "on-target", or "rejected" when
 * `refuses` says the dragged items can't be dropped (their MIME types are
 * known during the drag, their names only on drop). A drop on it goes to
 * `onDrop` and never reaches the composer. The state goes back to idle
 * when the drag leaves the window, ends, or is dropped.
 */
export function useZoneDrop(
  target: RefObject<HTMLElement | null>,
  {
    enabled,
    refuses,
    onDrop,
  }: {
    enabled: boolean;
    refuses?: (items: DataTransferItemList | undefined) => boolean;
    onDrop: (data: DataTransfer) => void;
  },
): ZoneDropState {
  const [state, setState] = useState<ZoneDropState>("idle");
  const latest = useRef({ refuses, onDrop });
  latest.current = { refuses, onDrop };
  if (!enabled && state !== "idle") setState("idle");
  useEffect(() => {
    const element = target.current;
    const body = element?.ownerDocument.body;
    if (!enabled || !element || !body) return;
    const unregister = registerDropZone(() => target.current);
    const files = (event: DragEvent) =>
      !!event.dataTransfer && dragHasFiles(event.dataTransfer.types);
    // The window's capture phase sees every drag before the page does.
    let entered: EventTarget | null = null;
    const over = (event: DragEvent) => {
      if (!files(event)) return;
      entered = event.target;
      if (dropZoneAt(event.target) !== target.current)
        return setState("off-target");
      event.preventDefault();
      const refused = Boolean(
        latest.current.refuses?.(event.dataTransfer?.items),
      );
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = refused ? "none" : "copy";
      setState(refused ? "rejected" : "on-target");
    };
    const leave = (event: DragEvent) => {
      if (!files(event)) return;
      // Leaving the window: the element left is still the last one entered
      // (a move inside the window enters the next element first).
      if (event.target === entered) setState("idle");
    };
    const reset = () => setState("idle");
    const drop = (event: DragEvent) => {
      if (!files(event) || !event.dataTransfer) return;
      // Whoever takes it, the drag is over (live: reset after the drop).
      setTimeout(reset);
      if (dropZoneAt(event.target) !== target.current) return;
      event.preventDefault();
      if (latest.current.refuses?.(event.dataTransfer.items)) return;
      latest.current.onDrop(event.dataTransfer);
    };
    body.addEventListener("dragenter", over, true);
    body.addEventListener("dragover", over, true);
    body.addEventListener("dragleave", leave, true);
    body.addEventListener("dragend", reset, true);
    body.addEventListener("drop", drop, true);
    return () => {
      unregister();
      body.removeEventListener("dragenter", over, true);
      body.removeEventListener("dragover", over, true);
      body.removeEventListener("dragleave", leave, true);
      body.removeEventListener("dragend", reset, true);
      body.removeEventListener("drop", drop, true);
    };
  }, [enabled, target]);
  return enabled ? state : "idle";
}
