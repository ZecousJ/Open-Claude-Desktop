import { useState } from "react";
import type { SshLinkTarget } from "../../shared/ssh-links";
import { sshLinkIdentity } from "../../shared/ssh-links";
import { useApp } from "../app/AppContext";
import { formatText, t } from "../i18n";
import { Modal } from "../ui/Controls";
import { chooseRemoteFolder, selectHost } from "./actions";
import { saveSshHost, useSshHosts } from "./useSshHosts";

/** Safe initial focus and provenance. */
export function SshLinkDialog({
  target,
  onClose,
}: {
  target: SshLinkTarget;
  onClose: () => void;
}) {
  const app = useApp();
  const ssh = useSshHosts();
  const [busy, setBusy] = useState(false);
  const existing = ssh.hosts.find(
    (host) =>
      sshLinkIdentity(host.destination, host.port) ===
      sshLinkIdentity(target.sshHost, target.sshPort),
  );
  const connect = async () => {
    setBusy(true);
    onClose();
    try {
      const host =
        existing ??
        (await saveSshHost({
          label: target.sshHost,
          destination: target.sshHost,
          port: target.sshPort,
        }));
      app.newChat("code");
      if (target.prompt) app.setText(target.prompt);
      await selectHost(
        {
          ...host,
          defaultFolder: target.folder ? undefined : host.defaultFolder,
        },
        app.setCwd,
        app.report,
      );
      if (target.folder)
        await chooseRemoteFolder(host.id, target.folder, app.setCwd);
    } catch (error) {
      app.report(error);
    }
  };
  return (
    <Modal
      title={t(existing ? "Use this SSH connection?" : "Connect to SSH host?")}
      onClose={onClose}
      variant="confirm"
      confirmFocus="cancel"
    >
      <p>
        {existing
          ? formatText(
              t(
                target.folder
                  ? "You opened a link to a folder on {name}. Nothing connects until you use the connection."
                  : "You opened a link to {name}. Nothing connects until you use the connection.",
              ),
              { name: existing.label },
            )
          : t(
              "You’re about to connect to a remote host via SSH. Claudex will be able to read and modify files on this server.",
            )}
      </p>
      <div className="ssh-link-details">
        <code>
          {target.sshHost}
          {target.sshPort ? `:${target.sshPort}` : ""}
        </code>
        {target.folder && <code>{target.folder}</code>}
        {!existing && (
          <>
            <p>
              {t(
                target.folder
                  ? "This host and folder came from a link you opened."
                  : "This host came from a link you opened.",
              )}
            </p>
            <p>
              {t(
                "Only connect to hosts you trust. This permission will be remembered for future sessions.",
              )}
            </p>
          </>
        )}
      </div>
      <div className="button-row">
        <button onClick={onClose}>{t("Cancel")}</button>
        <button
          className="primary"
          disabled={!ssh.ready || busy}
          onClick={() => void connect()}
        >
          {t(existing ? "Use connection" : "Connect")}
        </button>
      </div>
    </Modal>
  );
}
