import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Conversation } from "../../shared/types";
import { artifactOutputKinds } from "../../shared/artifact-output";
import { blankArtifactFiles } from "../../shared/blank-artifacts";
const identity = z.string().uuid();
const unavailable = () =>
  new Error("The artifact is not available in this account.");
/** A private file in the owning engine's actual workspace, on desktop or its
 * authenticated web runner. No client path or saved cwd authorizes access. */
export function blankArtifactDirectory(
  workspace: string,
  conversationId: string,
  create = false,
) {
  identity.parse(conversationId);
  if (create) fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(workspace);
  const parent = path.join(root, ".claudex-artifacts");
  if (create) {
    try {
      fs.mkdirSync(parent, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (fs.realpathSync(parent) !== parent) throw unavailable();
  const directory = path.join(parent, conversationId);
  if (create) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (fs.realpathSync(directory) !== directory) throw unavailable();
  return directory;
}
export function resolveBlankArtifactFile(
  workspace: string,
  conversation: Conversation,
) {
  const artifact = conversation.blankArtifact;
  if (
    !artifact ||
    !artifactOutputKinds.includes(artifact.kind) ||
    artifact.file !== blankArtifactFiles[artifact.kind]
  )
    throw unavailable();
  const directory = blankArtifactDirectory(workspace, conversation.id);
  const file = path.join(directory, artifact.file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file)
    throw unavailable();
  return { directory, file, artifact };
}

/** An editor may pin a send to the revision it actually flushed. Another
 * window or agent cannot make that request silently use a different file. */
export function assertBlankArtifactRevision(
  workspace: string,
  conversation: Conversation,
  expected:
    import("../../shared/blank-artifacts").BlankArtifactRevision | undefined,
) {
  if (!expected) return;
  const file = resolveBlankArtifactFile(workspace, conversation).file;
  if (
    conversation.blankArtifact?.id !== expected.artifactId ||
    createHash("sha256").update(fs.readFileSync(file)).digest("hex") !==
      expected.revision
  )
    throw new Error("The saved artifact changed. Reopen it and try again.");
}
