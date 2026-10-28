import { formatText, t } from "../i18n";

/**
 * Localized Chat/Cowork placeholder. Translation is owned here so user
 * project names are interpolated once, never translated as interface text.
 */
export function chatComposerPlaceholder(
  _mode: "chat" | "cowork",
  active: boolean,
  projectOverview: boolean,
  projectName?: string,
): string {
  if (active) return t("Reply");
  if (projectOverview && projectName?.trim())
    return formatText("New session in {project}", { project: projectName });
  if (projectOverview)
    return t("What would you like to work on in this project?");
  return t("How can I help you today?");
}
