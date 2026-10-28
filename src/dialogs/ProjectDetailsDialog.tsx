import { useContext, useEffect, useRef, useState } from "react";
import type { Project } from "../../shared/types";
import { AppContext } from "../app/AppContext";
import { Modal } from "../ui/Controls";
import { t } from "../i18n";

/**
 * Current official Edit details: name + description, separate from Settings.
 * Passes both current values to the editor.
 */
export function ProjectDetailsDialog({
  project,
  onClose,
  onSave,
}: {
  project: Project;
  onClose(): void;
  onSave(project: Project): Promise<void>;
}) {
  const app = useContext(AppContext);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const [name, setName] = useState(project.name),
    [description, setDescription] = useState(project.description);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true),
    saving = useRef(false);
  const origin = useRef({
    account: app?.accountId,
    controller: app?.controllerScope,
    bridge,
    id: project.id,
  });
  const latest = useRef({ app, project, bridge, onSave, onClose });
  latest.current = { app, project, bridge, onSave, onClose };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const actor = () => {
    const owner = latest.current.app;
    return owner?.currentController ? owner.currentController.current : owner;
  };
  const owns = () =>
    alive.current &&
    latest.current.bridge === origin.current.bridge &&
    (typeof window === "undefined" ||
      window.desktop === origin.current.bridge) &&
    actor()?.accountId === origin.current.account &&
    actor()?.controllerScope === origin.current.controller &&
    latest.current.project.id === origin.current.id;
  if (!owns()) return null;
  return (
    <Modal
      title={t("Edit details")}
      onClose={onClose}
      className="prj-details-dialog"
    >
      <form
        className="prj-details-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving.current || !name.trim() || !owns()) return;
          saving.current = true;
          setBusy(true);
          // Recheck before the first RPC and merge only these two draft fields
          // into the latest record, preserving current instructions/model/folders.
          void Promise.resolve()
            .then(() => {
              if (!owns()) return;
              const current =
                actor()?.snapshot.projects.find((p) => p.id === project.id) ??
                (!latest.current.app ? latest.current.project : undefined);
              if (!current) return;
              return latest.current.onSave({
                ...current,
                name: name.trim(),
                description,
              });
            })
            .then(() => {
              if (owns()) latest.current.onClose();
            })
            .catch((error) => {
              if (owns()) {
                if (actor()) actor()!.report(error);
                else console.error(error);
              }
            })
            .finally(() => {
              saving.current = false;
              if (owns()) setBusy(false);
            });
        }}
      >
        <label>
          {t("Name")}
          <input
            autoFocus
            className="prj-details-input"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {t("Description")}
          <textarea
            className="prj-details-input"
            rows={6}
            value={description}
            disabled={busy}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="button-row">
          <button type="button" className="secondary" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !name.trim()}
            aria-busy={busy || undefined}
          >
            {t("Save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
