import { useState } from "react";
import { Plus } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import { Spinner } from "../../ui/Spinner";
import { Modal } from "../../ui/Controls";
import { notAvailable } from "../../settings/unavailable";
import { skillSlug } from "./customize-list";
import "./create-skill.css";

export const nameRequired = "Use at least one letter or number.";
export const nameAndDescriptionRequired =
  "Add a valid name and description before saving.";

/**
 * Create a skill: a free-text name shown with the name it is saved as, a
 * description, the SKILL.md instructions in a numbered editor, a Draft badge,
 * Cancel and Create. Create checks the form when pressed (the original keeps it
 * enabled); leaving with changes asks "Discard this draft?". Add file is the
 * original's and disabled: Claudex skills are a single SKILL.md. Customize and
 * Settings → Skills share it.
 */
export function CreateSkillDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (skill: {
    name: string;
    description: string;
    instructions: string;
  }) => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    name: "",
    description: "",
    instructions: "",
  });
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [leaving, setLeaving] = useState(false);
  const slug = skillSlug(draft.name);
  const nameError = checked && !slug;
  const changed = Boolean(
    draft.name || draft.description || draft.instructions,
  );
  const leave = () => (changed ? setLeaving(true) : onClose());
  const lines = Math.max(1, draft.instructions.split("\n").length);
  return (
    <>
      <Modal
        title="Create a skill"
        onClose={leave}
        className="create-skill-dialog"
      >
        <form
          className="create-skill"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setChecked(true);
            if (busy) return;
            if (!slug || !draft.description.trim()) {
              setError(nameAndDescriptionRequired);
              return;
            }
            if (!draft.instructions.trim()) {
              setError("Add instructions before saving.");
              return;
            }
            setBusy(true);
            setError("");
            onCreate({
              name: slug,
              description: draft.description.trim(),
              instructions: draft.instructions.trim(),
            }).catch((reason) => {
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
              setBusy(false);
            });
          }}
        >
          <label>
            Skill name
            <input
              value={draft.name}
              maxLength={64}
              placeholder="Weekly status report"
              aria-invalid={nameError || undefined}
              aria-describedby="create-skill-name-note"
              className={nameError ? "invalid" : ""}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </label>
          {nameError ? (
            <small
              id="create-skill-name-note"
              className="create-skill-error"
              role="alert"
            >
              <AppIcon name="WarningCircle" size={13} strokeWidth={1.8} />
              {nameRequired}
            </small>
          ) : (
            slug && <small id="create-skill-name-note">Saved as /{slug}</small>
          )}
          <label>
            Description
            <textarea
              rows={2}
              value={draft.description}
              maxLength={1024}
              placeholder="Generate weekly status reports from recent work. Use when asked for updates or progress summaries."
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
            />
          </label>
          <div className="create-skill-editor">
            <span className="settings-unavailable" title={notAvailable}>
              <button type="button" disabled>
                <Plus size={14} strokeWidth={1.8} />
                Add file
              </button>
            </span>
            <div className="create-skill-code">
              <ol aria-hidden="true">
                {Array.from({ length: lines }, (_, index) => (
                  <li key={index}>{index + 1}</li>
                ))}
              </ol>
              <textarea
                aria-label="Instructions"
                value={draft.instructions}
                placeholder="Summarize my recent work in three sections: wins, blockers, and next steps. Keep the tone professional but not stiff..."
                onChange={(event) =>
                  setDraft({ ...draft, instructions: event.target.value })
                }
              />
            </div>
          </div>
          {error && (
            <p className="create-skill-error" role="alert">
              {error}
            </p>
          )}
          <div className="button-row create-skill-foot">
            <span className="create-skill-draft">Draft</span>
            <button type="button" className="secondary" onClick={leave}>
              Cancel
            </button>
            <button
              className={`primary ${busy ? "busy" : ""}`}
              disabled={busy}
              aria-busy={busy}
            >
              <span className="busy-label">Create</span>
              {busy && <Spinner inheritColor size="sm" className="spin" />}
            </button>
          </div>
        </form>
      </Modal>
      {leaving && (
        <Modal
          title="Discard this draft?"
          onClose={() => setLeaving(false)}
          variant="confirm"
          confirmFocus="cancel"
        >
          <p className="confirm-body">
            Your changes haven’t been saved and will be lost.
          </p>
          <div className="button-row">
            <button className="secondary" onClick={() => setLeaving(false)}>
              Keep editing
            </button>
            <button className="primary danger-button" onClick={onClose}>
              Discard
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
