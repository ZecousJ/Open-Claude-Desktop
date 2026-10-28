import { Suspense, useState } from "react";
import { useHostCapability } from "../../host/HostContext";
import { usePolicy } from "../../policy/PolicyContext";
import { lazyPiece } from "../../ui/lazy-piece";
import { preference } from "../../../shared/settings-extras";
import { Button, Row, Section } from "../controls";
import { Dropdown } from "../Dropdown";
import type { TabProps } from "../context";
import {
  trustedFoldersNote,
  useTrustedCoworkFolders,
} from "./CoworkTrustedFolders";
import "../desktop.css";

const TrustedFoldersDialog = lazyPiece(
  () => import("./CoworkTrustedFolders"),
  "TrustedFoldersDialog",
);

/** Hub Tasks group. */
export function TasksSection({
  settings,
  save,
  onError,
}: Pick<TabProps, "settings" | "save" | "onError">) {
  const trusted = useTrustedCoworkFolders(onError);
  const [managing, setManaging] = useState(false);
  const browser = useHostCapability("browserPanel");
  const policy = usePolicy();
  const showBrowser = browser && policy.browser?.enabled !== false;
  if (!trusted.folders && !showBrowser) return null;
  return (
    <Section title="Tasks">
      {trusted.folders && (
        <Row label="Trusted Cowork folders" description={trustedFoldersNote}>
          <Button onClick={() => setManaging(true)}>Manage</Button>
        </Row>
      )}
      {showBrowser && (
        <Row
          label="Preferred browser"
          description="Claudex uses this browser by default unless you ask otherwise."
        >
          <Dropdown
            label="Preferred browser"
            value={preference(settings, "preferredBrowser")}
            options={[{ value: "built_in", label: "Built-in browser" }]}
            onChange={(preferredBrowser) => save({ preferredBrowser })}
          />
        </Row>
      )}
      {managing && trusted.folders && (
        <Suspense fallback={null}>
          <TrustedFoldersDialog
            folders={trusted.folders}
            onChange={trusted.setFolders}
            onClose={() => setManaging(false)}
            onError={onError}
          />
        </Suspense>
      )}
    </Section>
  );
}
