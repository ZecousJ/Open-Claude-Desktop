import { AppIcon } from "../ui/app-icon";
import type { Conversation, Project } from "../../shared/types";
import type { MenuEntry } from "../ui/Menu";

/** What the project rows do. */
export type ProjectEntryHandlers = {
  moveToProject: (projectId: string | null) => void;
  /** Opens the new project dialog (with the typed name) for this conversation. */
  newProject?: (name: string) => void;
};

/**
 * Add to project / Change project (Projects), then Remove from project On its
 * own row when the conversation is in one. The list is searchable and always
 * offered: "New project" heads it, typing ends it with "Create project {name}",
 * and with no projects it says "No projects yet". Creating opens the new
 * project dialog with the name and moves the conversation there.
 */
export function projectEntries(
  c: Conversation,
  projects: Project[],
  on: ProjectEntryHandlers,
): MenuEntry[] {
  const create = on.newProject;
  return [
    {
      label: c.projectId ? "Change project" : "Add to project",
      icon: <AppIcon name="Projects" size={20} />,
      searchable: create ? "Search or create a project" : "Search projects",
      ...(create
        ? {
            searchCreate: {
              idle: "New project",
              typed: "Create project {name}",
              empty: "No projects yet",
              onSelect: create,
            },
          }
        : {}),
      submenu: projects.map((project) => ({
        label: project.name,
        noTranslate: true,
        checked: project.id === c.projectId,
        onSelect: () => {
          if (project.id !== c.projectId) on.moveToProject(project.id);
        },
      })),
    },
    ...(c.projectId
      ? [
          {
            label: "Remove from project",
            icon: <AppIcon name="ProjectsX" size={20} />,
            onSelect: () => on.moveToProject(null),
          },
        ]
      : []),
  ];
}
