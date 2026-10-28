import {
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CopyButton } from "../ui/Controls";
import { ReplyCopyIcon } from "../ui/ReplyIcons";
import { ChevronRight } from "../ui/glyphs";
import type { GeneratedFile, Item, Turn } from "../../shared/types";
import type { Artifact } from "../ui/ArtifactTypes";
import { generatedArtifact } from "../artifacts/generatedArtifact";
import { itemIsRunning } from "../../shared/activity";
import { DiffLines } from "../diff/DiffLines";
import { Collapsible } from "../ui/Collapsible";
import {
  useTranscriptViewContext,
  verboseOpen,
} from "../transcript-view/transcript-view-store";
import { WithTooltip } from "../ui/Tooltip";
import { AppIcon } from "../ui/app-icon";
import { FileTypeIcon } from "./FileTypeIcon";
import { sameDiffFile, useOpenDiffFile } from "../changes/diff-file-request";
import { isSessionFolder } from "../composer/recentFolders";
import { AppContext } from "../app/AppContext";
import { formatBytes } from "../../shared/format-bytes";
import {
  diffTotals,
  fileChangeDiff,
  languageForPath,
  parseUnifiedDiff,
  type DiffFile,
} from "../diff/diff-model";

const basename = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** The verb and, for one file, its name: "Editing" "app.js". */
export function fileChangeParts(item: Item): { verb: string; name?: string } {
  const changes = item.changes ?? [];
  const running = itemIsRunning(item);
  const failed = fileChangeFailure(item);
  if (failed) return { verb: failed.verb, name: failed.target };
  if (item.lifecycleStatus === "interrupted") return { verb: "Edit stopped" };
  const files = [...new Set(changes.map((change) => change.path))];
  const kinds = new Set(
    changes.map((change) =>
      typeof change.kind === "string" ? change.kind : change.kind?.type,
    ),
  );
  const verb =
    kinds.size === 1 && kinds.has("add")
      ? running
        ? "Creating"
        : "Created"
      : kinds.size === 1 && kinds.has("delete")
        ? running
          ? "Deleting"
          : "Deleted"
        : running
          ? "Editing"
          : "Edited";
  return {
    verb,
    name:
      files.length === 1
        ? basename(files[0])
        : `${files.length || "the"} files`,
  };
}

/** "Editing app.js" while Codex applies the patch, "Edited app.js" after. */
export function fileChangeLabel(item: Item) {
  const { verb, name } = fileChangeParts(item);
  return name ? `${verb} ${name}` : verb;
}

/**
 * "+2 −1" for a file row or a group summary; hidden while the edit is still
 * running. A row's is the original's pill (its DiffIndicator's default
 * variant): the two counts on their own tinted halves of one chip.
 */
export function DiffStat({
  additions,
  deletions,
  pill = false,
}: {
  additions: number;
  deletions: number;
  pill?: boolean;
}) {
  return (
    <span className="code-diff-stat" data-variant={pill ? "pill" : undefined}>
      <span className="code-diff-add">+{additions}</span>
      <span className="code-diff-del">−{deletions}</span>
    </span>
  );
}

/** Line totals of the file changes among these items that were applied. */
export function itemsDiffTotals(items: Item[]) {
  return diffTotals(
    items
      .filter(
        (item) =>
          item.type === "fileChange" &&
          !itemIsRunning(item) &&
          !fileChangeFailure(item) &&
          item.lifecycleStatus !== "interrupted",
      )
      .flatMap((item) => (item.changes ?? []).map(fileChangeDiff)),
  );
}

/**
 * A write that did not happen: "Failed to write <file>" ("Failed to edit" for
 * changes to existing files) and why, shown in red when the row opens. Declined
 * edits say the person declined them.
 */
export function fileChangeFailure(item: Item) {
  const declined = item.status === "declined";
  if (
    !declined &&
    item.status !== "failed" &&
    item.lifecycleStatus !== "failed"
  )
    return undefined;
  const changes = item.changes ?? [];
  const files = [...new Set(changes.map((change) => change.path))];
  const adds = changes.every(
    (change) =>
      (typeof change.kind === "string" ? change.kind : change.kind?.type) ===
      "add",
  );
  const reason =
    typeof item.error === "string"
      ? item.error
      : typeof item.error?.message === "string"
        ? item.error.message
        : undefined;
  return {
    verb: adds ? "Failed to write" : "Failed to edit",
    target:
      files.length === 1
        ? basename(files[0])
        : `${files.length || "the"} files`,
    reason: declined
      ? "You declined this change, so the file was not written. Claudex stopped and waits for you to say how to go on."
      : (reason ?? "The change could not be applied."),
  };
}

