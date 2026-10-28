import { useEffect, useRef, useState } from "react";
import { dismissToast, showToast } from "../ui/toast-store";

/** A name in a toast, cut at 32 characters. */
export function toastName(name: string, max = 32) {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

type Pending = { toast: number; settled: boolean };

/**
 * The row leaves at once and a toast says it is going ("Unsharing “…”…") with
 * Undo; when the toast goes the removal is made and a second toast says it is
 * done ("Unshared “…”"), or the row comes back and the failure is reported.
 * Leaving the page makes every waiting removal at once.
 */
export function useUndoableRemove() {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const pending = useRef(new Map<string, Pending>());
  const show = (key: string, gone: boolean) =>
    setHidden((current) => {
      const next = new Set(current);
      if (gone) next.add(key);
      else next.delete(key);
      return next;
    });
  // Leaving the page commits what is still waiting (its toast's dismissal
  // runs the removal).
  useEffect(
    () => () => {
      for (const item of pending.current.values()) dismissToast(item.toast);
    },
    [],
  );
  function remove(
    key: string,
    {
      title,
      doneTitle,
      commit,
      onDone,
      onFailed,
    }: {
      title: string;
      doneTitle: string;
      commit: () => Promise<unknown>;
      /** After a removal was made (to read the list again). */
      onDone?: () => void;
      onFailed: (error: unknown) => void;
    },
  ) {
    if (pending.current.has(key)) return;
    show(key, true);
    const item: Pending = { toast: 0, settled: false };
    pending.current.set(key, item);
    item.toast = showToast(title, {
      action: {
        label: "Undo",
        onSelect: () => {
          item.settled = true;
          pending.current.delete(key);
          show(key, false);
        },
      },
      onDismiss: () => {
        if (item.settled) return;
        item.settled = true;
        void commit()
          .then(() => {
            showToast(doneTitle);
            onDone?.();
          })
          .catch((error: unknown) => {
            show(key, false);
            onFailed(error);
          })
          .finally(() => pending.current.delete(key));
      },
    });
  }
  return { hidden, remove };
}
