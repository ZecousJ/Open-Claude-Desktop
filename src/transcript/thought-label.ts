import { formatText } from "../i18n";

/**
 * How long Claude thought, in the largest units that read naturally: "Thought
 * for 42s", "Thought for 2m 5s", "Thought for 3m", "Thought for 1h 4m",
 * "Thought for 2h".
 */
export function thoughtLabel(seconds: number) {
  const total = Math.round(seconds);
  if (total < 60) return formatText("Thought for {n}s", { n: total });
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60)
    return rest > 0
      ? formatText("Thought for {minutes}m {seconds}s", {
          minutes,
          seconds: rest,
        })
      : formatText("Thought for {minutes}m", { minutes });
  const hours = Math.floor(minutes / 60);
  const leftover = minutes % 60;
  return leftover > 0
    ? formatText("Thought for {hours}h {minutes}m", {
        hours,
        minutes: leftover,
      })
    : formatText("Thought for {hours}h", { hours });
}
