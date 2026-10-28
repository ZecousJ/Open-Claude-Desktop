import fs from "node:fs";
import path from "node:path";

// Folder memory editor.
export function readFolderInstructions(root: string): string {
  const file = path.join(fs.realpathSync(root), "CLAUDE.md");
  try {
    const descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      if (!fs.fstatSync(descriptor).isFile())
        throw new Error("Invalid instructions file.");
      return fs.readFileSync(descriptor, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function writeFolderInstructions(root: string, content: string): void {
  const file = path.join(fs.realpathSync(root), "CLAUDE.md");
  const descriptor = fs.openSync(
    file,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK,
    0o600,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(file);
    if (
      !opened.isFile() ||
      current.isSymbolicLink() ||
      opened.ino !== current.ino ||
      opened.dev !== current.dev
    )
      throw new Error("Instructions file changed during save.");
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, content, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}
