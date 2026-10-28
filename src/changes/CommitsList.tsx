import { useState } from "react";
import type { DiffScope, GitCommit } from "../../shared/types";
import { currentLocale, formatText, t } from "../i18n";
import { Menu, type MenuPosition } from "../ui/Menu";
import { WithTooltip } from "../ui/Tooltip";
import { showToast } from "../ui/toast-store";

/** At most this many commits are listed (the original's 100). */
const shownCommits = 100;

/** A commit's age as the original writes it: narrow, always numeric ("3d ago"). */
export function commitAge(at: number, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const [size, unit] =
    seconds >= 365 * 86400
      ? ([365 * 86400, "year"] as const)
      : seconds >= 30 * 86400
        ? ([30 * 86400, "month"] as const)
        : seconds >= 86400
          ? ([86400, "day"] as const)
          : seconds >= 3600
            ? ([3600, "hour"] as const)
            : seconds >= 60
              ? ([60, "minute"] as const)
              : ([1, "second"] as const);
  return new Intl.RelativeTimeFormat(currentLocale(), {
    numeric: "always",
    style: "narrow",
  }).format(-Math.round(seconds / size), unit);
}

/**
 * The Changes pane's Commits: All changes, Uncommitted changes while there are
 * any, then the branch's commits newest first — the subject (whole in a
 * tooltip) over "short SHA · author · age" — and how many older ones are left
 * out. A commit's right-click menu copies its SHA.
 */
export function CommitsList({
  commits,
  scope,
  dirty,
  onScope,
}: {
  commits: GitCommit[];
  scope: DiffScope;
  /** There are uncommitted changes (the row shows only then). */
  dirty: boolean;
  onScope: (scope: DiffScope) => void;
}) {
  const [menu, setMenu] = useState<{ sha: string; position: MenuPosition }>();
  const shown = commits.slice(0, shownCommits);
  // A picked commit further down stays listed.
  if (
    scope.kind === "commit" &&
    !shown.some((commit) => commit.sha === scope.sha)
  ) {
    const picked = commits.find((commit) => commit.sha === scope.sha);
    if (picked) shown.push(picked);
  }
  const hidden = commits.length - shown.length;
  return (
    <div
      className="changes-turns changes-commits u-scroll-fade-y"
      role="toolbar"
      aria-orientation="vertical"
      aria-label={t("Commits")}
    >
      <button
        className="changes-turn-row"
        aria-pressed={scope.kind === "branch"}
        onClick={() => onScope({ kind: "branch", base: scope.base })}
      >
        <span className="changes-turn-title">{t("All changes")}</span>
      </button>
      {dirty && (
        <button
          className="changes-turn-row"
          aria-pressed={scope.kind === "uncommitted"}
          onClick={() => onScope({ kind: "uncommitted", base: scope.base })}
        >
          <span className="changes-turn-title">{t("Uncommitted changes")}</span>
        </button>
      )}
      {shown.map((commit) => {
        const subject = commit.subject || t("(no message)");
        return (
          <WithTooltip
            key={commit.sha}
            label={subject}
            placement="below"
            size="wrap"
          >
            {(tip) => (
              <button
                {...tip}
                className="changes-turn-row changes-commit-row"
                aria-pressed={
                  scope.kind === "commit" && scope.sha === commit.sha
                }
                onClick={() =>
                  onScope({ kind: "commit", sha: commit.sha, base: scope.base })
                }
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({
                    sha: commit.sha,
                    position: { left: event.clientX, top: event.clientY },
                  });
                }}
              >
                <span className="changes-turn-title" data-no-translate>
                  {subject}
                </span>
                <span className="changes-turn-meta">
                  <span className="changes-commit-sha" dir="ltr">
                    {commit.shortSha}
                  </span>
                  {commit.author && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="changes-commit-author" data-no-translate>
                        {commit.author}
                      </span>
                    </>
                  )}
                  {commit.at !== undefined && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="changes-commit-age">
                        {commitAge(commit.at)}
                      </span>
                    </>
                  )}
                </span>
              </button>
            )}
          </WithTooltip>
        );
      })}
      {hidden > 0 && (
        <span className="changes-commits-more">
          {hidden === 1
            ? t("1 older commit not shown")
            : formatText("{count} older commits not shown", { count: hidden })}
        </span>
      )}
      {menu && (
        <Menu
          label={t("Commits")}
          position={menu.position}
          width={180}
          entries={[
            {
              label: "Copy commit SHA",
              onSelect: () => {
                void navigator.clipboard.writeText(menu.sha).then(
                  () => showToast(t("Commit SHA copied to clipboard.")),
                  () => showToast(t("Couldn’t copy to the clipboard.")),
                );
              },
            },
          ]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}
