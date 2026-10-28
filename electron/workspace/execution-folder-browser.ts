import fs from "node:fs";
import path from "node:path";

/**
 * A browser belongs to one execution workspace, never to the runner host.
 * IPC must derive this root from the authenticated conversation; no root
 * supplied by the renderer may be passed here. Both listing and granting
 * must call checked() so a typed path or replaced symlink cannot escape.
 */
export class ExecutionFolderBrowser {
  private readonly root: string;

  constructor(root: string) {
    this.root = fs.realpathSync.native(root);
    if (!fs.statSync(this.root).isDirectory())
      throw new Error("This task's workspace is not a folder.");
  }

  checked(folder: string): string {
    if (
      typeof folder !== "string" ||
      !folder ||
      folder.length > 4096 ||
      folder.includes("\0") ||
      !path.isAbsolute(folder)
    )
      throw new Error("Choose an absolute folder.");
    const inside = (candidate: string) => {
      const relative = path.relative(this.root, candidate);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error("This folder is outside this task's workspace.");
    };
    // Reject arbitrary host paths before probing their existence at all.
    inside(path.resolve(folder));
    const real = fs.realpathSync.native(folder);
    inside(real);
    if (!fs.statSync(real).isDirectory())
      throw new Error("This path is not a folder.");
    return real;
  }

  capability(
    initialPath = this.root,
  ): import("../../shared/folder-browser").TaskFolderBrowser {
    return {
      kind: "execution",
      root: this.root,
      initialPath: this.checked(initialPath),
    };
  }

  list(
    folder: string,
  ): import("../../shared/folder-browser").TaskFolderDirectory {
    const current = this.checked(folder);
    const directories = fs
      .readdirSync(current)
      .filter((name) => {
        // Symlinks are listed only if their real directory remains in this
        // session. Unreadable/deleted entries cannot reveal another root.
        try {
          this.checked(path.join(current, name));
          return true;
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b));
    // Reject a directory/root replaced while its entries were read.
    this.checked(current);
    return {
      path: current,
      ...(current === this.root
        ? {}
        : { parent: this.checked(path.dirname(current)) }),
      directories,
    };
  }
}
