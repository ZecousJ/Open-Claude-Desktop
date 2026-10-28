import { useEffect, useState } from "react";

/**
 * Whether the window is in full screen, as the main process reports it. On
 * macOS full screen hides the traffic lights, so the toolbar loses the room
 * they took and starts at the window's left edge.
 */
export function useFullScreen(): boolean {
  const [full, setFull] = useState(false);
  useEffect(
    () =>
      window.desktop?.onEvent?.((event) => {
        if (event.type === "full-screen") setFull(event.active);
      }),
    [],
  );
  return full;
}
