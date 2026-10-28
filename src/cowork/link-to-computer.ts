/** What a task that could not be linked to this computer says to the person. */
export const linkFailed = "Couldn’t link this task to this computer.";

/**
 * Why linking a cloud task to this computer failed, in the words the linking
 * itself chose for each reason. Anything else is a technical error and stays
 * out of sight: the person is told it could not be linked.
 */
const reasons = [
  /^Sign in to Claudex again on this computer, then link this task\.$/,
  /^Couldn’t connect\. Check your internet connection, then try again\.$/,
  /^This task was just linked to a different computer, so it wasn’t changed\.$/,
  /^This task is in the middle of a step\. Wait for it to finish \(or stop it\), then link again\.$/,
  /^Couldn’t link this task/,
  /can’t be linked to a computer\./,
  /^This task is too long to link to a computer\./,
  /^Something earlier in this task can’t be carried over to a computer\./,
  /^This task was set up with tools that can’t move to a computer\./,
  /^This task runs as part of a group, so it can’t be linked to a computer\.$/,
  /^Your organization has turned off connecting Claudex to computers\.$/,
];

export function linkFailureMessage(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "")
    .trim();
  return reasons.some((reason) => reason.test(message)) ? message : linkFailed;
}
