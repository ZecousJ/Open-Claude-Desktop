import { Fragment, useState } from "react";
import { addReviewComment, useReviewComments } from "./review-comments";
import { ArrowUpRight, ChevronDown } from "../ui/glyphs";
import { DiffLines, SplitDiffLines } from "../diff/DiffLines";
import {
  hiddenGaps,
  languageForPath,
  whitespaceOnly,
  type DiffFile,
} from "../diff/diff-model";
import { formatText, t } from "../i18n";
import type { GitHubReviewThread } from "../../shared/github-api";
import { ReviewThreadCard } from "./ReviewThreadCard";
import { ReviewFindingCard } from "./ReviewFindingCard";
import type { DiffFinding, FindingStatus } from "../review/diff-findings";
import { threadElementId } from "./useReviewThreads";

/**
 * What a file's header says beside its name: a binary file, only whitespace
 * moved, or the executable bit changed.
 */
export function fileBadge(file: DiffFile) {
  if (file.binary) return "Binary file";
  if (whitespaceOnly(file)) return "Whitespace only";
  if (file.executable === true) return "Made executable";
  if (file.executable === false) return "No longer executable";
  return undefined;
}

/** "Renamed from {path}": the old name alone when the folder stayed. */
export function renamedFrom(file: DiffFile) {
  if (!file.oldPath || file.oldPath === file.path) return undefined;
  const folder = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
  return folder(file.oldPath) === folder(file.path)
    ? file.oldPath.slice(file.oldPath.lastIndexOf("/") + 1)
    : file.oldPath;
}

/** The small `</>` file glyph in the Changes list and section headers. */
export function FileGlyph() {
  return (
    <svg
      className="changes-file-glyph"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 2.5 0.8 5 3 7.5M7 2.5 9.2 5 7 7.5M5.9 1.8 4.1 8.2" />
    </svg>
  );
}

export function DiffStat({ file }: { file: DiffFile }) {
  return (
    <span className="changes-stat">
      <span className="changes-add">+{file.additions}</span>
      <span className="changes-del">−{file.deletions}</span>
    </span>
  );
}

function MoreLines({ onMore }: { onMore: () => void }) {
  return (
    <button className="changes-more" onClick={onMore}>
      <ChevronDown size={16} strokeWidth={1.75} />
      Show more lines
    </button>
  );
}

