import { Suspense, useEffect, useState } from "react";
import { api } from "../../desktop-api";
import { lazyPiece } from "../../ui/lazy-piece";
import { Button, Row, Section } from "../controls";

const CodeAccountDialog = lazyPiece(() => import("./CodeAccountDialog"));

/** Account rows; CLI OAuth tokens have no Claudex equivalent. */
export default function CodeAccountSections({
  onError,
}: {
  onError: (error: unknown) => void;
}) {
  const [remote, setRemote] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [dialog, setDialog] = useState<"delete" | "sharing">();
  useEffect(() => {
    let live = true;
    void api
      .accountProfile()
      .then((profile) => {
        if (live) setRemote(profile.kind === "remote");
      })
      .catch(onError);
    void api
      .sharingStatus()
      .then((status) => {
        if (live) setSharing(!!status?.conversations);
      })
      .catch(onError);
    return () => {
      live = false;
    };
  }, [onError]);
  return (
    <>
      {remote && (
        <Section title="Claudex Code">
          <Row
            label="Delete sessions stored by your Claudex service"
            description="Permanently delete your Claudex service’s copies of your Claudex Code sessions. Sessions stored locally on your computer aren’t affected."
          >
            <Button size="regular" onClick={() => setDialog("delete")}>
              Delete…
            </Button>
          </Row>
        </Section>
      )}
      {remote && sharing && (
        <Section>
          <Row
            label="Sharing settings"
            description="Control how your cloud Code sessions are shared."
          >
            <Button size="regular" onClick={() => setDialog("sharing")}>
              Manage
            </Button>
          </Row>
        </Section>
      )}
      {dialog && (
        <Suspense fallback={null}>
          <CodeAccountDialog
            kind={dialog}
            onClose={() => setDialog(undefined)}
            onError={onError}
          />
        </Suspense>
      )}
    </>
  );
}
