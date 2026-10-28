import type { Item } from "../../../shared/types";
import { t } from "../../i18n";

export function isCodeExecution(item: Item) {
  const name = item.tool?.trim().split(/__|\./).at(-1) ?? "";
  return ["REPL", "JavaScript", "AppifactRepl", "js"].includes(name);
}

export function codeExecutionLabel() {
  return t("Running code…");
}
