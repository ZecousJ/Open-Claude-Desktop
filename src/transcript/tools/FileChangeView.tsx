import { latestGeneratedFiles } from "../../../shared/generated-files";
import { ArtifactCard } from "../../artifacts/LazyArtifactCard";
import { ChevronRight } from "../../ui/glyphs";
import { itemIsRunning } from "../../../shared/activity";
import type { Item } from "../../../shared/types";
import type { Artifact } from "../../ui/components";
import { generatedArtifact } from "../../artifacts/generatedArtifact";
import { ActivityElapsed, ActivityLabel, ActivityMark } from "../TurnActivity";
import { Suspense, useContext, useEffect, useRef } from "react";
import { t } from "../../i18n";
import { AppContext } from "../../app/AppContext";
import { lazyPiece } from "../../ui/lazy-piece";

const capitalized = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

const GeneratedFileCards = lazyPiece(
  () => import("../../artifacts/GeneratedFileCards"),
);

export function FileChangeView({
  item,
  items = [item],
  startedAt,
  onArtifact,
}: {
  item: Item;
  items?: Item[];
  /** Turn start: a running edit shows its elapsed time from 5s ("Editing a file 5s ›"). */
  startedAt?: number;
  onArtifact: (file: Artifact) => void;
}) {
  const app = useContext(AppContext);
  const running = items.some(itemIsRunning);
  const failed = items.some(
    (i) => i.status === "failed" || i.lifecycleStatus === "failed",
  );
  const declined = items.some((i) => i.status === "declined");
  const stopped = items.some((i) => i.lifecycleStatus === "interrupted");
  const changes = items.flatMap((i) =>
    (i.changes ?? []).map((change, index) => ({
      change,
      file: i.generatedFiles?.[index],
      id: `${i.id}:${index}`,
      running: itemIsRunning(i),
    })),
  );
  const created =
    changes.length > 0 &&
    changes.every(
      ({ change: c }) =>
        (typeof c.kind === "string" ? c.kind : c.kind?.type) === "add",
    );
  const count = new Set(changes.map(({ change: c }) => c.path)).size;
  const label = running
    ? created
      ? "Creating a file"
      : "Editing a file"
    : declined
      ? "File changes declined"
      : failed
        ? "File changes failed"
        : stopped
          ? "File changes stopped"
          : capitalized(
              t(
                `${created ? "created" : "edited"} ${count === 1 ? "a file" : `${count} files`}`,
              ),
            );
  const rows = changes.map(({ change, file, id, running }) => {
    const artifact = file && generatedArtifact(file);
    const name = file?.name ?? change.path.split(/[\\/]/).at(-1) ?? change.path;
    const operation =
      typeof change.kind === "string" ? change.kind : change.kind?.type;
    return (
      <button
        className="generated-file-row"
        key={id}
        disabled={!artifact || running}
        title={file?.error ?? change.path}
        onClick={() => artifact && onArtifact(artifact)}
      >
        <span>
          {operation === "add"
            ? "Create"
            : operation === "delete"
              ? "Delete"
              : "Update"}
        </span>
        <strong>{name}</strong>
        {artifact && <ChevronRight size={12} />}
      </button>
    );
  });
  const latest = new Map(
    items.flatMap((i) => i.generatedFiles ?? []).map((f) => [f.path, f]),
  );
  const documents = [...latest.values()].filter(
    (f) => ["html", "svg"].includes(f.language) && f.state === "ready",
  );
  // Every other file the reply wrote gets its own card.
  const files = [...latest.values()].filter(
    (f) =>
      !["html", "svg"].includes(f.language) &&
      f.state === "ready" &&
      generatedArtifact(f),
  );
  const pending = pendingArtifacts(
    changes,
    new Set(documents.map((f) => f.path)),
    declined ? "declined" : failed ? "failed" : stopped ? "stopped" : null,
  );
  const errors = items
    .flatMap((i) => i.generatedFiles ?? [])
    .filter((f) => f.error);
  const extra = (
    <>
      {!!errors.length && (
        <div className="generated-file-errors" role="status">
          {errors.map((f) => (
            <p key={f.id}>
              {f.name}: {f.error}
            </p>
          ))}
        </div>
      )}
      {!documents.length && changes.some(({ change: c }) => c.diff) && (
        <details className="generated-diff">
          <summary>
            View changes
            <ChevronRight size={12} />
          </summary>
          {changes.map(({ change: c, id }) => (
            <pre key={id}>{c.diff}</pre>
          ))}
        </details>
      )}
    </>
  );
  // A finished edit collapses to one grey row, "Edited a file ›"
  // (generated-file-update-001 at 30s; "Edited 2 files ›" at 26s).
  return (
    <div className="file-change-result">
      <details className="command-activity file-change-activity">
        <summary>
          {running && <ActivityMark phase="tools" />}
          <ActivityLabel phase={running ? "tools" : undefined}>
            {label}
          </ActivityLabel>
          {running && startedAt !== undefined && (
            <ActivityElapsed startedAt={startedAt} />
          )}
          <ChevronRight size={12} />
        </summary>
        <div className="grouped-activity-card">{rows}</div>
        {extra}
      </details>
      <FileChangeCards items={items} onArtifact={onArtifact} />
    </div>
  );
}

/**
 * What a file change hands over under its row: an artifact card for each
 * HTML or SVG file (generating while it is written, muted when it could not
 * finish) and a card with Download for every other file. Chat shows them
 * under its steps group, the file change's own row folded into the group.
 */
