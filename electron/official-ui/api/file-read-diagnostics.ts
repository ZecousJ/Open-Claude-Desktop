import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
/** Fixed-schema diagnostics only. Never accept a URL, identifier, byte content or raw error. */
export type FileReadStage =
  | "request"
  | "unauthorized"
  | "registry-hit"
  | "registry-miss"
  | "service-null"
  | "service-error"
  | "invalid-bytes-type"
  | "invalid-bytes-size"
  | "read-success"
  | "response"
  | "route-local"
  | "route-cloud"
  | "local-conversation"
  | "local-root-realpath"
  | "local-file-realpath"
  | "local-file-stat"
  | "local-read";
export type FileReadObserver = (
  stage: FileReadStage,
  status?: number,
  error?: unknown,
) => void;
const stages = new Set<FileReadStage>([
  "request",
  "unauthorized",
  "registry-hit",
  "registry-miss",
  "service-null",
  "service-error",
  "invalid-bytes-type",
  "invalid-bytes-size",
  "read-success",
  "response",
  "route-local",
  "route-cloud",
  "local-conversation",
  "local-root-realpath",
  "local-file-realpath",
  "local-file-stat",
  "local-read",
]);
const statuses = new Set([
  200, 400, 401, 403, 404, 405, 408, 409, 413, 429, 500, 501, 502, 503, 504,
]);
const codes = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EISDIR",
  "ENOTDIR",
  "EIO",
  "UNAUTHORIZED",
  "CLAUDEX_WEB_METHOD_UNAVAILABLE",
  "CLAUDEX_WEB_TIMEOUT",
  "CLAUDEX_WEB_DISABLED",
  "CLAUDEX_WEB_NOT_ALLOWED",
  "CLAUDEX_WEB_CAPACITY",
  "CLAUDEX_WEB_BAD_REQUEST",
  "CLAUDEX_WEB_RUNNER_UNAVAILABLE",
  "CLAUDEX_WEB_BAD_TICKET",
  "CLAUDEX_WEB_QUOTA_EXCEEDED",
  "CLAUDEX_WEB_HANDLER_FAILED",
  "CLAUDEX_WEB_TOO_LARGE",
]);
export function fileReadObserver(
  log: (...args: unknown[]) => void,
): FileReadObserver {
  return (stage, status, error) => {
    if (!stages.has(stage)) return;
    // Do not execute error accessors or Proxy traps for diagnostic classification.
    let kind = "none",
      code = "none",
      serviceStatus: number | "none" = "none";
    if (error !== undefined) {
      kind = "unknown";
      try {
        if (!types.isProxy(error) && types.isNativeError(error)) {
          const ownCode = Object.getOwnPropertyDescriptor(error, "code"),
            ownStatus = Object.getOwnPropertyDescriptor(error, "status");
          code =
            ownCode && "value" in ownCode && codes.has(ownCode.value)
              ? ownCode.value
              : "unknown";
          if (
            ownStatus &&
            "value" in ownStatus &&
            statuses.has(ownStatus.value)
          )
            serviceStatus = ownStatus.value;
          const ownName = Object.getOwnPropertyDescriptor(error, "name");
          if (ownName) {
            if (
              "value" in ownName &&
              ["Error", "TypeError", "RangeError", "AbortError"].includes(
                ownName.value,
              )
            )
              kind = ownName.value;
          } else {
            const prototype = Object.getPrototypeOf(error);
            if (prototype === TypeError.prototype) kind = "TypeError";
            else if (prototype === RangeError.prototype) kind = "RangeError";
            else if (prototype === Error.prototype) kind = "Error";
          }
        }
      } catch {}
    }
    try {
      log(
        "[official-ui:file-read]",
        `route=files.contents stage=${stage} status=${statuses.has(status!) ? status : "none"} error=${kind} code=${code} service_status=${serviceStatus}`,
      );
    } catch {}
  };
}

const scope = new AsyncLocalStorage<{
  observer: FileReadObserver;
  active: boolean;
}>();
/** Invoked only by this file read's service call. Detached work cannot keep logging. */
export async function withFileReadDiagnostics<T>(
  observer: FileReadObserver | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!observer) return operation();
  const state = { observer, active: true };
  return scope.run(state, async () => {
    try {
      return await operation();
    } finally {
      state.active = false;
    }
  });
}
export function fileReadServiceStage(stage: FileReadStage) {
  const state = scope.getStore();
  if (state?.active && stages.has(stage)) state.observer(stage);
}
