export const errorName = (error: unknown) =>
  error instanceof Error ? error.name : "";

/**
 * What to tell the person when the microphone can't be opened: access was
 * refused (the system's privacy settings), no input exists, or another app
 * holds it, in the original's words.
 */
export function microphoneError(error: unknown): Error {
  switch (errorName(error)) {
    case "NotAllowedError":
    case "SecurityError":
      return Error(
        "Microphone access was not granted. Allow it in your system's privacy settings.",
      );
    case "NotFoundError":
    case "OverconstrainedError":
      return Error("No microphone found. Connect a microphone and try again.");
    case "NotReadableError":
    case "AbortError":
      return Error(
        "Your microphone isn’t available. Another app or a system setting may be blocking it. Close other apps that use the microphone, then try again in a few seconds.",
      );
    default:
      return error instanceof Error ? error : Error("The microphone failed.");
  }
}
