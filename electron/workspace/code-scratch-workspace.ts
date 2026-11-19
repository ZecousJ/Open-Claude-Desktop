import path from "node:path";
import type { Conversation } from "../../shared/types";

const scratchId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function codeScratchWorkspaceRoot(cwd: string | undefined, workspace?: string) {
  if (!cwd || !workspace) return undefined;
  const paths = /^[a-z]:[\\/]|^\\\\/i.test(workspace) ? path.win32 : path.posix;
  const sessions = paths.resolve(workspace, "sessions");
  const [id] = paths.relative(sessions, paths.resolve(cwd)).split(paths.sep);
  return scratchId.test(id) ? paths.join(sessions, id) : undefined;
}

/** Match the account-owned layout minted by Engine.send and createScratchWorkspace.
 * Keep the real cwd for execution; the official UI uses this flag for grouping,
 * recent folders and location labels. UUID-named user folders are ordinary projects.
 */
export function isCodeScratchWorkspace(c: Conversation, workspace?: string) {
  const cwd = c.worktree?.origin ?? c.cwd;
  if (!workspace || !cwd) return false;
  const paths = /^[a-z]:[\\/]|^\\\\/i.test(workspace) ? path.win32 : path.posix;
  return codeScratchWorkspaceRoot(cwd, workspace) === paths.resolve(cwd);
}
