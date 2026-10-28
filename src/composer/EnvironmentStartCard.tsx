import { useContext, useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CodeHomeEnvironmentSlot } from "../code-home/CodeHomeEnvironmentSlot";
import { t } from "../i18n";
import { Check, ChevronDown } from "../ui/glyphs";
import { useTooltip } from "../ui/Tooltip";
import { surface } from "../../shared/host";
import { homeRelative } from "../session-info/session-info-model";
import "./environment-start-card.css";

export interface RecentEnvironment {
  id: string;
  name: string;
  detail?: string;
  detailKind?: "local-path" | "path" | "text";
  icon?: ReactNode;
  onSelect: () => void;
}

/** O14/c5220dfc1:3265; keep separators with their segment and path direction LTR. */
export function EnvironmentPath({ path }: { path: string }) {
  return (
    <span dir="ltr" style={{ maxWidth: "100%" }}>
      {path.split(/(?<=[\\/])/).map((part, index) => (
        <span
          key={index}
          style={{
            display: "inline-block",
            maxWidth: "100%",
            whiteSpace: "pre-wrap",
          }}
        >
          {part}
        </span>
      ))}
    </span>
  );
}

function EnvironmentRow({
  row,
  selected,
  home,
  onRequestComposerFocus,
}: {
  row: RecentEnvironment;
  selected: boolean;
  home?: string;
  onRequestComposerFocus?: () => void;
}) {
  const detail =
    row.detailKind === "local-path" && row.detail
      ? homeRelative(row.detail, home)
      : row.detail;
  const id = useId();
  const tip = useTooltip(detail ?? "", {
    placement: "above-start",
    maxWidth: 480,
    disabled: !detail,
    content:
      detail && row.detailKind !== "text" ? (
        <EnvironmentPath path={detail} />
      ) : (
        detail
      ),
  });
  const label = (
    <>
      {row.icon}
      <span data-no-translate>{row.name}</span>
    </>
  );
  return (
    <>
      {selected ? (
        <div
          {...tip.props}
          className="environment-start-row"
          data-testid="start-card-environment"
        >
          {label}
          {detail && (
            <span className="sr-only" data-no-translate>
              {detail}
            </span>
          )}
          <Check aria-hidden="true" />
        </div>
      ) : (
        <button
          {...tip.props}
          type="button"
          className="environment-start-row"
          data-testid="start-card-environment"
          aria-describedby={
            [detail ? id : undefined, tip.props["aria-describedby"]]
              .filter(Boolean)
              .join(" ") || undefined
          }
          onClick={() => {
            row.onSelect();
            onRequestComposerFocus?.();
          }}
        >
          {label}
        </button>
      )}
      {!selected && detail && (
        <span id={id} hidden data-no-translate>
          {detail}
        </span>
      )}
      {tip.tooltip}
    </>
  );
}

/** Three recents, retaining the selection. */
export function recentEnvironmentRows(
  rows: RecentEnvironment[],
  selectedId: string,
) {
  const first = rows.slice(0, 3);
  const selected = rows.find((row) => row.id === selectedId);
  return !selected || first.includes(selected)
    ? first
    : [...first.slice(0, -1), selected];
}

export function EnvironmentStartCard({
  rows,
  selectedId,
  open,
  onChoose,
  onRequestComposerFocus,
}: {
  rows: RecentEnvironment[];
  selectedId: string;
  open: boolean;
  onChoose: (button: HTMLButtonElement) => void;
  onRequestComposerFocus?: () => void;
}) {
  const slot = useContext(CodeHomeEnvironmentSlot);
  const [home, setHome] = useState<string>();
  const needsHome = rows.some((row) => row.detailKind === "local-path");
  useEffect(() => {
    if (
      surface === "web" ||
      !needsHome ||
      typeof window.desktop?.appEnvironment !== "function"
    )
      return;
    let live = true;
    void window.desktop.appEnvironment().then(
      (value) => {
        if (live && typeof value?.home === "string") setHome(value.home);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [needsHome]);
  const card = (
    <div className="environment-start-card" data-testid="epitaxy-start-card">
      <ul
        role="list"
        aria-label={t("Recent environments")}
        data-testid="start-card-environments"
      >
        {recentEnvironmentRows(rows, selectedId).map((row) => (
          <li
            key={row.id}
            aria-current={row.id === selectedId ? "true" : undefined}
          >
            <EnvironmentRow
              row={row}
              selected={row.id === selectedId}
              home={home}
              onRequestComposerFocus={onRequestComposerFocus}
            />
          </li>
        ))}
        <li className="environment-start-choose">
          <button
            type="button"
            className="environment-start-row"
            data-testid="start-card-choose"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={(event) => onChoose(event.currentTarget)}
          >
            <span className="environment-start-choose-label">
              <span>{t("Choose environment")}</span>
              <ChevronDown aria-hidden="true" />
            </span>
          </button>
        </li>
      </ul>
    </div>
  );
  return slot === undefined ? card : slot ? createPortal(card, slot) : null;
}
