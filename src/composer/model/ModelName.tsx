import { modelLabel, useModelCatalog } from "./code-model-choices";
import { isFastTier } from "../code/code-fast-mode";

/** The model button's label: the catalog's display name, else the model id. */
export function ModelName({ model }: { model: string }) {
  const catalog = useModelCatalog();
  return (
    <>
      {model ? modelLabel(catalog, model) : "Select model"}
      {model && isFastTier(catalog, model) && <FastTag />}
    </>
  );
}

/** The tag after a fast tier's name. */
export function FastTag() {
  return <span className="code-fast-tag">Fast</span>;
}
