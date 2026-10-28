import type { Conversation, Project } from "../../shared/types";
import { folderName, recentWorkFolders } from "./recentFolders";
import { coworkPlaceUsage } from "./cowork-options-model";
import type { ProjectPickerSort } from "./project-picker-preferences";

export const nativeLocalHistory = (rows: readonly Conversation[]) =>
  rows.filter(
    (c) =>
      !c.incognito &&
      !c.archived &&
      !c.linkedToComputer &&
      (!c.environment || c.environment.kind === "local"),
  );
export function nativeAbsoluteFolder(path: string | undefined): path is string {
  return Boolean(path && (/^\//.test(path) || /^[a-z]:[\\/]/i.test(path)));
}
/** Current project metadata is its own source; a fresh project need not have a chat yet. */
export function liveNativeProjectFolder(
  project: Project | undefined,
): project is Project & { cwd: string } {
  return Boolean(
    project &&
    !project.archivedAt &&
    nativeAbsoluteFolder(project.cwd) &&
    (!project.environment || project.environment.kind === "local"),
  );
}
export function knownLocalFolder(
  path: string | undefined,
  rows: readonly Conversation[],
) {
  return Boolean(
    nativeAbsoluteFolder(path) &&
    recentWorkFolders(nativeLocalHistory(rows), Infinity, true).includes(path),
  );
}
export interface NativePlaceRow {
  key: string;
  kind: "project" | "folder";
  name: string;
  path?: string;
  project?: Project;
  pinned: boolean;
  selected: boolean;
  isDefault: boolean;
  section?: "Default" | "Pinned";
  recent: number;
  created: number;
}
export function nativePlaceRows({
  projects,
  conversations,
  project,
  cwd,
  query,
  sort,
  defaultId,
  defaultFolder,
  showFolders,
}: {
  projects: Project[];
  conversations: Conversation[];
  project?: Project;
  cwd?: string;
  query: string;
  sort: ProjectPickerSort;
  defaultId?: string;
  defaultFolder?: string;
  showFolders: boolean;
}) {
  const history = nativeLocalHistory(conversations);
  const usage = coworkPlaceUsage(history, true);
  const liveProjects = projects.filter(
    (p) => !p.archivedAt && (!p.cwd || liveNativeProjectFolder(p)),
  );
  const needle = query.trim().toLocaleLowerCase();
  const matches = (...values: (string | undefined)[]) =>
    !needle ||
    values.some((value) => value?.toLocaleLowerCase().includes(needle));
  const rows: NativePlaceRow[] = liveProjects
    .filter((p) => matches(p.name, p.cwd))
    .map((p) => ({
      kind: "project",
      key: `project:${p.id}`,
      name: p.name,
      path: p.cwd,
      project: p,
      pinned: Boolean(p.pinned),
      selected: project?.id === p.id,
      isDefault: p.id === defaultId,
      recent: usage.get(p.id) ?? p.createdAt,
      created: p.createdAt,
    }));
  const folders = recentWorkFolders(history, 8, true);
  if (cwd && !folders.includes(cwd)) folders.unshift(cwd);
  if (
    knownLocalFolder(defaultFolder, history) &&
    !folders.includes(defaultFolder!)
  )
    folders.unshift(defaultFolder!);
  for (const path of folders) {
    if (
      liveProjects.some((p) => p.cwd === path) ||
      !matches(folderName(path), path) ||
      (!showFolders && path !== cwd)
    )
      continue;
    rows.push({
      kind: "folder",
      key: `folder:${path}`,
      name: folderName(path),
      path,
      pinned: false,
      selected: cwd === path && (!project || project.cwd !== path),
      isDefault: path === defaultFolder,
      recent: usage.get(path) ?? 0,
      created: usage.get(path) ?? 0,
    });
  }
  rows.sort(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      Number(b.pinned) - Number(a.pinned) ||
      (sort === "name"
        ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        : sort === "created"
          ? b.created - a.created
          : b.recent - a.recent),
  );
  return rows.map((row) => ({
    ...row,
    section: row.isDefault
      ? ("Default" as const)
      : row.pinned
        ? ("Pinned" as const)
        : undefined,
  }));
}
