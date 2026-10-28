import { useRef, type ReactNode } from "react";
import { usePresence } from "../ui/usePresence";

/** A chip waits 50ms, then fades in or out over 75ms. */
const chipExitMs = 125;

/**
 * A toolbar indicator chip (Research, knowledge bases) arriving and leaving the
 * way the original's do: after 50ms it fades in over 75ms, and when its mode is
 * turned off it stays for the same fade out. `children` is the chip, or nothing
 * while its mode is off; the last chip shown is kept for the exit.
 */
export function ChipPresence({ children }: { children: ReactNode }) {
  const shown = Boolean(children);
  const last = useRef<ReactNode>(children);
  if (shown) last.current = children;
  const { mounted, state } = usePresence(shown, chipExitMs);
  if (!mounted) return null;
  return (
    <span
      className="composer-chip-slot"
      data-state={state}
      inert={!shown || undefined}
    >
      {last.current}
    </span>
  );
}
