import { useConversationServices } from "../../conversation/ConversationServices";
import {
  Clock3,
  Image as ImageIcon,
  ScanEye,
  ChevronRight,
} from "../../ui/glyphs";
import { Suspense, useContext, useEffect, useState } from "react";
import { AppContext } from "../../app/AppContext";
import type { Item } from "../../../shared/types";
import type { GeneratedImage } from "../../../shared/artifacts-api";
import { itemIsRunning } from "../../../shared/activity";
import { ActivityMark } from "../TurnActivity";
import type { Artifact } from "../../ui/ArtifactTypes";
import { useSnapshotUrl } from "../../artifacts/useGeneratedBytes";
import { lazyPiece } from "../../ui/lazy-piece";
import { formatText } from "../../i18n";

const CodeReviewCard = lazyPiece(
  () => import("../../review/CodeReviewCard"),
  "CodeReviewCard",
);

function basename(value: unknown) {
  return typeof value === "string" ? value.split(/[\\/]/).at(-1) : undefined;
}
function safeImage(value: unknown) {
  return typeof value === "string" &&
    value.length < 2_000_100 &&
    /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(
      value,
    )
    ? value
    : undefined;
}
export function SessionToolView({
  item,
  onArtifact,
}: {
  item: Item;
  /** Opens a generated picture in the file viewer. */
  onArtifact?: (artifact: Artifact) => void;
}) {
  const running = itemIsRunning(item);
  if (item.type === "contextCompaction") {
    // A compaction whose turn failed ends with that status (recordItemLifecycle);
    // the live row says "Compaction failed" then (shared-9 iU).
    const failed =
      item.lifecycleStatus === "failed" || item.status === "failed";
    return (
      // A plain grey line, "Compacting session…" then "Compacted session"
      // (Codex reports no saved-token count for the original's "· saved 61.6k
      // tokens"); a compaction that failed says so.
      <div className="agent-tool-event compaction-event" role="status">
        <span>
          {running
            ? "Compacting session…"
            : failed
              ? "Compaction failed"
              : "Compacted session"}
        </span>
      </div>
    );
  }
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
    const row = (
      <div className="agent-tool-event" role="status">
        <ScanEye size={14} />
        <span>
          {item.type === "enteredReviewMode"
            ? "Started review"
            : "Finished review"}
        </span>
        {typeof item.review === "string" && <small>{item.review}</small>}
      </div>
    );
    // The review's end is the Code review card, with its findings.
    return item.type === "exitedReviewMode" ? (
      <Suspense fallback={row}>
        <CodeReviewCard item={item} />
      </Suspense>
    ) : (
      row
    );
  }
  if (item.type === "sleep") {
    // "Waiting 60 seconds" while it runs, "Slept for 60 seconds" once done. The
    // requested time is not on the running item, so the running row says
    // "Waiting" alone.
    const seconds = Math.max(
      0,
      Math.round(Number(item.durationMs ?? 0) / 1000),
    );
    const unit = (n: number) => `${n} ${n === 1 ? "second" : "seconds"}`;
    return (
      <div className="agent-tool-event" role="status">
        {running ? <ActivityMark phase="thinking" /> : <Clock3 size={14} />}
        <span>{running ? "Waiting" : `Slept for ${unit(seconds)}`}</span>
      </div>
    );
  }
  const generated = item.type === "imageGeneration";
  const label = generated
    ? running
      ? "Generating an image"
      : item.status === "failed"
        ? "Image generation failed"
        : "Generated an image"
    : "Viewed an image";
  const image = safeImage(item.result),
    filename = basename(generated ? item.savedPath : item.path);
  const preview =
    generated &&
    !running &&
    item.status !== "failed" &&
    typeof item.savedPath === "string" &&
    item.savedPath ? (
      <GeneratedImagePreview
        savedPath={item.savedPath}
        name={filename ?? "Generated image"}
        onArtifact={onArtifact}
      />
    ) : null;
  return (
    <>
      <SessionToolRow
        item={item}
        running={running}
        generated={generated}
        label={label}
        image={image}
        filename={filename}
        thumbnail={
          !generated &&
          !running &&
          typeof item.path === "string" &&
          item.path ? (
            <ViewedImageThumbnail
              path={item.path}
              name={filename ?? "Image"}
              onArtifact={onArtifact}
            />
          ) : null
        }
      />
      {preview}
    </>
  );
}

