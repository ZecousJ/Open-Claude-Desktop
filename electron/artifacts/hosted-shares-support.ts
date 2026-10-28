import { createHash } from "node:crypto";
import type { ShareKind } from "../../shared/sharing-api";
import type { ShareSnapshot } from "../../shared/sharing";
import type { ArtifactShareInput } from "../../shared/types";

export const unavailableMessage = "Sharing isn't available on this service.";

/** Why a version can't be published again. */
export const previouslyUnpublishedMessage =
  "This artifact was previously unpublished. Create a new artifact to publish again.";

/** The administrator took the version's page down. */
export const takenDownMessage =
  "Your administrator removed this page. Its link no longer opens.";

/** Remembered sources, most recent last; older ones are dropped beyond this. */
export const maxSources = 1000;

/** An identity longer than this is kept for this run only (inline code artifacts). */
export const maxStoredSource = 200_000;

/** The hash the service keeps instead of a conversation id or artifact identity. */
export function sourceKeyOf(kind: ShareKind, source: string) {
  return createHash("sha256").update(`${kind}\n${source}`).digest("hex");
}

export const digestOf = (snapshot: ShareSnapshot) =>
  createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

/** An artifact version is its content: the same text is the same version. */
export function versionOf(
  input: Pick<ArtifactShareInput, "language" | "content">,
) {
  return createHash("sha256")
    .update(`${input.language}\n${input.content}`)
    .digest("hex");
}

export const versionSource = (identity: string, version: string) =>
  `${identity}\u0000${version}`;

/** The hash the service keeps for one version of an artifact. */
export function versionKeyOf(input: ArtifactShareInput) {
  return sourceKeyOf(
    "artifact",
    versionSource(input.identity, versionOf(input)),
  );
}

export const sharingSource = (identity: string) => `shared\n${identity}`;

export const sharingKeyOf = (identity: string, version?: string) =>
  sourceKeyOf(
    "artifact",
    version
      ? versionSource(sharingSource(identity), version)
      : sharingSource(identity),
  );

export const sharingStopKey = (identity: string) => `sharing\n${identity}`;