/**
 * A path as the diff block shows it: from the profile's workspace down for a
 * chat without a folder, else whole.
 */
export function shownPath(path: string) {
  const match = /^.*[\\/]profiles[\\/][^\\/]+[\\/]workspace[\\/](.+)$/.exec(
    path,
  );
  return match ? match[1] : path;
}

/** The file's diff inside a bordered box, one per changed path. */
export function FileDiffBlock({
  file,
  onOpen,
  following = false,
}: {
  file: DiffFile;
  /** Opens the written file in the file panel. */
  onOpen?: () => void;
  /**
   * The file is still being written: its box keeps to the newest lines as they
   * arrive, until the person scrolls up to read.
   */
  following?: boolean;
}) {
  const lines = file.hunks.flatMap((hunk) => hunk.lines);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = box.current;
    if (!following || !element || !pinned.current) return;
    element.scrollTop = element.scrollHeight;
  }, [following, lines.length, lines.at(-1)?.text]);
  // The whole path on one line, its middle giving way to an ellipsis so the
  // file's name stays, and a copy button at the end.
  const slash = Math.max(
    file.path.lastIndexOf("/"),
    file.path.lastIndexOf("\\"),
  );
  const path = (
    <>
      <span className="code-file-diff-dir">
        {file.path.slice(0, slash + 1)}
      </span>
      <span className="code-file-diff-base">{file.path.slice(slash + 1)}</span>
    </>
  );
  return (
    <div className="code-file-diff">
      <div className="code-file-diff-path-row">
        {onOpen ? (
          <button
            type="button"
            className="code-file-diff-path code-file-open"
            title={file.path}
            onClick={onOpen}
          >
            {path}
          </button>
        ) : (
          <div className="code-file-diff-path" title={file.path}>
            {path}
          </div>
        )}
        <CopyButton iconOnly text={file.path} glyph={<ReplyCopyIcon />} />
      </div>
      {lines.length > 0 && (
        <div
          ref={box}
          className="diff-box diff-lines"
          data-new={file.status === "added" || undefined}
          onScroll={(event) => {
            const element = event.currentTarget;
            // Back at the bottom it follows again; scrolled up, it stays.
            pinned.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              24;
          }}
        >
          <DiffLines
            lines={lines}
            language={languageForPath(file.path)}
            markFirst={file.status === "added"}
          />
        </div>
      )}
    </div>
  );
}

/** Code-mode file edit row; expanding it shows the numbered diff. */
export function CodeFileChange({
  item,
  onArtifact,
}: {
  item: Item;
  onArtifact?: (artifact: Artifact) => void;
}) {
  const view = useTranscriptViewContext();
  const openDiffFile = useOpenDiffFile();
  const running = itemIsRunning(item);
  const files = (item.changes ?? []).map(fileChangeDiff);
  const failure = fileChangeFailure(item);
  if (failure)
    return (
      <details
        className="code-command code-file-change code-file-failed"
        open={verboseOpen(view)}
      >
        <summary>
          <span className="code-command-label">
            <em>{failure.verb}</em> {failure.target}
          </span>
          <ChevronRight size={16} strokeWidth={1.75} />
        </summary>
        <p className="code-file-failed-reason">{failure.reason}</p>
      </details>
    );
  const parts = fileChangeParts(item);
  const changedPaths = [...new Set((item.changes ?? []).map((c) => c.path))];
  const stat = itemsDiffTotals([item]);
  const written = (path: string): GeneratedFile | undefined =>
    item.generatedFiles?.find(
      (file) => file.path === path || file.path.endsWith(`/${basename(path)}`),
    );
  return (
    <details className="code-command code-file-change" open={verboseOpen(view)}>
      <summary>
        <span
          className="code-command-label"
          data-running={running || undefined}
        >
          {parts.verb}
          {parts.name && (
            <>
              {" "}
              {openDiffFile && !running && changedPaths.length === 1 ? (
                // A filename on an Edited or Wrote row opens that file in the
                // diff pane.
                <button
                  type="button"
                  className="code-file-name code-file-link"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openDiffFile(changedPaths[0]);
                  }}
                >
                  {parts.name}
                </button>
              ) : (
                <span className="code-file-name">{parts.name}</span>
              )}
            </>
          )}
        </span>
        {stat.files > 0 && (
          <DiffStat
            additions={stat.additions}
            deletions={stat.deletions}
            pill
          />
        )}
        <ChevronRight size={16} strokeWidth={1.75} />
      </summary>
      <div className="code-file-change-body">
        {files.map((file, index) => (
          <FileDiffBlock
            key={`${file.path}:${index}`}
            file={file}
            following={running}
            onOpen={(() => {
              const generated = written(file.path);
              const artifact = generated && generatedArtifact(generated);
              return artifact && onArtifact
                ? () => onArtifact(artifact)
                : undefined;
            })()}
          />
        ))}
      </div>
    </details>
  );
}

