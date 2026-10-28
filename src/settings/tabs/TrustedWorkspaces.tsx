import { useEffect, useState } from "react";
import type { DesktopAPI } from "../../../shared/types";
import { notAvailableOnWeb } from "../../../shared/web-bridge-methods";
import { Button, Row } from "../controls";
import { TrustedFoldersDialog } from "./CoworkTrustedFolders";

/** What a trusted folder means to Codex, under the row and in its dialog. */
export const trustedWorkspacesNote =
  "Codex loads a trusted folder’s own .codex config, hooks and rules. A Code session asks before it starts in a folder that isn’t trusted.";

type Bridge = Pick<DesktopAPI, "trustedWorkspaces" | "onEvent">;

/**
 * Loads the folders Codex trusts now and after every `workspace-trust`
 * event; returns the unsubscribe function. A bridge without them (the web
 * app, whose sandboxes trust their own folders) never sets the list.
 */
export function watchTrustedWorkspaces(
  desktop: Bridge,
  set: (folders: string[]) => void,
  onError: (error: unknown) => void,
) {
  if (typeof desktop.trustedWorkspaces !== "function") return () => {};
  let live = true;
  let latest = 0;
  const load = () => {
    const request = ++latest;
    return desktop
      .trustedWorkspaces()
      .then((list) => {
        if (live && request === latest) set(list);
      })
      .catch((error: unknown) => {
        const unavailable =
          error instanceof Error && error.message.includes(notAvailableOnWeb);
        if (live && request === latest && !unavailable) onError(error);
      });
  };
  void load();
  const off = desktop.onEvent((event) => {
    if (event.type === "workspace-trust") void load();
  });
  return () => {
    live = false;
    off();
  };
}

/**
 * Settings → Claude Code → Trusted folders: the folders Code's "Trust this
 * workspace?" recorded in Codex's config, laid out as the Trusted Cowork
 * folders dialog. Hidden where the bridge has none (the web app).
 */
export function TrustedWorkspacesRow({
  onError,
}: {
  onError: (error: unknown) => void;
}) {
  const [folders, setFolders] = useState<string[]>();
  const [managing, setManaging] = useState(false);
  useEffect(
    () => watchTrustedWorkspaces(window.desktop, setFolders, onError),
    [],
  );
  if (!folders) return null;
  return (
    <>
      <Row label="Trusted folders" description={trustedWorkspacesNote}>
        <Button onClick={() => setManaging(true)}>Manage</Button>
      </Row>
      {managing && (
        <TrustedFoldersDialog
          title="Trusted folders"
          note={trustedWorkspacesNote}
          folders={folders}
          onChange={setFolders}
          onClose={() => setManaging(false)}
          onError={onError}
          add={() => window.desktop.addTrustedWorkspace()}
          remove={(folder) => window.desktop.removeTrustedWorkspace(folder)}
        />
      )}
    </>
  );
}
