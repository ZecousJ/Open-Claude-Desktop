import type { BlankArtifact } from "../../shared/blank-artifacts";
import { NavTemplateIcon } from "../sidebar/NavCreateMenu";
import { t } from "../i18n";
import "./blank-artifact.css";
const heading = {
  docs: "Draft a plan, memo or brief with Claudex",
  slides: "Paste your ideas and turn them into slides",
  design: "Describe an idea and turn it into a design",
  dashboard: "What should this dashboard show?",
} as const;
export function BlankArtifactConversationIntro({
  artifact,
}: {
  artifact: BlankArtifact;
}) {
  return (
    <div className="blank-chat-intro">
      <NavTemplateIcon
        kind={
          artifact.kind === "docs"
            ? "Docs"
            : artifact.kind === "slides"
              ? "Slides"
              : artifact.kind === "design"
                ? "Design"
                : "Dashboard"
        }
      />
      <h1>{t(heading[artifact.kind])}</h1>
    </div>
  );
}
