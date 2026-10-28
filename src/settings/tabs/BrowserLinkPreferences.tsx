import { useState } from "react";
import { preference } from "../../../shared/settings-extras";
import { useHostCapability } from "../../host/HostContext";
import { usePolicy } from "../../policy/PolicyContext";
import type { TabProps } from "../context";
import { Button, Row, Toggle } from "../controls";
import {
  useSettingsRequestScope,
  type SettingsScopeOwner,
} from "../useSettingsRequestScope";
import { AllowedSitesDialog } from "./ClaudeCode";
import { browserSectionState } from "./ClaudeCodeSections";

/**
 * Link and allowed-sites controls only. Reuses Code's actual browser store
 * and site editor, without adding Chrome pairing.
 */
type BrowserLinkPreferencesProps = Pick<TabProps, "settings" | "save">;
export function BrowserLinkPreferences(props: BrowserLinkPreferencesProps) {
  const scope = useSettingsRequestScope();
  return (
    <ScopedBrowserLinkPreferences key={scope.key} {...props} scope={scope} />
  );
}
function ScopedBrowserLinkPreferences({
  settings,
  save,
  scope,
}: BrowserLinkPreferencesProps & { scope: SettingsScopeOwner }) {
  const scopedSave: TabProps["save"] = (patch) => {
    if (scope.capture().current()) return save(patch);
  };
  const available = useHostCapability("browserPanel");
  const policy = usePolicy();
  const [managing, setManaging] = useState(false);
  const { blocked, tools } = browserSectionState(settings, policy);
  if (!available || blocked) return null;
  const sites = preference(settings, "browserAllowedSites");
  return (
    <>
      <Row
        label="Open links in built-in browser"
        description="Links in Code sessions open in the built-in browser instead of your default browser."
      >
        <Toggle
          label="Open links in built-in browser"
          checked={preference(settings, "browserOpenLinksInApp")}
          onChange={(browserOpenLinksInApp) =>
            scopedSave({ browserOpenLinksInApp })
          }
        />
      </Row>
      {tools && (
        <Row
          label="Allowed sites"
          description="Sites where Claudex can use its Browser tools without a permission prompt."
        >
          <Button
            onClick={() => {
              if (scope.capture().current()) setManaging(true);
            }}
          >
            Manage
          </Button>
        </Row>
      )}
      {managing && tools && (
        <AllowedSitesDialog
          sites={sites}
          externalSites={policy.browser?.externalSites !== false}
          blockedDomains={policy.browser?.blockedDomains}
          onAdd={(site) =>
            scopedSave({ browserAllowedSites: [...sites, site] })
          }
          onRemove={(site) =>
            scopedSave({
              browserAllowedSites: sites.filter((value) => value !== site),
            })
          }
          onClear={() => scopedSave({ browserAllowedSites: [] })}
          onClose={() => setManaging(false)}
        />
      )}
    </>
  );
}
