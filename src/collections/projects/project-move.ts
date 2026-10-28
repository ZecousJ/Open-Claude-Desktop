import type { Conversation, Project } from "../../../shared/types";
import type { AppController } from "../../app/AppContext";
import { api } from "../../desktop-api";
import { formatText } from "../../i18n";
import { showToast } from "../../ui/toast-store";
import { runEach } from "../history/bulk-actions";

export function projectMoveMessage(
  rows: readonly Conversation[],
  count: number,
  projectName: string,
) {
  return formatText(
    rows.length === 1
      ? "Moved to {projectName}"
      : rows.every((row) => row.mode === "code")
        ? count === 1
          ? "{count} session moved to {projectName}"
          : "{count} sessions moved to {projectName}"
        : count === 1
          ? "{count} chat moved to {projectName}"
          : "{count} chats moved to {projectName}",
    { count, projectName },
  );
}

/** Partial successes are kept. */
export async function moveProjectChats(
  app: Pick<
    AppController,
    "upsert" | "report" | "activeId" | "setProjectId" | "setCwd"
  >,
  rows: readonly Conversation[],
  project: Project,
  update = api.updateConversation,
  notify = showToast,
) {
  const { failed } = await runEach(
    rows.map((row) => row.id),
    async (id) => {
      app.upsert(await update(id, { projectId: project.id }));
      if (id === app.activeId) {
        app.setProjectId(project.id);
        if (project.cwd) app.setCwd(project.cwd);
      }
    },
  );
  const moved = rows.length - failed.length;
  if (moved) notify(projectMoveMessage(rows, moved, project.name));
  if (failed.length) {
    const sessions = rows.every((row) => row.mode === "code");
    app.report(
      new Error(
        formatText(
          sessions
            ? failed.length === 1
              ? "Couldn’t move {count} session. You can try again."
              : "Couldn’t move {count} sessions. You can try again."
            : failed.length === 1
              ? "Couldn’t move {count} chat. You can try again."
              : "Couldn’t move {count} chats. You can try again.",
          { count: failed.length },
        ),
      ),
    );
  }
  return failed;
}

export async function createMoveProject(
  app: Pick<AppController, "setSnapshot">,
  name: string,
  save = api.saveProject,
) {
  const project = await save({
    id: crypto.randomUUID(),
    name,
    description: "",
    instructions: "",
    createdAt: Date.now(),
  });
  app.setSnapshot((current) =>
    current
      ? { ...current, projects: [...current.projects, project] }
      : current,
  );
  return project;
}
