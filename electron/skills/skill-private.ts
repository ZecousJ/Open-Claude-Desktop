import fs from "node:fs";
import path from "node:path";
import type { Store } from "../store/store";

/**
 * On a host without a desktop window (the web runner, shared by many users)
 * the agent's sandbox can write the profile's codex-home. It could swap the
 * skills folder for a link into another user's, so every read, install and
 * delete first checks that the path really is inside this user's own profile
 * and that the skills folders on the way are directories, not links. The
 * desktop trusts its one user's own file system.
 */
export function assertSkillPathPrivate(
  context: { store: Pick<Store, "root">; window: unknown },
  target: string,
) {
  if (context.window !== undefined) return;
  const root = fs.realpathSync(context.store.root);
  const real = fs.realpathSync(target);
  if (real !== root && !real.startsWith(root + path.sep))
    throw Error("That skill isn't in your own files.");
}
export function assertSkillsFolderPrivate(context: {
  store: Pick<Store, "root">;
  window: unknown;
}) {
  if (context.window !== undefined) return;
  let current = context.store.root;
  for (const part of ["codex-home", "skills"]) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    if (!stat.isDirectory())
      throw Error("Your skills folder can't be used. Ask an administrator.");
  }
}
