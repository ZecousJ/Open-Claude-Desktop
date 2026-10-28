import type { Item } from "../../../shared/types";
import { toolGroupCaption } from "../../../shared/tool-group-caption";
import { thoughtLine } from "../thought-line";

export default function ThinkingToolRecap({
  items,
  previous,
}: {
  items: Item[];
  previous?: Item;
}) {
  const recap =
    toolGroupCaption(items) ??
    (previous?.type === "reasoning" ? thoughtLine(previous) : undefined);
  return recap ? (
    <div className="code-command-label thinking-tool-recap">{recap}</div>
  ) : null;
}
