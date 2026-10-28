import { AppIcon } from "../../ui/app-icon";

/** A required field left empty, under it. */
export function FieldProblem({
  id,
  children,
}: {
  id: string;
  children: string;
}) {
  return (
    <span className="routine-problem" id={id} role="alert" data-no-translate>
      <AppIcon name="WarningCircle" size={16} />
      <span>{children}</span>
    </span>
  );
}
