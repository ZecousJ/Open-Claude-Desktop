import { useEffect, useState } from "react";
import { isApprovedDirectoryEntries } from "../../shared/connectors-catalogue";
import type { ApprovedDirectoryEntry } from "../../shared/directory-submissions";

/**
 * The Claudex directory's published entries, read while `enabled` (a
 * Discover page shows). Its curation only adds blocks: a failed read leaves
 * the marketplaces' plugins as they are, so it is not reported.
 */
export function useApprovedDirectory(enabled: boolean) {
  const [entries, setEntries] = useState<ApprovedDirectoryEntry[]>();
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    // A host without the directory has no curation (the call may not exist).
    Promise.resolve()
      .then(() => window.desktop.listApprovedDirectory())
      .then((value) => {
        if (current && isApprovedDirectoryEntries(value)) setEntries(value);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [enabled]);
  return enabled ? entries : undefined;
}
