import type { Turn } from "../../shared/types";
import type { Artifact } from "../ui/ArtifactTypes";
import { generatedArtifact } from "./generatedArtifact";

/** A captured write remains distinct when a later write restores the same bytes. */
export function artifactWriteKey(value: Artifact) {
  return JSON.stringify([value.id, value.sourceDigest, value.updatedAt]);
}

export function sameArtifactWrite(a: Artifact, b: Artifact) {
  return artifactWriteKey(a) === artifactWriteKey(b);
}

/** A history write, distinct from both the document and its content digest. */
export type ArtifactVersion = Artifact & { versionId: string };

/** Legacy callers can supply snapshots without a history-local write key. */
export function versionIdOf(version: Artifact & { versionId?: string }) {
  return version.versionId ?? version.id;
}

/*
 * An artifact's versions. Every turn that writes a generated file keeps a
 * snapshot of it (its text, or its bytes under a digest), so a file the agent
 * rewrote has one version per write on the conversation's current branch:
 * version 1 is the first, the last is "Latest". Artifacts in a reply's code
 * blocks and library copies have no history.
 */

/**
 * The snapshots of the file at `path`, oldest first: one per write that
 * left it readable, a rewrite that changed nothing counted once.
 */
export function artifactVersions(
  turns: Turn[],
  path: string,
): ArtifactVersion[] {
  const versions: ArtifactVersion[] = [];
  for (const turn of turns)
    for (const item of turn.items)
      for (const [fileIndex, file] of (item.generatedFiles ?? []).entries()) {
        if (file.path !== path) continue;
        const version = generatedArtifact(
          file.capturedAt === undefined
            ? { ...file, capturedAt: turn.createdAt }
            : file,
        );
        if (!version) continue;
        if (versions.at(-1)?.sourceDigest === version.sourceDigest) continue;
        versions.push({
          ...version,
          versionId: JSON.stringify([turn.id, item.id, fileIndex]),
        });
      }
  return versions;
}

/** The 1-based number of a captured write, independently of its content digest. */
export function versionNumber(versions: Artifact[], id: string) {
  const index = versions.findIndex((value) => versionIdOf(value) === id);
  return index < 0 ? undefined : index + 1;
}

/** "v2 · Latest": the switcher's label for version `number` of `count`. */
export function versionLabel(number: number, count: number) {
  return number === count ? `v${number} · Latest` : `v${number}`;
}
