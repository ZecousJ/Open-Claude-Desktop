/** The Cowork home options row's logic (src/composer/CoworkOptions.tsx). */
import type { Conversation, Project, Settings } from "../../shared/types";
import { folderName } from "./recentFolders";

export type CoworkPermission = "manual" | "auto";
/**
 * Cowork's permission modes, over Settings → Cowork → Permissions: Manual
 * runs read-only, so every change asks first; Auto may change files in the
 * folder and asks for anything beyond it. The original's "Skip all
 * approvals" needs turns that never ask, which Claudex's Cowork does not run,
 * so it is not offered.
 */
export const coworkPermissions: {
  id: CoworkPermission;
  sandbox: Settings["sandbox"];
  title: string;
  description: string;
}[] = [
  {
    id: "manual",
    sandbox: "read-only",
    title: "Manual",
    description: "Always ask before making changes",
  },
  {
    id: "auto",
    sandbox: "workspace-write",
    title: "Auto",
    description: "Change files in the folder without asking",
  },
];

/** The permission chip's mode. */
export function coworkPermission(
  sandbox: Settings["sandbox"],
  platform: NodeJS.Platform,
): CoworkPermission {
  return sandbox === "read-only" ? "manual" : "auto";
}

/** Projects and folders matching the menu's search, by name or path. */
export function coworkPlaces(
  projects: Project[],
  folders: string[],
  query: string,
) {
  const needle = query.trim().toLowerCase();
  const matches = (...texts: (string | undefined)[]) =>
    !needle || texts.some((text) => text?.toLowerCase().includes(needle));
  return {
    projects: projects.filter((p) => matches(p.name, p.cwd)),
    folders: folders.filter((path) => matches(folderName(path), path)),
  };
}

/** When each project (by id) and working folder (by path) was last used by a conversation. */
export function coworkPlaceUsage(
  conversations: Pick<
    Conversation,
    "projectId" | "cwd" | "mode" | "updatedAt" | "incognito"
  >[],
  includeChat = false,
) {
  const usedAt = new Map<string, number>();
  const touch = (key: string, at: number) =>
    usedAt.set(key, Math.max(usedAt.get(key) ?? 0, at));
  for (const c of conversations) {
    if (c.incognito) continue;
    if (c.projectId) touch(c.projectId, c.updatedAt);
    if (
      c.cwd &&
      (c.mode === "code" ||
        c.mode === "cowork" ||
        (includeChat && c.mode === "chat"))
    )
      touch(c.cwd, c.updatedAt);
  }
  return usedAt;
}

/** One row of the project or folder menu. */
export type CoworkPlaceRow =
  | { kind: "project"; project: Project; at: number }
  | { kind: "folder"; path: string; at: number };

/**
 * The menu's rows once projects and folders are mixed by when they were last
 * used, newest first; a project goes before a folder used at the same time.
 */
export function coworkPlaceRows(
  projects: Project[],
  folders: string[],
  query: string,
  /** When each project or folder was last used, by project id or folder path. */
  usedAt: ReadonlyMap<string, number>,
): CoworkPlaceRow[] {
  const found = coworkPlaces(projects, folders, query);
  const rows: CoworkPlaceRow[] = [
    ...found.projects.map((project) => ({
      kind: "project" as const,
      project,
      at: usedAt.get(project.id) ?? project.createdAt,
    })),
    ...found.folders.map((path) => ({
      kind: "folder" as const,
      path,
      at: usedAt.get(path) ?? 0,
    })),
  ];
  // Array#sort is stable, so equal times keep projects ahead of folders.
  return rows.sort((a, b) => b.at - a.at);
}
