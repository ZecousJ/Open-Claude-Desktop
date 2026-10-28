import { Suspense } from "react";
import type { Project } from "../../shared/types";
import { useT } from "../i18n";
import { lazyPiece } from "../ui/lazy-piece";
import { PlacePickerTrigger, usePlacePickerShell } from "./PlacePickerTrigger";

export interface ProjectPickerProps {
  /** Native incognito keeps this host label while offering projects only. */
  label?: string;
  project?: Project;
  projects: Project[];
  onProject: (id: string) => void;
  onCreateProject: (name?: string) => void;
  collapsed: boolean;
  platform: NodeJS.Platform;
}
export function createProjectPickerShell(
  load: () => Promise<{
    ProjectPickerPopup: typeof import("./ProjectPickerPopup").ProjectPickerPopup;
  }>,
) {
  const Popup = lazyPiece(load, "ProjectPickerPopup");
  return function ProjectPicker(props: ProjectPickerProps) {
    const t = useT();
    const { open, anchor, popup, close, toggle } = usePlacePickerShell();
    return (
      <>
        <PlacePickerTrigger
          label={props.project?.name ?? props.label ?? t("Project")}
          chosen={Boolean(props.project)}
          collapsed={props.collapsed}
          open={open}
          anchor={anchor}
          onToggle={toggle}
        />
        {open && (
          <Suspense fallback={null}>
            <Popup
              {...props}
              externalTrigger={{ anchor, popup, onClose: close }}
            />
          </Suspense>
        )}
      </>
    );
  };
}
export const ProjectPicker = createProjectPickerShell(
  () => import("./ProjectPickerPopup"),
);
