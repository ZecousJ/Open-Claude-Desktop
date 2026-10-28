import type { ArtifactOutputKind } from "../../shared/artifact-output";
import { t } from "../i18n";
export function codeOutputPlaceholder(kind: ArtifactOutputKind) {
  switch (kind) {
    case "docs":
      return t("What should this document be about?");
    case "slides":
      return t("What should this deck be about?");
    case "design":
      return t("What should this design show?");
    case "dashboard":
      return t("What should this dashboard show?");
  }
}
