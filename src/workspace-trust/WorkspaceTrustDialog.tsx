import { Modal } from "../ui/Controls";
import { formatText } from "../i18n";
import type { TrustQuestion } from "./trust-request";
import "./workspace-trust.css";

/**
 * "on {host}" under the folder of an SSH host's workspace: the host's name in
 * the monospace of the folder.
 */
function HostLine({ host }: { host: string }) {
  const [before, after = ""] = formatText("on {host}", {
    host: "\u0000",
  }).split("\u0000");
  return (
    <p className="workspace-trust-host">
      {before}
      <span className="workspace-trust-mono" dir="ltr">
        {host}
      </span>
      {after}
    </p>
  );
}

/**
 * "Trust this workspace?": asked before the first Code session in a folder
 * Codex doesn't trust. Cancel starts focused (initialFocus "cancel"); Escape
 * and Cancel decline. Under the description: the folder, where Codex records
 * the trust when that is the repository around it, and the folder's own Codex
 * files that load once it is trusted ("Execution allowed by:"); on an SSH host
 * "on {host}" under the folder. The original's macOS folder-permission note and
 * security guide link are Claude Code's and are left out.
 */
export function WorkspaceTrustDialog({
  question,
}: {
  question: TrustQuestion;
}) {
  const { trust, answer } = question;
  return (
    <Modal
      title="Trust this workspace?"
      onClose={() => answer(false)}
      variant="confirm"
      confirmFocus="cancel"
      className="workspace-trust"
    >
      <p className="confirm-body">
        Codex may read, write, or execute files in this folder. Only proceed if
        you trust this workspace.
      </p>
      <div
        className="workspace-trust-details"
        role="region"
        aria-label="Workspace details"
        tabIndex={0}
      >
        <div className="workspace-trust-path" dir="ltr" title={trust.folder}>
          {trust.folder}
        </div>
        {trust.host !== undefined && <HostLine host={trust.host} />}
        {trust.root !== trust.folder && (
          <p className="workspace-trust-note">
            {formatText("Trusting applies to the whole repository at {root}.", {
              root: trust.root,
            })}
          </p>
        )}
        {trust.sources.length > 0 && (
          <div className="workspace-trust-sources">
            <div className="workspace-trust-sources-label">
              Execution allowed by:
            </div>
            <ul>
              {trust.sources.map((source) => (
                <li key={source} dir="ltr">
                  {source}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="button-row">
        <button className="secondary" onClick={() => answer(false)}>
          Cancel
        </button>
        <button className="primary" onClick={() => answer(true)}>
          Trust workspace
        </button>
      </div>
    </Modal>
  );
}
