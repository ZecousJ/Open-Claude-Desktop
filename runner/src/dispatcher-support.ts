import { ZodError } from "zod";
import { isStorageFullError, storageFullMessage } from "../../shared/turn-errors";
import { webErrorCodes, type WebRpcError } from "../../shared/web-protocol";

export const organizationPluginMethods = [
  "readOrganizationPluginStates", "readOrganizationPluginDetails",
  "setOrganizationPluginEnabled", "removeOrganizationPlugin",
] as const;
export type OrganizationPluginMethod = typeof organizationPluginMethods[number];
export const isOrganizationPluginMethod = (method: string): method is OrganizationPluginMethod =>
  organizationPluginMethods.some((name) => name === method);
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
  "synthesizeMemory",
  "listSkills",
  "setSkillEnabled",
  "editSkill",
  "deleteSkill",
  "duplicateSkill",
  "renameSkill",
]);

export class CapacityError extends Error {
  code = webErrorCodes.capacity;
}

/** The answer a failed call gives the browser. */
export function callError(error: unknown): WebRpcError {
  if (isStorageFullError(error)) return { message: storageFullMessage };
  if (error instanceof ZodError)
    return {
      message: "The request was not valid.",
      code: webErrorCodes.badRequest,
    };
  const raw = error as {
    message?: unknown;
    code?: unknown;
    details?: unknown;
    syscall?: unknown;
    errno?: unknown;
  };
  // A Node system error names the runner's own files (ENOENT, EACCES, …).
  const system =
    typeof raw?.syscall === "string" || typeof raw?.errno === "number";
  const message =
    !system && typeof raw?.message === "string" && raw.message
      ? raw.message
      : "Something went wrong. Try again.";
  const out: WebRpcError = { message };
  if (typeof raw?.code === "string" && /^CLAUDEX_[A-Z0-9_]+$/.test(raw.code))
    out.code = raw.code;
  if (raw?.details !== undefined)
    try {
      out.details = JSON.parse(JSON.stringify(raw.details));
    } catch {
      // Not serialisable: left out.
    }
  return out;
}
