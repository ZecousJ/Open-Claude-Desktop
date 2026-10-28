import { useEffect, useRef, useState } from "react";
import { AppIcon } from "../../ui/app-icon";
import { Spinner } from "../../ui/Spinner";
import { Modal } from "../../ui/Controls";
import { isComposingKey } from "../../ui/ime";
import { copyName, hasHiddenOrAngle } from "../../../shared/duplicate-name";
import { formatText } from "../../i18n";
import { showToast } from "../../ui/toast-store";
import { skillSlug } from "./customize-list";
import { nameRequired } from "./CreateSkillDialog";
import "./create-skill.css";

/**
 * Duplicate skill, Rename skill, Duplicate plugin and Rename plugin: a Name
 * field with the proposed name selected, the name it is saved as under it, an
 * optional note ("The copy is added to your personal skills."), Cancel and the
 * action. A name that cannot be used, or one the main process refuses (taken),
 * shows its reason under the field; while the request runs the field and
 * buttons wait and the dialog stays open. Laid out with Create a skill's field
 * and footer (the closest Claudex analogue).
 */
export function NameCopyDialog({
  title,
  action,
  initialName,
  slug,
  savedAs,
  note,
  fieldLabel,
  sameName,
  sameMessage,
  checkAfterEdit = false,
  plan,
  onSubmit,
  onClose,
  isCurrent,
}: {
  title: string;
  /** The primary button ("Duplicate", "Rename"). */
  action: string;
  initialName: string;
  /** The name a typed text is saved as. */
  slug: (typed: string) => string;
  /** The words before the saved name ("Saved as /" for a skill). */
  savedAs: string;
  note?: string;
  /** The field's accessible name when it differs from "Name". */
  fieldLabel?: string;
  /** A saved name the dialog refuses (the original's, or the current one). */
  sameName?: string;
  sameMessage?: string;
  /** Rename: the problems show once the person has typed. */
  checkAfterEdit?: boolean;
  /**
   * Rename plugin: the name a typed text is saved as and whether nothing
   * would change, when that depends on more than the saved name (a new
   * display name alone is a change). Replaces `sameName` for the check.
   */
  plan?: (typed: string) => { savedAs: string; unchanged: boolean };
  /** Resolves when done (the dialog then closes); a rejection's text shows. */
  onSubmit: (typed: string, name: string) => Promise<void>;
  onClose: () => void;
  /** An operation may finish after its account or controller has retired. */
  isCurrent?: () => boolean;
}) {
  const [typed, setTyped] = useState(initialName);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => {
      mounted.current = false;
      cancelAnimationFrame(frame);
    };
  }, []);
  const clean = typed.trim();
  const name = slug(clean);
  const planned = plan?.(clean);
  const unchanged = planned
    ? planned.unchanged
    : sameName !== undefined && name === sameName;
  const problem = !name
    ? nameRequired
    : hasHiddenOrAngle(clean)
      ? "Names can’t contain < or >, or hidden formatting characters."
      : unchanged
        ? sameMessage
        : undefined;
  const shown =
    refused || (problem && (!checkAfterEdit || edited) ? problem : "");
  const ready = !problem && !busy;
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Modal title={title} onClose={close}>
      <form
        className="create-skill"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || (isCurrent && !isCurrent())) return;
          setBusy(true);
          setRefused("");
          const current = () => mounted.current && (!isCurrent || isCurrent());
          onSubmit(clean, name)
            .then(
              () => {
                if (current()) onClose();
              },
              (reason) => {
                if (current())
                  setRefused(
                    reason instanceof Error ? reason.message : String(reason),
                  );
              },
            )
            .finally(() => {
              if (current()) setBusy(false);
            });
        }}
      >
        <label>
          Name
          <input
            ref={input}
            value={typed}
            maxLength={64}
            disabled={busy}
            aria-label={fieldLabel}
            aria-invalid={Boolean(shown) || undefined}
            aria-describedby="name-copy-note"
            className={shown ? "invalid" : ""}
            onChange={(event) => {
              setTyped(event.target.value);
              setEdited(true);
              setRefused("");
            }}
            // The Enter that accepts an IME candidate must not submit.
            onKeyDown={(event) => {
              if (event.key === "Enter" && isComposingKey(event))
                event.preventDefault();
            }}
          />
        </label>
        {shown ? (
          <small
            id="name-copy-note"
            className="create-skill-error"
            role="alert"
          >
            <AppIcon name="WarningCircle" size={13} strokeWidth={1.8} />
            {shown}
          </small>
        ) : (
          name && (
            <small id="name-copy-note">
              {savedAs}
              <b className="name-copy-saved" data-no-translate>
                {planned?.savedAs ?? name}
              </b>
            </small>
          )
        )}
        {note && <small>{note}</small>}
        <div className="button-row create-skill-foot name-copy-foot">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          <button
            className={`primary ${busy ? "busy" : ""}`}
            disabled={!ready}
            aria-busy={busy}
          >
            <span className="busy-label">{action}</span>
            {busy && <Spinner inheritColor size="sm" className="spin" />}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Duplicate skill or Rename skill for a listed skill: the copy goes to the
 * person's own skills under the saved name (Rename: the skill's folder takes
 * it), then a notice says so (live: "Duplicated as {skillName}", "Renamed
 * to {skillName}"). Customize and Settings → Skills share it.
 */
export function SkillNameDialog({
  kind,
  skill,
  onDone,
  onClose,
}: {
  kind: "duplicate" | "rename";
  skill: { name: string; path: string };
  /** After the copy or the new name is saved (reload the list). */
  onDone: (name: string) => void;
  onClose: () => void;
}) {
  const duplicate = kind === "duplicate";
  return (
    <NameCopyDialog
      title={duplicate ? "Duplicate skill" : "Rename skill"}
      action={duplicate ? "Duplicate" : "Rename"}
      initialName={duplicate ? copyName(skill.name) : skill.name}
      slug={skillSlug}
      savedAs="Saved as /"
      note={
        duplicate ? "The copy is added to your personal skills." : undefined
      }
      sameName={skillSlug(skill.name)}
      sameMessage={
        duplicate
          ? "Choose a name different from the original."
          : "Choose a name different from the current one."
      }
      checkAfterEdit={!duplicate}
      onSubmit={async (_typed, name) => {
        await (duplicate
          ? window.desktop.duplicateSkill(skill.path, name)
          : window.desktop.renameSkill(skill.path, name));
        showToast(
          formatText(
            duplicate ? "Duplicated as {skillName}" : "Renamed to {skillName}",
            { skillName: name },
          ),
        );
        onDone(name);
      }}
      onClose={onClose}
    />
  );
}
