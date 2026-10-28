/**
 * This build against the service's release information: when an update stops
 * sending, what Check for Updates says, and the release notes What's new shows.
 */
import type { ClientPolicy, ClientUpdate } from "./client-policy";

export const automaticUpdateNotice = {
  title: "Update Available",
  message:
    "A new version is available. It will be downloaded and installed automatically.",
  buttons: ["OK"],
};

/**
 * Whether a required update stops sending. The service says whether it
 * enforces its minimum version (`release.enforced`, off unless the
 * administrator turns it on); without that answer a required update is
 * enforced, as the policy file for local accounts always did.
 */
export function updateBlocksSending(update: ClientUpdate | undefined) {
  return update?.state === "required" && update.enforced !== false;
}

/** Composer placeholder while a required update stops sending. */
export const updateRequiredPlaceholder = "Update Claudex to keep working";

/**
 * The service's release notes for the newest version (`release_notes_md`,
 * with `version` and `published_at` from the same release). Package C2 adds
 * them to the policy it sends the window as `releaseNotes`; until it does
 * What's new shows only the bundled notes and announcements.
 */
export interface ServiceReleaseNotes {
  version: string;
  /** Markdown; shown without raw HTML and without loading remote images. */
  markdown: string;
  /** Epoch ms. */
  publishedAt?: number;
}
/** A policy that may carry the service's release notes (see ServiceReleaseNotes). */
export type PolicyWithReleaseNotes = ClientPolicy & {
  releaseNotes?: ServiceReleaseNotes;
};

/** The longest release notes shown (the service accepts up to 20,000 characters). */
const maxNotes = 20_000;

/** The release notes in a policy, when they are well formed. */
export function serviceReleaseNotes(
  policy: ClientPolicy,
): ServiceReleaseNotes | undefined {
  const notes = (policy as PolicyWithReleaseNotes).releaseNotes as unknown;
  if (!notes || typeof notes !== "object") return undefined;
  const { version, markdown, publishedAt } = notes as Record<string, unknown>;
  if (typeof version !== "string" || !/^\d[\w.+-]{0,63}$/.test(version))
    return undefined;
  if (typeof markdown !== "string" || !markdown.trim()) return undefined;
  return {
    version,
    markdown: markdown.slice(0, maxNotes),
    ...(typeof publishedAt === "number" && Number.isFinite(publishedAt)
      ? { publishedAt }
      : {}),
  };
}

/** What Check for Updates reports, from the policy's update and this build's version. */
export function updateCheckResult(
  update: ClientUpdate | undefined,
  currentVersion: string,
) {
  if (!update)
    return {
      title: "No Update Available",
      detail: "You are running the latest version.",
    };
  if (update.state === "available")
    return {
      title: "Update Available",
      detail: `Claudex ${update.latestVersion} is available. You have ${update.currentVersion}.`,
    };
  return updateBlocksSending(update)
    ? {
        title: "Update required",
        detail: `This version of Claudex (${update.currentVersion}) is no longer supported. Install ${update.latestVersion} to keep working.`,
      }
    : {
        title: `Update to Claudex ${update.latestVersion}`,
        detail: `Your administrator no longer supports Claudex ${update.currentVersion}. Install ${update.latestVersion} soon.`,
      };
}
