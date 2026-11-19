import path from "node:path";
import type { Conversation } from "../../../shared/types";
/** No filesystem access or trust mutation. Known unsupported sessions fail before any trust request. */
export function environmentChangeRefusal(c: Conversation | undefined, id: string, cwd: unknown) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.length > 4096 || /[\0\r\n]/.test(cwd))
    return { status: "rejected", reason: "invalid_directory", message: "Choose an existing local folder." };
  if (process.platform === "win32" && /^(?:[\\/]{2}|[\\/]\?\?[\\/])/.test(cwd))
    return { status: "rejected", reason: "blocked_by_rule", message: "Network (UNC) paths can't be used as a session working directory." };
  if (!c || id !== `local_${c.id}` || c.archived)
    return { status: "rejected", reason: "not_active", message: "Session not found or archived." };
  if (c.mode !== "code" || c.cloudHosted || c.cloudEnvironmentId || c.incognito || c.importedSessionResumePending ||
    (c.sessionAuthors && c.sessionAuthors.ownerAccountUuid !== c.sessionAuthors.viewerAccountUuid))
    return { status: "rejected", reason: "unsupported_session", message: "Only a local, non-worktree Code session can change folders." };
  if ((c.environment?.kind ?? "local") !== "local")
    return { status: "rejected", reason: "ssh_unsupported", message: "Changing the directory of an SSH session isn't supported yet." };
  if (c.worktree || c.additionalWorktrees?.some(tree => tree.state !== "deleted"))
    return { status: "rejected", reason: "worktree_unsupported", message: "This session runs in an isolated worktree; changing its folder isn't supported. You can still ask Claudex to work in another folder from this session." };
  if (c.turns.some(t => t.status === "inProgress"))
    return { status: "rejected", reason: "busy", message: "Claudex is working right now. Wait for the current turn to finish, then try again." };
  return undefined;
}
