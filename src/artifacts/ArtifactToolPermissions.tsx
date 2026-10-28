import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ArtifactToolGroup } from "../../shared/artifact-tools";
import { Modal } from "../ui/Controls";
import { formatText, t } from "../i18n";
import { toolDisplay } from "./ArtifactToolDialog";

export function ArtifactToolPermissions({
  identity,
  onClose,
  onError,
}: {
  identity: string;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const [groups, setGroups] = useState<ArtifactToolGroup[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void window.desktop
      .artifactToolPermissions(identity)
      .then((groups) => live && setGroups(groups))
      .catch(onError);
    return () => {
      live = false;
    };
  }, [identity, onError]);
  return createPortal(
    <Modal
      title={t("Permissions")}
      onClose={onClose}
      className="artifact-tool-dialog"
    >
      <div
        className="artifact-tool-body"
        role="region"
        aria-label={t("Connectors")}
      >
        {groups.map((group) => (
          <div className="artifact-tool-group" key={group.server}>
            <div>
              {formatText("From {connector}", {
                connector: `“⁨${toolDisplay(group.server)}⁩”`,
              })}
            </div>
            <ul>
              {group.tools.map((tool) => (
                <li key={tool}>{toolDisplay(tool)}</li>
              ))}
            </ul>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void window.desktop
                  .revokeArtifactTools(identity, group.server)
                  .then(() => window.desktop.artifactToolPermissions(identity))
                  .then(setGroups)
                  .catch(onError)
                  .finally(() => setBusy(false));
              }}
            >
              {t("Remove")}
            </button>
          </div>
        ))}
        <button className="primary" onClick={onClose}>
          {t("Done")}
        </button>
      </div>
    </Modal>,
    document.body,
  );
}
