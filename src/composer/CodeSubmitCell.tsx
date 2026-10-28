import { useState, type ReactNode } from "react";

/**
 * The Code prompt's send cell: Stop and Send stacked in one grid cell, only one
 * of them shown. When they swap, the one leaving fades out over 80ms and is
 * hidden at the end; the one coming fades in over 120ms after an 80ms wait. The
 * first render does not fade.
 */
export function CodeSubmitCell({
  showStop,
  stop,
  send,
}: {
  showStop: boolean;
  stop: ReactNode;
  send: ReactNode;
}) {
  const current = showStop ? "stop" : "send";
  const [shown, setShown] = useState(current);
  const [swapped, setSwapped] = useState(false);
  // Worked out while rendering, so the cell never draws both or neither.
  if (shown !== current) {
    setShown(current);
    setSwapped(true);
  }
  const face = (key: "stop" | "send", content: ReactNode) => {
    const visible = key === current;
    return (
      <span
        className="code-submit-face"
        data-shown={visible || undefined}
        data-entering={(visible && swapped) || undefined}
        inert={!visible || undefined}
        aria-hidden={!visible || undefined}
      >
        {content}
      </span>
    );
  };
  return (
    <span className="composer-submit code-submit-cell">
      {face("stop", stop)}
      {face("send", send)}
    </span>
  );
}
