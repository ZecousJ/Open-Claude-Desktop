import { useState, type FormEvent } from "react";
import { api } from "../../desktop-api";
import { actionVerificationHandled } from "../../auth/action-verification-store";
import {
  apiKeyNameLimit,
  apiKeyNameProblem,
  apiProviderOf,
  rateText,
  type ApiGroups,
  type ApiKey,
} from "../../../shared/api-keys-api";
import { Modal } from "../../ui/Controls";
import { Choice } from "../routines/ScheduledTaskDialog";
import { ProviderLogo } from "./ProviderLogo";
import "../routines/scheduled.css";

/**
 * New key, as the web's Create scheduled task dialog is drawn: a name field
 * and a menu-backed field for the group, Cancel and a white primary button.
 */
export function NewKeyDialog({
  groups,
  rates,
  onClose,
  onCreated,
}: {
  groups: ApiGroups;
  /** Each group's rate multiplier, shown with its name. */
  rates: Record<number, number>;
  onClose: () => void;
  /** The service made the key; the dialog closes. */
  onCreated: (key: ApiKey) => void;
}) {
  const [name, setName] = useState("");
  const [group, setGroup] = useState(
    String(
      groups.groups.find((item) => item.primary)?.id ??
        groups.groups[0]?.id ??
        "",
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const problem = name.trim() ? apiKeyNameProblem(name) : undefined;
  const ready = Boolean(name.trim() && group && !problem);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      onCreated(await api.createApiKey({ name: name.trim(), groupId: +group }));
    } catch (reason) {
      if (!actionVerificationHandled(reason))
        setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="New API key"
      className="task-dialog key-dialog"
      onClose={onClose}
    >
      <form className="task-form" onSubmit={(event) => void submit(event)}>
        <label className="task-field">
          <span>
            Name <b aria-hidden="true">*</b>
          </span>
          <input
            autoFocus
            required
            maxLength={apiKeyNameLimit}
            placeholder="My script"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="task-row">
          <span>Group</span>
          <div className="task-row-fields">
            <Choice
              label="Group"
              value={group}
              options={groups.groups.map((item) =>
                rates[item.id] === undefined
                  ? ([String(item.id), item.name] as const)
                  : ([
                      String(item.id),
                      item.name,
                      rateText(rates[item.id]!),
                    ] as const),
              )}
              onChange={setGroup}
              // Each group's provider mark.
              icon={(id) => {
                const item = groups.groups.find((g) => String(g.id) === id);
                return item ? (
                  <ProviderLogo
                    id={apiProviderOf(item.platform).id}
                    size={16}
                  />
                ) : null;
              }}
              // Group names and their rates read whole.
              minMenuWidth={220}
            />
          </div>
        </div>
        {(problem || error) && (
          <p className="task-error" role="alert">
            {problem || error}
          </p>
        )}
        <div className="task-actions">
          <button type="button" className="task-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="task-save" disabled={!ready || busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