/** The files a turn changed: Codex's turn diff, else its applied edits. */
export function turnChangedFiles(turn: Turn): DiffFile[] {
  const diff = [...turn.items].reverse().find((item) => item.type === "diff");
  return typeof diff?.text === "string" && diff.text.trim()
    ? parseUnifiedDiff(diff.text)
    : turn.items
        .filter(
          (item) =>
            item.type === "fileChange" &&
            item.status !== "declined" &&
            item.status !== "failed",
        )
        .flatMap((item) => (item.changes ?? []).map(fileChangeDiff));
}

/** Files and line totals a turn changed. */
export function turnChanges(turn: Turn) {
  return diffTotals(turnChangedFiles(turn));
}

/**
 * A turn's files outside a repository: a card each, the file's type as a
 * badge, its name and its size, opening the file.
 */
function TurnFileCards({
  turn,
  files,
  onOpen,
}: {
  turn: Turn;
  files: DiffFile[];
  onOpen: (path?: string) => void;
}) {
  const generated = turn.items.flatMap((item) => item.generatedFiles ?? []);
  const shown = files.filter((file) => file.status !== "deleted");
  if (!shown.length) return null;
  return (
    <div className="turn-file-cards">
      {shown.map((file, index) => {
        const name = basename(file.path);
        const type = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toUpperCase();
        const bytes = generated.find((entry) =>
          sameDiffFile(entry.path, file.path),
        )?.bytes;
        return (
          <button
            key={`${file.path}:${index}`}
            type="button"
            className="turn-file-card"
            title={file.path}
            onClick={() => onOpen(file.path)}
          >
            {type && <span className="turn-file-badge">{type}</span>}
            <span className="turn-file-name">{name}</span>
            {typeof bytes === "number" && (
              <span className="turn-file-size">
                {formatBytes(bytes).replace(" ", "")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Files listed before "Show N more". */
const FIRST_FILES = 3;

/**
 * What Undo sends: the original asks Claude in a new message to put the turn's
 * files back, naming each one in backticks. Backticks and line breaks in a path
 * are dropped so the name stays one code span.
 */
export function undoChangesPrompt(paths: string[]) {
  const names = paths.map(
    (path) => `\`${path.replace(/[`\r\n\u2028\u2029]/g, "")}\``,
  );
  return names.length === 1
    ? `Undo the changes you made to ${names[0]} in your last turn and restore it to its previous state.`
    : [
        `Undo the changes you made to these ${names.length} files in your last turn and restore them to their previous state:`,
        ...names.map((name) => `- ${name}`),
      ].join("\n");
}

/**
 * The names a row shows beside a file whose name another file of the turn
 * shares: the shortest end of its folder that tells them apart; none for a
 * unique name.
 */
function folderHints(paths: string[]) {
  const parts = paths.map((path) => path.split(/[\\/]/).filter(Boolean));
  const hints = new Map<string, string>();
  parts.forEach((own, index) => {
    const name = own.at(-1) ?? paths[index];
    const others = parts.filter(
      (other, at) => at !== index && other.at(-1) === name,
    );
    if (!others.length) return;
    const folder = own.slice(0, -1);
    for (let n = 1; n <= folder.length; n++) {
      const end = folder.slice(-n).join("/");
      if (
        others.every((other) => other.slice(0, -1).slice(-n).join("/") !== end)
      ) {
        hints.set(paths[index], end);
        return;
      }
    }
    hints.set(paths[index], folder.join("/") || "/");
  });
  return hints;
}

/** One row of the card: its button, then the action and the counts. */
function TurnEditsRow({
  icon,
  label,
  detail,
  additions,
  deletions,
  action,
  tooltip,
  expanded,
  onOpen,
}: {
  icon?: ReactNode;
  label: ReactNode;
  detail?: string;
  additions: number;
  deletions: number;
  action?: ReactNode;
  tooltip?: string;
  /** A row that lists more files in place says whether they are shown. */
  expanded?: boolean;
  onOpen: () => void;
}) {
  const button = (props: object = {}) => (
    <button
      {...props}
      type="button"
      className="turn-edits-open"
      aria-expanded={expanded}
      onClick={onOpen}
    >
      <span className="turn-edits-main">
        {icon && <span className="turn-edits-icon">{icon}</span>}
        <span className="turn-edits-label">{label}</span>
        {detail && <span className="turn-edits-detail">{detail}</span>}
      </span>
    </button>
  );
  return (
    <li className="turn-edits-row">
      {tooltip ? (
        <WithTooltip label={tooltip}>{(props) => button(props)}</WithTooltip>
      ) : (
        button()
      )}
      <span className="turn-edits-end">
        {action && <span className="turn-edits-action">{action}</span>}
        <span className="turn-edits-meta">
          <DiffStat additions={additions} deletions={deletions} />
        </span>
      </span>
    </li>
  );
}

/**
 * * a bordered card whose header, "Edited N files" with the changes glyph,
 *   opens the turn's changes; then each file with its type icon, three before
 *   "Show N more"; each row ends in its line counts and a caret. One file is
 *   its own row, without the header. On the latest turn Undo asks Claude in a
 *   new message to put the files back.
 */
export function CodeTurnChanges({
  turn,
  onOpen,
  onUndo,
}: {
  turn: Turn;
  /** Opens the turn's changes, on one file when a file row asks. */
  onOpen: (path?: string) => void;
  /** Latest turn only: sends the Undo message. */
  onUndo?: (prompt: string) => void;
}) {
  const [all, setAll] = useState(false);
  const conversation = useContext(AppContext)?.active;
  if (turn.status === "inProgress") return null;
  const files = turnChangedFiles(turn);
  const totals = diffTotals(files);
  if (!totals.files) return null;
  // A session started without a folder has nothing to undo against: its files
  // are file cards that open the file; a folder keeps the edits card,
  // repository or not.
  if (
    conversation?.mode === "code" &&
    conversation.cwd &&
    isSessionFolder(conversation.cwd)
  )
    return <TurnFileCards turn={turn} files={files} onOpen={onOpen} />;
  const undo = onUndo && (
    <WithTooltip label="Ask Claudex to undo this turn’s file changes">
      {(tooltip) => (
        <button
          {...tooltip}
          type="button"
          className="turn-edits-undo"
          onClick={() =>
            onUndo(undoChangesPrompt(files.map((file) => file.path)))
          }
        >
          Undo
        </button>
      )}
    </WithTooltip>
  );
  const hints = folderHints(files.map((file) => file.path));
  const fileRow = (file: DiffFile, index: number, action?: ReactNode) => (
    <TurnEditsRow
      key={`${file.path}:${index}`}
      icon={
        <FileTypeIcon
          path={file.path}
          fallback={<span className="turn-edits-icon-space" />}
        />
      }
      label={basename(file.path)}
      detail={hints.get(file.path)}
      additions={file.additions}
      deletions={file.deletions}
      action={action}
      onOpen={() => onOpen(file.path)}
    />
  );
  if (files.length === 1)
    return (
      <div className="turn-edits-card">
        <ul className="turn-edits-list">{fileRow(files[0], 0, undo)}</ul>
      </div>
    );
  // Several files: "Edited N files" over a rule with Undo at its end, three
  // files, then a last row with the turn's totals: "See all" opens the turn's
  // changes, or past three files lists the rest in place ("Show less" folds
  // them).
  const more = files.length > FIRST_FILES;
  const shown = all || !more ? files : files.slice(0, FIRST_FILES);
  return (
    <div className="turn-edits-card">
      <div className="turn-edits-head">
        <span className="turn-edits-title">{`Edited ${files.length} files`}</span>
        {undo}
      </div>
      <div className="turn-edits-rule" aria-hidden="true" />
      <ul className="turn-edits-list">
        {shown.map((file, index) => fileRow(file, index))}
        <TurnEditsRow
          label={
            <span className="turn-edits-see-all">
              {more && all ? "Show less" : "See all"}
            </span>
          }
          additions={totals.additions}
          deletions={totals.deletions}
          tooltip={more ? undefined : "View this turn’s changes"}
          expanded={more ? all : undefined}
          onOpen={() => (more ? setAll((value) => !value) : onOpen())}
        />
      </ul>
    </div>
  );
}
