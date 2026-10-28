import { helpUrl } from "../../shared/help-links";
import { t } from "../i18n";
import { Row, Toggle } from "./controls";
import type { TabProps } from "./context";
import { useState } from "react";

/**
 * Location metadata, shown on Privacy and in Capabilities → General after the
 * model switch. Enabled unless the person turns it off (enabled_geolocation).
 */
export function LocationMetadataRow({
  settings,
  save,
}: Pick<TabProps, "settings" | "save">) {
  const [saving, setSaving] = useState(false);
  const [before, rest = ""] = t(
    "Allow Claudex to use coarse location metadata (city/region) to improve product experiences. <a>Learn more</a>.",
  ).split("<a>");
  const [linked, after = ""] = rest.split("</a>");
  return (
    <Row
      label="Location metadata"
      description={
        <>
          {before}
          <a
            href={helpUrl("location-metadata")}
            target="_blank"
            rel="noreferrer"
          >
            {linked}
          </a>
          {after}
        </>
      }
    >
      <Toggle
        label={t("Location metadata")}
        checked={settings.locationMetadata !== false}
        disabled={saving}
        onChange={async (locationMetadata) => {
          setSaving(true);
          try {
            await save({ locationMetadata });
          } finally {
            setSaving(false);
          }
        }}
      />
    </Row>
  );
}
