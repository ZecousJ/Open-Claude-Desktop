import fs from "node:fs";
import path from "node:path";
import type { Project } from "../../shared/types";
import type { ProjectContextInput } from "../../shared/project-access";
import { ProjectKnowledgeStore } from "./project-knowledge";

const refused = () =>
  new Error("Failed to prepare project context. You can try again.");
const exists = () => new Error("Project context already exists.");
const receiptFile = "creation-receipt.json";
export interface PreparedProjectContext {
  commit(resumable?: boolean): void;
  rollback(): void;
}

export function hasPreparedProjectContext(root: string, id: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) &&
    !!stat(path.join(root, "projects", id, receiptFile))?.isFile();
}
function stat(file: string) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
const same = (first: fs.Stats | undefined, second: fs.Stats | undefined) =>
  !!first && !!second && first.ino === second.ino && first.dev === second.dev;
function directory(file: string) {
  const value = fs.lstatSync(file);
  if (!value.isDirectory() || value.isSymbolicLink()) throw refused();
  return value;
}
function tree(folder: string): { relative: string; stat: fs.Stats }[] {
  const entries: { relative: string; stat: fs.Stats }[] = [];
  const visit = (relative: string) => {
    const full = path.join(folder, relative);
    const value = fs.lstatSync(full);
    if (value.isSymbolicLink() || (!value.isDirectory() && !value.isFile()))
      throw refused();
    entries.push({ relative, stat: value });
    if (value.isDirectory())
      for (const name of fs.readdirSync(full)) visit(path.join(relative, name));
  };
  visit("");
  return entries;
}

/** Stage and validate all initial context before any project metadata is
 * published. The account's existing ProjectKnowledgeStore owns type, UTF-8,
 * PDF-header, file-size, count and total-byte validation. */
export async function prepareProjectContext(
  root: string,
  project: Project,
  input: ProjectContextInput,
): Promise<PreparedProjectContext> {
  directory(root);
  const accountRoot = fs.realpathSync(root);
  const accountIdentity = directory(accountRoot);
  if (
    !project ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(project.id) ||
    !input ||
    !Array.isArray(input.files) ||
    (input.text !== undefined && typeof input.text !== "string")
  )
    throw refused();
  const files = input.files.map((file) => {
    if (
      !file ||
      typeof file.name !== "string" ||
      !(file.data instanceof Uint8Array)
    )
      throw refused();
    return { name: file.name, data: Buffer.from(file.data) };
  });
  if (input.text?.trim())
    files.push({
      name: "project-context.txt",
      data: Buffer.from(input.text, "utf8"),
    });
  const stageRoot = fs.mkdtempSync(
    path.join(
      path.dirname(accountRoot),
      `.${path.basename(accountRoot)}-project-context-`,
    ),
  );
  const stageIdentity = directory(stageRoot);
  const stageProject = path.join(stageRoot, "projects", project.id);
  try {
    const store = new ProjectKnowledgeStore(stageRoot, () => [project]);
    await store.add(project.id, files);
    tree(stageProject);
  } catch (error) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
  const projectsRoot = path.join(accountRoot, "projects");
  const target = path.join(projectsRoot, project.id);
  let targetIdentity: fs.Stats | undefined;
  let projectsIdentity: fs.Stats | undefined;
  let owned: { relative: string; stat: fs.Stats }[] = [];
  let state: "prepared" | "committed" | "rolled-back" = "prepared";
  const receipt = project.creationReceipt;
  const cleanStage = () => {
    if (same(stat(stageRoot), stageIdentity))
      fs.rmSync(stageRoot, { recursive: true, force: true });
  };
  const cleanPublished = () => {
    // Never follow a replaced parent or target, nor remove unrelated files
    // added to the directory after preparation/publication.
    if (
      !same(stat(accountRoot), accountIdentity) ||
      !same(stat(projectsRoot), projectsIdentity) ||
      !same(stat(target), targetIdentity)
    )
      return;
    const expected = new Map(
      owned.map((entry) => [entry.relative, entry.stat]),
    );
    const safeParents = (relative: string) => {
      const parts = relative.split(path.sep);
      parts.pop();
      for (let length = 1; length <= parts.length; length++) {
        const parent = parts.slice(0, length).join(path.sep);
        const actual = stat(path.join(target, parent));
        if (
          !actual?.isDirectory() ||
          actual.isSymbolicLink() ||
          !same(actual, expected.get(parent))
        )
          return false;
      }
      return true;
    };
    for (const entry of [...owned].reverse()) {
      if (!safeParents(entry.relative)) continue;
      const full = path.join(target, entry.relative);
      const current = stat(full);
      if (!same(current, entry.stat) || current?.isSymbolicLink()) continue;
      if (current?.isDirectory()) {
        try {
          fs.rmdirSync(full);
        } catch (error) {
          if (
            !["ENOTEMPTY", "ENOENT"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw error;
        }
      } else if (
        current?.isFile() &&
        current.size === entry.stat.size &&
        current.mtimeMs === entry.stat.mtimeMs
      )
        fs.unlinkSync(full);
    }
    if (same(stat(target), targetIdentity)) {
      try {
        fs.rmdirSync(target);
      } catch (error) {
        if (
          !["ENOTEMPTY", "ENOENT"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
    }
  };
  return {
    commit(resumable = false) {
      if (state === "committed") return;
      if (state !== "prepared") throw refused();
      try {
        if (!same(directory(accountRoot), accountIdentity)) throw refused();
        if (!stat(projectsRoot)) fs.mkdirSync(projectsRoot, { mode: 0o700 });
        projectsIdentity = directory(projectsRoot);
        if (!same(directory(stageRoot), stageIdentity)) throw refused();
        if (stat(target)) {
          const marker = path.join(target, receiptFile);
          if (!resumable || !receipt || !stat(target)?.isDirectory() || !stat(marker)?.isFile() ||
              fs.readFileSync(marker, "utf8") !== JSON.stringify(receipt) ||
              !stat(path.join(target, "knowledge"))?.isDirectory()) throw exists();
          owned = tree(target).filter(entry => !!entry.relative);
          targetIdentity = directory(target);
          state = "committed";
          cleanStage();
          return;
        }
        const stagedEntries = tree(stageProject);
        // mkdir is an exclusive reservation. rename alone may replace an
        // existing empty directory on POSIX and is not a no-replace primitive.
        try {
          fs.mkdirSync(target, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw exists();
          throw error;
        }
        targetIdentity = directory(target);
        for (const metadata of ["knowledge-sources.json", "knowledge-names.json"]) {
          const from = path.join(stageProject, metadata);
          if (!stat(from)) continue;
          const to = path.join(target, metadata);
          fs.renameSync(from, to);
          owned.push({ relative: metadata, stat: fs.lstatSync(to) });
        }
        if (stat(path.join(target, "knowledge"))) throw exists();
        fs.renameSync(
          path.join(stageProject, "knowledge"),
          path.join(target, "knowledge"),
        );
        owned = stagedEntries.filter((entry) => !!entry.relative);
        if (resumable && receipt) {
          const marker = path.join(target, receiptFile);
          fs.writeFileSync(marker, JSON.stringify(receipt), { mode: 0o600 });
          owned.push({ relative: receiptFile, stat: fs.lstatSync(marker) });
        }
        state = "committed";
        cleanStage();
      } catch (error) {
        try {
          cleanPublished();
        } finally {
          cleanStage();
          state = "rolled-back";
        }
        throw error;
      }
    },
    rollback() {
      if (state === "rolled-back") return;
      try {
        cleanPublished();
      } finally {
        cleanStage();
        state = "rolled-back";
      }
    },
  };
}
