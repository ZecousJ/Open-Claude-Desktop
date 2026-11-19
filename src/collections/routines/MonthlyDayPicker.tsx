import { nextRun } from "../../../shared/routines";
import { toLocalInput } from "./routine-draft";

/** The next occurrence of each day (live claude.ai bundle, 2026-10-14, c97b955f1-DnH50wWB.js, xi). */
export function MonthlyDayPicker({
  dayOfMonth,
  time,
  onChange,
}: {
  dayOfMonth: number;
  time: string;
  onChange: (dayOfMonth: number) => void;
}) {
  const now = Date.now();
  const dates = Array.from({ length: 31 }, (_, index) =>
    toLocalInput(
      nextRun({ kind: "monthly", time, dayOfMonth: index + 1 }, now) ?? null,
    ).slice(0, 10),
  );
  return (
    <label className="routine-monthly-day">
      <span>starts on</span>
      <input
        className="routine-time"
        type="date"
        required
        value={dates[dayOfMonth - 1]}
        min={[...dates].sort()[0]}
        max={[...dates].sort().at(-1)}
        onChange={(event) => {
          if (dates.includes(event.target.value))
            onChange(Number(event.target.value.slice(-2)));
        }}
      />
    </label>
  );
}
