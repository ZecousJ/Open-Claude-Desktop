/**
 * How a failed load is told apart, after the original's: its boot error page
 * says "temporarily unavailable" when the service answered with a 5xx or its
 * own error envelope, "You're offline" when the browser knows it has no
 * network, and "Can't reach" for any other failure on the way; its page
 * boundary offers Reload, not Try again, when a script failed to load (a retry
 * would ask React for the same failed import).
 */

export type BootFailure = "unavailable" | "offline" | "unreachable";

/** Refusals of this service's web front that mean it is up but not serving. */
const serviceDown = new Set([
  "CLAUDEX_WEB_DISABLED",
  "CLAUDEX_WEB_CAPACITY",
  "CLAUDEX_WEB_HANDLER_FAILED",
]);

function field(error: unknown, name: "status" | "code"): unknown {
  return error && typeof error === "object"
    ? (error as Record<string, unknown>)[name]
    : undefined;
}

/**
 * Why the workspace (or the account) could not load. `online` is
 * navigator.onLine; `answered` is whether a failure without an HTTP status
 * still came from the service (the desktop's main process answers every
 * call itself, so a failure it reports is the service's, unless the browser
 * knows it has no network: then the page says offline, as the original does).
 */
export function bootFailureKind(
  error: unknown,
  { online, answered = false }: { online: boolean; answered?: boolean },
): BootFailure {
  const status = field(error, "status");
  const code = field(error, "code");
  if (
    (typeof status === "number" && status >= 500) ||
    (typeof code === "string" && serviceDown.has(code))
  )
    return "unavailable";
  if (!online) return "offline";
  return answered ? "unavailable" : "unreachable";
}

const chunkFailure =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading (?:CSS )?chunk \S+ failed/i;

/** A script or stylesheet the page loads on demand did not arrive. */
export function isChunkLoadError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return name === "ChunkLoadError" || chunkFailure.test(message);
}

/** The browser's own idea of whether it is online (true when unknown). */
export function browserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}
