import { useState } from "react";
import type { SshPrompt } from "../../shared/ssh-api";
import { Modal } from "../ui/Controls";
import { promptView } from "./model";

/**
 * A question ssh asked while connecting (design 5.3): a password, a key's
 * passphrase or a new host's fingerprint. ssh's own words show in a
 * monospace block. The answer goes straight back to ssh and is never
 * stored, so there is no Remember option. Cancel (or Escape) cancels the
 * connection attempt. Not captured; styled as the app's other dialogs.
 */
export function SshPromptDialog({
  prompt,
  label,
  onAnswer,
}: {
  prompt: SshPrompt;
  /** The host's name, or its destination. */
  label: string;
  onAnswer: (answer: string | null) => void;
}) {
  const view = promptView(prompt, label);
  const [answer, setAnswer] = useState("");
  const cancel = () => onAnswer(null);
  return (
    <Modal title={view.title} onClose={cancel}>
      <form
        className="ssh-prompt"
        onSubmit={(event) => {
          event.preventDefault();
          onAnswer(view.input ? answer : "yes");
          setAnswer("");
        }}
      >
        <pre className="ssh-prompt-text">{prompt.text}</pre>
        {prompt.fingerprint && (
          <p className="ssh-fingerprint">
            <code>{prompt.fingerprint}</code>
          </p>
        )}
        {view.note && <p className="ssh-prompt-note">{view.note}</p>}
        {view.input && (
          <input
            type={view.input}
            aria-label={view.title}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
          />
        )}
        <div className="button-row">
          <button type="button" className="secondary" onClick={cancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            // A host key question starts on Connect, not on Close.
            autoFocus={!view.input}
          >
            {view.confirm}
          </button>
        </div>
      </form>
    </Modal>
  );
}