export function FileChangeCards({
  items,
  onArtifact,
}: {
  items: Item[];
  onArtifact: (file: Artifact) => void;
}) {
  const app = useContext(AppContext);
  const running = items.some(itemIsRunning);
  const failed = items.some(
    (i) => i.status === "failed" || i.lifecycleStatus === "failed",
  );
  const declined = items.some((i) => i.status === "declined");
  const stopped = items.some((i) => i.lifecycleStatus === "interrupted");
  const changes = items.flatMap((i) =>
    (i.changes ?? []).map((change, index) => ({
      change,
      file: i.generatedFiles?.[index],
      running: itemIsRunning(i),
    })),
  );
  const latest = new Map(
    items.flatMap((i) => i.generatedFiles ?? []).map((f) => [f.path, f]),
  );
  const documents = [...latest.values()].filter(
    (f) => ["html", "svg"].includes(f.language) && f.state === "ready",
  );
  const files = [...latest.values()].filter(
    (f) =>
      !["html", "svg"].includes(f.language) &&
      f.state === "ready" &&
      generatedArtifact(f),
  );
  const pending = pendingArtifacts(
    changes,
    new Set(documents.map((f) => f.path)),
    declined ? "declined" : failed ? "failed" : stopped ? "stopped" : null,
  );
  if (!documents.length && !pending.length && (running || !files.length))
    return null;
  return (
    <>
      {documents.map((file) => (
        <ArtifactCard
          key={file.id}
          artifact={generatedArtifact(file)!}
          onArtifact={onArtifact}
        />
      ))}
      {pending.map(({ artifact, failure }) => (
        <ArtifactCard
          key={artifact.id}
          artifact={artifact}
          failure={failure}
          onArtifact={onArtifact}
        />
      ))}
      {!running && files.length > 0 && (
        <Suspense fallback={null}>
          <GeneratedFileCards
            files={files}
            all={[...documents, ...files]}
            platform={app?.snapshot.platform}
            onArtifact={onArtifact}
            onError={app?.report}
            onNotify={app?.notify}
          />
        </Suspense>
      )}
    </>
  );
}

const artifactLanguage = (file: string) =>
  /\.html?$/i.test(file) ? "html" : /\.svg$/i.test(file) ? "svg" : undefined;

/** Why an artifact's change ended without it. */
const failures = {
  declined: "Changes declined",
  failed: "Couldn't finish this artifact",
  stopped: "Stopped before it was finished",
} as const;

/**
 * HTML and SVG files the change is still writing or that it could not finish.
 * Files whose snapshot is ready show as ordinary artifact cards instead.
 */
export function pendingArtifacts(
  changes: {
    change: { path: string };
    file?: { state?: string };
    running: boolean;
  }[],
  ready: ReadonlySet<string>,
  ended: keyof typeof failures | null,
): { artifact: Artifact; failure?: string }[] {
  const seen = new Map<string, boolean>();
  for (const { change, file, running } of changes) {
    const language = artifactLanguage(change.path);
    if (!language || ready.has(change.path) || file?.state === "ready")
      continue;
    seen.set(change.path, (seen.get(change.path) ?? false) || running);
  }
  return [...seen].flatMap(([path, running]) => {
    if (!running && !ended) return [];
    const filename = path.split(/[\\/]/).at(-1) ?? path;
    const artifact: Artifact = {
      id: `pending-artifact:${path}`,
      name: filename,
      filename,
      language: artifactLanguage(path)!,
      content: "",
      sourcePath: path,
      ...(running ? { generating: true } : {}),
    };
    return [running ? { artifact } : { artifact, failure: failures[ended!] }];
  });
}

/**
 * Files a Chat or Cowork turn saved without a file change (a spreadsheet a
 * script wrote): their cards at the end of the reply, with Download, as the
 * original hands over its output files. No "Created a file" row.
 */
export function OutputFilesView({
  item,
  onArtifact,
}: {
  item: Item;
  onArtifact: (file: Artifact) => void;
}) {
  const app = useContext(AppContext);
  const ready = (item.generatedFiles ?? []).filter(
    (f) => f.state === "ready" && generatedArtifact(f),
  );
  const documents = ready.filter((f) => ["html", "svg"].includes(f.language));
  const files = ready.filter((f) => !["html", "svg"].includes(f.language));
  // Files a reply has just shared open in the side panel on their own (live
  // claude.ai opens the first one as it is shared); a conversation opened
  // later does not open them again.
  const first = ready.find((f) => !f.tooLarge);
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !first) return;
    opened.current = true;
    if (Date.now() - (first.capturedAt ?? 0) < 15_000) {
      // Only the newest version of the file opens by itself: when the reply
      // rewrote it, the older share must not open (or fail, or close the
      // newer one), and a file that could not be read again stays quiet.
      const latest = app?.active
        ? latestGeneratedFiles(app.active.turns).get(first.path)
        : undefined;
      if (app?.active && latest && latest.digest !== first.digest) return;
      const artifact = generatedArtifact(first);
      if (artifact) onArtifact(artifact);
    }
  }, [first, onArtifact]);
  if (!ready.length) return null;
  return (
    <div className="file-change-result output-files">
      {documents.map((file) => (
        <ArtifactCard
          key={file.id}
          artifact={generatedArtifact(file)!}
          onArtifact={onArtifact}
        />
      ))}
      {files.length > 0 && (
        <Suspense fallback={null}>
          <GeneratedFileCards
            files={files}
            all={ready}
            platform={app?.snapshot.platform}
            onArtifact={onArtifact}
            onError={app?.report}
            onNotify={app?.notify}
          />
        </Suspense>
      )}
    </div>
  );
}
