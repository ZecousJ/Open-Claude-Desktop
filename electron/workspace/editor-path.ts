import fs from "node:fs/promises";
import path from "node:path";
import type { Conversation } from "../../shared/types";

const unsafe =
  /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800\uFFFC\u{1D159}\u{13441}\u{13442}\u{16910}]|[^\S ]/u;

export function sessionRoots(
  c: Pick<
    Conversation,
    "additionalFolders" | "worktree" | "additionalWorktrees"
  > & { cwd: string },
) {
  return [
    c.cwd,
    ...(c.additionalFolders ?? []),
    ...(c.worktree && c.worktree.state !== "deleted" ? [c.worktree.path] : []),
    ...(c.additionalWorktrees ?? [])
      .filter((tree) => tree.state !== "deleted")
      .map((tree) => tree.path),
  ];
}
export function checkedFilePath(
  cwd: string,
  input: string,
  roots: string[],
  paths: typeof path,
) {
  if (
    input !== input.trim() ||
    unsafe.test(input) ||
    /:\d+(?::\d+)?$/.test(input)
  )
    throw Error("The path cannot be displayed or opened safely.");
  const file = paths.resolve(cwd, input);
  if (unsafe.test(file) || /:\d+(?::\d+)?$/.test(file))
    throw Error("The path cannot be displayed or opened safely.");
  const root = roots.find((candidate) => {
    const rel = paths.relative(candidate, file);
    return (
      paths.isAbsolute(candidate) &&
      !!rel &&
      rel !== ".." &&
      !rel.startsWith(`..${paths.sep}`) &&
      !paths.isAbsolute(rel)
    );
  });
  if (!root || /\.code-workspace$/i.test(file))
    throw Error("Choose a file inside a session folder.");
  return { file, root };
}
export async function identifyLocalFile(root: string, file: string) {
  const rel = path.relative(root, file);
  const realRoot = await fs.realpath(root);
  const real = await fs.realpath(file);
  if (real !== path.join(realRoot, rel))
    throw Error("Symbolic links cannot be opened.");
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n)
    throw Error("The target must be a file with one hard link.");
  return { real, dev: String(stat.dev), ino: String(stat.ino) };
}
