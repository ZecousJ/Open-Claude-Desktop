/**
 * Continue in cloud's words and steps, and the run behind its button: save the
 * work, upload it, write the handoff note, start the cloud session on that work
 * with the note as its first message. The dialog is ContinueInCloudDialog.tsx;
 * the calls are shared/cloud-continue-api.ts.
 */
import type {
  CloudContinuationPlan,
  CloudHandOffNote,
  CloudPushFailure,
  CloudSavedWork,
  CloudUploadResult,
} from "../../shared/cloud-continue-api";
import { handOffPrompt } from "../../shared/hand-off";
import type { Conversation, DesktopAPI } from "../../shared/types";
import { formatText } from "../i18n";

/** The steps, in the order Claudex runs them. */
export type ContinuationStep =
  "saving_work" | "uploading" | "generating_summary" | "creating_session";

export const continuationSteps: ContinuationStep[] = [
  "saving_work",
  "uploading",
  "generating_summary",
  "creating_session",
];

export const stepLabels: Record<ContinuationStep, string> = {
  saving_work: "Saving your work",
  uploading: "Uploading your work",
  generating_summary: "Writing the handoff note",
  creating_session: "Starting the cloud session",
};

/** Why a plan can't continue in the cloud, in the dialog's words. */
export const blockedMessages: Record<
  Extract<CloudContinuationPlan, { kind: "unsupported" }>["reason"],
  string
> = {
  noGit: "This session can’t be moved to the cloud from here.",
  noGitHub: "This session can’t be moved to the cloud from here.",
  elsewhere: "This session can’t be moved to the cloud from here.",
  noRemote:
    "This repository has no remote named origin, so there’s nowhere to upload your work. Add one, then try again.",
  signedOut:
    "Sign in to your Claudex account in the desktop app, then try again.",
};

/** Read failed: the folder's git state could not be read. */
export const planUnreadable =
  "Couldn’t read this folder’s git state. Check again in a moment.";
/** The generic failure. */
export const moveFailed =
  "Couldn’t move this session to the cloud. Try again, or keep working here.";
/** The cloud session could not be started after the upload (retryable). */
export const createFailed =
  "Your work is uploaded, but the cloud session couldn’t be started right now. Try again in a moment.";

/** The opening sentence, and the one on what happens to this session. */
const intro =
  "Claudex picks up where you left off in a new cloud session, with your work exactly as it is now.";
const staysHere = "This session stays on this computer.";

/** A sentence's parts: text, or a name shown as code. */
export type Segment = string | { code: string };
/** The description: paragraphs of segments. */
export type Description = Segment[][];

/** Names as code, then "+N" for those not listed. */
function names(listed: string[], total: number): Segment[] {
  const out: Segment[] = [];
  listed.forEach((name, index) => {
    if (index > 0) out.push(", ");
    out.push({ code: name });
  });
  const more = total - listed.length;
  if (more > 0) out.push(`${listed.length ? ", " : ""}+${more}`);
  return out;
}

/** Splits a translated sentence at `{name}`, putting the segments there. */
function around(sentence: string, name: string, inner: Segment[]): Segment[] {
  const at = sentence.indexOf(`{${name}}`);
  if (at < 0) return [sentence];
  return [
    sentence.slice(0, at),
    ...inner,
    sentence.slice(at + name.length + 2),
  ].filter((part) => part !== "");
}

/** Blocked: what to change before the work can move. */
export function blockedDescription(
  plan: Extract<CloudContinuationPlan, { kind: "blocked" }>,
): Description {
  if (plan.blocker === "operation_in_progress")
    return [
      [
        formatText(
          "A {operation} is in progress in this folder. Finish or abort it, then check again.",
          { operation: plan.operation ?? "git operation" },
        ),
      ],
    ];
  if (plan.blocker === "conflicts")
    return [
      [
        formatText(
          "This folder has unresolved merge conflicts. Resolve them, or ask Claudex to, then check again.",
        ),
      ],
    ];
  const count = plan.untrackedCount ?? 0;
  const dirs = plan.topDirs ?? [];
  const sentence = dirs.length
    ? formatText(
        "{count} untracked files here aren’t ignored by git ({dirs}), which is more than a move can carry. Add them to .gitignore, or continue without untracked files.",
        { count },
      )
    : formatText(
        "{count} untracked files here aren’t ignored by git, which is more than a move can carry. Add them to .gitignore, or continue without untracked files.",
        { count },
      );
  return [around(sentence, "dirs", names(dirs, dirs.length))];
}

