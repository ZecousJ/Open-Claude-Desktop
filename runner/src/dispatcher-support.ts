import { webErrorCodes } from "../../shared/web-protocol";
/** Calls that may start a user's engine (and so need an engine slot). */
export const engineStartingMethods = new Set([
  "send",
  "retryResponse",
  "editPrompt",
  "compactConversation",
  "forkConversation",
  "handOffConversation",
  "askSideChat",
  "startReview",
  "runShellCommand",
  "rewindConversation",
]);

export class CapacityError extends Error {
  code = webErrorCodes.capacity;
}
