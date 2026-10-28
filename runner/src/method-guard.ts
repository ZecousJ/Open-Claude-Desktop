/**
 * What the runner lets through from the network (web plan §9 risk 3, W-ARCH
 * §10.2). The desktop handlers were written for one trusted person on their
 * own computer; on the runner they serve many users on a shared host, so:
 *
 * 1. Default deny: only the "remote-runner" calls of the web method table
 *    are registered (`webRemoteRunnerMethods`); every other name the IPC
 *    domains try to register is dropped and listed at start.
 * 2. No local paths: an argument object may not name a folder or file of
 *    the host (`cwd`, `folder`, `path`, …, or an SSH environment). The
 *    desktop's own checks (allowedFolder, the skills list, the generated
 *    images folder) still run behind this.
 * 3. Modes: `send` only starts conversations of the modes the web offers
 *    (Chat in phase A; Cowork and Code once the service turns them on).
 * 4. Answers: a few desktop answers describe the host (the MCP config file's
 *    path, an attachment's stored path); they are cleared before they leave.
 * 5. Echoes: the desktop app sends back what it was given (a whole Attachment
 *    row with its path, the conversation's own folder when sending from an
 *    artifact); `webArguments` drops those before the guard looks, since the
 *    handlers never use them from the page.
 */
import { anyFolder } from "../../shared/sandbox-policy";
import {
  notAvailableOnWeb,
  webRemoteRunnerMethods,
} from "../../shared/web-bridge-methods";
import { webErrorCodes } from "../../shared/web-protocol";
import type { Mode } from "../../shared/types";
import { parseRepositories } from "./code-workspace";

/** Argument keys that would name a place on the host. */
export const localPathKeys = new Set([
  "cwd",
  "folder",
  "folders",
  // A project's other folders on the person's computer (shared/project-folders.ts).
  "additionalFolders",
  "path",
  "paths",
  "filePath",
  "file",
  "directory",
  "location",
  "dir",
  "root",
  "workspace",
  "configPath",
  "bypassFolders",
  "savedPath",
  "localPath",
]);

/** The error a refused call answers with (`code` travels to the browser). */
export class GuardError extends Error {
  code: string;
  constructor(message: string, code: string = webErrorCodes.badRequest) {
    super(message);
    this.name = "GuardError";
    this.code = code;
  }
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.some(hasValue);
  return true;
}

/**
 * The first key path in `value` that names a host place, or undefined.
 * Byte arrays are data, not paths, and are not walked.
 */
export function localPathIn(
  value: unknown,
  trail = "",
  depth = 0,
): string | undefined {
  if (depth > 16 || !value || typeof value !== "object") return undefined;
  if (value instanceof Uint8Array) return undefined;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = localPathIn(item, `${trail}[${index}]`, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    const here = trail ? `${trail}.${key}` : key;
    // The runner's own "every folder" confirmation (Bypass) names no place.
    const anyFolderOnly =
      key === "bypassFolders" &&
      Array.isArray(item) &&
      item.every((entry) => entry === anyFolder);
    if (localPathKeys.has(key) && hasValue(item) && !anyFolderOnly) return here;
    if (
      key === "environment" &&
      item &&
      typeof item === "object" &&
      (item as { kind?: unknown }).kind !== undefined &&
      (item as { kind?: unknown }).kind !== "local"
    )
      return here;
    const found = localPathIn(item, here, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export interface GuardOptions {
  /** Conversation modes `send` may start (phase A: chat). */
  modes: readonly Mode[];
}

export const defaultGuardOptions: GuardOptions = { modes: ["chat"] };

/** The allow-list of a runner (sorted). */
export const runnerMethods: ReadonlySet<string> = new Set(
  webRemoteRunnerMethods,
);

/** Refuses a call the web may not make; returns nothing when it may. */
export function guardCall(
  method: string,
  args: unknown[],
  options: GuardOptions = defaultGuardOptions,
) {
  if (!runnerMethods.has(method))
    throw new GuardError(notAvailableOnWeb, webErrorCodes.methodUnavailable);
  const where = localPathIn(args);
  if (where)
    throw new GuardError(
      "Folders on the server can't be used from the web.",
      webErrorCodes.badRequest,
    );
  if (method === "send" || method === "retryResponse") {
    const input = args[0] as { mode?: unknown } | undefined;
    const mode = input && typeof input === "object" ? input.mode : undefined;
    if (method === "send" && input && typeof input === "object") {
      try {
        parseRepositories(
          input as { repository?: unknown; repositories?: unknown },
        );
      } catch (error) {
        throw new GuardError(
          (error as Error).message,
          webErrorCodes.badRequest,
        );
      }
    }
    if (
      method === "send" &&
      typeof mode === "string" &&
      !options.modes.includes(mode as Mode)
    )
      throw new GuardError(
        mode === "code"
          ? "Code isn't available on the web yet."
          : mode === "cowork"
            ? "Cowork isn't available on the web yet."
            : notAvailableOnWeb,
        webErrorCodes.methodUnavailable,
      );
  }
}

/**
 * The call's arguments without the host places the app only echoes back:
 * `send`'s attachment rows are reduced to their ids (the handler reads only
 * the id and looks the file up itself), and a `cwd` equal to the existing
 * conversation's own folder is left out (the engine uses that folder anyway).
 * Anything else is left for the guard to judge.
 */
export function webArguments(
  method: string,
  args: unknown[],
  conversationCwd: (id: string) => string | undefined,
): unknown[] {
  if (method !== "send" && method !== "sendOnChatDevice") return args;
  const input = args[0];
  if (!input || typeof input !== "object" || Array.isArray(input)) return args;
  const next: Record<string, unknown> = { ...(input as object) };
  if (Array.isArray(next.attachments))
    next.attachments = next.attachments.map((item) =>
      item &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string"
        ? { id: (item as { id: string }).id }
        : item,
    );
  if (
    typeof next.cwd === "string" &&
    typeof next.conversationId === "string" &&
    conversationCwd(next.conversationId) === next.cwd
  )
    delete next.cwd;
  return [next, ...args.slice(1)];
}

/** Clears what an answer says about the host before it leaves the runner. */
export function sanitizeResult(method: string, value: unknown): unknown {
  if (
    method === "mcpServers" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const {
      configPath: _path,
      configError: _error,
      ...rest
    } = value as Record<string, unknown>;
    return { ...rest, configPath: "" };
  }
  if (
    (method === "addAttachmentData" || method === "linkChatGitHubRepository") &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    return { ...(value as Record<string, unknown>), path: "" };
  return value;
}
