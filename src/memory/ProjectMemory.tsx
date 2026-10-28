import { Suspense, useEffect, useState } from "react";
import { lazyPiece } from "../ui/lazy-piece";
import { LockKeyhole, Pencil } from "../ui/glyphs";
import type { MemoryDocView } from "../../shared/memory-api";
import { formatText, useT } from "../i18n";
import { relativeTime } from "../ui/RelativeTime";
import {
  flattenMemory,
  projectMemoryEmpty,
  projectMemoryState,
  showsProjectMemory,
} from "./project-memory";
import { useMemory } from "./useMemory";
import { Skeleton } from "../ui/Skeleton";

// Manage project memory and its styles load when Edit memory is pressed.
const ManageMemoryDialog = lazyPiece(
  () => import("./ManageMemoryDialog"),
  "ManageMemoryDialog",
);

/**
 * * "Memory" with the "Only you" pill and, once the project has memory, an Edit
 *   memory pencil; then the memory, or "Project memory will show here after a
 *   few chats." (muted) while there is none, or "Couldn't load project memory."
 *   with Try again when the read failed; and "Last updated …" under memory that
 *   has a date. Shown only while memory is usable and Generate is on.
 */
export function ProjectMemory({
  projectId,
  onError,
}: {
  projectId: string;
  onError: (error: unknown) => void;
}) {
  useT();
  const memory = useMemory(onError);
  // undefined while reading; null when the project has no memory yet.
  const [doc, setDoc] = useState<MemoryDocView | null>();
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reads, setReads] = useState(0);
  const shows = showsProjectMemory(memory.status);
  useEffect(() => {
    if (!shows) return;
    let live = true;
    const read = () =>
      void window.desktop
        .memoryDoc({ kind: "project", projectId })
        .then((value) => {
          if (!live) return;
          setDoc(value);
          setFailed(false);
        })
        .catch(() => {
          if (live) setFailed(true);
        })
        .finally(() => {
          if (live) setRetrying(false);
        });
    read();
    const off = window.desktop.onEvent((event) => {
      if (event.type === "memory-changed") read();
    });
    return () => {
      live = false;
      off();
    };
  }, [shows, projectId, reads]);
  if (!shows) return null;
  const state = projectMemoryState(doc, failed);
  return (
    <section aria-busy={state === "loading" || retrying || undefined}>
      <div className="prj-side-head">
        <h2>Memory</h2>
        <span className="prj-only-you">
          <LockKeyhole size={11} strokeWidth={1.8} aria-hidden="true" />
          Only you
        </span>
        {state === "memory" && (
          <button
            type="button"
            aria-label="Edit memory"
            onClick={() => setEditing(true)}
          >
            <Pencil size={16} strokeWidth={1.6} />
          </button>
        )}
      </div>
      {state === "loading" ? (
        <span className="prj-memory-placeholder" aria-hidden="true">
          <Skeleton width="60%" height={12} />
        </span>
      ) : state === "failed" ? (
        <>
          <p className="prj-muted prj-memory-body">
            Couldn’t load project memory.
          </p>
          <button
            type="button"
            className="secondary prj-memory-retry"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              setReads((count) => count + 1);
            }}
          >
            Try again
          </button>
        </>
      ) : state === "empty" ? (
        <p className="prj-muted">{projectMemoryEmpty}</p>
      ) : (
        <>
          <p className="prj-muted prj-memory-body" data-no-translate>
            {flattenMemory(doc!.content)}
          </p>
          {doc!.updatedAt > 0 && (
            <p className="prj-muted prj-memory-updated" data-no-translate>
              {formatText("Last updated {time}", {
                time: relativeTime(doc!.updatedAt),
              })}
            </p>
          )}
        </>
      )}
      {editing && (
        <Suspense fallback={null}>
          <ManageMemoryDialog
            scope={{ kind: "project", projectId }}
            initial={doc ?? undefined}
            onClose={() => setEditing(false)}
            onChanged={() => void memory.reload()}
          />
        </Suspense>
      )}
    </section>
  );
}
