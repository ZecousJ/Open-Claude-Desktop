/** Host-only fixed vocabulary. No arbitrary error payload becomes diagnostic metadata. */
const allowedPhases = new Set(["profile_setup", "artifact_shares", "credentials_and_host_prepare", "engine_setup", "policy_start", "native_extensions", "activation_listeners", "host.credentials_initialize", "host.groups_in_use", "host.backend_prepare", "host.follow_group", "host.store_flush", "credentials.queue", "credentials.validate", "credentials.master", "credentials.client", "credentials.legacy", "credentials.set_keys", "credentials.key_status", "credentials.close", "backend.service_kind", "backend.bootstrap", "backend.register", "backend.store_keys", "backend.public_settings", "backend.models", "backend.register_device", "backend.legacy_provision", "backend.store_key", "backend.remote_models", "backend.group_models", "backend.models_result", "cleanup.begin", "cleanup.quick_entry", "cleanup.listeners", "cleanup.conversation_windows", "cleanup.cloud_sync", "cleanup.device_link", "cleanup.usage", "cleanup.scheduler", "cleanup.terminals", "cleanup.engine", "cleanup.store_flush", "cleanup.shares", "cleanup.popouts", "cleanup.selection", "cleanup.remote_release", "cleanup.credentials", "cleanup.mcp", "cleanup.account_devices", "cleanup.window_shape", "cleanup.integration_reset", "cleanup.integration_apply", "cleanup.policy", "cleanup.clear_state", "cleanup.notify"]);
const allowedCodes = new Set(["credential_unlock_unavailable", "credential_master_invalid", "credential_providers_missing", "credential_migration_unavailable", "credential_legacy_invalid", "credential_close_unconfirmed", "device_keys_disabled", "device_registration_rate_limited", "legacy_no_models", "account_operation_stale", "account_transition_superseded"]);
const phases = new WeakMap<object, string[]>();
const localCodes = new WeakMap<object, string>();
export function noteActivationPhase(error: unknown, phase: string) {
  if (!allowedPhases.has(phase)) return;
  if (error && (typeof error === "object" || typeof error === "function")) {
    const trail = phases.get(error) ?? [];
    if (trail.length < 12 && !trail.includes(phase)) phases.set(error, [...trail, phase]);
  } else {
    // Primitive throws have no stable identity. Report only this trusted boundary.
    try { console.error("Account operation failed without an error object.", {phase}); } catch {}
  }
}
export function activationFailureTrail(error: unknown): string[] {
  return error && (typeof error === "object" || typeof error === "function") ? [...(phases.get(error) ?? [])] : [];
}
export function activationFailurePhase(error: unknown) { return activationFailureTrail(error).at(-1) ?? "activation"; }
export function activationLocalError(code: string, message: string): Error {
  const error = Error(message);
  if (allowedCodes.has(code)) localCodes.set(error, code);
  return error;
}
export function activationFailureCode(error: unknown): string | undefined {
  return error && (typeof error === "object" || typeof error === "function") ? localCodes.get(error) : undefined;
}
export interface ActivationPriorFailure { phases: string[]; code?: string }
const priorFailures = new WeakMap<object, ActivationPriorFailure>();
export function captureActivationPriorFailure(error: unknown, phase: string): ActivationPriorFailure {
  const trail = activationFailureTrail(error);
  return { phases: trail.length ? trail : allowedPhases.has(phase) ? [phase] : [], code: activationFailureCode(error) };
}
export function noteActivationPriorFailure(error: unknown, prior: ActivationPriorFailure) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return;
  priorFailures.set(error, {phases: prior.phases.filter(phase => allowedPhases.has(phase)).slice(0, 12),
    ...(prior.code && allowedCodes.has(prior.code) ? {code: prior.code} : {})});
}
export function activationPriorFailure(error: unknown): ActivationPriorFailure | undefined {
  const prior = error && (typeof error === "object" || typeof error === "function") ? priorFailures.get(error) : undefined;
  return prior ? {phases: [...prior.phases], ...(prior.code ? {code: prior.code} : {})} : undefined;
}
const privateCauses = new WeakMap<Error, {activation: unknown; cleanup: unknown}>();
export class ActivationCleanupUnconfirmed extends Error {
  constructor(readonly phase: string, private readonly owned: () => boolean, original: unknown, cleanup: unknown) {
    super("The account could not be opened and cleanup was not confirmed. Do not retry automatically.");
    privateCauses.set(this, {activation: original, cleanup});
  }
  isCurrent() { try { return this.owned() === true; } catch { return false; } }
}

const diagnosticCodes = new Set([
  "ENOENT", "EACCES", "EPERM", "EADDRINUSE", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EISDIR", "ENOTDIR", "ENOSPC", "EDQUOT", "EROFS",
]);
type SafeFailureSummary = {kind: "Error" | "TypeError" | "RangeError" | "SyntaxError" | "unknown"; code?: string; status?: number};
/** Fixed scalar vocabulary only; never invoke error getters, stringify values, or expose causes. */
export function safeActivationFailureSummary(error: unknown): SafeFailureSummary[] {
  const result: SafeFailureSummary[] = [];
  const seen = new Set<object>();
  let current = error;
  // Root plus at most two own-data cause links (e.g. fetch TypeError -> errno).
  for (let depth = 0; depth < 3; depth++) {
    if (!current || typeof current !== "object" || seen.has(current)) {
      if (!result.length) result.push({kind: "unknown"});
      break;
    }
    seen.add(current);
    try {
      const prototype = Object.getPrototypeOf(current);
      const kind = prototype === TypeError.prototype ? "TypeError"
        : prototype === RangeError.prototype ? "RangeError"
        : prototype === SyntaxError.prototype ? "SyntaxError"
        : prototype === Error.prototype ? "Error" : "unknown";
      const summary: SafeFailureSummary = {kind};
      const code = Object.getOwnPropertyDescriptor(current, "code");
      if (code && "value" in code && typeof code.value === "string" && diagnosticCodes.has(code.value)) summary.code = code.value;
      const status = Object.getOwnPropertyDescriptor(current, "status");
      if (status && "value" in status && typeof status.value === "number" && Number.isInteger(status.value) && status.value >= 100 && status.value <= 599) summary.status = status.value;
      const cause = Object.getOwnPropertyDescriptor(current, "cause");
      result.push(summary);
      if (!cause || !("value" in cause)) break;
      current = cause.value;
    } catch {
      // Proxies may throw while inspecting descriptors/prototype. Never propagate their data.
      result.push({kind: "unknown"});
      break;
    }
  }
  return result;
}
