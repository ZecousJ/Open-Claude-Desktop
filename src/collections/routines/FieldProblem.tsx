import { Anthropicon } from "../../ui/anthropicons";

/** A required field left empty, under it (live claude.ai CDS field error,
 * 2026-10-21: a 16px WarningCircle 4px before 13px text in the danger ink). */
export function FieldProblem({
  id,
  children,
}: {
  id: string;
  children: string;
}) {
  return (
    <span className="routine-problem" id={id} role="alert" data-no-translate>
      <Anthropicon name="WarningCircle" size={16} />
      <span>{children}</span>
    </span>
  );
}
