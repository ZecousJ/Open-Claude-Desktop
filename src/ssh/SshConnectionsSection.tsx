import { useEffect, useState } from "react";
import { Button, Row, Section } from "../settings/controls";
import { openSshDialog } from "./dialogs";
import { useSshHosts } from "./useSshHosts";

// Settings only manages grants.
export function SshConnectionsSection({
  onError,
}: {
  onError: (error: unknown) => void;
}) {
  const ssh = useSshHosts();
  const [hasGrants, setHasGrants] = useState(false);
  useEffect(() => {
    let active = true;
    if (ssh.ready)
      void window.desktop
        .sshToolGrants()
        .then((grants) => {
          if (active) setHasGrants(grants.length > 0);
        })
        .catch(onError);
    return () => {
      active = false;
    };
  }, [ssh.ready, onError]);
  if (!ssh.ready || (!ssh.hosts.length && !hasGrants)) return null;
  return (
    <Section title="SSH sessions">
      <Row
        label="Allowed connector tools"
        description="Connector tools Claudex can use on an SSH host without a permission prompt."
      >
        <Button onClick={() => openSshDialog({ kind: "tools" })}>Manage</Button>
      </Row>
    </Section>
  );
}
