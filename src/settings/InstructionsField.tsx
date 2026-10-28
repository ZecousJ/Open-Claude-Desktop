import { useEffect, useId, useState } from "react";
import { formatText } from "../i18n";
import { Button } from "./controls";

/** The longest instructions Claudex is told to use (the original's default served limit). */
export const instructionsLimit = 32768;

/** Whether the text is over the limit: its trimmed length, in characters. */
export function instructionsTooLong(text: string, limit = instructionsLimit) {
  const trimmed = text.trim();
  return trimmed.length > limit && Array.from(trimmed).length > limit;
}

/** How often the empty field shows the next suggestion. */
const rotateMs = 6000;

/**
 * Account → Instructions: a text box that keeps the typed text until it is
 * saved. Changing it shows Save changes and Discard; leaving the box saves it
 * too; Escape in a changed box does not close Settings; text over the limit
 * gets a warning. While empty, the placeholder cycles through `placeholders`.
 */
export function InstructionsField({
  label,
  value,
  placeholders,
  onSave,
}: {
  label: string;
  value: string;
  placeholders: readonly string[];
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(0);
  const warning = useId();
  const dirty = draft !== value;
  // A value saved elsewhere replaces an untouched draft.
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft || placeholders.length < 2) return;
    const timer = setInterval(
      () => setShown((at) => (at + 1) % placeholders.length),
      rotateMs,
    );
    return () => clearInterval(timer);
  }, [draft === "", placeholders.length]);
  return (
    <div
      className="settings-instructions"
      onKeyDown={(event) => {
        // Escape in a changed box leaves Settings open.
        if (event.key === "Escape" && dirty) event.stopPropagation();
      }}
      onBlur={(event) => {
        // Moving to Save changes or Discard is not leaving the field.
        if (!event.currentTarget.contains(event.relatedTarget) && dirty)
          onSave(draft);
      }}
    >
      <textarea
        className="settings-textarea"
        aria-label={label}
        aria-describedby={warning}
        placeholder={placeholders[shown % placeholders.length]}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div id={warning} role="status">
        {instructionsTooLong(draft) && (
          <p className="settings-instructions-warning">
            {formatText(
              "These instructions are too long, so Claudex might not use them. Shorten them to {limit} characters or fewer.",
              { limit: instructionsLimit.toLocaleString() },
            )}
          </p>
        )}
      </div>
      {dirty && (
        <div className="settings-instructions-actions">
          <Button primary onClick={() => onSave(draft)}>
            Save changes
          </Button>
          <Button onClick={() => setDraft(value)}>Discard</Button>
        </div>
      )}
    </div>
  );
}
