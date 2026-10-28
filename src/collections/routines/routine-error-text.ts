import { formatText } from "../../i18n";

/** Translate the UI sentence while preserving the person's task name. */
export function routineErrorText(error: string) {
  const collision = /^A routine named “([\s\S]*)” already exists\.$/.exec(
    error,
  );
  return collision
    ? formatText("A routine named “{name}” already exists.", {
        name: collision[1],
      })
    : formatText(error);
}
