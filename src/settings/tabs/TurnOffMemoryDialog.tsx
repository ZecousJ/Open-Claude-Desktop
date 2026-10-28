import { useState } from "react";
import { createPortal } from "react-dom";
import type { MemoryStatus } from "../../../shared/memory-api";
import { memoryError } from "../../memory/useMemory";
import { Modal } from "../../ui/Controls";
import "./turn-off-memory.css";

const choices = [
  {
    value: "pause",
    label: "Pause memory",
    description:
      "Claudex keeps its existing memory but won’t use memory or make new memories.",
  },
  {
    value: "reset",
    label: "Reset memory",
    description:
      "This will permanently delete all memories, including project memories. This can’t be undone.",
  },
] as const;

/**
 * Turn off memory: turning "Generate memory from chats" off asks whether to
 * pause memory (keep what it has, stop using it) or reset it (delete it all).
 * Cancel leaves the switch on. Reset is offered only while the memory can be
 * reached.
 */
export function TurnOffMemoryDialog({
  canReset,
  onPause,
  onReset,
  onClose,
}: {
  canReset: boolean;
  /** Turns the switch off, keeping the memory. */
  onPause: () => void;
  /** Called with the status the reset left, then the switch turns off. */
  onReset: (status: MemoryStatus) => void;
  onClose: () => void;
}) {
  const [choice, setChoice] =
    useState<(typeof choices)[number]["value"]>("pause");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const reset = choice === "reset";
  return createPortal(
    <Modal title="Turn off memory" onClose={onClose}>
      <div
        className="turn-off-memory"
        role="radiogroup"
        aria-label="Turn off memory"
      >
        {choices.map((option) => {
          const disabled = option.value === "reset" && !canReset;
          return (
            <label
              key={option.value}
              className={disabled ? "disabled" : undefined}
            >
              <input
                type="radio"
                name="turn-off-memory"
                value={option.value}
                checked={choice === option.value}
                disabled={disabled || busy}
                onChange={() => setChoice(option.value)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          );
        })}
      </div>
      {error && (
        <p className="confirm-body error-text" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={`primary${reset ? " danger-button" : ""}`}
          disabled={busy}
          onClick={() => {
            if (!reset) {
              onPause();
              onClose();
              return;
            }
            setBusy(true);
            setError(undefined);
            window.desktop
              .resetMemory()
              .then((status) => {
                onReset(status);
                onClose();
              })
              .catch((cause) => {
                setBusy(false);
                setError(memoryError(cause));
              });
          }}
        >
          {reset ? "Reset memory" : "Pause memory"}
        </button>
      </div>
    </Modal>,
    document.body,
  );
}
