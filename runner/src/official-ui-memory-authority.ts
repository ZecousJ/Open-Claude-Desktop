import { randomUUID } from "node:crypto";
import type { MemoryService } from "../../electron/memory/service";
import type { OfficialMemoryAction, OfficialMemoryCapability, OfficialMemoryPreferenceActions } from "../../shared/official-memory-capability";

export interface MemoryAuthorityHost {
  accountId(): string | undefined;
  identity(): unknown;
  root(): string;
  service(): MemoryService | undefined;
  current(): boolean;
  controlsEnabled(): boolean;
  resetEnabled(): boolean;
  preferencesEnabled(): boolean;
  synthesisAvailable(): boolean;
}

function hasControlsVersion(service: MemoryService) {
  const version = service.controlsVersion("global");
  return typeof version === "string" && version.length > 0 && version.length <= 200;
}

export function createMemoryAuthority(host: MemoryAuthorityHost) {
  const owner = host.accountId();
  const identity = host.identity();
  const root = host.root();
  const service = host.service();
  const controlsEnabled = host.controlsEnabled();
  const resetEnabled = host.resetEnabled();
  const preferencesEnabled = host.preferencesEnabled();
  const lease = randomUUID();
  const current = () => !!owner && identity !== undefined && identity !== null && identity !== "" &&
    !!root && host.current() && host.accountId() === owner && host.identity() === identity &&
    host.root() === root && host.service() === service &&
    host.controlsEnabled() === controlsEnabled && host.resetEnabled() === resetEnabled &&
    host.preferencesEnabled() === preferencesEnabled;

  const inspectControls = (): OfficialMemoryCapability["controls"] => {
    if (!current()) return { state: "unavailable", reason: "session_changed" };
    if (!controlsEnabled) return { state: "unavailable", reason: "disabled" };
    if (!service) return { state: "unavailable", reason: "service_unavailable" };
    try {
      const status = service.status();
      if (typeof status?.available !== "boolean" || typeof status.allowed?.generate !== "boolean" ||
          typeof status.prefs?.generate !== "boolean") return { state: "error", reason: "source_error" };
      if (!status.available) return { state: "unavailable", reason: "service_unavailable" };
      if (!status.allowed.generate || service.store.kind === "remote" && !status.prefs.generate)
        return { state: "denied", reason: "memory_off" };
      if (!hasControlsVersion(service))
        return { state: "unavailable", reason: "version_unavailable" };
      return { state: "ready", reason: "ready" };
    } catch {
      return { state: "error", reason: "source_error" };
    }
  };

  const preferences = (): OfficialMemoryPreferenceActions | undefined =>
    current() && preferencesEnabled ? service?.preferenceActions() : undefined;

  const canPause = () => {
    if (!current() || !resetEnabled || !service) return false;
    try {
      const status = service.status();
      return (status.available === true || status.reason === "offline") && status.allowed.generate === true;
    } catch {
      return false;
    }
  };

  const ready = (action: OfficialMemoryAction) => {
    if (action === "controls") return inspectControls().state === "ready";
    if (!current() || !resetEnabled || !service) return false;
    try {
      if (action === "synthesize")
        return service.canRegenerate() && hasControlsVersion(service) && host.synthesisAvailable();
      if (action === "backfill") return preferences()?.searchChats === true;
      if (action === "settings") return canPause() || preferences()?.searchChats === true;
      const status = service.status();
      return status.available === true || status.reason === "offline" || status.reason === "policy";
    } catch {
      return false;
    }
  };

  return {
    current,
    accepts: (value: unknown) => current() && value === lease,
    ready,
    canPause,
    preferences,
    describe: (): OfficialMemoryCapability => ({
      version: 1,
      accountId: owner ?? "",
      activationLease: lease,
      controls: inspectControls(),
      generation: "unavailable",
      ...(ready("synthesize") ? { synthesis: "ready" } : {}),
      reset: ready("reset") ? "ready" : "unavailable",
      settings: canPause() ? "disable-only" : "unavailable",
      preferences: preferences(),
    }),
  };
}
