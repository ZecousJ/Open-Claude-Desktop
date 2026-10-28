import { formatText } from "../i18n";
import { modelLabel } from "../composer/model/code-model-choices";
import { useModelCatalog } from "../composer/useComposerServices";
import "./model-switch-note.css";

/**
 * After safeguards flagged a message the reply came from another model:
 * "Switched to {toName}".
 */
export function ModelSwitchNote({ model }: { model: string }) {
  const catalog = useModelCatalog();
  return (
    <p className="model-switch-note" role="status">
      {formatText("Switched to {toName}", {
        toName: modelLabel(catalog, model),
      })}
    </p>
  );
}
