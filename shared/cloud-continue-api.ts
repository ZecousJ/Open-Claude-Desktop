/**
 * Continue in cloud: a local Code session moves to a cloud session with its
 * work exactly as it is now. "Move this session to the cloud?" shows what comes
 * along; Continue in cloud then saves the working tree as a commit of its own
 * on top of HEAD ("Saving your work"), uploads that commit to a ref of the
 * session's own on GitHub with the person's GitHub connection ("Uploading your
 * work"; nothing is pushed to their branch), writes the handoff note ("Writing
 * the handoff note") and starts the cloud session on that commit ("Starting the
 * cloud session"). The local session stays.
 *
 * Desktop only: the folder is on this computer. Handlers in
 * electron/ipc/cloud-continue.ts; electron/cloud/cloud-router.ts gives the
 * upload its lease from the service and says when the cloud is off.
 */
import { bridgeMethods } from "./bridge-methods";
import type { RepositoryRef } from "./host";

/** Why a session can't continue in the cloud from here. */
export type CloudContinuationBlock =
  /** The folder is not a git checkout. */
  | "noGit"
  /** The checkout has no remote named origin. */
  | "noRemote"
  /** origin isn't on github.com. */
  | "noGitHub"
  /** Not signed in to Claudex, or sync with the web is off. */
  | "signedOut"
  /** The session is not a Code session in a folder on this computer. */
  | "elsewhere";

/** What in the folder has to change before its work can move. */
export type CloudSnapshotBlocker =
  /** A rebase, merge, cherry-pick, revert or bisect is under way. */
  | "operation_in_progress"
  /** Unresolved merge conflicts. */
  | "conflicts"
  /** More untracked files than a move carries (2,000). */
  | "too_many_untracked";

/** What saving the folder's work would carry; at most a few names each. */
export interface CloudSnapshotCensus {
  /** Changed tracked files (staged or not, deleted included). */
  trackedChanges: number;
  /** Untracked files that come along. */
  untrackedIncluded: number;
  /** Commits origin's copy of the branch (as last fetched) lacks; missing when unknown. */
  aheadOfUpstream?: number;
  /** Untracked files that stay: they look like secrets or are over 10 MB. */
  leftBehind: string[];
  leftBehindCount: number;
  /** Untracked files that could not be read, so they stay. */
  unchecked: string[];
  uncheckedCount: number;
}

export type CloudContinuationPlan =
  | ({
      kind: "ready";
      /** origin's repository, "owner/name". */
      repository: string;
      /** The checked-out branch; "" when HEAD is detached. */
      branch: string;
    } & CloudSnapshotCensus)
  | {
      kind: "blocked";
      blocker: CloudSnapshotBlocker;
      /** operation_in_progress: "rebase", "merge"… */
      operation?: string;
      /** too_many_untracked: how many, and the top folders they are in. */
      untrackedCount?: number;
      topDirs?: string[];
    }
  | {
      kind: "unsupported";
      reason: CloudContinuationBlock;
      branch?: string;
    };

export interface CloudContinuationOptions {
  /** Untracked files come along (default); off: "Continue without untracked files". */
  includeUntracked?: boolean;
}

/** The saved work, ready to upload (the commit stays in the person's repository). */
export interface CloudSavedWork {
  /** The commit the cloud session starts from. */
  tip: string;
  /** Whether a commit was made for uncommitted work (false: the tip is HEAD). */
  snapshot: boolean;
  branch: string;
  repository: string;
}

/** Why the upload failed (the live dialog's upload errors). */
export type CloudPushFailure =
  | "non_fast_forward"
  | "remote_rejected"
  | "auth"
  | "timed_out"
  | "network"
  | "unknown";

export type CloudUploadResult =
  | {
      ok: true;
      /** What the cloud session clones (no credentials in the address). */
      repository: RepositoryRef;
      /** The first message's note on where the checkout came from. */
      preamble?: string;
      /** The upload was not confirmed (it was made outside this app). */
      unverified?: boolean;
    }
  | {
      ok: false;
      failure: CloudPushFailure;
      message: string;
      /** Git's last words, without the credential ("Git said:"). */
      excerpt?: string;
      /** The push to run in a terminal, or to ask Claudex to run. */
      command?: string;
    };

export interface CloudHandOffNote {
  /** The session's title (the cloud session's first message names it). */
  title: string;
  note: string;
  /** false: an excerpt of the latest messages stands in for the note. */
  written: boolean;
}

export interface CloudContinueAPI {
  /** What continuing this local Code session in the cloud would carry. */
  cloudContinuationPlan(
    conversationId: string,
    options?: CloudContinuationOptions,
  ): Promise<CloudContinuationPlan>;
  /**
   * Saves the folder's work as a commit on top of HEAD, made with a
   * separate index (the folder, its index and its branches are untouched).
   */
  saveWorkForCloud(
    conversationId: string,
    options?: CloudContinuationOptions,
  ): Promise<CloudSavedWork>;
  /**
   * Uploads the saved work to the session's own ref on origin (GitHub) with
   * the person's GitHub connection; their branch is never pushed.
   * `alreadyUploaded`: the person (or Claudex in the session) pushed it.
   */
  uploadWorkForCloud(
    conversationId: string,
    options?: { alreadyUploaded?: boolean },
  ): Promise<CloudUploadResult>;
  /** The handoff note for the cloud session; this session is not touched. */
  writeHandOffNote(conversationId: string): Promise<CloudHandOffNote>;
}

export const cloudContinueMethods = bridgeMethods<CloudContinueAPI>({
  cloudContinuationPlan: true,
  saveWorkForCloud: true,
  uploadWorkForCloud: true,
  writeHandOffNote: true,
});
