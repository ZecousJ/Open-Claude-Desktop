import type { Conversation } from "../../shared/types";
import { surface } from "../../shared/host";
import { api } from "../desktop-api";
import { openSshDialog } from "../ssh/dialogs";
import { shownFolder } from "../../shared/session-folder";

/**
 * Whether folders can be added to this session: on the desktop, in a session
 * on this computer or an SSH host (a cloud environment brings its own).
 */
export function sessionFoldersChoosable(conversation: Conversation) {
  return surface !== "web" && conversation.environment?.kind !== "space";
}

let browsing = false;

/**
 * Add folder to session. The first folder becomes the working folder of a
 * session without one; the rest are added to it.
 */
export function chooseSessionFolders(
  conversation: Conversation,
  title: string,
  report: (error: unknown) => void,
) {
  const save = async (folders: string[]) => {
    const extras = conversation.additionalFolders ?? [];
    await api.updateConversation(
      conversation.id,
      shownFolder(conversation.cwd)
        ? { additionalFolders: [...extras, ...folders] }
        : { cwd: folders[0], additionalFolders: folders.slice(1) },
    );
  };
  const environment = conversation.environment;
  if (environment?.kind === "ssh") {
    openSshDialog({
      kind: "folder",
      hostId: environment.hostId,
      onChoose: async (folder) => {
        await api.sshChooseFolder(environment.hostId, folder);
        await save([folder]);
      },
    });
    return;
  }
  // Native multi-selection with a re-entry guard.
  if (browsing) return;
  browsing = true;
  void api
    .chooseFolders(title)
    .then((folders) => (folders.length ? save(folders) : undefined))
    .catch(report)
    .finally(() => {
      browsing = false;
    });
}
