import { useSyncExternalStore } from "react";
import type { Conversation } from "../../../shared/types";

type MoveRequest = {
  id: number;
  rows: readonly Conversation[];
  done?: (failed: string[]) => void;
};
let request: MoveRequest | undefined;
let nextRequestId = 0;
const listeners = new Set<() => void>();

export function requestProjectMove(
  rows: readonly Conversation[],
  done?: MoveRequest["done"],
) {
  request = rows.length
    ? { id: ++nextRequestId, rows: [...rows], done }
    : undefined;
  listeners.forEach((listener) => listener());
}

export function closeProjectMove() {
  request = undefined;
  listeners.forEach((listener) => listener());
}

export function useProjectMoveRequest() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => request,
    () => undefined,
  );
}
