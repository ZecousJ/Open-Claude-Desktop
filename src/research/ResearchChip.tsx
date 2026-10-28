import { WithTooltip } from "../ui/Tooltip";
import { ResearchIcon } from "./ResearchIcon";

/**
 * The composer's Research chip: shown right of the "+" button while Research is
 * on; clicking it turns Research off, as unchecking the menu row does.
 */
export function ResearchChip({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <WithTooltip label="Research" placement="above">
      {(tooltip) => (
        <button
          {...tooltip}
          type="button"
          className="research-chip"
          aria-label="Research"
          aria-pressed="true"
          disabled={disabled}
          onClick={onClick}
        >
          <ResearchIcon size={16} />
        </button>
      )}
    </WithTooltip>
  );
}