/**
 * The description under the title: what comes along, where it goes, what
 * stays (live dialog: the intro, then the counts, then the upload or the
 * branch it starts from, then what stays here).
 */
export function continuationDescription(
  plan: CloudContinuationPlan | undefined,
): Description {
  if (!plan) return [[`${formatText(intro)} ${formatText(staysHere)}`]];
  if (plan.kind === "unsupported")
    return [[formatText(blockedMessages[plan.reason])]];
  if (plan.kind === "blocked") return blockedDescription(plan);
  const out: Description = [[formatText(intro)]];
  const changes = plan.trackedChanges + plan.untrackedIncluded;
  const ahead = plan.aheadOfUpstream ?? 0;
  const moving: Segment[] = [];
  if (changes > 0)
    moving.push(
      changes === 1
        ? formatText("1 uncommitted change comes along.")
        : formatText("{count} uncommitted changes come along.", {
            count: changes,
          }),
      " ",
    );
  if (ahead > 0)
    moving.push(
      ahead === 1
        ? formatText("1 unpushed commit rides along.")
        : formatText("{count} unpushed commits ride along.", { count: ahead }),
      " ",
    );
  if (changes > 0 || ahead > 0 || plan.aheadOfUpstream === undefined)
    moving.push(
      ...around(
        formatText(
          "Your work is uploaded to {repo} on GitHub. Nothing is pushed to your branch.",
        ),
        "repo",
        [{ code: plan.repository }],
      ),
      " ",
    );
  else if (plan.branch)
    moving.push(
      ...around(formatText("It starts from {branch}."), "branch", [
        { code: plan.branch },
      ]),
      " ",
    );
  moving.push(formatText(staysHere));
  out.push(moving);
  if (plan.leftBehindCount > 0)
    out.push(
      around(
        plan.leftBehindCount === 1
          ? formatText(
              "1 untracked file stays on this computer because it looks like a secret or is over 10 MB: {names}. Stage a file with git add to bring it along.",
            )
          : formatText(
              "{count} untracked files stay on this computer because they look like secrets or are over 10 MB: {names}. Stage a file with git add to bring it along.",
              { count: plan.leftBehindCount },
            ),
        "names",
        names(plan.leftBehind, plan.leftBehindCount),
      ),
    );
  if (plan.uncheckedCount > 0)
    out.push(
      around(
        plan.uncheckedCount === 1
          ? formatText(
              "1 file can’t be moved safely, so it stays on this computer: {names}.",
            )
          : formatText(
              "{count} files can’t be moved safely, so they stay on this computer: {names}.",
              { count: plan.uncheckedCount },
            ),
        "names",
        names(plan.unchecked, plan.uncheckedCount),
      ),
    );
  return out;
}

/** Where a run failed, and what the dialog then says and offers. */
export type ContinuationFailure =
  | {
      step: "uploading";
      failure: CloudPushFailure;
      message: string;
      excerpt?: string;
      command?: string;
    }
  | {
      /** Saving refused: the dialog reads the folder again. */
      step: "saving_work";
      message: string;
    }
  | { step: "generating_summary" | "creating_session"; message: string };

/** Upload failures Claudex in the session can be asked to push past. */
const askable = new Set<CloudPushFailure>([
  "auth",
  "remote_rejected",
  "timed_out",
  "non_fast_forward",
  "unknown",
]);
export function canAskToPush(failure: ContinuationFailure) {
  return (
    failure.step === "uploading" &&
    askable.has(failure.failure) &&
    Boolean(failure.command)
  );
}

/** What Claudex in this session is asked. */
export function askToPushPrompt(command: string) {
  return [
    "The desktop app couldn't upload my work for the move to the cloud.",
    `Please run exactly \`${command}\` from the repository root and tell me whether it succeeded. Don't change, commit or push anything else.`,
  ].join(" ");
}

