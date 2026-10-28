import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useExitPresence } from "./usePresence";

/*
 * The open dialogs, oldest first. A dialog opened over another is "nested": its
 * backdrop stays clear so the window is shaded once, and the dialog under it is
 * "covered" and blurs. Dialogs register while mounted.
 */
let stack: readonly symbol[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly symbol[]) {
  stack = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Registers a dialog for as long as it is mounted, and returns the
 * attributes for its backdrop: `data-nested` when it opened over another
 * dialog, `data-nested-open` while another dialog is open over it.
 */
export function useDialogLayer() {
  const [token] = useState(() => Symbol("dialog"));
  useLayoutEffect(() => {
    publish([...stack, token]);
    return () => publish(stack.filter((entry) => entry !== token));
  }, [token]);
  const current = useSyncExternalStore(
    subscribe,
    () => stack,
    () => stack,
  );
  const index = current.indexOf(token);
  return {
    "data-nested": index > 0 ? "" : undefined,
    "data-nested-open":
      index >= 0 && index < current.length - 1 ? "" : undefined,
  };
}

/** A dialog's exit: the Dialog popup's 200ms. */
export const DIALOG_EXIT_MS = 200;

/**
 * Props for a dialog's backdrop element, the one that holds the panel:
 * it fades out when the dialog unmounts and takes its nesting attributes.
 */
export function useDialogOverlay(exitMs = DIALOG_EXIT_MS) {
  const ref = useRef<HTMLDivElement>(null);
  useExitPresence(ref, exitMs);
  useFocusReturn();
  return { ref, ...useDialogLayer() };
}

/** What had the focus when a dialog opened, read while it first renders. */
function focusedElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const focused = document.activeElement as HTMLElement | null;
  return focused &&
    focused !== document.body &&
    typeof focused.focus === "function"
    ? focused
    : null;
}

/**
 * A dialog gives the focus back to what had it when it opened, as the
 * original's dialogs and popovers do. Only when the focus went with the dialog:
 * a dialog that sent it somewhere on purpose keeps that.
 */
export function useFocusReturn() {
  const [opener] = useState(focusedElement);
  useEffect(
    () => () => {
      const focused = document.activeElement;
      const lost =
        !focused ||
        focused === document.body ||
        !focused.isConnected ||
        Boolean(focused.closest("[inert]"));
      if (lost && opener?.isConnected && !opener.closest("[inert]"))
        opener.focus({ preventScroll: true });
    },
    [opener],
  );
}
