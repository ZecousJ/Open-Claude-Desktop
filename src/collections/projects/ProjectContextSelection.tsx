import { formatText, t } from "../../i18n";
import { Trash2, X } from "../../ui/glyphs";
import { useTooltip } from "../../ui/Tooltip";

/** What ProjectContextSelection needs from ProjectKnowledgeView.tsx. */
export interface PrjContextSelectionProps {
  busy: boolean;
  cancelSelection: () => void;
  removeSelected: () => void;
  scope: string[];
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export function ProjectContextSelection({
  busy,
  cancelSelection,
  removeSelected,
  scope,
  selected,
  setSelected,
}: PrjContextSelectionProps) {
  // The one checkbox selects or clears every file; its hint says which.
  const { props, tooltip } = useTooltip(
    selected.size < scope.length ? t("Select all") : t("Deselect all"),
    { placement: "below", disabled: !scope.length },
  );
  return (
    <div className="prj-context-selection">
      <input
        {...props}
        type="checkbox"
        aria-label={
          selected.size
            ? formatText("Select all ({numSelected})", {
                numSelected: selected.size,
              })
            : t("Select all")
        }
        checked={selected.size > 0}
        ref={(input) => {
          if (input)
            input.indeterminate =
              selected.size > 0 && selected.size !== scope.length;
        }}
        disabled={!scope.length}
        onChange={() =>
          setSelected(
            selected.size === scope.length ? new Set() : new Set(scope),
          )
        }
      />
      {tooltip}
      <span>{formatText("{count} selected", { count: selected.size })}</span>
      <button
        type="button"
        disabled={!selected.size || busy}
        aria-label={
          selected.size === 1
            ? t("Delete 1 selected item")
            : formatText("Delete {numSelected} selected items", {
                numSelected: selected.size,
              })
        }
        onClick={removeSelected}
      >
        <Trash2 size={16} />
      </button>
      <button type="button" aria-label="Cancel" onClick={cancelSelection}>
        <X size={16} />
      </button>
    </div>
  );
}