/**
 * Pull and push: the remote has commits this branch lacks, so Claude is asked
 * to pull, then push, stopping at conflicts.
 */
export const pullAndPushPrompt =
  "Pull the latest changes for the current branch from the remote and push. If there are merge conflicts, stop and tell me instead of resolving them.";

/** Whether the refused upload is answered by Pull and push. */
export const offersPullAndPush = (failure: ContinuationFailure | undefined) =>
  failure?.step === "uploading" && failure.failure === "non_fast_forward";

/** What a run has done so far; a retry starts after it. */
export interface ContinuationProgress {
  work?: CloudSavedWork;
  uploaded?: Extract<CloudUploadResult, { ok: true }>;
  note?: CloudHandOffNote;
  /** The note, written while the work is saved and uploaded. */
  writing?: Promise<CloudHandOffNote>;
}

const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message
    ? error.message.replace(
        /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/,
        "",
      )
    : fallback;

/** The cloud session's first message: where its checkout came from, then the note. */
export function firstMessage(
  note: CloudHandOffNote,
  preamble: string | undefined,
) {
  const prompt = handOffPrompt(note);
  return preamble ? `${preamble}\n\n${prompt}` : prompt;
}

/**
 * Runs the steps from where `progress` left off. Resolves with the new
 * cloud session, or with the failure (the progress keeps what was done).
 */
export async function runContinuation({
  api,
  conversation,
  includeUntracked,
  alreadyUploaded,
  progress,
  onStep,
}: {
  api: Pick<
    DesktopAPI,
    "saveWorkForCloud" | "uploadWorkForCloud" | "writeHandOffNote" | "send"
  >;
  conversation: Conversation;
  includeUntracked: boolean;
  /** The person had the work pushed outside this app (Ask Claudex to push). */
  alreadyUploaded?: boolean;
  progress: ContinuationProgress;
  onStep: (step: ContinuationStep) => void;
}): Promise<
  | { created: Conversation; unverified: boolean }
  | { failed: ContinuationFailure }
> {
  if (!progress.note && !progress.writing) {
    const writing = api.writeHandOffNote(conversation.id);
    // Read below; a failure here is said at its own step.
    writing.catch(() => undefined);
    progress.writing = writing;
  }
  if (!progress.uploaded) {
    onStep("saving_work");
    try {
      progress.work = await api.saveWorkForCloud(conversation.id, {
        includeUntracked,
      });
    } catch (error) {
      return {
        failed: { step: "saving_work", message: messageOf(error, moveFailed) },
      };
    }
    onStep("uploading");
    let uploaded: CloudUploadResult;
    try {
      uploaded = await api.uploadWorkForCloud(
        conversation.id,
        alreadyUploaded ? { alreadyUploaded } : {},
      );
    } catch (error) {
      return {
        failed: {
          step: "uploading",
          failure: "unknown",
          message: messageOf(error, moveFailed),
        },
      };
    }
    if (!uploaded.ok)
      return {
        failed: {
          step: "uploading",
          failure: uploaded.failure,
          message: uploaded.message,
          ...(uploaded.excerpt ? { excerpt: uploaded.excerpt } : {}),
          ...(uploaded.command ? { command: uploaded.command } : {}),
        },
      };
    progress.uploaded = uploaded;
  }
  if (!progress.note) {
    onStep("generating_summary");
    try {
      progress.note = await progress.writing!;
    } catch (error) {
      progress.writing = undefined;
      return {
        failed: {
          step: "generating_summary",
          message: messageOf(error, moveFailed),
        },
      };
    }
  }
  onStep("creating_session");
  try {
    const created = await api.send({
      text: firstMessage(progress.note, progress.uploaded.preamble),
      mode: "code",
      attachments: [],
      providerId: conversation.providerId,
      model: conversation.model,
      // The cloud session clones the uploaded work.
      repository: progress.uploaded.repository,
    });
    return { created, unverified: progress.uploaded.unverified === true };
  } catch (error) {
    return {
      failed: {
        step: "creating_session",
        message: messageOf(error, createFailed),
      },
    };
  }
}
