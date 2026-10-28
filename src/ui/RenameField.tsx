import { useRef, useState } from "react";
import { isEditEndKey } from "./ime";

/** A title edited in place: Enter or leaving saves, Escape cancels. */
export function RenameField({
  className,
  title,
  onDone,
  label = "Conversation title",
  selectAll = false,
  sized = false,
}: {
  className: string;
  title: string;
  onDone: (title: string | undefined) => void;
  label?: string;
  /** Starts with the whole title selected (a Code session's title). */
  selectAll?: boolean;
  /** Its `size` follows the text, 1 to 30 characters (the original's session title field). */
  sized?: boolean;
}) {
  const [value, setValue] = useState(title);
  const done = useRef(false);
  const finish = (result: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(result?.trim());
  };
  return (
    <input
      className={className}
      aria-label={label}
      value={value}
      size={sized ? Math.min(Math.max(value.length, 1), 30) : undefined}
      autoFocus
      // The capture shows the caret after the title, nothing selected; a Code
      // session's title starts selected.
      onFocus={(event) => {
        if (selectAll) return event.currentTarget.select();
        const end = event.currentTarget.value.length;
        event.currentTarget.setSelectionRange(end, end);
      }}
      onChange={(event) => setValue(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (isEditEndKey(event, "Enter")) finish(value);
        if (isEditEndKey(event, "Escape")) {
          event.stopPropagation();
          finish(undefined);
        }
      }}
      onBlur={() => finish(value)}
    />
  );
}
