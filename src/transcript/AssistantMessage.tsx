import type { ReactNode } from "react";
import type { MessageTextSize } from "./transcript-text-size";
import "./assistant-bubbles.css";

/** Message frame and optional bubbles (1016 shared-9:15220–15349). */
export function AssistantMessage({
  bubble,
  bubbles = true,
  frame = true,
  busy = false,
  textSize,
  heading,
  children,
}: {
  bubble: boolean;
  bubbles?: boolean;
  /** The independent legacy task renderer keeps its existing direct children. */
  frame?: boolean;
  busy?: boolean;
  textSize?: MessageTextSize;
  heading?: string;
  children: ReactNode;
}) {
  if (!frame && !bubble) return children;
  const title = busy ? undefined : heading?.trim() || undefined;
  return (
    <div
      className={bubble ? "assistant-bubble-stack" : "assistant-message-frame"}
      data-cds="AssistantMessage"
      data-busy={busy ? "" : undefined}
      data-text-size={textSize}
      data-cds-bubble-stack={bubble && bubbles ? "" : undefined}
      data-variant={bubble && !bubbles ? "bubble" : undefined}
    >
      {heading !== undefined && (
        <h2
          className="sr-only message-summary"
          data-find-omitted=""
          aria-hidden={!title || undefined}
        >
          {title}
        </h2>
      )}
      <div
        className={
          bubble ? "assistant-bubble-content" : "assistant-message-body"
        }
      >
        {children}
      </div>
    </div>
  );
}
