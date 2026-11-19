import type { EnvironmentRef } from "../../shared/types";
import { mainState } from "./main-state";
import { ownsLocalCodeWorktreePath } from "../git/code-worktree";
import { ownsRemoteCodeWorktreePath } from "../git/remote-code-worktree";
import { selectedFolders, remoteFolders, sshHost } from "../main";

export function allowedFolder(
  folder: string | undefined,
  environment?: EnvironmentRef,
) {
  if (!folder) return;
  // A folder counts only in its own environment: a remote path never lets a
  // local folder through, and the other way round.
  const folderHost = (ref?: EnvironmentRef) => ref?.kind === "wsl"
    ? `wsl:${ref.distro.toLowerCase()}`
    : sshHost(ref);
  const host = folderHost(environment);
  const used = (item: { cwd?: string; environment?: EnvironmentRef; additionalFolders?: string[] }) =>
    item.environment?.kind !== "space" &&
    (item.cwd === folder || item.additionalFolders?.includes(folder)) &&
    folderHost(item.environment) === host;
  if (
    !(host
      ? remoteFolders.get(host)?.has(folder)
      : selectedFolders.has(folder)) &&
    !((environment?.kind ?? "local") === "local" &&
      mainState.store.localFolderGrants.includes(folder)) &&
    !mainState.scheduler?.list().some(used) &&
    !mainState.store.projects.some(used) &&
    !mainState.store.conversations.some(c => {
      if (c.cloudHosted || c.cloudEnvironmentId ||
          (c.sessionAuthors && (c.sessionAuthors.ownerAccountUuid !== mainState.activeAccount?.id ||
            c.sessionAuthors.viewerAccountUuid !== mainState.activeAccount?.id)))
        return false;
      if (used(c) && (c.cwd === folder || !c.codeSessionFolderGrants?.includes(folder))) return true;
      if (environment?.kind === "ssh" || environment?.kind === "wsl")
        return ownsRemoteCodeWorktreePath(c, folder, environment);
      return (environment?.kind ?? "local") === "local" &&
        ownsLocalCodeWorktreePath(c, folder);
    })
  )
    throw new Error(
      host
        ? "Choose the remote folder with the folder picker."
        : "Choose the working folder with the folder picker.",
    );
}
