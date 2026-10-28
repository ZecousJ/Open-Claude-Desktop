import { WorkingKnot } from "../../ui/WorkingKnot";
import type { MarkBody } from "./activity";

/**
 * The working mark of the Code status line: the knot, paced by what the
 * turn is doing (thinking, reading, searching, running code, writing,
 * composing a document, waiting on the person).
 */
export function ClayMark({
  body,
  size = 20,
  className,
}: {
  body: MarkBody;
  size?: number;
  className?: string;
}) {
  return <WorkingKnot kind={body} size={size} className={className} />;
}