/**
 * The picture under "Generated an image": a 240px tall thumbnail read from its
 * profile snapshot; clicking it opens the image in the file viewer.
 */
export function GeneratedImagePreview({
  savedPath,
  name,
  onArtifact,
}: {
  savedPath: string;
  name: string;
  onArtifact?: (artifact: Artifact) => void;
}) {
  const services = useConversationServices();
  const [snapshot, setSnapshot] = useState<GeneratedImage | null>();
  useEffect(() => {
    let live = true;
    setSnapshot(undefined);
    services.imageGenerationSnapshot(savedPath).then(
      (value) => live && setSnapshot(value),
      () => live && setSnapshot(null),
    );
    return () => {
      live = false;
    };
  }, [savedPath, services]);
  if (!snapshot) return null;
  return (
    <SnapshotThumbnail
      artifact={generatedImageArtifact(snapshot, savedPath, name)}
      onArtifact={onArtifact}
    />
  );
}

/** The file viewer's artifact for a generated picture's snapshot. */
export function generatedImageArtifact(
  snapshot: GeneratedImage,
  savedPath: string,
  name: string,
): Artifact {
  return {
    id: `generated-image:${snapshot.digest}`,
    name,
    filename: name,
    language: "text",
    content: "",
    blob: true,
    mime: snapshot.mime,
    bytes: snapshot.bytes,
    sourcePath: savedPath,
    sourceDigest: snapshot.digest,
    surface: "file",
  };
}

/**
 * The picture the agent viewed, as a 111×62 thumbnail at the row's right end:
 * snapshotted from the conversation's working folder, and opening in the file
 * viewer.
 */
export function ViewedImageThumbnail({
  path,
  name,
  onArtifact,
}: {
  path: string;
  name: string;
  onArtifact?: (artifact: Artifact) => void;
}) {
  const app = useContext(AppContext);
  const services = useConversationServices();
  const conversationId = app?.activeId ?? services.conversationId;
  const [snapshot, setSnapshot] = useState<GeneratedImage | null>();
  useEffect(() => {
    if (!conversationId) return;
    let live = true;
    services.viewedImageSnapshot(conversationId, path).then(
      (value) => live && setSnapshot(value),
      () => live && setSnapshot(null),
    );
    return () => {
      live = false;
    };
  }, [conversationId, path, services]);
  if (!snapshot) return null;
  return (
    <span className="viewed-image-thumbnail">
      <SnapshotThumbnail
        artifact={generatedImageArtifact(snapshot, path, name)}
        onArtifact={onArtifact}
      />
    </span>
  );
}

function SnapshotThumbnail({
  artifact,
  onArtifact,
}: {
  artifact: Artifact;
  onArtifact?: (artifact: Artifact) => void;
}) {
  const { url } = useSnapshotUrl(artifact);
  if (!url) return null;
  const image = <img src={url} alt={artifact.name} draggable={false} />;
  return onArtifact ? (
    <button
      type="button"
      className="generated-image-preview"
      aria-label={formatText("Open {name}", { name: artifact.name })}
      onClick={() => onArtifact(artifact)}
    >
      {image}
    </button>
  ) : (
    <div className="generated-image-preview">{image}</div>
  );
}

function SessionToolRow({
  item,
  running,
  generated,
  label,
  image,
  filename,
  thumbnail,
}: {
  item: Item;
  running: boolean;
  generated: boolean;
  label: string;
  image?: string;
  filename?: string;
  /** The viewed picture at the row's right end. */
  thumbnail?: React.ReactNode;
}) {
  return (
    <details
      className={`activity session-tool-activity${item.status === "failed" ? " failed" : ""}`}
    >
      <summary>
        {running ? <ActivityMark phase="tools" /> : <ImageIcon size={15} />}
        <span>{label}</span>
        {filename && <small>{filename}</small>}
        <ChevronRight size={13} />
        {thumbnail}
      </summary>
      <div className="activity-body session-tool-body">
        {generated &&
          typeof item.revisedPrompt === "string" &&
          item.revisedPrompt && (
            <section>
              <strong>Prompt</strong>
              <p>{item.revisedPrompt}</p>
            </section>
          )}
        {image ? (
          <img src={image} alt="Generated image result" />
        ) : filename ? (
          <p>{filename}</p>
        ) : (
          <p>
            {running
              ? "Waiting for image…"
              : item.resultOmitted
                ? "Large image omitted from this transcript"
                : "Image result is not available in this view"}
          </p>
        )}
      </div>
    </details>
  );
}
