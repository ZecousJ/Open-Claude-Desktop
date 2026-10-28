/**
 * The search labels of every Settings page. Each page file exports
 * `searchLabels`; a package adding a page's labels appends one import and one
 * entry here.
 */
import type { SearchIndex } from "./registry";
import { searchLabels as account } from "../tabs/Account";
import { searchLabels as billing } from "../billing/search";
import { searchLabels as general } from "../tabs/General";
import { privacySearchLabels as privacy } from "../privacy-search";
import { searchLabels as usage } from "../planUsageFormat";
import {
  capabilitiesLabels as capabilities,
  chromeLabels as chrome,
  codeLabels as code,
  connectorsLabels as connectors,
  coworkLabels as cowork,
  designLabels as design,
  developerLabels as developer,
  extensionsLabels as extensions,
  importLabels,
  memoryLabels as memory,
  pluginsLabels as plugins,
  reflectLabels as reflect,
  timeLabels as time,
  skillsLabels as skills,
  systemLabels as system,
} from "../tabs/desktop-labels";

export const settingsSearchIndex: SearchIndex = {
  network: ["Network", "Auto-updates", "Update feed", "Update binaries"],
  general,
  account,
  privacy,
  usage,
  billing,
  capabilities,
  memory,
  design,
  reflect,
  time,
  code,
  cowork,
  import: importLabels,
  chrome,
  system,
  extensions,
  developer,
  skills,
  connectors,
  plugins,
};

/** Cloud mail has no row on a desktop/local-only host. */
export function settingsSearchIndexForHost(cloudCode: boolean): SearchIndex {
  return cloudCode
    ? settingsSearchIndex
    : {
        ...settingsSearchIndex,
        general: general.filter(
          (label) => label !== "Emails from Claudex Code cloud sessions",
        ),
      };
}
