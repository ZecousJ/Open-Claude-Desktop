import { useContext } from "react";
import type { RefObject } from "react";
import type { ProjectPickerProps } from "./ProjectPicker";
import { AppContext } from "../app/AppContext";
import { useT } from "../i18n";
import { projectPickerRows, typedProjectName } from "./project-picker-model";
import {
  setDefaultProjectId,
  setProjectPickerSort,
  useProjectPickerPreferences,
} from "./project-picker-preferences";
import { PlacePickerSurface } from "./PlacePickerSurface";
import { useProjectCatalogState } from "./useProjectCatalogState";

/** Lazy web data adapter for the shared picker popup. */
export function ProjectPickerPopup({
  label,
  project,
  projects,
  onProject,
  onCreateProject,
  collapsed,
  platform,
  externalTrigger,
}: ProjectPickerProps & {
  externalTrigger: {
    anchor: RefObject<HTMLButtonElement | null>;
    popup: RefObject<HTMLDivElement | null>;
    onClose(): void;
  };
}) {
  const app = useContext(AppContext);
  const accountId = app?.accountId ?? "local";
  const t = useT();
  const projectRead = useProjectCatalogState();
  const { defaultId, sort } = useProjectPickerPreferences(accountId);
  return (
    <PlacePickerSurface
      projectRead={projectRead}
      popupLabel={label}
      label={project?.name ?? label ?? t("Project")}
      chosen={Boolean(project)}
      collapsed={collapsed}
      platform={platform}
      externalTrigger={externalTrigger}
      content={(query) => {
        const name =
          projectRead.status === "pending"
            ? undefined
            : typedProjectName(projects, query);
        return {
          rows: projectPickerRows(
            projects,
            app?.snapshot.conversations ?? [],
            query,
            sort,
          ).map((row) => ({
            key: `project:${row.id}`,
            name: row.name,
            icon: "Projects",
            selected: row.id === project?.id,
            isDefault: row.id === defaultId,
            onPick: () => onProject(row.id),
            onDefault: () =>
              setDefaultProjectId(
                accountId,
                defaultId === row.id ? undefined : row.id,
              ),
          })),
          footer: [
            {
              key: "create",
              name: name ? `${t("Create")} ${name}` : t("New project"),
              createName: name,
              icon: "Plus",
              onPick: () => onCreateProject(name),
            },
          ],
        };
      }}
      controls={(
        [
          ["recent", "Recent activity"],
          ["created", "Date created"],
          ["name", "Name"],
        ] as const
      ).map(([value, label]) => ({
        key: value,
        label,
        checked: sort === value,
        onPick: () => setProjectPickerSort(accountId, value),
      }))}
    />
  );
}
