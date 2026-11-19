import { Anthropicon } from "../../ui/anthropicons";
import type { Item } from "../../../shared/types";
import { webFetchError } from "../../../shared/web-fetch";
import { t } from "../../i18n";
import { WithTooltip } from "../../ui/Tooltip";
import "./web-fetch-error.css";

/** Error tooltip on the Warning icon (live claude.ai bundle, 2026-10-14,
 * shared-13-CALRr8Bn.js and shared-17-DZw1BgLL.js). */
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
          <Anthropicon name="Warning" size={16} />
        </span>
      )}
    </WithTooltip>
  );
}
