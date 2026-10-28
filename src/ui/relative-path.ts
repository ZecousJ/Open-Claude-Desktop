/** A file's path inside a folder (a working folder), or the whole path outside it. */
export function relativePath(path: string | undefined, folder?: string) {
  if (!path) return undefined;
  if (!folder) return path;
  const base = folder.replace(/[\\/]+$/, "");
  return path.startsWith(base) && /^[\\/]/.test(path.slice(base.length))
    ? path.slice(base.length + 1)
    : path;
}
