import os from "node:os";
import path from "node:path";

/** The official desktop's R9r/uJ folder classification; no filesystem access. */
export function classifyTccFolderKind(input: string, home = os.homedir()) {
  const candidate = path.resolve(input).toLowerCase();
  const inside = (folder: string) => {
    const relative = path.relative(folder.toLowerCase(), candidate);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  for (const [name, folder] of [["desktop", "Desktop"], ["documents", "Documents"], ["downloads", "Downloads"]] as const)
    if (inside(path.join(home, folder))) return name;
  if (inside(path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"))) return "icloud";
  if (inside(path.join(home, "Library", "CloudStorage"))) return "cloudStorage";
  return null;
}
