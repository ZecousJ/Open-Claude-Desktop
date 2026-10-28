import type { CodeEffort } from "../../shared/types";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import { codeEffortLabels } from "../../shared/code-effort";
import { modelLabel } from "./model/code-model-choices";
import { formatText, t } from "../i18n";

/** The catalog's actual model and active effort, including Code's extra level. */
export function modelTriggerLabel(
  model: string,
  effort: CodeEffort,
  catalog?: ModelCatalog | null,
) {
  return formatText(t("Model: {model} {effort}"), {
    model: model ? modelLabel(catalog, model) : t("Select model"),
    effort: t(codeEffortLabels[effort]),
  });
}
