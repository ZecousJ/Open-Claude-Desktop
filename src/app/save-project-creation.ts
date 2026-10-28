import type { DesktopAPI, Project } from "../../shared/types";
import type { ProjectCreation } from "../dialogs/ProjectCreateDialog";
/** Serialize selected files before the single authoritative creation call. */
export async function saveProjectCreation(
  bridge: Pick<DesktopAPI, "saveProject">,
  project: Project,
  creation: ProjectCreation | undefined,
  current: () => boolean,
): Promise<Project> {
  const check = () => {
    if (!current())
      throw new Error("The signed-in account changed. Try again.");
  };
  check();
  const serialize = (files: File[]) =>
    Promise.all(
      files.map(async (file) => ({
        name: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
      })),
    );
  const [files, contextFiles] = creation
    ? await Promise.all([
        serialize(creation.files),
        serialize(creation.contextFiles ?? []),
      ])
    : [[], []];
  check();
  const saved = await bridge.saveProject(
    project,
    creation
      ? {
          location: creation.location,
          files,
          projectIds: creation.projectIds,
          operationId: creation.operationId,
          ...(contextFiles.length || creation.contextText
            ? {
                context: {
                  files: contextFiles,
                  ...(creation.contextText
                    ? { text: creation.contextText }
                    : {}),
                },
              }
            : {}),
        }
      : undefined,
  );
  check();
  return saved;
}
