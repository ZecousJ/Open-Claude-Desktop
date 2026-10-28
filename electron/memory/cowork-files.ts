import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface AccountMemoryFile {
  path: string;
  content?: string;
  updatedAt: string;
}

// Account memory is separate from the global instructions. MEMORY.md is an
// index, not an editable account file; only existing regular Markdown files
// edit.
export class CoworkMemoryFiles {
  readonly directory: string;
  private readonly parents: string[];

  constructor(root: string, projectId?: string) {
    if (projectId && (!/^[\w-]+$/.test(projectId) || projectId.length > 200))
      throw new Error("Invalid memory request.");
    this.directory = projectId
      ? path.join(root, "cowork-memory-spaces", projectId, "memory")
      : path.join(root, "cowork-memory");
    this.parents = projectId
      ? [
          path.join(root, "cowork-memory-spaces"),
          path.join(root, "cowork-memory-spaces", projectId),
        ]
      : [];
  }

  private safeParents(create = false) {
    for (const parent of this.parents) {
      if (!fs.existsSync(parent)) {
        if (!create) return false;
        fs.mkdirSync(parent, { mode: 0o700 });
      }
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
    return true;
  }

  private file(name: string) {
    const safe = path.basename(name);
    return safe.endsWith(".md") && safe.toLowerCase() !== "memory.md"
      ? path.join(this.directory, safe)
      : undefined;
  }

  list(includeContent = true): AccountMemoryFile[] {
    if (!this.safeParents()) return [];
    if (!fs.existsSync(this.directory)) return [];
    if (!fs.lstatSync(this.directory).isDirectory()) return [];
    return fs
      .readdirSync(this.directory)
      .flatMap((name) => {
        const memory = this.read(name);
        if (!memory) return [];
        if (!includeContent) delete memory.content;
        return [memory];
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  read(name: string): AccountMemoryFile | null {
    const file = this.file(name);
    if (!file) return null;
    try {
      if (!this.safeParents()) return null;
      const directory = fs.lstatSync(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 262144) return null;
        return {
          path: path.basename(file),
          content: fs.readFileSync(fd, "utf8"),
          updatedAt: stat.mtime.toISOString(),
        };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  write(name: string, content: string): boolean {
    const file = this.file(name);
    if (!file || !this.read(name) || Buffer.byteLength(content) > 262144)
      return false;
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, file);
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  save(name: string, content: string): boolean {
    if (this.read(name)) return this.write(name, content);
    const file = this.file(name);
    if (!file || Buffer.byteLength(content) > 262144) return false;
    try {
      if (!this.safeParents(true)) return false;
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const directory = fs.lstatSync(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
      fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  delete(name: string): boolean {
    const file = this.file(name);
    if (!file || !this.read(name)) return false;
    fs.unlinkSync(file);
    return true;
  }

  reset(): boolean {
    if (!this.safeParents(true)) return false;
    if (fs.existsSync(this.directory)) {
      if (!fs.lstatSync(this.directory).isDirectory()) return false;
      fs.rmSync(this.directory, { recursive: true, force: true });
    }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    return true;
  }

  instructions(): string {
    if (!this.safeParents()) return "";
    let remaining = 262144;
    const memories: string[] = [];
    for (const name of fs.existsSync(this.directory) &&
    fs.lstatSync(this.directory).isDirectory()
      ? fs.readdirSync(this.directory)
      : []) {
      if (remaining <= 0) break;
      const file = this.read(name);
      if (!file) continue;
      const content = file.content?.slice(0, remaining) ?? "";
      remaining -= content.length;
      memories.push(
        `<account_memory path="${file.path.replace(/[<>&"\n\r]/g, "_")}">\n${content.replace(/</g, "&lt;")}\n</account_memory>`,
      );
    }
    return memories.join("\n");
  }
}
