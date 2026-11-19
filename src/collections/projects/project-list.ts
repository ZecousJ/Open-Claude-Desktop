import { currentLocale } from "../../i18n";
import { fullTime, relativeTime } from "../../ui/RelativeTime";
import type { Conversation, Project } from "../../../shared/types";
import { projectKind } from "../../../shared/project-kind";

// Type sections and persisted grouping (live claude.ai bundle, 2026-10-14, c17beaa76-CrQT9ilA.js).
export function projectGroups(projects: Project[], grouped: boolean) {
  if (!grouped) return [{ label: "Projects", projects }];
  return [
    {
      label: "Projects",
      projects: projects.filter((project) => projectKind(project) === "chat"),
    },
    {
      label: "Code projects",
      projects: projects.filter((project) => projectKind(project) === "code"),
    },
    {
      label: "Local projects",
      projects: projects.filter((project) => projectKind(project) === "local"),
    },
  ].filter((group) => group.projects.length);
}

export function storedProjectGrouping() {
  try {
    return localStorage.getItem("claudex.projects.group-by-type") === "true";
  } catch {
    return false;
  }
}

export function storeProjectGrouping(grouped: boolean) {
  try {
    localStorage.setItem("claudex.projects.group-by-type", String(grouped));
  } catch {}
}

export type ProjectSort = "updated" | "created" | "name";

export const projectSortLabels: Record<ProjectSort, string> = {
  updated: "Last updated",
  created: "Date created",
  name: "Alphabetical",
};

/** When a project last changed: its newest chat, or when it was made. */
export function projectUpdatedAt(
  project: Project,
  conversations: Conversation[],
) {
  return conversations.reduce(
    (latest, c) =>
      c.projectId === project.id ? Math.max(latest, c.updatedAt) : latest,
    project.createdAt,
  );
}

const sortKey = "claudex.projects.sort";

/** The sort the person chose last (desktop bundle 2.31226.1 keeps it: "recent" by default). */
export function storedProjectSort(): ProjectSort {
  try {
    const value = localStorage.getItem(sortKey);
    return value === "created" || value === "name" ? value : "updated";
  } catch {
    return "updated";
  }
}

export function storeProjectSort(sort: ProjectSort) {
  try {
    localStorage.setItem(sortKey, sort);
  } catch {
    // The choice lasts until the page is left.
  }
}

/** A folder path's last part, as a card shows it (the path is its tooltip). */
export const folderName = (folder: string) =>
  folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

/**
 * The date on a project's card: when it was made when the list is sorted by
 * creation, else when it last changed (desktop bundle 2.31226.1).
 */
export function projectCardTime(
  project: Project,
  conversations: Conversation[],
  sort: ProjectSort,
) {
  return sort === "created"
    ? project.createdAt
    : projectUpdatedAt(project, conversations);
}

/** The list's tabs: Your projects, and Archived once something is archived. */
export type ProjectView = "mine" | "archived";

/**
 * The Projects grid after search (name, description and folder) and sort
 * (R-1290), for one tab; pinned projects come first whatever the sort (live
 * claude.ai bundle, 2026-10-14, c17beaa76: the starred set's comparator).
 */
export function visibleProjects(
  projects: Project[],
  conversations: Conversation[],
  query: string,
  sort: ProjectSort,
  view: ProjectView = "mine",
): Project[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const updated = new Map(
    projects.map((p) => [p.id, projectUpdatedAt(p, conversations)]),
  );
  const byName = (a: Project, b: Project) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return projects
    .filter((p) => {
      if (Boolean(p.archivedAt) !== (view === "archived")) return false;
      const text = `${p.name} ${p.description} ${p.cwd ?? ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .sort(
      (a, b) =>
        Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        (sort === "name"
          ? byName(a, b)
          : sort === "created"
            ? b.createdAt - a.createdAt || byName(a, b)
            : updated.get(b.id)! - updated.get(a.id)! || byName(a, b)),
    );
}

/** A project's chats, newest first, archived ones last. */
export function projectChats(project: Project, conversations: Conversation[]) {
  return conversations
    .filter((c) => c.projectId === project.id && !c.incognito)
    .sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) || b.updatedAt - a.updatedAt,
    );
}

/**
 * A card's date as the original's relative time writes it (live claude.ai
 * bundle, 2026-10-14, shared-2 `oN`: relative for a week, then a short date),
 * with the full date and time as its tooltip.
 */
export const projectDate = (timestamp: number, now = Date.now()) =>
  relativeTime(timestamp, now);
export const projectDateTooltip = (timestamp: number) => fullTime(timestamp);

/**
 * Whether a project's settings differ, including appearance and defaults
 * (live claude.ai bundle, 2026-10-14, c57eefbba-Z8dldrXK.js).
 */
export function projectChanged(initial: Project, draft: Project) {
  return (
    initial.name !== draft.name ||
    initial.description !== draft.description ||
    initial.instructions !== draft.instructions ||
    initial.icon !== draft.icon ||
    initial.color !== draft.color ||
    initial.defaultModel !== draft.defaultModel ||
    initial.defaultProviderId !== draft.defaultProviderId ||
    initial.defaultEffort !== draft.defaultEffort ||
    (initial.cwd ?? "") !== (draft.cwd ?? "")
  );
}
