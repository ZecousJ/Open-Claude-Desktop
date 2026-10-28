import type { Project } from "../../../shared/types";
import { t, useT } from "../../i18n";

/** 1014 c71dee58b-DpJg0DX-:4705; captured private row after Scheduled.
 * Read persisted access metadata. Unrecognized visibility is not "Private". */
export function ProjectVisibility({
  project,
}: {
  project: Pick<Project, "visibility">;
}) {
  useT();
  if (project.visibility !== "private") return null;
  // "mt-4 font-small text-muted-as-secondary", the word alone, 16px under the
  // cards.
  return <p className="prj-visibility">{t("Private")}</p>;
}
