import type { Project } from "./types";
import { projectKind } from "./project-kind";

/**
 * A project's folders. Claudex keeps the first folder in `Project.cwd`, where
 * Code and Cowork start, and the rest in `Project.additionalFolders`.
 */
export const projectFolderLimit = 16;

/** Every folder of the project, the working folder first; empty without one. */
export function projectFolders(
  project: Pick<Project, "cwd" | "additionalFolders">,
): string[] {
  if (!project.cwd) return [];
  const folders = [project.cwd];
  for (const folder of project.additionalFolders ?? [])
    if (folder && !folders.includes(folder)) folders.push(folder);
  return folders.slice(0, projectFolderLimit);
}

/**
 * The project with these folders: the first becomes the working folder,
 * the rest its additional folders (duplicates and blanks left out, at most
 * 16). No folders clears both.
 */
export function withProjectFolders<T extends Project>(
  project: T,
  folders: readonly string[],
): T {
  const unique: string[] = [];
  for (const folder of folders)
    if (folder && !unique.includes(folder)) unique.push(folder);
  const kept = unique.slice(0, projectFolderLimit);
  const { cwd: _cwd, additionalFolders: _more, ...rest } = project;
  return {
    ...rest,
    kind:
      projectKind(project) === "chat" && kept.length
        ? "local"
        : projectKind(project),
    ...(kept[0] ? { cwd: kept[0] } : {}),
    ...(kept.length > 1 ? { additionalFolders: kept.slice(1) } : {}),
  } as T;
}

/** The project's folders with `folder` added at the end (no change when it is there or full). */
export function addProjectFolder<T extends Project>(
  project: T,
  folder: string,
): T {
  const folders = projectFolders(project);
  if (folders.includes(folder) || folders.length >= projectFolderLimit)
    return project;
  return withProjectFolders(project, [...folders, folder]);
}

/** The project without `folder`; removing the working folder moves the next one up. */
export function removeProjectFolder<T extends Project>(
  project: T,
  folder: string,
): T {
  return withProjectFolders(
    project,
    projectFolders(project).filter((value) => value !== folder),
  );
}

/** The project's only folder replaced (Edit, live's "Choose a different folder"). */
export function replaceProjectFolder<T extends Project>(
  project: T,
  folder: string,
): T {
  const folders = projectFolders(project);
  if (folders.length > 1) return project;
  return withProjectFolders(project, [folder]);
}
