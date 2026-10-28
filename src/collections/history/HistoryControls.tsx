import { t } from "../../i18n";
import { useRef, useState } from "react";
import { ArrowUpDown } from "../../ui/glyphs";
import type { Mode } from "../../../shared/types";
import {
  historyTabs,
  type HistorySearchSort,
  type HistoryTab,
} from "./history-rows";
import { Menu, type MenuPosition } from "../../ui/Menu";
import { WithTooltip } from "../../ui/Tooltip";
import "../collections.css";
import "./history.css";

export function SearchSortButton({
  disabled,
  value,
  onChange,
}: {
  disabled: boolean;
  value: HistorySearchSort;
  onChange: (value: HistorySearchSort) => void;
}) {
  const [position, setPosition] = useState<MenuPosition>();
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <WithTooltip
        label={disabled ? t("Sort applies to search results") : t("Sort by")}
      >
        {(tip) => (
          <button
            {...tip}
            ref={anchor}
            type="button"
            className={`collection-icon${position ? " open" : ""}`}
            aria-label={t("Sort by")}
            aria-haspopup="menu"
            aria-expanded={Boolean(position)}
            aria-pressed={value !== "type"}
            aria-disabled={disabled || undefined}
            onClick={(event) => {
              if (disabled) return;
              if (position) return setPosition(undefined);
              const box = event.currentTarget.getBoundingClientRect();
              setPosition({ left: box.right - 200, top: box.bottom + 4 });
            }}
          >
            <ArrowUpDown size={16} strokeWidth={1.5} />
          </button>
        )}
      </WithTooltip>
      {position && (
        <Menu
          label="Sort by"
          entries={[
            {
              label: "Type",
              checked: value === "type",
              checkedRole: "radio",
              onSelect: () => onChange("type"),
            },
            {
              label: "Date",
              checked: value === "date",
              checkedRole: "radio",
              onSelect: () => onChange("date"),
            },
          ]}
          position={position}
          width={200}
          anchors={[anchor]}
          onClose={() => setPosition(undefined)}
        />
      )}
    </>
  );
}

/** The tab-style filter. */
export function HistoryTabs({
  id,
  mode,
  value,
  onChange,
}: {
  /** Prefix of the tabs' ids; the list below is `${id}-panel`. */
  id: string;
  mode: Mode;
  value: HistoryTab;
  onChange: (tab: HistoryTab) => void;
}) {
  const tabs = historyTabs(mode);
  const move = (from: HTMLElement, step: number | "first" | "last") => {
    const buttons = [
      ...(from.parentElement?.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      ) ?? []),
    ];
    const at = buttons.indexOf(from as HTMLButtonElement);
    const next =
      step === "first"
        ? 0
        : step === "last"
          ? buttons.length - 1
          : (at + step + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return (
    <div className="history-tabs" role="tablist" aria-label={t("Filter by")}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          id={`${id}-${tab.value}`}
          aria-selected={tab.value === value}
          aria-controls={`${id}-panel`}
          tabIndex={tab.value === value ? 0 : -1}
          onClick={() => onChange(tab.value)}
          onKeyDown={(event) => {
            const step =
              event.key === "ArrowRight"
                ? 1
                : event.key === "ArrowLeft"
                  ? -1
                  : event.key === "Home"
                    ? "first"
                    : event.key === "End"
                      ? "last"
                      : undefined;
            if (step === undefined) return;
            event.preventDefault();
            move(event.currentTarget, step);
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
