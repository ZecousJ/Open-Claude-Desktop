import fs from "node:fs";
import path from "node:path";
import type { Project } from "../../shared/types";
import { importableChatProjects } from "../../shared/project-import";
import { ProjectKnowledgeStore } from "./project-knowledge";

const creationFailure = "Failed to create project. You can try again.";

/** Snapshot Chat context, not chats. */
export function importChatProjects(
  root: string,
  projects: Project[],
  projectIds: string[],
  location: string,
  name: string,
) {
  const available = importableChatProjects(projects);
  if (!projectIds.length || new Set(projectIds).size !== projectIds.length)
    throw new Error(creationFailure);
  const sources = projectIds.map((id) => {
    const project = available.find((value) => value.id === id);
    if (!project) throw new Error(creationFailure);
    return project;
  });
  const instructions = sources
    .filter((project) => project.instructions.trim())
    .map((project) =>
      sources.length === 1
        ? project.instructions.trim()
        : `# ${project.name}\n\n${project.instructions.trim()}`,
    )
    .join("\n\n");
  if (instructions.length > 100000) throw new Error(creationFailure);
  const knowledge = new ProjectKnowledgeStore(root, () => projects);
  const folder = createProjectFolder(location, name);
  try {
    for (const project of sources) {
      const source = knowledge.folder(project.id);
      const files = knowledge.list(project.id).files;
      if (!files.length) continue;
      const real = fs.realpathSync(source);
      if (
        real !==
        path.join(fs.realpathSync(root), "projects", project.id, "knowledge")
      )
        throw new Error(creationFailure);
      const target =
        sources.length === 1 ? folder : path.join(folder, project.id);
      if (target !== folder) fs.mkdirSync(target);
      for (const file of files) {
        const descriptor = fs.openSync(
          path.join(source, file.name),
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        try {
          if (!fs.fstatSync(descriptor).isFile())
            throw new Error(creationFailure);
          fs.writeFileSync(
            path.join(target, file.name),
            fs.readFileSync(descriptor),
            {
              flag: "wx",
            },
          );
        } finally {
          fs.closeSync(descriptor);
        }
      }
    }
    return { cwd: folder, instructions };
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

/** New folder per project. */
export function createProjectFolder(location: string, name: string) {
  if (!name.trim() || /[/\\\x00]/.test(name) || name === "." || name === "..")
    throw new Error("Failed to create project. You can try again.");
  const folder = path.join(location, name);
  fs.mkdirSync(folder);
  return folder;
}

export function copyProjectCreationFiles(
  folder: string,
  files: { name: string; data: Uint8Array }[],
) {
  for (const file of files) {
    if (
      !file.name ||
      /[/\\\x00]/.test(file.name) ||
      file.name === "." ||
      file.name === ".."
    )
      throw new Error("Failed to create project. You can try again.");
  }
  const copied: string[] = [];
  try {
    for (const file of files) {
      const target = path.join(folder, file.name);
      fs.writeFileSync(target, file.data, { flag: "wx" });
      copied.push(target);
    }
  } catch (error) {
    for (const target of copied) fs.unlinkSync(target);
    throw error;
  }
}
