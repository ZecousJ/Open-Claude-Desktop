export function microphoneBlocked(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    (error instanceof Error && error.name === "NotAllowedError") ||
    /Microphone access was not granted|permission.denied|permission.dismissed/i.test(
      message,
    )
  );
}

/** Why dictation can't start, as the original's microphone panel tells it. */
export type MicrophoneReason =
  | "permission_denied"
  | "no_microphone"
  | "mic_unavailable"
  | "connection_failed"
  | "start_failed";

/** Starts that failed in a row before "Dictation couldn’t start". */
export const startFailuresBeforeGivingUp = 3;

/**
 * The panel's reason for an error while dictation starts: the microphone's
 * own errors by name, else the connection, and after several failed starts
 * in a row, a failed start. Null for anything that is not a start failure.
 */
export function microphoneReason(
  error: unknown,
  starting: boolean,
  failedStarts = 0,
): MicrophoneReason | null {
  if (microphoneBlocked(error)) return "permission_denied";
  const name = error instanceof Error ? error.name : "";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "no_microphone";
  if (name === "NotReadableError" || name === "AbortError")
    return "mic_unavailable";
  if (!starting) return null;
  return failedStarts >= startFailuresBeforeGivingUp
    ? "start_failed"
    : "connection_failed";
}

/** The panel's title and, except for permission, its description. */
export function microphoneReasonCopy(reason: MicrophoneReason) {
  switch (reason) {
    case "no_microphone":
      return {
        title: "No microphone found",
        description: "Connect a microphone, then try again.",
      };
    case "mic_unavailable":
      return {
        title: "Your microphone isn’t available",
        description:
          "Another app or a system setting may be blocking it. Close other apps that use the microphone, then try again in a few seconds.",
      };
    case "connection_failed":
      return {
        title: "Dictation is having trouble connecting",
        description:
          "There may be a problem with your connection or with the service. Try again in a moment.",
      };
    case "start_failed":
      return {
        title: "Dictation couldn’t start",
        description:
          "It failed several times in a row. Wait a moment, then try again.",
      };
    default:
      return { title: "Microphone access is blocked", description: undefined };
  }
}

/** Permission guidance. */
export function microphoneGuidance(platform: string, desktop: boolean) {
  if (desktop && platform === "darwin")
    return "To use dictation, open System Settings, go to Privacy and Security, select Microphone, and turn on Claudex.";
  if (desktop && platform === "win32")
    return "To use dictation, open Settings, go to Privacy and security, select Microphone, and allow Claudex.";
  return "To use dictation, select the site settings icon in your browser’s address bar and allow the microphone.";
}

export function dictationLabel(
  phase: string,
  comment = false,
  hold = false,
  coarse = false,
) {
  if (phase === "requesting") return "Starting dictation…";
  if (phase === "finishing") return "Finishing dictation…";
  if (phase === "recording")
    return comment ? "Finish dictating" : "Stop dictation";
  return comment
    ? "Dictate a comment"
    : hold && !coarse
      ? "Press and hold to record"
      : "Dictate";
}

export const dictationErrorMs = 1500;

/** Failure copy. */
export function dictationFailureCopy(reason: string | null, hasWords: boolean) {
  // Dictation that stopped itself.
  if (reason === "auto_silence" || reason === "auto_max_duration")
    return {
      title:
        reason === "auto_silence"
          ? "Dictation stopped because it heard no words for 1 minute."
          : "Dictation stopped at its time limit.",
      description: hasWords
        ? "Your words so far are in the message box."
        : reason === "auto_silence"
          ? "If you were speaking, check your microphone."
          : "Nothing was added to the message box.",
    };
  if (reason === "mic_lost")
    return {
      title: "Your microphone stopped working.",
      description: hasWords
        ? "Your words so far are in the message box. Check the connection and microphone access."
        : "Check the connection and microphone access.",
    };
  if (reason === null)
    return { title: "Couldn’t start dictation.", description: undefined };
  return {
    title: "Dictation lost its connection.",
    description: !hasWords
      ? "Nothing was added to the message box."
      : reason === "stt_stalled"
        ? "Only your earlier words are in the message box. Anything you said after the connection was lost is missing."
        : "Your words are in the message box, but the last few may be missing.",
  };
}
