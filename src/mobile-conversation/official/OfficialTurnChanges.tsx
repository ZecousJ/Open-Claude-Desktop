import { useState } from "react";
import type { Turn } from "../../../shared/types";
import { shownPath, turnChangedFiles } from "../../code-tools/CodeFileChange";
import { diffTotals } from "../../diff/diff-model";
import { AppIcon } from "../../ui/app-icon";
import { t, tf, useT } from "../../i18n";

/** Files listed before "Show N more". */
const FIRST_FILES = 3;

const basename = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * "+a −d" as one two-part pill: 11 sp / 550 text in g74.F on its 20 % tint,
 * then g74.e on its tint, 6 dp inside, 18 dp tall, 4.5 dp corners round the
 * pair.
 */
function DiffPill({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (!additions && !deletions) return null;
  return (
    <span className="official-diff-pill">
      <span data-add>{`+${additions}`}</span>
      <span data-del>{`−${deletions}`}</span>
    </span>
  );
}

/** A path as qfx.d draws it: the folder muted, then the file name. */
function FilePath({ path }: { path: string }) {
  const shown = shownPath(path);
  const name = basename(shown);
  const folder = shown.slice(0, shown.length - name.length);
  return (
    <span className="official-edits-path">
      {folder && (
        <span className="official-edits-folder">
          <bdi dir="ltr">{folder}</bdi>
        </span>
      )}
      <span className="official-edits-name">{name}</span>
    </span>
  );
}

/**
 * After a Code turn that changed files, the official turn-edits card: a 12 dp
 * bordered card holding one header row, the edit icon, "Edited {file}" (or
 * "Created {file}" for a new one; "Edited N files" for several), the line
 * totals, and Review, which opens the diff. With several files the first three
 * follow, each with its own totals and a caret, then "Show N more" / "Show
 * less". Undo is not on the phones.
 */
export function OfficialTurnChanges({
  turn,
  onOpen,
}: {
  turn: Turn;
  onOpen: () => void;
}) {
  useT();
  const [all, setAll] = useState(false);
  if (turn.status === "inProgress") return null;
  const files = turnChangedFiles(turn);
  const totals = diffTotals(files);
  if (!totals.files) return null;
  const single = files.length === 1 ? files[0] : undefined;
  const title = single
    ? tf(single.status === "added" ? "Created {file}" : "Edited {file}", {
        file: basename(single.path),
      })
    : tf("Edited {n} files", { n: files.length });
  const shown = all ? files : files.slice(0, FIRST_FILES);
  const more = files.length - FIRST_FILES;
  return (
    <div className="official-turn-edits">
      <div className="official-edits-header">
        {(() => {
          const content = (
            <>
              <span className="official-edits-icon" aria-hidden="true">
                <AppIcon name="Edit" />
              </span>
              <span className="official-edits-text">{title}</span>
              <DiffPill
                additions={totals.additions}
                deletions={totals.deletions}
              />
            </>
          );
          // Only a lone file's title opens it.
          return single ? (
            <button
              type="button"
              className="official-edits-title"
              onClick={onOpen}
            >
              {content}
            </button>
          ) : (
            <div className="official-edits-title">{content}</div>
          );
        })()}
        <button
          type="button"
          className="official-edits-review"
          onClick={onOpen}
        >
          {t("Review")}
        </button>
      </div>
      {files.length > 1 && (
        <ul className="official-edits-files">
          {shown.map((file, index) => (
            <li key={`${file.path}:${index}`}>
              <button type="button" onClick={onOpen}>
                <FilePath path={file.path} />
                <DiffPill
                  additions={file.additions}
                  deletions={file.deletions}
                />
                <span className="official-edits-caret" aria-hidden="true">
                  <AppIcon name="CaretRight" />
                </span>
              </button>
            </li>
          ))}
          {more > 0 && (
            <li>
              <button
                type="button"
                className="official-edits-more"
                aria-expanded={all}
                onClick={() => setAll((value) => !value)}
              >
                <span>
                  {all ? t("Show less") : tf("Show {n} more", { n: more })}
                </span>
                <span
                  className="official-edits-caret"
                  data-open={all || undefined}
                  aria-hidden="true"
                >
                  <AppIcon name="CaretDownSmall" />
                </span>
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
