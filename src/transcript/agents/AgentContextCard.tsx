import { useState } from "react";
import { Markdown } from "../../ui/components";
import { useOverflowClamp } from "../../ui/useOverflowClamp";

export function AgentContextCard({ context }: { context: string }) {
  const [open, setOpen] = useState(false);
  const { ref: content, clipped } = useOverflowClamp<HTMLDivElement>(253.5, [
    context,
  ]);
  return (
    <div
      className={`agent-transcript-context${open ? " is-open" : ""}${clipped ? " is-clipped" : ""}`}
    >
      <div ref={content}>
        <Markdown text={context} onArtifact={() => {}} />
      </div>
      {clipped && (
        <button aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
