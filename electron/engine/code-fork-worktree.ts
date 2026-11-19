import fs from "node:fs";
import path from "node:path";
import type { Conversation } from "../../shared/types";
import {
  cleanupRemoteCodeWorktree,
  localGit,
  materializeRemoteCodeWorktree,
  planRemoteCodeWorktree,
} from "../git/code-worktree";

export async function prepareCodeForkWorktree(
  parent: Conversation,
  location: string,
  prefix: string,
  current: () => void,
) {
  const source = parent.worktree;
  if (!source || !parent.cwd || source.state === "deleted")
    throw Error("The source worktree is unavailable.");
  const relative = path.relative(
    fs.realpathSync(source.path),
    fs.realpathSync(parent.cwd),
  );
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw Error("The session folder is outside its worktree.");
  const head = (
    await localGit(parent.cwd, ["rev-parse", "--verify", "HEAD^{commit}"])
  ).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(head))
    throw Error("The source worktree has no committed HEAD.");
  current();
  const plan = {
    ...(await planRemoteCodeWorktree(source.repository, location, prefix)),
    commit: head,
  };
  try {
    const made = await materializeRemoteCodeWorktree(plan, current);
    const cwd = path.join(made.worktree.path, relative);
    let existing = cwd;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    const resolved = path.relative(
      fs.realpathSync(made.worktree.path),
      fs.realpathSync(existing),
    );
    if (
      resolved === ".." ||
      resolved.startsWith(`..${path.sep}`) ||
      path.isAbsolute(resolved)
    )
      throw Error("The fork folder is outside its worktree.");
    fs.mkdirSync(cwd, { recursive: true });
    current();
    if (
      (
        await localGit(parent.cwd, ["rev-parse", "--verify", "HEAD^{commit}"])
      ).trim() !== head
    )
      throw Error("The source worktree's commit changed during the fork.");
    current();
    return {
      worktree: made.worktree,
      cwd,
      cleanup: () => cleanupRemoteCodeWorktree(plan),
    };
  } catch (error) {
    await cleanupRemoteCodeWorktree(plan);
    throw error;
  }
}
