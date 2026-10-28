import type { EnvironmentRef } from "../../shared/types";
import { mainState } from "./main-state";
import { selectedFolders, remoteFolders, sshHost } from "../main";

export function allowedFolder(
  folder: string | undefined,
  environment?: EnvironmentRef,
) {
  if (!folder) return;
  // A folder counts only in its own environment: a remote path never lets a
  // local folder through, and the other way round.
  const host = sshHost(environment);
  const used = (item: { cwd?: string; environment?: EnvironmentRef }) =>
    item.cwd === folder && sshHost(item.environment) === host;
  if (
    !(host
      ? remoteFolders.get(host)?.has(folder)
      : selectedFolders.has(folder)) &&
    !mainState.scheduler?.list().some(used) &&
    !mainState.store.projects.some(used) &&
    !mainState.store.conversations.some(used)
  )
    throw new Error(
      host
        ? "Choose the remote folder with the folder picker."
        : "Choose the working folder with the folder picker.",
    );
}
