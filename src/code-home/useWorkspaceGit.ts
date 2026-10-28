import { useEffect, useState } from "react";
import type { WorkspaceGit } from "../../shared/code-usage-api";
import type { EnvironmentRef } from "../../shared/types";

const none: WorkspaceGit = { branch: null, githubRemote: false };

/**
 * The folder's Git branch and whether it has a GitHub remote, read by the
 * main process from the repository's files (electron/git-branch.ts).
 * Outside a repository, or for a folder the user did not choose, both are
 * empty. `refresh` changes re-read it (a branch switched meanwhile).
 *
 * A folder on an SSH host (R9) is read on the host, never looked up
 * locally; while the host can't be reached both are empty.
 */
export function useWorkspaceGit(
  folder?: string,
  refresh: unknown = 0,
  environment?: EnvironmentRef,
) {
  const [git, setGit] = useState<WorkspaceGit>(none);
  const host = environment?.kind === "ssh" ? environment.hostId : undefined;
  useEffect(() => {
    if (!folder) {
      setGit(none);
      return;
    }
    let live = true;
    void Promise.resolve(
      window.desktop?.workspaceGit?.(
        folder,
        host ? { kind: "ssh", hostId: host } : undefined,
      ),
    )
      .then((value) => {
        if (live) setGit(value ?? none);
      })
      .catch(() => {
        if (live) setGit(none);
      });
    return () => {
      live = false;
    };
  }, [folder, refresh, host]);
  return git;
}
