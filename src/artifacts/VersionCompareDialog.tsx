import { useMemo } from "react";
import { createPortal } from "react-dom";
import { DiffStat } from "../changes/ChangedFileSection";
import { DiffLines } from "../diff/DiffLines";
import { languageForPath } from "../diff/diff-model";
import { diffTexts } from "../diff/text-diff";
import { formatText } from "../i18n";
import { Modal } from "../ui/Controls";

/**
 * "Compare with current" in the version switcher: what changed from an earlier
 * version to the one the file has now, as the Changes panel shows a file's
 * change (numbered rows, +/- counts, the changed words emphasised). After the
 * original's compare of an earlier version with the current one, which opens a
 * dialog with a sentence and the file's diff; its own sentences were not in the
 * package, so the lead here is ours, and its notes are the original's: "Too
 * large to compare" when the texts differ too much, "Line endings only" when no
 * line differs.
 */
export function VersionCompareDialog({
  name,
  before,
  after,
  from,
  to,
  onClose,
}: {
  /** The file's name, for the language of the rows. */
  name: string;
  /** The earlier version's text, and the current one's. */
  before: string;
  after: string;
  /** Their 1-based version numbers. */
  from: number;
  to: number;
  onClose: () => void;
}) {
  const file = useMemo(
    () => diffTexts(before, after, name),
    [before, after, name],
  );
  const language = languageForPath(name);
  const dialog = (
    <Modal
      title="Compare with current"
      wide
      className="version-compare"
      onClose={onClose}
    >
      <p className="version-compare-lead">
        {formatText(
          "Changes from version {from} to the current version, {to}.",
          {
            from,
            to,
          },
        )}
        {file && file.hunks.length > 0 && <DiffStat file={file} />}
      </p>
      {!file ? (
        <p className="version-compare-note" role="status">
          Too large to compare
        </p>
      ) : !file.hunks.length ? (
        <p className="version-compare-note" role="status">
          Line endings only
        </p>
      ) : (
        <div className="version-compare-diff diff-lines" data-variant="panel">
          {file.hunks.map((hunk, index) => (
            <div className="version-compare-hunk" key={index}>
              <DiffLines lines={hunk.lines} language={language} />
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
  // Out of the panel, whose transforms would make the backdrop its own size.
  return typeof document === "undefined"
    ? dialog
    : createPortal(dialog, document.body);
}
