import { useState } from "react";
import type { Settings } from "../../../shared/types";
import {
  remoteFolderValid,
  remoteFoldersLimit,
} from "../../../shared/remote-devices";
import { preference } from "../../../shared/settings-extras";
import { Button, Row } from "../controls";
import type { TabProps } from "../context";
import { TrustedFoldersDialog } from "./CoworkTrustedFolders";

/** What a folder added for phones means, under the row and in its dialog. */
export const remoteFoldersNote =
  "Your phone can start new Code sessions only in these folders. Adding a folder also trusts it for Codex, so a session started from your phone doesn’t wait for a trust prompt.";

/**
 * Settings → General → Control from your phone → Folders for your phone: the
 * folders a phone may start Code sessions in.
 */
export function RemoteFoldersRow({
  settings,
  save,
  onError,
}: {
  settings: Settings;
  save: TabProps["save"];
  onError: (error: unknown) => void;
}) {
  const [managing, setManaging] = useState(false);
  const folders = preference(settings, "remoteFolders");
  const keep = async (next: string[]) => {
    const kept = await save({ remoteFolders: next });
    return kept === false ? folders : next;
  };
  const add = async () => {
    const folder = await window.desktop.chooseFolder(
      "Add a folder for your phone",
    );
    if (!folder) return folders;
    if (!remoteFolderValid(folder))
      throw new Error("Choose a directory, not the filesystem root.");
    if (folders.includes(folder)) return folders;
    if (folders.length >= remoteFoldersLimit)
      throw new Error("You can add up to 50 folders.");
    // Adding it is the person's explicit trust; the page names the folder
    // it just chose, never a path from anywhere else.
    await window.desktop.saveWorkspaceTrust(folder);
    return keep([...folders, folder]);
  };
  return (
    <>
      <Row label="Folders for your phone" description={remoteFoldersNote}>
        <Button onClick={() => setManaging(true)}>Manage</Button>
      </Row>
      {managing && (
        <TrustedFoldersDialog
          title="Folders for your phone"
          note={remoteFoldersNote}
          empty="No folders added yet."
          folders={folders}
          onChange={() => {}}
          onClose={() => setManaging(false)}
          onError={onError}
          add={add}
          remove={(folder) => keep(folders.filter((item) => item !== folder))}
        />
      )}
    </>
  );
}
