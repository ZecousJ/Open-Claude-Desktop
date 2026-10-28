/**
 * Import history (Settings → Import): bringing conversations and projects over
 * from a Claudex export (.zip) or from a Claudex data folder copied from
 * another computer. The wizard follows the original's session import: a list
 * of locations, a time range, what will be added, and an Import history of
 * earlier runs that can be removed.
 */

/** A location the person added: an export file or a copied data folder. */
export interface HistorySource {
  id: string;
  kind: "file" | "folder";
  /** The file or folder name. */
  label: string;
  /** Where it is on this computer. */
  path: string;
  /** Why it could not be read, when it could not. */
  problem?: HistorySourceProblem;
  scan: HistorySourceScan | null;
}

/** What went wrong with a location (the original's SOURCE_* codes). */
export type HistorySourceProblem = "self" | "unknown-shape" | "unreadable";

/** What a location holds, without the conversations themselves. */
export interface HistorySourceScan {
  conversations: {
    id: string;
    updatedAt: number;
    sizeBytes: number;
    /** A conversation with this id is already here. */
    alreadyImported: boolean;
    projectId?: string;
  }[];
  projects: {
    id: string;
    createdAt: number;
    alreadyImported: boolean;
  }[];
}

/** How far back a run reaches (the original's range control). */
export type HistoryRange = "30d" | "90d" | "all";

export const historyRanges: { id: HistoryRange; label: string }[] = [
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "all", label: "Everything" },
];

const day = 24 * 60 * 60 * 1000;

/** The earliest activity a range includes; 0 for everything. */
export function rangeStart(range: HistoryRange, now = Date.now()) {
  return range === "30d"
    ? now - 30 * day
    : range === "90d"
      ? now - 90 * day
      : 0;
}

/** What a run would add from one location in a range. */
export interface HistoryTally {
  /** New conversations in the range. */
  conversations: number;
  /** New projects the range brings: referenced by those conversations or created in it. */
  projects: number;
  sizeBytes: number;
  /** New conversations older than the range. */
  outOfWindow: number;
  /** Conversations in the range that are already here. */
  alreadyImported: number;
}

/**
 * Counts a location's conversations for a range, as the original's rollup
 * does: older ones that are new are only counted as out of the window, and
 * ones already here only when they fall inside it.
 */
export function tallyHistory(
  scan: HistorySourceScan,
  since: number,
): HistoryTally {
  const tally: HistoryTally = {
    conversations: 0,
    projects: 0,
    sizeBytes: 0,
    outOfWindow: 0,
    alreadyImported: 0,
  };
  const wanted = new Set<string>();
  for (const conversation of scan.conversations) {
    if (conversation.updatedAt < since) {
      if (!conversation.alreadyImported) tally.outOfWindow += 1;
    } else if (conversation.alreadyImported) tally.alreadyImported += 1;
    else {
      tally.conversations += 1;
      tally.sizeBytes += conversation.sizeBytes;
      if (conversation.projectId) wanted.add(conversation.projectId);
    }
  }
  for (const project of scan.projects)
    if (
      !project.alreadyImported &&
      (wanted.has(project.id) || project.createdAt >= since)
    )
      tally.projects += 1;
  return tally;
}

/** The bytes the way the original writes them ("12 KB", "3.4 MB"). */
export function formatSize(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What one import added, kept so it can be removed. */
export interface HistoryImportRun {
  runId: string;
  /** When it ran. */
  timestamp: number;
  /** The location it came from, as it was named then. */
  source: { label: string; kind: "file" | "folder" };
  counts: { conversations: number; projects: number };
}

export interface HistoryImportResult {
  ok: boolean;
  imported: { conversations: number; projects: number };
  /** Conversations that were already here and so not copied again. */
  skipped: number;
  /** Conversations that could not be read. */
  failed: number;
}

/** What removing an import would delete. */
export interface HistoryRemovePreview {
  conversations: number;
  projects: number;
  /** Conversations that were used (updated) after the import. */
  modifiedSinceImport: number;
}

export interface HistoryRemoveResult {
  removed: number;
  failed: number;
}

/**
 * The answer when a location was picked: the source added, or why it cannot
 * be (null when the picker was cancelled).
 */
export type HistoryAddResult =
  { source: HistorySource } | { problem: HistorySourceProblem } | null;
