import type { ButtonHTMLAttributes } from "react";
import type { CodeEffort } from "../../shared/types";
import { codeEffortLabels } from "../../shared/code-effort";
import { ModelName } from "./model/ModelName";
import { useModelCatalog } from "./model/code-model-choices";
import { modelTriggerLabel } from "./model-trigger-label";

/** Current web Code draft combines the model and effort in one trigger. */
export function CodeModelTrigger({
  model,
  effort,
  className,
  ...button
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & {
  model: string;
  effort: CodeEffort;
}) {
  const catalog = useModelCatalog();
  return (
    <button
      {...button}
      className={`model-button u-press web-code-model-trigger${className ? ` ${className}` : ""}`}
      aria-label={modelTriggerLabel(model, effort, catalog)}
    >
      <ModelName model={model} />
      <span className="web-code-model-effort">{codeEffortLabels[effort]}</span>
    </button>
  );
}
