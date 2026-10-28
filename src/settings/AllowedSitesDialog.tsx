import { useState } from "react";
import { Plus, Trash2 } from "../ui/glyphs";
import {
  parseAllowedSite,
  type AllowedSiteRefusal,
} from "../../shared/settings-extras";
import { formatText } from "../i18n";
import { isComposingKey } from "../ui/ime";
import { hostBlocked } from "../../shared/browser";
import { SettingsModal } from "./controls";
import "./allowed-sites.css";

/**
 * Allowed sites: the sites added with "Always allow this site" or typed here,
 * each with a trash button, and Clear all. Local development addresses never
 * ask, so they are listed as built in. Settings and the browser panel's ⋯ menu
 * open the same dialog.
 */
export function AllowedSitesDialog(props: AllowedSitesProps) {
  return (
    <SettingsModal
      title="Allowed sites"
      className="allowed-sites"
      onClose={props.onClose}
    >
      <AllowedSitesContent {...props} />
    </SettingsModal>
  );
}

interface AllowedSitesProps {
  sites: readonly string[];
  /** The administrator lets Claude use the browser on other websites. */
  externalSites: boolean;
  blockedDomains?: readonly string[];
  onAdd: (site: string) => void;
  onRemove: (site: string) => void;
  onClear: () => void;
  onClose: () => void;
}

/** What a refused address says (the original's messages). */
const siteRefusals: Record<AllowedSiteRefusal | "policy", string> = {
  invalid: "Enter a valid web address.",
  loopback: "Localhost is always allowed.",
  exists: "That site is already allowed.",
  full: "This site can’t be added due to safety restrictions.",
  policy: "This site is blocked by your organization’s policy.",
};

/** How a site reads in the list: https is the norm, so only other origins show their scheme. */
export function siteLabel(site: string) {
  return site.replace(/^https:\/\//, "");
}

/** The Allowed sites dialog's body. */
export function AllowedSitesContent({
  sites,
  externalSites,
  blockedDomains = [],
  onAdd,
  onRemove,
  onClear,
  onClose,
}: AllowedSitesProps) {
  const [draft, setDraft] = useState("");
  const [refusal, setRefusal] = useState<keyof typeof siteRefusals>();
  const add = () => {
    if (!draft.trim()) return;
    const parsed = parseAllowedSite(draft, sites);
    if ("refusal" in parsed) return setRefusal(parsed.refusal);
    if (
      !externalSites ||
      hostBlocked(new URL(parsed.site).hostname, blockedDomains)
    )
      return setRefusal("policy");
    onAdd(parsed.site);
    setDraft("");
    setRefusal(undefined);
  };
  return (
    <>
      <p className="desktop-dialog-note">
        Claudex can use its Browser tools on these sites without a permission
        prompt. Remove a site and Claudex asks again the next time that site
        needs your approval.
      </p>
      {!externalSites && (
        <p className="desktop-dialog-note" role="note">
          Your administrator doesn’t allow Claudex to use the browser on other
          websites.
        </p>
      )}
      <div className="allowed-sites-add">
        <label htmlFor="allowed-sites-url">Add URL</label>
        <div>
          <input
            id="allowed-sites-url"
            type="text"
            value={draft}
            placeholder="example.com"
            spellCheck={false}
            aria-invalid={!!refusal}
            aria-describedby={refusal ? "allowed-sites-error" : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setRefusal(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || isComposingKey(event)) return;
              event.preventDefault();
              add();
            }}
          />
          <button
            type="button"
            aria-label="Add"
            disabled={!draft.trim()}
            onClick={add}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        {refusal && (
          <p id="allowed-sites-error" role="alert">
            {siteRefusals[refusal]}
          </p>
        )}
      </div>
      <div className="allowed-sites-list" aria-label="Allowed sites">
        {sites.map((site) => (
          <div key={site}>
            <span title={site}>{siteLabel(site)}</span>
            <button
              type="button"
              aria-label={formatText("Remove {name}", {
                name: siteLabel(site),
              })}
              onClick={() => onRemove(site)}
            >
              <Trash2 size={16} aria-hidden="true" />
            </button>
          </div>
        ))}
        {!sites.length && <p>No allowed sites yet.</p>}
      </div>
      <div className="button-row">
        <button
          type="button"
          className="primary danger-button"
          disabled={!sites.length}
          onClick={onClear}
        >
          Clear all
        </button>
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </>
  );
}
