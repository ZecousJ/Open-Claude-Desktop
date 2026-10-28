import { AppIcon } from "../../ui/app-icon";
import type { Item } from "../../../shared/types";
import { webFetchError } from "../../../shared/web-fetch";
import { t } from "../../i18n";
import { WithTooltip } from "../../ui/Tooltip";
import "./web-fetch-error.css";

/** Error tooltip on the Warning icon. */
export default function WebFetchErrorContent({ item }: { item: Item }) {
  const error = webFetchError(item);
  if (!error) return null;
  const label = t(error);
  return (
    <WithTooltip label={label}>
      {(props) => (
        <span
          {...props}
          className="web-fetch-error"
          role="img"
          aria-label={label}
          tabIndex={0}
        >
          <AppIcon name="Warning" size={16} />
        </span>
      )}
    </WithTooltip>
  );
}
