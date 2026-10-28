import type { SearchFilter, SearchSources } from "./search-model";
import { t } from "../../i18n";

export type PaletteFilterKey =
  "owner" | "date" | "repo" | "project" | "type" | "archived" | "actions";
export type PaletteFilters = Partial<
  Record<PaletteFilterKey, { value: string; label: string }>
>;
export const paletteFilterLabels: Record<PaletteFilterKey, string> = {
  owner: "Owner",
  date: "Date",
  repo: "Repo",
  project: "Project",
  type: "Type",
  archived: "Archived",
  actions: "Actions",
};

/**
 * Empty-input Backspace removes the last logical filter in the live order;
 * date is the active time-window field.
 */
export function removeLastPaletteFilter(
  filters: PaletteFilters,
): PaletteFilters {
  const key = (
    ["actions", "archived", "project", "repo", "date", "owner", "type"] as const
  ).find((key) => filters[key] !== undefined);
  if (!key) return filters;
  const next = { ...filters };
  delete next[key];
  return next;
}
export interface PaletteFilterOption {
  key: PaletteFilterKey;
  value: string;
  label: string;
}

const fieldHints: Record<PaletteFilterKey, readonly string[]> = {
  owner: ["from", "shared", "owner"],
  date: ["when", "recently", "today", "week", "month", "date"],
  repo: ["repo", "repository"],
  project: ["project"],
  type: ["type", "kind"],
  archived: ["archived"],
  actions: ["actions"],
};
const typeHints: Record<string, readonly string[]> = {
  chats: ["chat", "chats", "session", "sessions"],
  sessions: ["code"],
  projects: ["project", "projects"],
  routines: ["scheduled", "schedule", "routine", "routines"],
  artifacts: ["artifact", "artifacts"],
};

export function filterPicker(
  query: string,
): { key?: PaletteFilterKey; query: string } | undefined {
  if (query.startsWith("/")) return { query: query.slice(1).trim() };
  // The live parser aliases active/when to the displayed date: token, from to
  // owner, and repository to repo.
  const match =
    /^(owner|from|date|when|active|repo|repository|project|type|archived|is|actions):\s*(.*)$/i.exec(
      query,
    );
  if (!match || (match[1].toLowerCase() === "is" && !match[2])) return;
  const aliases: Record<string, PaletteFilterKey> = {
    owner: "owner",
    from: "owner",
    date: "date",
    when: "date",
    active: "date",
    repo: "repo",
    repository: "repo",
    project: "project",
    type: "type",
    archived: "archived",
    is: "archived",
    actions: "actions",
  };
  return { key: aliases[match[1].toLowerCase()], query: match[2] };
}

export function paletteFilterOptions(
  picker: NonNullable<ReturnType<typeof filterPicker>>,
  sources: SearchSources,
): PaletteFilterOption[] {
  const { key } = picker;
  const options: PaletteFilterOption[] = !key
    ? Object.entries(paletteFilterLabels).map(([key, label]) => ({
        key: key as PaletteFilterKey,
        value: "",
        label,
      }))
    : key === "owner"
      ? [
          { key, value: "mine", label: "Yours" },
          { key, value: "shared", label: "Shared with you" },
        ]
      : key === "date"
        ? [
            { key, value: "today", label: "Today" },
            { key, value: "week", label: "Past week" },
            { key, value: "month", label: "Past month" },
          ]
        : key === "project"
          ? sources.projects.map((project) => ({
              key,
              value: project.id,
              label: project.name,
            }))
          : key === "repo"
            ? [
                ...new Set(
                  sources.conversations.flatMap((c) =>
                    c.repository?.fullName ? [c.repository.fullName] : [],
                  ),
                ),
              ].map((name) => ({ key, value: name, label: name }))
            : key === "type"
              ? [
                  { key, value: "artifacts", label: "Artifacts" },
                  { key, value: "chats", label: "Sessions" },
                  { key, value: "sessions", label: "Code" },
                  { key, value: "projects", label: "Projects" },
                  { key, value: "routines", label: "Scheduled" },
                ]
              : [{ key, value: "true", label: paletteFilterLabels[key] }];
  const typed = picker.query.toLocaleLowerCase();
  return options.filter((option) => {
    // Published command aliases remain usable when a displayed label differs.
    const hints = !key
      ? fieldHints[option.key]
      : key === "owner"
        ? option.value === "mine"
          ? ["me", "mine", "yours"]
          : ["shared"]
        : key === "type"
          ? typeHints[option.value]
          : [];
    const label =
      key === "repo" || key === "project" ? option.label : t(option.label);
    return [label, option.label, ...(hints ?? [])].some((value) =>
      value.toLocaleLowerCase().includes(typed),
    );
  });
}

export function filterSearchSources(
  sources: SearchSources,
  filters: PaletteFilters,
  now = Date.now(),
): SearchSources {
  const date = filters.date?.value;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const after =
    date === "today"
      ? Math.min(today.getTime(), now - 3_600_000)
      : date === "week"
        ? now - 7 * 86400000
        : date === "month"
          ? now - 30 * 86400000
          : -Infinity;
  const shared = filters.owner?.value === "shared";
  const ownerMatches = (recordShared: boolean) =>
    !filters.owner || recordShared === shared;
  const project = filters.project?.value;
  const repo = filters.repo?.value;
  const archived = filters.archived?.value === "true";
  return {
    conversations: sources.conversations.filter(
      (c) =>
        !c.incognito &&
        ownerMatches(
          Boolean(
            c.sessionAuthors &&
            c.sessionAuthors.ownerAccountUuid !==
              c.sessionAuthors.viewerAccountUuid,
          ),
        ) &&
        c.archived === archived &&
        c.updatedAt >= after &&
        (!project || c.projectId === project) &&
        (!repo || c.repository?.fullName.toLowerCase() === repo.toLowerCase()),
    ),
    projects: sources.projects.filter(
      (p) =>
        !shared &&
        !repo &&
        Boolean(p.archivedAt) === archived &&
        p.createdAt >= after &&
        (!project || p.id === project),
    ),
    artifacts: sources.artifacts.filter(
      (a) =>
        !archived &&
        !repo &&
        ownerMatches(Boolean(a.sharedWithYou)) &&
        (a.updatedAt ?? 0) >= after &&
        (!project || a.projectId === project),
    ),
    routines: sources.routines.filter(
      (r) =>
        !shared &&
        !archived &&
        !repo &&
        (r.lastRunAt ?? r.createdAt) >= after &&
        (!project || r.projectId === project),
    ),
  };
}

export function paletteType(
  filters: PaletteFilters,
  fallback: SearchFilter,
): SearchFilter {
  return (filters.type?.value as SearchFilter | undefined) ?? fallback;
}
