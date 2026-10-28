import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tooltipPosition } from "../ui/tooltip-position";
import { formatText } from "../i18n";
import {
  compactTokens,
  unsplit,
  type DayUsage,
  type ModelUsage,
} from "./usageStats";

/** Model colours by rank, darkest for the largest share. */
const shades = ["#5781d8", "#7195de", "#8dabe5", "#aabfea", "#c6d5f2"];
const shade = (rank: number) => shades[Math.min(rank, shades.length - 1)];

/** A round axis maximum covered by three equal steps of 1, 2 or 5 × 10ⁿ. */
function axis(max: number) {
  if (max <= 0) return { top: 3, step: 1 };
  const raw = max / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  return { top: step * 3, step };
}

/** The legend lists this many models; the rest sit behind "Show N more". */
const LEGEND_ROWS = 6;

/** Up to ten evenly spaced day labels, always including both ends. */
function labelDays(count: number) {
  const labels = Math.min(count, 10);
  if (labels < 2) return new Set([0]);
  return new Set(
    Array.from({ length: labels }, (_, k) =>
      Math.round((k * (count - 1)) / (labels - 1)),
    ),
  );
}

type DayRow = { model: string; tokens: number; color: string };

/**
 * One day's tokens per model, in the legend's order; the service's daily
 * totals without a model split read "All models".
 */
export function dayRows(day: DayUsage, models: ModelUsage[]): DayRow[] {
  const rows: DayRow[] = models.flatMap((m, rank) =>
    day.byModel[m.model]
      ? [{ model: m.model, tokens: day.byModel[m.model], color: shade(rank) }]
      : [],
  );
  if (day.byModel[unsplit])
    rows.push({
      model: "All models",
      tokens: day.byModel[unsplit],
      color: shade(0),
    });
  return rows;
}

/**
 * The hovered day: its date, then a dot and "model: tokens" per model, above
 * the bar in the chrome tooltip's style.
 */
function DayTooltip({
  anchor,
  date,
  rows,
}: {
  anchor: HTMLElement;
  date: Date;
  rows: DayRow[];
}) {
  const bubble = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    if (!bubble.current) return;
    const size = bubble.current.getBoundingClientRect();
    setPlace(
      tooltipPosition(
        anchor.getBoundingClientRect(),
        { width: size.width, height: size.height },
        { width: innerWidth, height: innerHeight },
        "above",
        6,
      ),
    );
  }, [anchor, date, rows.length]);
  return createPortal(
    <div
      ref={bubble}
      role="tooltip"
      className="usage-chart-tip"
      data-open={Boolean(place)}
      style={place ?? { left: 0, top: 0 }}
    >
      <strong>
        {date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        })}
      </strong>
      {rows.map((row) => (
        <span key={row.model} className="usage-chart-tip-row">
          <i style={{ background: row.color }} />
          <span>
            {formatText("{model}: {tokens}", {
              model: row.model,
              tokens: compactTokens(row.tokens),
            })}
          </span>
        </span>
      ))}
    </div>,
    document.body,
  );
}

/**
 * Daily tokens stacked by model, with the largest model at the bottom,
 * and a legend of input, output and share per model. Hovering a day shows
 * its tokens per model.
 */
export function ModelChart({
  daily,
  models,
}: {
  daily: DayUsage[];
  models: ModelUsage[];
}) {
  const [hovered, setHovered] = useState<{
    index: number;
    anchor: HTMLElement;
  }>();
  const [allModels, setAllModels] = useState(false);
  const totals = daily.map((d) =>
    Object.values(d.byModel).reduce((a, b) => a + b, 0),
  );
  const { top, step } = axis(Math.max(...totals));
  const labelled = labelDays(daily.length);
  const day = hovered && daily[hovered.index];
  return (
    <div className="usage-models">
      {day && hovered && (
        <DayTooltip
          anchor={hovered.anchor}
          rows={dayRows(day, models)}
          date={day.date}
        />
      )}
      <div className="usage-chart">
        <div className="usage-chart-axis" aria-hidden="true">
          {[3, 2, 1, 0].map((k) => (
            <span key={k} style={{ top: `${((3 - k) / 3) * 100}%` }}>
              {compactTokens(k * step)}
            </span>
          ))}
        </div>
        <div
          className="usage-chart-plot"
          role="img"
          aria-label="Daily tokens by model"
        >
          {daily.map((d, i) => (
            <div
              key={i}
              className="usage-chart-slot"
              data-hovered={hovered?.index === i || undefined}
              onPointerEnter={(event) =>
                setHovered({
                  index: i,
                  // Above the bar itself; an empty day uses its column.
                  anchor:
                    (event.currentTarget.firstElementChild as HTMLElement) ??
                    event.currentTarget,
                })
              }
              onPointerLeave={() =>
                setHovered((current) =>
                  current?.index === i ? undefined : current,
                )
              }
            >
              <div
                className="usage-chart-day"
                style={{ height: `${(totals[i] / top) * 100}%` }}
              >
                {models.map((m, rank) =>
                  d.byModel[m.model] ? (
                    <span
                      key={m.model}
                      style={{
                        flexGrow: d.byModel[m.model],
                        background: shade(rank),
                      }}
                    />
                  ) : null,
                )}
                {/* The service's daily totals carry no model split. */}
                {d.byModel[unsplit] ? (
                  <span
                    style={{
                      flexGrow: d.byModel[unsplit],
                      background: shade(0),
                    }}
                  />
                ) : null}
              </div>
            </div>
          ))}
        </div>
        <div className="usage-chart-dates" aria-hidden="true">
          {daily.map((d, i) => (
            <span key={i}>
              {labelled.has(i)
                ? d.date.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })
                : ""}
            </span>
          ))}
        </div>
      </div>
      <ul className="usage-legend">
        {(allModels ? models : models.slice(0, LEGEND_ROWS)).map((m, rank) => (
          <li key={m.model}>
            <i style={{ background: shade(rank) }} />
            <span>{m.model}</span>
            <small>
              {formatText("{inTokens} in · {outTokens} out", {
                inTokens: compactTokens(m.input),
                outTokens: compactTokens(m.output),
              })}
            </small>
            <strong>{(m.share * 100).toFixed(1)}%</strong>
          </li>
        ))}
      </ul>
      {!models.length && (
        <p className="usage-legend-note">No model usage in this range</p>
      )}
      {models.length > LEGEND_ROWS && (
        <button
          type="button"
          className="usage-legend-note usage-legend-more"
          aria-expanded={allModels}
          onClick={() => setAllModels(!allModels)}
        >
          {allModels
            ? "Show less"
            : formatText("Show {count} more", {
                count: models.length - LEGEND_ROWS,
              })}
        </button>
      )}
    </div>
  );
}
