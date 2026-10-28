import type {
  DiffScope,
  GitCommit,
  WorkingTreeChanges,
} from "../../shared/types";
import type { MenuEntry } from "../ui/Menu";

/**
 * The Changes panel's "Diff scope" menu: All changes against the base branch,
 * Uncommitted changes while the working tree has some, "Compare against"
 * another branch, and one of the branch's commits.
 */

/** The original lists the newest 50 commits and says how many more there are. */
export const SHOWN_COMMITS = 50;

/**
 * The scope chosen per folder for as long as the window is open, so the
 * panel opens on it again (the original keeps it per repository).
 */
const chosen = new Map<string, DiffScope>();

export function rememberedScope(folder: string | undefined): DiffScope {
  return (folder && chosen.get(folder)) || { kind: "branch" };
}

export function rememberScope(folder: string | undefined, scope: DiffScope) {
  if (!folder) return;
  if (scope.kind === "branch" && !scope.base) chosen.delete(folder);
  else chosen.set(folder, scope);
}

/** The base the scope's "All changes" and commit list are measured from. */
export function scopeBase(data: WorkingTreeChanges | undefined) {
  return data?.scope === "uncommitted" ? undefined : data?.base;
}

/** "abc1234 Fix the thing", or the short id when the commit isn't listed. */
export function commitLabel(sha: string, commits: GitCommit[] | undefined) {
  const commit = commits?.find((item) => item.sha === sha);
  return commit ? `${commit.shortSha} ${commit.subject}` : sha.slice(0, 7);
}

/** What the trigger reads, for its accessible name and tooltip. */
export function scopeText(
  data: WorkingTreeChanges,
  scope: DiffScope,
  base: string,
) {
  if (data.scope === "uncommitted") return "Uncommitted changes";
  if (data.scope === "commit" && scope.kind === "commit")
    return commitLabel(scope.sha, data.commits);
  return `${base} → ${data.head ?? "working tree"}`;
}

/** The branch list's state while "Compare against" is open. */
export type BranchList =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; names: string[] };

export function scopeEntries({
  data,
  scope,
  base,
  branches,
  onScope,
}: {
  data: WorkingTreeChanges;
  scope: DiffScope;
  /** The base branch shown (the picked one, else the default). */
  base: string;
  branches: BranchList;
  onScope: (scope: DiffScope) => void;
}): MenuEntry[] {
  // The base a scope keeps: only one that isn't the default is remembered.
  const picked = scope.base;
  const kind = data.scope ?? "branch";
  const entries: MenuEntry[] = [
    {
      label: "All changes",
      value: `vs ${base}`,
      checked: kind === "branch",
      onSelect: () => onScope({ kind: "branch", base: picked }),
    },
  ];
  if (data.dirty)
    entries.push({
      label: "Uncommitted changes",
      checked: kind === "uncommitted",
      onSelect: () => onScope({ kind: "uncommitted", base: picked }),
    });
  entries.push({ separator: true });

  const names =
    branches.state === "ready"
      ? branches.names
      : // The current base stays listed while the rest load.
        [base];
  const branchRows: MenuEntry[] = names.map((name) => ({
    label: name,
    noTranslate: true,
    value: name === data.defaultBase ? "default" : undefined,
    checked: name === base,
    onSelect: () =>
      onScope({
        kind: "branch",
        base: name === data.defaultBase ? undefined : name,
      }),
  }));
  if (branches.state === "loading")
    branchRows.push({ label: "Loading branches…", disabled: true });
  else if (branches.state === "failed" && !names.length)
    branchRows.push({ label: "Couldn’t load branches", disabled: true });
  entries.push({
    label: "Compare against",
    value: base,
    submenu: branchRows,
    searchable: "Search branches",
    searchEmpty:
      branches.state === "failed"
        ? "Couldn’t load branches"
        : branches.state === "loading"
          ? "Loading branches…"
          : "No branches match",
  });

  const commits = data.commits ?? [];
  if (commits.length) {
    const selected =
      kind === "commit" && scope.kind === "commit" ? scope.sha : undefined;
    const rows: MenuEntry[] = commits.slice(0, SHOWN_COMMITS).map((commit) => ({
      label: commit.subject || "(no message)",
      noTranslate: Boolean(commit.subject),
      value: commit.shortSha,
      checked: selected === undefined ? undefined : commit.sha === selected,
      onSelect: () =>
        onScope({ kind: "commit", sha: commit.sha, base: picked }),
    }));
    const hidden = commits.length - SHOWN_COMMITS;
    if (hidden > 0)
      rows.push({
        label:
          hidden === 1
            ? "1 older commit not shown"
            : `${hidden} older commits not shown`,
        disabled: true,
      });
    entries.push({ separator: true });
    entries.push({
      label: "Commits",
      value: selected
        ? (commits.find((commit) => commit.sha === selected)?.shortSha ??
          selected.slice(0, 7))
        : String(commits.length),
      submenu: rows,
      searchable: "Search commits",
      searchEmpty:
        commits.length > SHOWN_COMMITS
          ? `No match in the newest ${SHOWN_COMMITS} commits`
          : "No commits match",
    });
  }
  return entries;
}