/** One file's header row and hunks, with "Show more lines" where lines are hidden. */
export function ChangedFileSection({
  file,
  lineCount,
  collapsed,
  sectionRef,
  onToggle,
  onMore,
  words = true,
  split = false,
  wrap = false,
  onMenu,
  displayPath,
  onOpenFile,
  onViewImage,
  conversationId,
  threads = [],
  canApply = false,
  onThreadsChanged,
  threadNav,
  findings = [],
  findingCard,
}: {
  file: DiffFile;
  lineCount?: number;
  collapsed: boolean;
  sectionRef: (node: HTMLElement | null) => void;
  onToggle: () => void;
  /** More context around the hunks; without it (a turn's own diff) none is offered. */
  onMore?: () => void;
  /** Whether the words that changed within a line are emphasised. */
  words?: boolean;
  /** Side by side instead of one column (the settings menu's choice). */
  split?: boolean;
  /** Long lines wrap (Word wrap). */
  wrap?: boolean;
  /** The file's right-click menu. */
  onMenu?: (event: React.MouseEvent) => void;
  /** The name the header shows (the path inside the session folder). */
  displayPath?: string;
  /** Open file: the file in the session's file pane. */
  onOpenFile?: () => void;
  /** View image, for an image file (the before and after dialog). */
  onViewImage?: () => void;
  /** Lines take comments for Claude (the Changes panel's diffs). */
  conversationId?: string;
  /** The pull request's review threads on this file, under their lines. */
  threads?: GitHubReviewThread[];
  /** Suggested changes can be written here. */
  canApply?: boolean;
  onThreadsChanged?: () => void;
  /** Previous / Next comment across the panel's open threads. */
  threadNav?: (id: string, step: -1 | 1) => (() => void) | undefined;
  /** The latest review's findings on this file, under their lines. */
  findings?: DiffFinding[];
  findingCard?: (finding: DiffFinding) => {
    status: FindingStatus;
    onFix?: () => void;
    onNext?: () => void;
    onDismiss: () => void;
  };
}) {
  // The comment being written: its hunk and rows (shift-click extends).
  const [draft, setDraft] = useState<{
    hunk: number;
    start: number;
    end: number;
    text: string;
  }>();
  const comments = useReviewComments(conversationId).filter(
    (comment) => comment.file === file.path,
  );
  const lineNo = (hunk: number, index: number) => {
    const line = file.hunks[hunk].lines[index];
    return line.newNo ?? line.oldNo ?? 0;
  };
  const submit = () => {
    if (!draft || !conversationId || !draft.text.trim()) return;
    const lines = file.hunks[draft.hunk].lines.slice(
      draft.start,
      draft.end + 1,
    );
    addReviewComment(conversationId, {
      file: file.path,
      startLine: lineNo(draft.hunk, draft.start),
      endLine: lineNo(draft.hunk, draft.end),
      code: lines.map((line) => line.text).join("\n"),
      text: draft.text.trim(),
    });
    setDraft(undefined);
  };
  const gaps = onMore
    ? hiddenGaps(file, lineCount)
    : { before: [] as boolean[], after: false };
  return (
    <section className="changes-file" ref={sectionRef}>
      <div className="changes-file-head">
        <button
          className="changes-file-header"
          aria-expanded={!collapsed}
          onClick={onToggle}
          onContextMenu={onMenu}
        >
          <ChevronDown size={16} strokeWidth={1.75} />
          <FileGlyph />
          <span className="changes-file-name" title={file.path}>
            {displayPath ?? file.path}
          </span>
          {renamedFrom(file) && (
            <span className="changes-file-badge" title={file.oldPath}>
              {formatText("Renamed from {path}", { path: renamedFrom(file)! })}
            </span>
          )}
          {fileBadge(file) && (
            <span className="changes-file-badge">{t(fileBadge(file)!)}</span>
          )}
          <DiffStat file={file} />
        </button>
        {onViewImage && (
          <button className="changes-view-image" onClick={onViewImage}>
            {t("View image")}
          </button>
        )}
        {/* Open file shows while the header is hovered or focused. */}
        {onOpenFile && (
          <button
            type="button"
            className="changes-open-file"
            aria-label={t("Open file")}
            title={t("Open file")}
            onClick={onOpenFile}
          >
            <ArrowUpRight size={14} />
          </button>
        )}
      </div>
      {!collapsed &&
        (file.binary ? (
          <p className="changes-note">Binary file</p>
        ) : (
          <div
            className="changes-hunks diff-lines"
            data-variant="panel"
            data-split={split || undefined}
            data-wrap={wrap || undefined}
          >
            {file.hunks.map((hunk, index) => (
              <Fragment key={index}>
                {onMore && gaps.before[index] && <MoreLines onMore={onMore} />}
                {split ? (
                  <SplitDiffLines
                    lines={hunk.lines}
                    language={languageForPath(file.path)}
                    words={words}
                  />
                ) : (
                  <DiffLines
                    lines={hunk.lines}
                    language={languageForPath(file.path)}
                    words={words}
                    onComment={
                      conversationId
                        ? (row, event) =>
                            setDraft((current) =>
                              event.shiftKey &&
                              current &&
                              current.hunk === index
                                ? {
                                    ...current,
                                    start: Math.min(current.start, row),
                                    end: Math.max(current.end, row),
                                  }
                                : {
                                    hunk: index,
                                    start: row,
                                    end: row,
                                    text: "",
                                  },
                            )
                        : undefined
                    }
                    marked={(row) => {
                      if (draft && draft.hunk === index)
                        return row >= draft.start && row <= draft.end;
                      const no = lineNo(index, row);
                      return comments.some(
                        (comment) =>
                          no >= comment.startLine && no <= comment.endLine,
                      );
                    }}
                    afterRow={(row) => {
                      const line = hunk.lines[row];
                      const here =
                        line && line.kind !== "del" && line.newNo !== undefined
                          ? threads.filter(
                              (thread) => thread.line === line.newNo,
                            )
                          : [];
                      const found =
                        line &&
                        line.kind !== "del" &&
                        line.newNo !== undefined &&
                        findingCard
                          ? findings.filter(
                              (finding) => finding.line === line.newNo,
                            )
                          : [];
                      const editor =
                        draft && draft.hunk === index && draft.end === row ? (
                          <form
                            className="diff-comment-editor"
                            onSubmit={(event) => {
                              event.preventDefault();
                              submit();
                            }}
                          >
                            <textarea
                              autoFocus
                              rows={3}
                              placeholder={t("Add a comment…")}
                              aria-label={t("Add a comment…")}
                              value={draft.text}
                              onChange={(event) =>
                                setDraft({ ...draft, text: event.target.value })
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Escape") setDraft(undefined);
                                if (
                                  event.key === "Enter" &&
                                  (event.metaKey || event.ctrlKey)
                                ) {
                                  event.preventDefault();
                                  submit();
                                }
                              }}
                            />
                            <div className="diff-comment-actions">
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => setDraft(undefined)}
                              >
                                {t("Discard comment")}
                              </button>
                              <button
                                type="submit"
                                className="primary"
                                disabled={!draft.text.trim()}
                              >
                                {t("Comment")}
                              </button>
                            </div>
                          </form>
                        ) : null;
                      if (!editor && !here.length && !found.length) return null;
                      return (
                        <>
                          {editor}
                          {found.map((finding) => (
                            <div
                              key={finding.id}
                              id={`review-finding-${finding.id.replace(/[^A-Za-z0-9_-]/g, "")}`}
                            >
                              <ReviewFindingCard
                                finding={finding}
                                {...findingCard!(finding)}
                              />
                            </div>
                          ))}
                          {here.map((thread) => (
                            <div
                              key={thread.id}
                              id={threadElementId(thread.id)}
                            >
                              <ReviewThreadCard
                                thread={thread}
                                conversationId={conversationId}
                                canApply={canApply}
                                onChanged={() => onThreadsChanged?.()}
                                onPrevious={threadNav?.(thread.id, -1)}
                                onNext={threadNav?.(thread.id, 1)}
                              />
                            </div>
                          ))}
                        </>
                      );
                    }}
                  />
                )}
              </Fragment>
            ))}
            {onMore && gaps.after && <MoreLines onMore={onMore} />}
          </div>
        ))}
    </section>
  );
}
