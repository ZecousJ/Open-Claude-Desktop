import { sameArtifactWrite } from "./artifact-versions";
import { useConversationServices } from "../conversation/ConversationServices";
import { presentationId } from "../ui/presentation-id";
import {
  useArtifactMetadata,
  ArtifactConversation,
  artifactIdentity,
} from "./artifact-metadata";
import { useContext } from "react";
import { Globe, Laptop, LockKeyhole, Share } from "../ui/glyphs";
import { SheetTile, artifactLook } from "./SheetTile";
import { useSharingStatus } from "./artifact-publication";
import type { Artifact } from "../ui/components";
import {
  ArtifactLibraryContext,
  ArtifactSelection,
  ArtifactShareContext,
  sameArtifact,
} from "./artifact-context";
import { formatText } from "../i18n";
export {
  ArtifactLibraryContext,
  ArtifactSelection,
  ArtifactShareContext,
  sameArtifact,
};
/**
 * An HTML or SVG artifact in the transcript. While the agent is still writing
 * it the card shows only the file's name, "Artifact" and Open/Hide; when the
 * change that was writing it failed or stopped it is muted, gives the reason
 * and has nothing to open. The card is the original's sheet card: a grey page
 * with the Artifacts glyph that draws a web page's marks when hovered.
 */
export function ArtifactCard({
  artifact,
  onArtifact,
  failure,
}: {
  artifact: Artifact;
  onArtifact: (a: Artifact) => void;
  failure?: string;
}) {
  const services = useConversationServices();
  const conversationId = useContext(ArtifactConversation);
  artifact = useArtifactMetadata({
    ...artifact,
    conversationId: artifact.conversationId ?? conversationId,
  }).artifact;
  const selected = useContext(ArtifactSelection);
  // Share opens Publish on the panel: offered only when the Claudex
  // service takes artifact links.
  const publishable = Boolean(useSharingStatus()?.artifacts);
  const share = useContext(ArtifactShareContext).find(
    (value) => value.identity === artifactIdentity(artifact),
  );
  const open =
    !!selected &&
    selected.surface === "artifact" &&
    sameArtifact(selected, artifact) &&
    (!artifact.sourceDigest || sameArtifactWrite(selected, artifact));
  const selectedArtifact = {
    ...artifact,
    surface: "artifact" as const,
    versionPinned: artifact.sourceDigest ? true : undefined,
  };
  const state = failure
    ? "failed"
    : artifact.generating
      ? "generating"
      : "ready";
  const name =
    state === "ready"
      ? artifact.name
      : (artifact.filename ?? artifact.name).replace(/\.[a-z0-9]+$/i, "");
  const subtitle =
    state === "failed" ? (
      failure
    ) : state === "generating" ? (
      "Artifact"
    ) : (
      <>
        Artifact ·{" "}
        {share?.visibility === "link" && share.scope === "public" ? (
          // The reach's glyph and words, as the share popover's General access
          // tile draws them.
          <>
            <Globe size={10} /> Anyone with the link
          </>
        ) : share?.visibility === "link" ? (
          <>
            <Laptop size={10} /> On this computer
          </>
        ) : (
          <>
            <LockKeyhole size={10} /> Only you
          </>
        )}
      </>
    );
  if (state === "failed")
    return (
      <div
        className="file-document-card artifact-document-card sheet-card"
        data-tint={artifactLook.tint}
        data-state="failed"
        role="group"
        aria-label={`${name}: ${failure}`}
      >
        <span className="artifact-card-main">
          <SheetTile look={artifactLook} openable={false} />
          <span className="artifact-card-description">
            <strong>{name}</strong>
            <small>{subtitle}</small>
          </span>
        </span>
      </div>
    );
  return (
    <div
      className={`file-document-card artifact-document-card sheet-card${open ? " is-open" : ""}`}
      data-tint={artifactLook.tint}
      data-sheet-kind={artifactLook.kind}
      data-state={state}
    >
      <button
        className="artifact-card-main"
        aria-label={`View ${name}`}
        aria-pressed={open}
        onClick={() => onArtifact(selectedArtifact)}
      >
        <SheetTile look={artifactLook} openable />
        <span className="artifact-card-description">
          <strong>{name}</strong>
          <small>{subtitle}</small>
        </span>
      </button>
      {state === "ready" &&
        publishable &&
        services.inlineArtifactSharing !== false && (
          <button
            className="artifact-card-share"
            aria-label={formatText("Share {name}", { name })}
            onClick={() =>
              onArtifact({
                ...selectedArtifact,
                shareRequest: presentationId(),
              })
            }
          >
            <Share size={17} />
          </button>
        )}
      <button
        className="artifact-card-open"
        aria-label={`${open ? "Hide" : "Open"} ${name}`}
        onClick={() => onArtifact(selectedArtifact)}
      >
        {open ? "Hide" : "Open"}
      </button>
    </div>
  );
}
