import { useEffect } from "react";

type Listening = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * Reports whether the page is visible now and after every change, until the
 * returned function stops it (which reports it hidden). Repeated states are
 * sent once; a failed report is sent again on the next change.
 */
export function watchVisibility(
  report: (visible: boolean) => Promise<void>,
  target: {
    document: Listening & Pick<Document, "visibilityState">;
    window: Listening;
  },
) {
  let last: boolean | undefined;
  const send = (visible: boolean) => {
    if (visible === last) return;
    last = visible;
    void report(visible).catch(() => {
      // Only the unread mark depends on it; try again on the next change.
      last = undefined;
    });
  };
  const update = () => send(target.document.visibilityState === "visible");
  update();
  target.document.addEventListener("visibilitychange", update);
  target.window.addEventListener("focus", update);
  return () => {
    target.document.removeEventListener("visibilitychange", update);
    target.window.removeEventListener("focus", update);
    send(false);
  };
}

/**
 * A separate conversation window tells the main process whether the person can
 * see it (R2): a reply that finishes while its window is on screen is not
 * marked unread in the main window's sidebar, and no notification is raised for
 * it. Minimizing and hiding are reported by the main process itself; the page
 * reports what only it knows (the document became hidden or visible, the window
 * gained focus) and that it stopped showing the conversation when it unmounts.
 */
export function useWindowVisibility(
  report: ((visible: boolean) => Promise<void>) | undefined,
) {
  useEffect(() => {
    if (!report) return;
    return watchVisibility(report, { document, window });
  }, [report]);
}
