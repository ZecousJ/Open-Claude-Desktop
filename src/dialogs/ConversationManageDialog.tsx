import { useEffect, useRef } from "react";
import type { Conversation } from "../../shared/types";
import { Modal } from "../ui/Controls";
import "../collections/collections.css";

const nouns = { chat: "chat", cowork: "task", code: "session" } as const;

/**
 * Rename chat: a ~398px dialog with the name selected in a field, Cancel and
 * Save (disabled while empty) and no close button. Esc and Cancel keep the old
 * name.
 */
export function ConversationManageDialog({
  draft,
  onChange,
  onClose,
  conversation,
  onPatch,
}: {
  draft: { id: string; title: string };
  onChange: (value: { id: string; title: string }) => void;
  onClose: () => void;
  conversation?: Conversation;
  onPatch: (
    conversation: Conversation,
    patch: { title?: string; pinned?: boolean },
  ) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const noun = nouns[conversation?.mode ?? "chat"];
  // The dialog focuses its first control after this effect; the capture
  // shows the name field focused with its text selected.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <Modal title={`Rename ${noun}`} onClose={onClose}>
      <form
        className="rename-form"
        onSubmit={(event) => {
          event.preventDefault();
          const title = draft.title.trim();
          if (conversation && title) {
            onPatch(conversation, { title });
            onClose();
          }
        }}
      >
        <input
          ref={input}
          aria-label="Name"
          value={draft.title}
          maxLength={200}
          onChange={(event) =>
            onChange({ ...draft, title: event.target.value })
          }
        />
        <div className="rename-actions">
          <button type="button" className="rename-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="rename-save" disabled={!draft.title.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
